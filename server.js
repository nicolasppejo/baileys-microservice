// server.js (ESM)
import express from "express";
import cors from "cors";
import pino from "pino";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import QRCode from "qrcode";

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  DisconnectReason
} from "@whiskeysockets/baileys";

// ---------- Config ----------

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "changeme";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = pino({ level: "info" });
const app = express();

app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false
  })
);

// API key guard
app.use((req, res, next) => {
  const key = req.header("x-api-key");
  if (!API_KEY) return res.status(500).json({ error: "Missing API_KEY env" });
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------- Sesiones en memoria ----------

/**
 * sessions: Map<sessionId, {
 *   sock,
 *   store,
 *   state,
 *   startPromise,
 *   lastQr,                 // string (raw) del último QR
 *   lastQrPng,              // Buffer PNG
 *   connected: boolean,
 *   sseClients: Set<res>,   // conexiones SSE de ese sessionId
 * }>
 */
const sessions = new Map();

// util FS
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function removeDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

// ---------- Helper: crear/iniciar sesión ----------

async function startSession(sessionId) {
  if (sessions.get(sessionId)?.sock) {
    // ya existe y está iniciada
    return sessions.get(sessionId);
  }

  // evita doble arranque
  if (sessions.get(sessionId)?.startPromise) {
    return sessions.get(sessionId).startPromise;
  }

  const startPromise = (async () => {
    const authDir = path.join(__dirname, "auth", sessionId);
    await ensureDir(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const store = makeInMemoryStore({ logger: log });

    const { version } = await fetchLatestBaileysVersion();
    log.info({ version }, "Using WA Web version");

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      version,
      browser: ["Bolt", "Chrome", "121.0"],
      logger: log
    });

    store.bind(sock.ev);

    const sess = {
      sock,
      store,
      state,
      startPromise: null,
      lastQr: null,
      lastQrPng: null,
      connected: false,
      sseClients: new Set()
    };

    sessions.set(sessionId, sess);

    // Eventos
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        sess.lastQr = qr;
        try {
          sess.lastQrPng = await QRCode.toBuffer(qr, { width: 320 });
        } catch (e) {
          log.error({ err: e }, "QR png generation failed");
          sess.lastQrPng = null;
        }
        pushSse(sessionId, "qr.update", { hasQr: true });
      }

      if (connection === "open") {
        sess.connected = true;
        log.info({ sessionId }, "WA connection opened");
        pushSse(sessionId, "connection.update", { connected: true });
      } else if (connection === "close") {
        sess.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        log.warn({ sessionId, code }, "WA connection closed");
        pushSse(sessionId, "connection.update", { connected: false });

        // Reconnect si no es logout explícito
        if (code && code !== DisconnectReason.loggedOut) {
          log.info({ sessionId }, "Trying to reconnect...");
          setTimeout(() => startSession(sessionId).catch(() => {}), 2000);
        }
      }
    });

    // Reenvía eventos de mensajes/chats a SSE
    sock.ev.on("messages.upsert", (payload) => {
      pushSse(sessionId, "messages.upsert", payload);
    });
    sock.ev.on("chats.upsert", (payload) => {
      pushSse(sessionId, "chats.upsert", payload);
    });
    sock.ev.on("chats.update", (payload) => {
      pushSse(sessionId, "chats.update", payload);
    });
    sock.ev.on("creds.update", () => {
      pushSse(sessionId, "creds.update", {});
    });

    return sess;
  })();

  sessions.set(sessionId, { startPromise });
  const sess = await startPromise;
  return sess;
}

// ---------- SSE helper ----------

