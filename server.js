// server.js — Baileys Microservice (Railway)
// Versión sin "pino-pretty" para evitar crash por dependencia faltante.

import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import { EventEmitter } from "events";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  DisconnectReason
} from "@adiwajshing/baileys";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.set("trust proxy", 1);

// ====== CONFIG ======
const API_KEY = process.env.API_KEY || "dev-key";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PORT = Number(process.env.PORT || 3000);

// ====== MIDDLEWARE ======
app.use(
  cors({
    origin: (origin, cb) => cb(null, ALLOWED_ORIGIN === "*" ? true : origin === ALLOWED_ORIGIN),
    credentials: true,
  })
);
app.use(express.json());

// API-key guard (dejamos /stream y /qr.png sin key para iframes/imagenes)
const guard = (req, res, next) => {
  const ok = req.headers["x-api-key"] === API_KEY;
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ====== SESIONES ======
const sessions = new Map(); // { sessionId: { sock, store } }
const sseMap = new Map();   // { sessionId: EventEmitter }

const broadcast = (sessionId, event, payload) => {
  const ev = sseMap.get(sessionId);
  if (!ev) return;
  ev.emit("sse", { event, payload, ts: Date.now() });
};

const ensureSession = (sessionId) => sessions.get(sessionId);
const validJid = (to) => /@s\.whatsapp\.net$|@g\.us$/.test(to);

// ====== BAILEYS ======
async function startSession(sessionId) {
  if (sessions.get(sessionId)?.sock?.ev) return sessions.get(sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();

  const store = makeInMemoryStore({ logger: log });
  try {
    store.readFromFile(`./auth/${sessionId}/store.json`);
  } catch {}
  setInterval(() => {
    try {
      store.writeToFile(`./auth/${sessionId}/store.json`);
    } catch {}
  }, 30_000);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Veroz", "Chrome", "121.0"],
    markOnlineOnConnect: false,
    logger: log,
  });

  store.bind(sock.ev);

  // Eventos → SSE
  sock.ev.on("chats.upsert", (payload) => broadcast(sessionId, "chats.upsert", payload));
  sock.ev.on("chats.update", (payload) => broadcast(sessionId, "chats.update", payload));
  sock.ev.on("messages.upsert", (payload) => broadcast(sessionId, "messages.upsert", payload));
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    broadcast(sessionId, "creds.update", {});
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      sock.__lastQr = qr;
      broadcast(sessionId, "qr.update", { ts: Date.now() });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || "";
      log.warn({ sessionId, code, reason }, "connection closed");
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(sessionId).catch(() => {}), 1000);
      }
    } else if (connection === "open") {
      log.info({ sessionId }, "WhatsApp connected");
      broadcast(sessionId, "status", { connected: true });
    }
  });

  const ref = { sock, store };
  sessions.set(sessionId, ref);
  return ref;
}

// ====== ROUTES ======

// Ping
app.get("/", (_req, res) => res.json({ ok: true, service: "baileys-microservice" }));

// Crear/(re)cargar sesión
app.post("/sessions", guard, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    await startSession(sessionId);
    if (!sseMap.get(sessionId)) sseMap.set(sessionId, new EventEmitter());
    res.json({ ok: true, sessionId });
  } catch (e) {
    log.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Estado
app.get("/sessions/:id/status", guard, (req, res) => {
  const { id } = req.params;
  const ref = ensureSession(id);
  if (!ref?.sock) return res.json({ connected: false, me: null });
  res.json({ connected: !!ref.sock.user, me: ref.sock.user || null });
});

// QR como PNG
app.get("/sessions/:id/qr.png", async (req, res) => {
  try {
    const { id } = req.params;
    const ref = ensureSession(id);
    if (!ref?.sock) return res.status(404).send("Session not found");
    const qr = ref.sock.__lastQr;
    if (!qr) return res.status(404).send("QR not ready");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache, no-store");
    const png = await QRCode.toBuffer(qr, { margin: 1, width: 360 });
    res.end(png);
  } catch {
    res.status(500).send("QR error");
  }
});

// Listar chats
app.get("/sessions/:id/chats", guard, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const ref = ensureSession(id);
    if (!ref?.sock) return res.status(404).json({ error: "Session not found" });

    let chats = ref.store?.chats?.all?.() || [];
    chats.sort(
      (a, b) =>
        Number(b?.lastMessageRecvTimestamp || 0) -
        Number(a?.lastMessageRecvTimestamp || 0)
    );
    res.json({ ok: true, chats: chats.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Listar mensajes de un chat
app.get("/sessions/:id/messages", guard, async (req, res) => {
  try {
    const { id } = req.params;
    let { jid, limit } = req.query;
    limit = Math.min(Number(limit || 50), 200);

    const ref = ensureSession(id);
    if (!ref?.sock) return res.status(404).json({ error: "Session not found" });
    if (!jid) return res.status(400).json({ error: "Missing jid" });

    const j = decodeURIComponent(String(jid));
    let msgs = [];
    try {
      msgs = ref.store?.messages?.[j]?.array?.() || [];
    } catch {}

    if (!msgs?.length) {
      const resLoad = await ref.sock.loadMessages(j, limit);
      msgs = resLoad || [];
    }

    const out = msgs.map((m) => ({
      id: m?.key?.id,
      fromMe: m?.key?.fromMe,
      pushName: m?.pushName,
      messageTimestamp: Number(m?.messageTimestamp) || 0,
      message: m?.message,
    }));

    out.sort((a, b) => a.messageTimestamp - b.messageTimestamp);
    res.json({ ok: true, messages: out.slice(-Number(limit)) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Enviar mensaje
app.post("/sessions/:id/send", guard, async (req, res) => {
  try {
    const { id } = req.params;
    const { to, text } = req.body || {};
    const ref = ensureSession(id);
    if (!ref?.sock) return res.status(404).json({ error: "Session not found" });
    if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });

    let jid = String(to).trim();
    if (!/@s\.whatsapp\.net$|@g\.us$/.test(jid)) {
      const num = jid.replace(/\D+/g, "");
      jid = `${num}@s.whatsapp.net`;
    }
    if (!validJid(jid)) return res.status(400).json({ error: "Invalid jid" });

    const r = await ref.sock.sendMessage(jid, { text: String(text) });
    return res.json({ ok: true, id: r?.key?.id || null });
  } catch (e) {
    log.error({ err: e?.message || e }, "send error");
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// SSE en vivo
app.get("/sessions/:id/stream", async (req, res) => {
  const { id } = req.params;

  if (!ensureSession(id)) {
    try { await startSession(id); } catch {}
  }
  if (!sseMap.get(id)) sseMap.set(id, new EventEmitter());

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("ready", { ts: Date.now() });
  const hb = setInterval(() => send("ping", { ts: Date.now() }), 15000);

  const emitter = sseMap.get(id);
  const onSse = ({ event, payload, ts }) => send(event, { sessionId: id, payload, ts });

  emitter.on("sse", onSse);

  req.on("close", () => {
    clearInterval(hb);
    emitter.off("sse", onSse);
    res.end();
  });
});

// ====== START ======
app.listen(PORT, () => {
  log.info({ port: PORT }, "Baileys microservice running");
});
