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
  DisconnectReason,
  jidDecode,
  Browsers,
} from "@whiskeysockets/baileys";

// 👇 Import correcto (en Linux es case-sensitive)
import { makeInMemoryStore } from "@whiskeysockets/baileys/lib/Store.js";

/* -------------------------- Configuración básica ------------------------- */

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY; // ej: "Nicolasperes00*!"
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(","),
  })
);

// Middleware API Key (excepto health)
app.use((req, res, next) => {
  if (req.path === "/") return next();
  if (!API_KEY) {
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing API_KEY env" });
  }
  const k = req.header("x-api-key");
  if (!k || k !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Health
app.get("/", (_req, res) => res.json({ ok: true, service: "baileys-microservice" }));

/* --------------------------------- Estado -------------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_ROOT = path.join(__dirname, "auth");

// Mapas por sesión
const sessions = new Map(); // sessionId -> sock
const stores = new Map();   // sessionId -> store
const lastQR = new Map();   // sessionId -> string (data del QR)
const sseClients = new Map(); // sessionId -> Set(res)

/* ------------------------- Utilidades / helpers -------------------------- */

const logger = pino({ level: "info" });

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

function toDataURItoBuffer(dataURI) {
  const base64 = dataURI.split(",")[1];
  return Buffer.from(base64, "base64");
}

function broadcast(sessionId, event, payload) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const line = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {}
  }
}

function sseKeepAlive(sessionId) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const line = `event: keepalive\n` + `data: {"ts":${Date.now()}}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {}
  }
}

/* --------------------------- Crear / Obtener sock ------------------------ */

async function startSession(sessionId) {
  const authDir = path.join(AUTH_ROOT, sessionId);
  await ensureDir(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const store = makeInMemoryStore({ logger });
  stores.set(sessionId, store);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  store.bind(sock.ev);
  sessions.set(sessionId, sock);

  // Eventos de conexión
  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];

      if (qr) {
        lastQR.set(sessionId, qr);
        broadcast(sessionId, "qr.update", { sessionId, ts: Date.now() });
      }

      if (connection === "open") {
        logger.info({ sessionId }, "WA connected");
        broadcast(sessionId, "ready", { ts: Date.now() });
      }

      if (connection === "close") {
        const reason =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.status ||
          lastDisconnect?.error?.code;

        logger.warn({ sessionId, reason }, "WA disconnected");

        if (reason === DisconnectReason.loggedOut) {
          // limpie auth; pedirá nuevo QR
          try {
            await fs.rm(authDir, { recursive: true, force: true });
          } catch {}
          lastQR.delete(sessionId);
        }

        sessions.delete(sessionId);
        stores.delete(sessionId);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      broadcast(sessionId, "creds.update", { ts: Date.now() });
    }

    if (events["messages.upsert"]) {
      const { messages } = events["messages.upsert"];
      // Notificación ligera (para UI). La carga grande la pide la UI al endpoint /messages
      broadcast(sessionId, "messages.upsert", {
        sessionId,
        payload: { type: "notify", count: messages?.length || 0 },
        ts: Date.now(),
      });
    }

    if (events["chats.upsert"] || events["chats.update"]) {
      broadcast(sessionId, "chats.update", {
        sessionId,
        payload: { count: 1 },
        ts: Date.now(),
      });
    }
  });

  return sock;
}

async function getSession(sessionId) {
  let sock = sessions.get(sessionId);
  if (sock) return sock;
  sock = await startSession(sessionId);
  return sock;
}

/* -------------------------------- Endpoints ------------------------------ */

/**
 * POST /sessions
 * body: { "sessionId": "cliente-123" }
 * Crea o rehidrata una sesión (dispara QR si no hay auth).
 */
app.post("/sessions", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    await getSession(sessionId);
    return res.json({ ok: true, sessionId });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * GET /sessions/:id/status
 * Devuelve si está conectado y el jid propio si aplica.
 */
app.get("/sessions/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const sock = sessions.get(id);
    const connected = !!sock?.user;
    return res.json({
      connected,
      me: connected ? { id: sock.user?.id } : null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * GET /sessions/:id/qr.png
 * Devuelve el último QR capturado para esa sesión en PNG.
 */
app.get("/sessions/:id/qr.png", async (req, res) => {
  const id = req.params.id;
  const qr = lastQR.get(id);
  if (!qr) return res.status(404).send("QR not ready");
  try {
    const dataURI = await QRCode.toDataURL(qr, { margin: 1, width: 256 });
    const buf = toDataURItoBuffer(dataURI);
    res.setHeader("Content-Type", "image/png");
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * GET /sessions/:id/chats
 * Lista chats del store. (param: ?force=1 para forzar sync ligero)
 * opcional ?limit=200 (sólo para UI; no corta el store real)
 */
app.get("/sessions/:id/chats", async (req, res) => {
  try {
    const id = req.params.id;
    const limit = Number(req.query.limit || 0);
    const _force = String(req.query.force || "0") === "1";

    const store = stores.get(id);
    if (!store) return res.json({ ok: true, chats: [] });

    // El store guarda en store.chats (map). Lo exponemos como array simple.
    const all = store.chats ? Array.from(store.chats.values()) : [];
    const out = limit > 0 ? all.slice(0, limit) : all;

    // “force” notifica a la UI que hubo petición explícita
    if (_force) {
      broadcast(id, "chats.update", { sessionId: id, payload: { count: out.length } });
    }

    return res.json({ ok: true, chats: out });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * GET /sessions/:id/messages?jid=<waId@s.whatsapp.net>&limit=50
 * Retorna mensajes de ese chat desde el store (y si no hay, intenta cargar algunos).
 */
app.get("/sessions/:id/messages", async (req, res) => {
  try {
    const id = req.params.id;
    const jidRaw = req.query.jid;
    const limit = Number(req.query.limit || 50);
    if (!jidRaw) return res.status(400).json({ error: "Missing jid" });

    const jid = decodeURIComponent(jidRaw);
    const store = stores.get(id);
    const sock = sessions.get(id);

    if (!store || !sock) return res.json({ ok: true, messages: [] });

    // Cargar desde el store
    let msgs = await store.loadMessages(jid, limit);
    if (!msgs || msgs.length === 0) {
      // Si no hay en memoria, intenta pedir un poco al server
      try {
        const page = await sock?.loadMessages(jid, limit);
        // store.loadMessages ya las indexa vía bind(ev),
        // pero devolvemos lo obtenido para no esperar el rebind.
        msgs = page || [];
      } catch {
        msgs = [];
      }
    }

    return res.json({ ok: true, messages: msgs });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * POST /sessions/:id/send
 * body: { "to": "573xxxx@s.whatsapp.net", "text": "Hola" }
 */
app.post("/sessions/:id/send", async (req, res) => {
  try {
    const id = req.params.id;
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });

    const sock = sessions.get(id);
    if (!sock || !sock.user) {
      return res.status(400).json({ error: "Session not ready" });
    }

    const r = await sock.sendMessage(to, { text });
    return res.json({ ok: true, id: r?.key?.id || null });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * GET /sessions/:id/stream
 * Server-Sent Events: empuja eventos live (ready, chats.update, messages.upsert, creds.update, keepalive).
 */
app.get("/sessions/:id/stream", async (req, res) => {
  const id = req.params.id;

  // Iniciar headers SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // para proxies
  });

  // (re)crear sesión si no existe -> dispara QR si hace falta
  try {
    await getSession(id);
  } catch (e) {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
  }

  // registrar cliente
  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);

  // primer ping
  res.write(`event: ready\n`);
  res.write(`data: {"ts":${Date.now()}}\n\n`);

  // keepalive
  const ka = setInterval(() => sseKeepAlive(id), 25000);

  req.on("close", () => {
    clearInterval(ka);
    const set = sseClients.get(id);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(id);
    }
  });
});

/* --------------------------------- Arranque ------------------------------ */

await ensureDir(AUTH_ROOT);

app.listen(PORT, () => {
  logger.info(`Baileys microservice running on ${PORT}`);
});