function pushSse(sessionId, event, data) {
  const sess = sessions.get(sessionId);
  if (!sess?.sseClients?.size) return;
  const payload = typeof data === "string" ? data : JSON.stringify({ sessionId, payload: data, ts: Date.now() });
  for (const res of sess.sseClients) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload}\n\n`);
  }
}

// ---------- Rutas ----------

// Salud
app.get("/", (req, res) => {
  res.json({ ok: true, service: "baileys-microservice" });
});

// Crear o (re)cargar sesión
app.post("/sessions", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });

    const sess = await startSession(sessionId);
    res.json({ ok: true, sessionId });
  } catch (e) {
    log.error({ err: e }, "create session error");
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Estado
app.get("/sessions/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const sess = sessions.get(id);
    if (!sess?.sock) return res.json({ ok: true, connected: false, me: null });

    res.json({
      ok: true,
      connected: !!sess.connected,
      me: sess.sock?.user || null
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// QR como PNG
app.get("/sessions/:id/qr.png", async (req, res) => {
  try {
    const { id } = req.params;
    const sess = sessions.get(id);
    if (!sess) return res.status(404).send("Session not found");

    // Si no está arrancada, arráncala (para emitir QR)
    if (!sess.sock) await startSession(id);

    if (!sessions.get(id)?.lastQrPng) {
      return res.status(404).send("QR not ready");
    }

    res.setHeader("Content-Type", "image/png");
    res.send(sessions.get(id).lastQrPng);
  } catch (e) {
    res.status(500).send("QR error");
  }
});

// Lista de chats
app.get("/sessions/:id/chats", async (req, res) => {
  try {
    const { id } = req.params;
    const force = req.query.force === "1" || req.query.force === "true";
    const limit = Number(req.query.limit || 200);

    const sess = sessions.get(id);
    if (!sess?.sock) return res.status(404).json({ error: "Session not found" });

    // Si quieres forzar refresco (primera vez, etc.)
    if (force) {
      try {
        // cargar algo del historial ayuda a poblar el store
        await sess.sock.presenceSubscribe(sess.sock.user?.id);
      } catch {}
    }

    // store.chats.all() devuelve { id, name, ... } si ya se pobló
    const all = sess.store?.chats?.all?.() || [];
    res.json({ ok: true, chats: all.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Lista de mensajes de un chat (usar jid URL-encoded)
app.get("/sessions/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    let { jid, count } = req.query;
    if (!jid) return res.status(400).json({ error: "Missing 'jid' query param" });

    jid = decodeURIComponent(jid);
    count = Number(count || 50);

    const sess = sessions.get(id);
    if (!sess?.sock) return res.status(404).json({ error: "Session not found" });

    // intenta store primero
    const fromStore = sess.store?.messages?.[jid];
    if (fromStore?.array?.length) {
      return res.json({ ok: true, messages: fromStore.array.slice(-count) });
    }

    // si no hay en store, pide a WhatsApp
    const msgs = await sess.sock.loadMessages(jid, count);
    res.json({ ok: true, messages: msgs || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Enviar mensaje
app.post("/sessions/:id/send", async (req, res) => {
  try {
    const { id } = req.params;
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });

    // Normaliza JID para individuos: E164@s.whatsapp.net
    let jid = to;
    if (!/@g\.us$/.test(jid) && !/@s\.whatsapp\.net$/.test(jid)) {
      // e.g. 57321...  => 57321...@s.whatsapp.net
      jid = `${to}@s.whatsapp.net`;
    }

    const sess = sessions.get(id);
    if (!sess?.sock || !sess.connected) return res.status(400).json({ error: "Not connected" });

    const r = await sess.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r?.key?.id || null });
  } catch (e) {
    log.error({ err: e }, "send error");
    res.status(500).json({ error: String(e.message || e) });
  }
});

// SSE en vivo
app.get("/sessions/:id/stream", async (req, res) => {
  try {
    const { id } = req.params;
    const sess = sessions.get(id) || (await startSession(id));

    // cabeceras SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // conexión abierta
    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);

    sess.sseClients.add(res);

    req.on("close", () => {
      sess.sseClients.delete(res);
    });
  } catch (e) {
    res.status(500).end();
  }
});

// Borrar sesión (logout + borrar auth)
app.delete("/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sess = sessions.get(id);
    if (sess?.sock) {
      try { await sess.sock.logout(); } catch {}
      try { sess.sock.end?.(); } catch {}
    }
    sessions.delete(id);

    const authDir = path.join(__dirname, "auth", id);
    await removeDir(authDir);

    res.json({ ok: true, sessionId: id, deleted: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Arranque ----------
app.listen(PORT, () => {
  log.info(`Baileys microservice running on ${PORT}`);
});
