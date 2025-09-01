// --- Polyfills necesarios para Baileys ---
import { webcrypto as _webcrypto } from "crypto";

if (!globalThis.crypto) globalThis.crypto = _webcrypto;

if (typeof globalThis.atob === "undefined") {
  globalThis.atob = (data) => Buffer.from(data, "base64").toString("binary");
}
if (typeof globalThis.btoa === "undefined") {
  globalThis.btoa = (data) => Buffer.from(data, "binary").toString("base64");
}

// --- Imports principales ---
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser,
  DisconnectReason
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== ENV ======
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, "auth");
const PORT = process.env.PORT || 3000;

// ====== EXPRESS ======
const app = express();
app.use(bodyParser.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// ====== API KEY (solo POST necesita llave) ======
const requireKey = (req, res, next) => {
  if (req.method === "GET") return next();
  const key = req.headers["x-api-key"];
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: "invalid api key" });
};
app.use(requireKey);

// ====== BAILEYS STORE ======
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const store = makeInMemoryStore({});
let sock = null;
let authState = null;
let qrData = { qr: null, ts: 0 };

const sseClients = new Set();
const broadcast = (event, payload) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
};

// ====== INIT WA SOCKET ======
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  store.bind(sock.ev);

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];
      if (qr) {
        qrData = { qr, ts: Date.now() };
        broadcast("qr", { qr });
      }
      if (connection === "open") {
        qrData = { qr: null, ts: 0 };
        broadcast("ready", { user: sock.user });
      }
      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
        if (shouldReconnect) startSock();
      }
    }

    if (events["creds.update"]) await saveCreds();

    if (events["chats.set"]) {
      const { chats } = events["chats.set"];
      broadcast("chats.set", { chats });
    }
    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      broadcast("messages", { type, messages });
    }
  });
}

// ====== ENDPOINTS ======
app.get("/session/qr", async (req, res) => {
  if (!qrData.qr) return res.json({ qr: null });
  const dataUrl = await QRCode.toDataURL(qrData.qr);
  res.json({ qr: dataUrl, ts: qrData.ts });
});

app.get("/session/status", (req, res) => {
  const connected = !!(sock && sock.user);
  res.json({ connected, user: sock?.user || null });
});

app.get("/chats", (req, res) => {
  const chats = store.chats.all();
  res.json({ count: chats.length, chats });
});

app.get("/messages", async (req, res) => {
  const { jid, pageSize } = req.query;
  if (!jid) return res.status(400).json({ error: "jid required" });

  try {
    const msgs = await sock.fetchMessagesFromWA(jid, parseInt(pageSize || "25", 10));
    res.json({ jid, messages: msgs });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/messages/send", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to & text required" });

  try {
    const jid = jidNormalizedUser(to);
    const sent = await sock.sendMessage(jid, { text });
    res.json({ ok: true, id: sent.key.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN
  });
  res.write("\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`Baileys microservice on :${PORT}`);
  startSock().catch(err => {
    console.error("Failed to start Baileys", err);
    process.exit(1);
  });
});
