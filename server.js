// server.js
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

// ====== API KEY (para POST/DELETE y endpoints sensibles) ======
const requireKey = (req, res, next) => {
  if (req.method === "GET") return next(); // GETs públicos (ajusta si quieres)
  const key = req.headers["x-api-key"];
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: "invalid api key" });
};
app.use(requireKey);

// ====== BAILEYS STATE/STORE ======
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const store = makeInMemoryStore({}); // mantiene chats, contactos y mensajes recientes
// persistimos snapshots para debug (opcional)
const STORE_FILE = path.join(__dirname, "store.json");
setInterval(() => {
  try {
    const data = {
      chats: store.chats.all(),
      contacts: store.contacts,
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}, 30_000);

let sock = null;
let authState = null;
let qrData = { qr: null, ts: 0 };

// SSE (clientes conectados para tiempo real)
const sseClients = new Set();
const broadcast = (event, payload) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* ignore */ }
  }
};

// ====== INIT WHATSAPP SOCKET ======
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    syncFullHistory: true, // intenta traer todo lo posible (WA limita por chat)
    markOnlineOnConnect: false,
    printQRInTerminal: false, // gestionamos QR nosotros
  });

  // vincular store
  store.bind(sock.ev);

  // eventos principales
  sock.ev.process(async (events) => {
    // conexión/QR
    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];
      if (qr) {
        qrData = { qr, ts: Date.now() };
        broadcast("qr", { qr }); // opcional: push QR a los clientes
      }
      if (connection === "open") {
        qrData = { qr: null, ts: 0 };
        // empujar snapshot inicial de chats cuando hay set
        const chats = store.chats.all().map(cleanChat);
        broadcast("ready", { user: sock.user, chats });
      }
      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
        if (shouldReconnect) startSock();
      }
    }

    // credenciales
    if (events["creds.update"]) await saveCreds();

    // cuando BAILEYS nos entrega el set inicial de chats
    if (events["chats.set"]) {
      const { chats } = events["chats.set"];
      broadcast("chats.set", { chats: chats.map(cleanChat) });
    }

    // updates de chats (nuevos mensajes no leídos, título, etc.)
    if (events["chats.upsert"]) {
      const { chats } = events["chats.upsert"];
      broadcast("chats.upsert", { chats: chats.map(cleanChat) });
    }
    if (events["chats.update"]) {
      const { updates } = events["chats.update"];
      broadcast("chats.update", { updates: updates.map(cleanChatUpdate) });
    }

    // llegada de mensajes (entrantes/salientes)
    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      const normalized = messages.map(cleanMessage);
      broadcast("messages", { type, messages: normalized });
    }
  });
}

// ====== HELPERS ======
const cleanChat = (c) => ({
  id: c.id,
  name: c.name || c.subject || "",
  unreadCount: c.unreadCount || 0,
  archived: !!c.archived,
  pinned: !!c.pinned,
  isGroup: c.id?.endsWith("@g.us"),
  lastMessageTimestamp: c.conversationTimestamp || c.t || 0,
});

const cleanChatUpdate = (u) => ({
  id: u.id,
  name: u.name,
  unreadCount: u.unreadCount,
  archived: u.archived,
  pinned: u.pinned,
});

const cleanMessage = (m) => {
  const jid = m.key?.remoteJid || "";
  const fromMe = !!m.key?.fromMe;
  const id = m.key?.id;
  const ts = (m.messageTimestamp || m.message?.messageContextInfo?.deviceListMetadata?.timestamp) ?? Date.now()/1000;

  // texto primario (simplificado para demo; extiéndelo para tipos media)
  let text = "";
  if (m.message?.conversation) text = m.message.conversation;
  else if (m.message?.extendedTextMessage?.text) text = m.message.extendedTextMessage.text;
  else if (m.message?.imageMessage?.caption) text = m.message.imageMessage.caption || "";
  else if (m.message?.videoMessage?.caption) text = m.message.videoMessage.caption || "";

  return { id, jid, fromMe, text, ts };
};

// ====== ENDPOINTS ======

// 1) QR actual (PNG en dataURL) — llámalo hasta que devuelva algo no nulo
app.get("/session/qr", async (req, res) => {
  if (!qrData.qr) return res.json({ qr: null });
  const dataUrl = await QRCode.toDataURL(qrData.qr);
  res.json({ qr: dataUrl, ts: qrData.ts });
});

// 2) Estado de sesión (conectado / user)
app.get("/session/status", (req, res) => {
  const connected = !!(sock && sock.user);
  res.json({ connected, user: sock?.user || null });
});

// 3) Listar chats actuales (snapshot del store)
app.get("/chats", (req, res) => {
  const chats = store.chats.all().map(cleanChat);
  res.json({ count: chats.length, chats });
});

// 4) Historial por chat con paginación (igual que Web: WA limita a lotes)
app.get("/messages", async (req, res) => {
  const { jid, pageSize, cursorId } = req.query;
  if (!jid) return res.status(400).json({ error: "jid required" });

  const limit = Math.min(parseInt(pageSize || "25", 10), 100);

  try {
    // Si tenemos cursorId, pedimos a partir de ese mensaje hacia atrás
    const cursor = cursorId ? { id: cursorId, fromMe: false, remoteJid: jid } : null;
    const msgs = await sock.fetchMessagesFromWA(jid, limit, { cursor });
    res.json({
      jid,
      messages: msgs.map(cleanMessage),
      nextCursorId: msgs.length ? msgs[0].key.id : null // siguiente página = más antiguo
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 5) Enviar mensaje
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

// 6) SSE para tiempo real (mensajes/chats sin refrescar)
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN
  });
  res.write("\n");
  sseClients.add(res);

  // al conectar, mandar snapshot básico
  res.write(`event: hello\ndata: ${JSON.stringify({ connected: !!sock?.user })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`Baileys microservice on :${PORT}`);
  startSock().catch(err => {
    console.error("Failed to start Baileys", err);
    process.exit(1);
  });
});
