// server.js (ESM) — listo para Lovable (historial + vivo)

// === Polyfill WebCrypto (necesario en algunos runtimes) ===
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// === Imports base ===
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { fileURLToPath } from "url";
import { startBaileys } from "./baileys.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

// === Utils ruta (ESM) ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === App ===
const app = express();
app.use(bodyParser.json());

// === CORS ===
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// === API KEY (solo POST/DELETE) ===
const API_KEY = process.env.API_KEY || "";
app.use((req, res, next) => {
  if (req.method === "POST" || req.method === "DELETE") {
    const key = req.headers["x-api-key"];
    if (!API_KEY || key === API_KEY) return next();
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
});

// === STATE ===
/**
 * sessions: Map<sessionId, {
 *   sock,
 *   lastQrText,
 *   lastQrDataUrl,
 *   webhookUrl,
 *   chats: Map<jid, chat>,
 *   messages: Map<jid, Message[]>,   // más nuevos primero
 *   sseClients: Set<ServerResponse>
 * }>
 */
const sessions = new Map();

const authDir = (id) => path.join(__dirname, "auth", id);
const ensureSession = (id) => {
  const s = sessions.get(id);
  if (!s) throw new Error("Session not found");
  return s;
};

// === Push a webhook + SSE ===
async function pushEvent(sessionId, type, payload) {
  const s = sessions.get(sessionId);
  if (!s) return;

  // Webhook (opcional)
  if (s.webhookUrl) {
    try {
      await fetch(s.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, type, payload, ts: Date.now() }),
      });
    } catch (_) {}
  }

  // SSE (live)
  if (s.sseClients.size) {
    const frame =
      `event: ${type}\n` +
      `data: ${JSON.stringify({ sessionId, payload, ts: Date.now() })}\n\n`;
    for (const res of s.sseClients) {
      try { res.write(frame); } catch (_) {}
    }
  }
}

// === HEALTH ===
app.get("/", (_, res) => res.json({ ok: true, service: "baileys-microservice" }));

// === CREATE SESSION (QR) ===
app.post("/sessions", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    fs.mkdirSync(authDir(sessionId), { recursive: true });

    const state = {
      sock: null,
      lastQrText: null,
      lastQrDataUrl: null,
      webhookUrl: null,
      chats: new Map(),
      messages: new Map(),
      sseClients: new Set(),
    };
    sessions.set(sessionId, state);

    const sock = await startBaileys(
      async (qr) => {
        // Guarda texto crudo (siempre fresco) y notifica
        state.lastQrText = qr;
        pushEvent(sessionId, "qr", { png: true });
        // Si quieres cachear dataURL (no necesario):
        // QRCode.toDataURL(qr).then(url => { state.lastQrDataUrl = url; }).catch(() => {});
      },
      (s) => {
        state.sock = s;

        // ---- Listeners para cache + SSE ----
        s.ev.on("chats.set", ({ chats }) => {
          for (const c of chats) state.chats.set(c.id, c);
          pushEvent(sessionId, "chats.set", { count: chats.length });
        });

        s.ev.on("chats.upsert", (chats) => {
          for (const c of chats) state.chats.set(c.id, c);
          pushEvent(sessionId, "chats.upsert", { count: chats.length });
        });

        s.ev.on("chats.update", (updates) => {
          for (const u of updates) {
            const prev = state.chats.get(u.id) || {};
            state.chats.set(u.id, { ...prev, ...u });
          }
          pushEvent(sessionId, "chats.update", { count: updates.length });
        });

        // ✅ Enviar mensajes en el payload para evitar refetch
        s.ev.on("messages.upsert", ({ messages, type }) => {
          const jids = [];
          for (const m of messages) {
            const jid = m.key.remoteJid;
            if (!jid) continue;
            if (!jids.includes(jid)) jids.push(jid);
            const arr = state.messages.get(jid) || [];
            arr.unshift(m);
            if (arr.length > 300) arr.pop();
            state.messages.set(jid, arr);
          }

          // Compactar campos relevantes (evita payload gigante)
          const compact = messages.map((m) => ({
            key: m.key,
            messageTimestamp: m.messageTimestamp,
            message: m.message,
          }));

          pushEvent(sessionId, "messages.upsert", {
            type,
            jids,
            messages: compact,
          });
        });

        s.ev.on("messages.update", (updates) => {
          pushEvent(sessionId, "messages.update", { count: updates.length });
        });

        s.ev.on("creds.update", () => {
          pushEvent(sessionId, "creds.update", {});
        });

        s.ev.on("connection.update", ({ connection }) => {
          pushEvent(sessionId, "connection.update", { connection });
        });
      },
      authDir(sessionId)
    );

    state.sock = sock;
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// === STATUS ===
app.get("/sessions/:id/status", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ connected: false });
  const connected = !!(s.sock && s.sock.user);
  res.json({ connected, me: s.sock?.user || null });
});

