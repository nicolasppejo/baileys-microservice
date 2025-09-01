// ---------- Polyfills necesarios ----------
import { webcrypto as _webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = _webcrypto;
if (typeof globalThis.atob === "undefined") {
  globalThis.atob = (d) => Buffer.from(d, "base64").toString("binary");
}
if (typeof globalThis.btoa === "undefined") {
  globalThis.btoa = (d) => Buffer.from(d, "binary").toString("base64");
}

// ---------- Imports ----------
// 👉 Importamos TODO y resolvemos el export real en runtime (default vs named)
import * as Baileys from "@whiskeysockets/baileys";
const makeWASocket =
  // v6 suele exportar default; otras builds exportan named
  Baileys.default || Baileys.makeWASocket;
const {
  useMultiFileAuthState,
  makeInMemoryStore,
  jidNormalizedUser,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = Baileys;

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { fileURLToPath } from "url";

// ---------- Paths util ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- ENV ----------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, "auth");

// ---------- Express ----------
const app = express();
app.use(bodyParser.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// API key sólo en POST/DELETE
app.use((req, res, next) => {
  if (req.method === "GET") return next();
  const key = req.headers["x-api-key"];
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: "invalid api key" });
});

// Asegurar carpeta de sesión
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ---------- Estado global ----------
const store = makeInMemoryStore({});
let sock = null;
let latestQR = null;
const QR_FILE = path.join(SESSION_DIR, "latest-qr.json");

// ---------- SSE ----------
const sseClients = new Set();
const broadcast = (event, payload) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
};

// ---------- Baileys ----------
async function startSock() {
  if (typeof makeWASocket !== "function") {
    throw new Error("makeWASocket export not resolved (default/named).");
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    syncFullHistory: true,
    browser: ["Ubuntu", "Chrome", "122.0"],
    markOnlineOnConnect: true,     // evitar “en pausa”
    keepAliveIntervalMs: 30000,    // heartbeat
    emitOwnEvents: true,           // emits para propios envíos/acks
  });

  // Mantener presencia “available”
  setInterval(() => {
    try { sock.sendPresenceUpdate("available"); } catch {}
  }, 30000);

  // Vincular store para que /chats funcione
  store.bind(sock.ev);

  sock.ev.process(async (events) => {
    // Conexión / QR
    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];
      console.log("[conn.update]", {
        connection,
        hasQR: !!qr,
        code: lastDisconnect?.error?.output?.statusCode,
      });

      if (qr) {
        latestQR = qr;
        try { fs.writeFileSync(QR_FILE, JSON.stringify({ qr }), "utf8"); } catch {}
        broadcast("qr", { qr: true }); // notificación de QR nuevo
      }

      if (connection === "open") {
        latestQR = null;
        broadcast("ready", { user: sock.user });
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) startSock();
      }
    }

    if (events["creds.update"]) await saveCreds();

    // Chats
    if (events["chats.set"]) {
      const { chats, isLatest } = events["chats.set"];
      console.log("[chats.set]", chats?.length, "isLatest:", isLatest);
      broadcast("chats.set", { chats, isLatest });
    }
    if (events["chats.upsert"]) {
      const { chats } = events["chats.upsert"];
      broadcast("chats.upsert", { chats });
    }
    if (events["chats.update"]) {
      const { updates } = events["chats.update"];
      broadcast("chats.update", { updates });
    }

    // Mensajes
    if (events["messages.upsert"]) {
      const { type, messages } = events["messages.upsert"];
      console.log("[messages.upsert]", type, "count:", messages?.length);
      broadcast("messages", { type, messages });
    }
    if (events["messages.update"]) {
      console.log("[messages.update]", events["messages.update"]?.length || 0);
      broadcast("messages.update", events["messages.update"]);
    }
  });
}

// ---------- Rutas ----------

// QR como data URL
app.get("/session/qr", async (_req, res) => {
  try {
    const qrText = latestQR
      ? latestQR
      : (fs.existsSync(QR_FILE) ? JSON.parse(fs.readFileSync(QR_FILE, "utf8")).qr : null);

    if (!qrText) return res.json({ qr: null });

    const dataUrl = await QRCode.toDataURL(qrText);
    return res.json({ qr: dataUrl, ts: Date.now() });
  } catch {
    return res.json({ qr: null });
  }
});

// Estado
app.get("/session/status", (_req, res) => {
  res.json({ connected: !!(sock && sock.user), user: sock?.user || null });
});

// Lista de chats desde el store
app.get("/chats", (_req, res) => {
  try {
    const chats = store.chats.all();
    res.json({ count: chats.length, chats });
  } catch {
    res.json({ count: 0, chats: [] });
  }
});

// Historial (paginación hacia atrás con cursorId)
app.get("/messages", async (req, res) => {
  const { jid, pageSize, cursorId } = req.query;
  if (!jid) return res.status(400).json({ error: "jid required" });
  const limit = Math.min(parseInt(pageSize || "25", 10), 100);

  try {
    const cursor = cursorId ? { id: String(cursorId), fromMe: false, remoteJid: String(jid) } : null;
    const msgs = await sock.fetchMessagesFromWA(String(jid), limit, { cursor });
    res.json({
      jid,
      messages: msgs,
      nextCursorId: msgs.length ? msgs[0].key.id : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Enviar mensaje + eco a SSE
app.post("/messages/send", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to & text required" });

  try {
    const jid = jidNormalizedUser(to);
    const sent = await sock.sendMessage(jid, { text });

    broadcast("messages", {
      type: "sent",
      messages: [{ id: sent.key.id, jid, fromMe: true, text, ts: Math.floor(Date.now()/1000) }],
    });

    res.json({ ok: true, id: sent.key.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// SSE en vivo
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  });

  // saludo inmediato
  res.write(`event: hello\ndata: ${JSON.stringify({ connected: !!sock?.user })}\n\n`);

  // keep-alive cada 25s
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: "ok"\n\n`); } catch {}
  }, 25000);

  sseClients.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// “Despertar” presencia (debug)
app.get("/debug/poke", async (_req, res) => {
  try {
    await sock.sendPresenceUpdate("available");
    res.json({ ok: true, connected: !!sock?.user });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Boot ----------
app.listen(PORT, () => {
  console.log(`Baileys microservice on :${PORT}`);
  startSock().catch((err) => {
    console.error("Failed to start Baileys", err);
    process.exit(1);
  });
});
