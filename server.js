// server.js (ESM)

import express from "express";
import cors from "cors";
import pino from "pino";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import QRCode from "qrcode";

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidDecode,
  Browsers,
} from "@whiskeysockets/baileys";

// --- Baileys Store: import resiliente (Store.js vs store.js) ---
let makeInMemoryStore;
try {
  ({ makeInMemoryStore } = await import("@whiskeysockets/baileys/lib/Store.js"));
} catch {
  ({ makeInMemoryStore } = await import("@whiskeysockets/baileys/lib/store.js"));
}

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // ej: "Nicolasperes00*!"
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(__dirname, "auth");

// ---------- Infra ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false,
  })
);

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Memoria de runtime
/** @typedef {{ sock:any, store:any, state:any, saveCreds:Function, connected:boolean, lastQr:string|null }} Session */
const sessions = new Map(); // sessionId => Session

// ---------- Helpers ----------
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || "";
  if (!API_KEY) return res.status(500).json({ error: "API key not configured" });
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  return next();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function fail(res, code, err) {
  logger.error({ err }, "Request error");
  return res.status(code).json({ error: String(err?.message || err) });
}

function jidToHuman(jid) {
  try {
    const d = jidDecode(jid);
    if (!d?.user) return jid;
    return `${d.user}${d.server ? "@" + d.server : ""}`;
  } catch {
    return jid;
  }
}

// “Poblar” store con algunos chats/mensajes
async function softRefreshChats(sessionId, limit = 50) {
  const s = sessions.get(sessionId);
  if (!s?.sock) return;

  try {
    // Llamada “suave” que acostumbra a poblar la store.
    await s.sock.ws?.sendRawMessage?.(
      JSON.stringify({ tag: "query", content: "chats", limit })
    );
  } catch (e) {
    logger.warn({ e }, "softRefreshChats ws.sendRawMessage failed (non-fatal)");
  }
}

// Force refresh: usa la API para pedir la lista
async function forceLoadChats(sessionId, limit = 200) {
  const s = sessions.get(sessionId);
  if (!s?.sock) return;
  try {
    await s.sock?.fetchPrivacySettings?.(); // innocua
    // No hay API pública “fetchChats”; nos apoyamos en la store y/o
    // en el efecto de las notificaciones de history.
    await softRefreshChats(sessionId, limit);
  } catch (e) {
    logger.warn({ e }, "forceLoadChats failed (non-fatal)");
  }
}

// ---------- Core: start socket ----------
async function startSession(sessionId) {
  await ensureDir(AUTH_DIR);
  const sessionDir = path.join(AUTH_DIR, sessionId);
  await ensureDir(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const store = makeInMemoryStore({ logger });

  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.appropriate("Veroz/Service"),
    syncFullHistory: false, // reduce carga
    logger,
  });

  store.bind(sock.ev);

  const s = {
    sock,
    store,
    state,
    saveCreds,
    connected: false,
    lastQr: null,
  };
  sessions.set(sessionId, s);

  // Eventos
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    // si quieres emitir por SSE, el stream ya lo maneja abajo
  });

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      s.lastQr = qr;
    }
    if (connection === "open") {
      s.connected = true;
      logger.info({ sessionId }, "WA connected");
    } else if (connection === "close") {
      s.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.code;
      if (code === DisconnectReason.loggedOut) {
        logger.warn({ sessionId }, "Logged out, clearing session");
        sessions.delete(sessionId);
      } else {
        logger.warn({ sessionId, code }, "Connection closed");
      }
    }
  });

  // “Despierte” la store
  setTimeout(() => softRefreshChats(sessionId, 50), 2000);

  return s;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

// ---------- Endpoints ----------

// Health
app.get("/", (req, res) => ok(res, { service: "baileys-microservice" }));

// Crear / recargar sesión
app.post("/sessions", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });

    let s = getSession(sessionId);
    if (!s) {
      s = await startSession(sessionId);
    }
    return ok(res, { sessionId });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// Estado
app.get("/sessions/:id/status", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const s = getSession(id);
    if (!s) return res.status(400).json({ error: "Session not found" });

    return ok(res, {
      connected: !!s.connected,
      me: s.sock?.user || null,
    });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// QR
app.get("/sessions/:id/qr.png", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    let s = getSession(id);
    if (!s) s = await startSession(id);

    if (s.connected) {
      // Ya conectado: no hay QR
      res.type("text/plain").status(200).send("Already connected");
      return;
    }
    if (!s.lastQr) {
      return res.status(404).send("QR not ready");
    }
    const dataUrl = await QRCode.toDataURL(s.lastQr, { margin: 1, scale: 6 });
    const base64 = dataUrl.split(",")[1];
    const buf = Buffer.from(base64, "base64");

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buf.length);
    res.status(200).send(buf);
  } catch (e) {
    fail(res, 500, e);
  }
});

