import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { join } from "path";
import { Boom } from "@hapi/boom";
import makeWASocket, { useMultiFileAuthState, jidNormalizedUser } from "@whiskeysockets/baileys";
import fs from "fs";

const app = express();
app.use(bodyParser.json());

// ====== ENV ======
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions";

// ====== CORS ======
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// ====== API KEY middleware ======
app.use((req, res, next) => {
  if (req.method === "POST" || req.method === "DELETE") {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// ====== Global ======
let sock;
let sseClients = new Set();

// ====== SSE Broadcast helper ======
function broadcast(event, data) {
  for (const client of sseClients) {
    try {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }
}

// ====== Start Baileys ======
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    syncFullHistory: true,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      if (update.qr) {
        fs.writeFileSync(join(SESSION_DIR, "latest-qr.json"), JSON.stringify(update));
      }
      if (update.connection === "open") {
        broadcast("ready", { user: sock.user });
      }
      if (update.connection === "close") {
        const shouldReconnect =
          (update.lastDisconnect?.error as Boom)?.output?.statusCode !== 401;
        if (shouldReconnect) startSock();
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["chats.set"]) {
      broadcast("chats.set", events["chats.set"]);
    }
    if (events["chats.upsert"]) {
      broadcast("chats.upsert", events["chats.upsert"]);
    }
    if (events["chats.update"]) {
      broadcast("chats.update", events["chats.update"]);
    }
    if (events["messages.upsert"]) {
      broadcast("messages", { type: "notify", messages: events["messages.upsert"].messages });
    }
    if (events["messages.update"]) {
      broadcast("messages.update", events["messages.update"]);
    }
  });
}

startSock();

// ====== API Routes ======

// QR
app.get("/session/qr", (req, res) => {
  try {
    const file = join(SESSION_DIR, "latest-qr.json");
    if (!fs.existsSync(file)) return res.json({ qr: null });
    const qr = JSON.parse(fs.readFileSync(file).toString());
    return res.json({ qr: qr.qr || null });
  } catch (e) {
    return res.json({ qr: null });
  }
});

// Status
app.get("/session/status", (req, res) => {
  return res.json({ connected: !!sock?.user, user: sock?.user || null });
});

// Chats
app.get("/chats", async (req, res) => {
  try {
    const chats = Object.values(sock?.store?.chats || {});
    res.json({ count: chats.length, chats });
  } catch (e) {
    res.json({ count: 0, chats: [] });
  }
});

// Messages
app.get("/messages", async (req, res) => {
  const { jid, pageSize = 25, cursorId } = req.query;
  if (!jid) return res.status(400).json({ error: "jid required" });
  try {
    const msgs = await sock.store.loadMessages(jid, Number(pageSize), cursorId || undefined);
    res.json({ count: msgs.length, messages: msgs });
  } catch (e) {
    res.json({ count: 0, messages: [] });
  }
});

// Send message
app.post("/messages/send", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to & text required" });

  try {
    const jid = jidNormalizedUser(to);
    const sent = await sock.sendMessage(jid, { text });

    // eco inmediato al SSE
    const msg = {
      id: sent.key.id,
      jid,
      fromMe: true,
      text,
      ts: Math.floor(Date.now() / 1000),
    };
    broadcast("messages", { type: "sent", messages: [msg] });

    res.json({ ok: true, id: sent.key.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ====== SSE Events ======
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  });

  // hello inmediato
  res.write(`event: hello\ndata: ${JSON.stringify({ connected: !!sock?.user })}\n\n`);

  // heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: "ok"\n\n`); } catch {}
  }, 25000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ====== Start Server ======
app.listen(PORT, () => {
  console.log(`Baileys microservice on :${PORT}`);
});