// === QR PNG (sin caché + render al vuelo) ===
app.get("/sessions/:id/qr.png", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.lastQrText) return res.status(404).send("QR not ready");

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Content-Disposition", "inline; filename=qr.png");

  try {
    return QRCode.toFileStream(res, s.lastQrText, { type: "png", margin: 1, scale: 6 });
  } catch {
    return res.status(500).send("QR render error");
  }
});

// === SEND MESSAGE ===
app.post("/sessions/:id/send", async (req, res) => {
  try {
    const s = ensureSession(req.params.id);
    if (!s.sock) return res.status(400).json({ error: "Session not found" });
    if (!s.sock.user) return res.status(400).json({ error: "Not connected" });

    let { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });

    if (!to.includes("@")) to = `${to}@s.whatsapp.net`;
    const jid = jidNormalizedUser(to);

    try { await s.sock.presenceSubscribe?.(jid); } catch (_) {}
    const r = await s.sock.sendMessage(jid, { text });

    const msgId = r?.key?.id || null;
    if (msgId) {
      const arr = s.messages.get(jid) || [];
      arr.unshift({
        key: r.key,
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
      if (arr.length > 300) arr.pop();
      s.messages.set(jid, arr);
    }

    pushEvent(req.params.id, "messages.sent", { to: jid, id: msgId });
    res.json({ ok: true, id: msgId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// === CHATS LIST ===
app.get("/sessions/:id/chats", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(400).json({ error: "Session not found" });

  const list = Array.from(s.chats.values()).sort(
    (a, b) => (b?.conversationTimestamp || 0) - (a?.conversationTimestamp || 0)
  );
  const limit = Number(req.query.limit || 500);
  res.json({ ok: true, chats: list.slice(0, limit) });
});

// === MESSAGES LIST (paginación simple) ===
app.get("/sessions/:id/messages", async (req, res) => {
  try {
    const s = ensureSession(req.params.id);
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: "Missing jid" });

    const limit = Number(req.query.limit || 50);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    let items = s.messages.get(jid) || [];

    // si no hay suficientes, intenta traer más antiguos de WhatsApp
    if (items.length < limit && s.sock) {
      try {
        const cursorKey = cursor ? { id: cursor, remoteJid: jid } : undefined;
        const more = await s.sock.loadMessages(jid, limit, cursorKey);
        const map = new Map();
        for (const m of [...more, ...items]) map.set(m.key.id, m);
        items = Array.from(map.values()).sort(
          (a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)
        );
        s.messages.set(jid, items.slice(0, 600));
      } catch (_) {}
    }

    const page = items.slice(0, limit);
    const nextCursor = page.length ? page[page.length - 1].key.id : null;

    // compactar para transporte
    const compact = page.map(m => ({
      key: m.key,
      messageTimestamp: m.messageTimestamp,
      message: m.message
    }));

    res.json({ ok: true, messages: compact, nextCursor });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// === BOOTSTRAP (chats + últimos N mensajes por chat) ===
app.get("/sessions/:id/bootstrap", async (req, res) => {
  try {
    const s = ensureSession(req.params.id);
    if (!s.sock) return res.status(400).json({ error: "Session not found" });

    const maxChats = Math.min(Number(req.query.maxChats || 100), 500);
    const perChat  = Math.min(Number(req.query.perChat  || 30), 100);

    const chats = Array.from(s.chats.values())
      .sort((a,b) => (b?.conversationTimestamp||0) - (a?.conversationTimestamp||0))
      .slice(0, maxChats);

    const limit = 5; // evitar golpear demasiado a WA
    const entries = [];
    for (let i = 0; i < chats.length; i += limit) {
      const slice = chats.slice(i, i + limit);
      const batch = await Promise.all(
        slice.map(async (c) => {
          let items = s.messages.get(c.id) || [];
          if (items.length < perChat) {
            try {
              const more = await s.sock.loadMessages(c.id, perChat, undefined);
              const map = new Map();
              for (const m of [...more, ...items]) map.set(m.key.id, m);
              items = Array.from(map.values()).sort(
                (a,b) => (b.messageTimestamp||0) - (a.messageTimestamp||0)
              );
              s.messages.set(c.id, items.slice(0, 600));
            } catch {}
          }
          const compact = (items.slice(0, perChat) || []).map(m => ({
            key: m.key,
            messageTimestamp: m.messageTimestamp,
            message: m.message
          }));
          return [c.id, compact];
        })
      );
      entries.push(...batch);
    }

    const messagesByJid = Object.fromEntries(entries);
    res.json({ ok: true, chats, messagesByJid, perChat });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// === SSE (stream en vivo) ===
app.get("/sessions/:id/stream", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(400).json({ error: "Session not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  s.sseClients.add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  // keep-alive para proxies
  const ping = setIn