// Listar chats (opcional force y limit)
app.get("/sessions/:id/chats", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { force, limit } = req.query;
    const s = getSession(id);
    if (!s) return res.status(400).json({ error: "Session not found" });

    const lim = Math.min(Number(limit) || 50, 500);

    if (String(force) === "1") {
      await forceLoadChats(id, lim);
      // pequeña espera para permitir poblar la store
      await new Promise((r) => setTimeout(r, 800));
    }

    const chatsArr = s.store?.chats?.all() || [];
    // Normaliza mínimo: id (jid) y nombre pushName si está
    const data = chatsArr.map((c) => ({
      id: c.id,
      name: c.name || c.subject || jidToHuman(c.id),
      unreadCount: c.unreadCount || 0,
    }));

    return ok(res, { chats: data });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// Listar mensajes de un chat (usar ?jid=... url-encoded)
app.get("/sessions/:id/messages", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: "Missing 'jid' query param" });

    const s = getSession(id);
    if (!s) return res.status(400).json({ error: "Session not found" });

    const msgs = s.store?.messages?.get(jid) || [];
    // Normaliza un poco la estructura
    const mapped = msgs.map((m) => {
      const content = m.message?.conversation
        ?? m.message?.extendedTextMessage?.text
        ?? m.message?.imageMessage
        ?? m.message?.videoMessage
        ?? m.message?.buttonsResponseMessage
        ?? m.message?.templateButtonReplyMessage
        ?? m.message?.audioMessage
        ?? null;

      return {
        key: m.key,
        pushName: m.pushName,
        messageTimestamp: m.messageTimestamp,
        fromMe: m.key?.fromMe || false,
        status: m.status ?? null,
        message: content,
      };
    });

    return ok(res, { messages: mapped });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// Enviar mensaje de texto
app.post("/sessions/:id/send", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });

    // Validación simple de JID
    if (!/@s\.whatsapp\.net$|@g\.us$/.test(to)) {
      return res.status(400).json({
        error: "Invalid jid. For individuals use <E164>@s.whatsapp.net",
      });
    }

    const s = getSession(id);
    if (!s || !s.connected) {
      return res.status(400).json({ error: "Not connected. Create session and scan QR." });
    }

    const r = await s.sock.sendMessage(to, { text });
    return ok(res, { id: r.key?.id || null });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// SSE: stream en vivo
app.get("/sessions/:id/stream", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const s = getSession(id);
    if (!s) return res.status(400).json({ error: "Session not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Marca de listo
    send("ready", { ts: Date.now() });

    // Suscripciones
    const unsub = [];

    unsub.push(
      s.sock.ev.on("messages.upsert", (payload) => {
        send("messages.upsert", { sessionId: id, payload, ts: Date.now() });
      })
    );
    unsub.push(
      s.sock.ev.on("chats.update", (payload) => {
        send("chats.update", { sessionId: id, payload, ts: Date.now() });
      })
    );
    unsub.push(
      s.sock.ev.on("creds.update", (payload) => {
        send("creds.update", { sessionId: id, payload, ts: Date.now() });
      })
    );
    unsub.push(
      s.sock.ev.on("connection.update", (payload) => {
        send("connection.update", { sessionId: id, payload, ts: Date.now() });
      })
    );

    // Ping keep-alive
    const ping = setInterval(() => send("ping", { ts: Date.now() }), 25000);

    req.on("close", () => {
      try {
        clearInterval(ping);
        unsub.forEach((u) => u && typeof u === "function" && u());
      } catch {}
      res.end();
    });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// Borrar sesión (opcional)
app.delete("/sessions/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const s = getSession(id);
    if (s) {
      try { await s.sock.logout?.(); } catch {}
      sessions.delete(id);
    }
    // limpiar auth
    const dir = path.join(AUTH_DIR, id);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    return ok(res, { cleared: true });
  } catch (e) {
    return fail(res, 500, e);
  }
});

// ---------- Start ----------
app.listen(PORT, async () => {
  await ensureDir(AUTH_DIR);
  logger.info(`Baileys microservice running on ${PORT}`);
});
