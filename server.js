import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { startBaileys } from "./baileys.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

const app = express();
app.use(bodyParser.json());

// ====== ENV ======
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";

// ====== CORS ======
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// ====== API KEY middleware (solo POST/DELETE necesitan llave) ======
app.use((req, res, next) => {
  if (req.method === "POST" || req.method === "DELETE") {
    const key = req.headers["x-api-key"];
    if (!API_KEY || key === API_KEY) return next();
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
});

// ====== STATE ======
/**
 * sessions: Map<sessionId, {
 *   sock,
 *   lastQrDataUrl,
 *   webhookUrl,
 *   chats: Map<jid, chat>,
 *   messages: Map<jid, Message[]>,
 *   sseClients: Set<ServerResponse>
 * }>
 */
const sessions = new Map();

function authDir(sessionId) {
  return path.join("./auth", sessionId);
}

function ensureSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Session not found");
  return s;
}

// Enviar evento a webhook + SSE
async function pushEvent(sessionId, type, payload) {
  const s = sessions.get(sessionId);
  if (!s) return;

  // A) Webhook (opcional)
  if (s.webhookUrl) {
    try {
      await fetch(s.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          type,
          payload,
          ts: Date.now(),
        }),
      });
    } catch (_) {}
  }

  // B) SSE (en vivo al navegador)
  if (s.sseClients.size) {
    const frame = `event: ${type}\ndata: ${JSON.stringify({
      sessionId,
      payload,
      ts: Date.now(),
    })}\n\n`;
    for (const res of s.sseClients) {
      try {
        res.write(frame);
      } catch (_) {}
    }
  }
}

// ====== HEALTH ======
app.get("/", (_, res) =>
  res.json({ ok: true, service: "baileys-microservice" })
);

// ====== CREATE SESSION (QR) ======
app.post("/sessions", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    // prepara carpeta y estado
    fs.mkdirSync(authDir(sessionId), { recursive: true });

    const state = {
      sock: null,
      lastQrDataUrl: null,
      webhookUrl: null,
      chats: new Map(),
      messages: new Map(),
      sseClients: new Set(),
    };
    sessions.set(sessionId, state);

    // arranca Baileys
    const sock = await startBaileys(
      async (qr) => {
        state.lastQrDataUrl = await QRCode.toDataURL(qr);
        pushEvent(sessionId, "qr", { png: true });
      },
      (s) => {
        state.sock = s;

        // --- Eventos de Baileys para historial y vivo ---
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

        s.ev.on("messages.upsert", ({ messages, type }) => {
          for (const m of messages) {
            const jid = m.key.remoteJid;
            if (!jid) continue;
            const arr = state.messages.get(jid) || [];
            arr.unshift(m); // más nuevos primero
            if (arr.length > 300) arr.pop(); // corta memoria
            state.messages.set(jid, arr);
          }
          pushEvent(sessionId, "messages.upsert", {
            type,
            count: messages.length,
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
    return res.json({ ok: true, sessionId });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== STATUS ======
app.get("/sessions/:id/status", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ connected: false });
  const connected = !!(s.sock && s.sock.user);
  return res.json({ connected, me: s.sock?.user || null });
});

// ====== QR PNG ======
app.get("/sessions/:id/qr.png", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.lastQrDataUrl) return res.status(404).send("QR not ready");
  const base64 = s.lastQrDataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.send(Buffer.from(base64, "base64"));
});

// ====== SEND MESSAGE ======
app.post("/sessions/:id/send", async (req, res) => {
  try {
    const s = ensureSession(req.params.id);
    if (!s.sock) return res.status(400).json({ error: "Session not found" });
    if (!s.sock.user) return res.status(400).json({ error: "Not connected" });

    let { to, text } = req.body || {};
    if (!to || !text)
      return res.status(400).json({ error: "Missing 'to' or 'text'" });

    if (!to.includes("@")) to = `${to}@s.whatsapp.net`;
    const jid = jidNormalizedUser(to);

    // opcional: presencia antes de enviar
    try { await s.sock.presenceSubscribe?.(jid); } catch (_) {}
    const r = await s.sock.sendMessage(jid, { text });

    // actualiza cache local
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
    return res.json({ ok: true, id: msgId });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== CHATS LIST ======
app.get("/sessions/:id/chats", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(400).json({ error: "Session not found" });

  const list = Array.from(s.chats.values()).sort(
    (a, b) =>
      (b?.conversationTimestamp || 0) - (a?.conversationTimestamp || 0)
  );

  // limit simple
  const limit = Number(req.query.limit || 200);
  res.json({ ok: true, chats: list.slice(0, limit) });
});

// ====== MESSAGES LIST (con paginación simple) ======
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
        const cursorKey = cursor
          ? { id: cursor, fromMe: false, remoteJid: jid }
          : undefined;
        const more = await s.sock.loadMessages(jid, limit, cursorKey);
        const map = new Map();
        for (const m of [...more, ...items]) map.set(m.key.id, m);
        items = Array.from(map.values()).sort(
          (a, b) =>
            (b.messageTimestamp || 0) - (a.messageTimestamp || 0)
        );
        s.messages.set(jid, items.slice(0, 600)); // cachea un poco más
      } catch (_) {}
    }

    const page = items.slice(0, limit);
    const nextCursor = page.length ? page[page.length - 1].key.id : null;
    res.json({ ok: true, messages: page, nextCursor });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== SSE (stream en vivo) ======
app.get("/sessions/:id/stream", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(400).json({ error: "Session not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  s.sseClients.add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  req.on("close", () => {
    s.sseClients.delete(res);
  });
});

// ====== Webhook (guardar URL) — opcional ======
app.post("/sessions/:id/webhook", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(400).json({ error: "Session not found" });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });
  s.webhookUrl = url;
  return res.json({ ok: true });
});

// ====== DELETE SESSION ======
app.delete("/sessions/:id", (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (s) {
    for (const res of s.sseClients) {
      try {
        res.write(`event: close\ndata: {}\n\n`);
        res.end();
      } catch (_) {}
    }
  }
  sessions.delete(id);
  try {
    fs.rmSync(authDir(id), { recursive: true, force: true });
  } catch {}
  return res.json({ ok: true });
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Baileys microservice running on", PORT)
);
