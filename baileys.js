// baileys.js — ESM, robusto para v6.6.0
import * as baileys from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import fs from "fs";

const {
  default: _makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = baileys;

// normaliza default para ESM/CJS
const makeWASocket =
  typeof _makeWASocket === "function"
    ? _makeWASocket
    : _makeWASocket?.default ?? _makeWASocket;

export async function startBaileys(onQr, onSock, authPath = "./auth") {
  // carga/crea estado persistente
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" });

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["Railway", "Chrome", "124.0"],
    logger,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
  });

  // guarda credenciales cuando cambien
  sock.ev.on("creds.update", saveCreds);

  // conexión / QR / reconexión
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // 🔑 ¡EMITIR QR!
    if (qr && onQr) {
      try { onQr(qr); } catch (e) { console.error("[onQr error]", e); }
    }

    if (connection === "open") {
      console.log("WhatsApp connection opened ✅");
      try { onSock && onSock(sock); } catch (e) { console.error("[onSock error]", e); }
    }

    if (connection === "close") {
      // determinar motivo
      let code = 0;
      if (lastDisconnect?.error instanceof Boom) {
        code = lastDisconnect.error.output?.statusCode ?? 0;
      } else {
        code = lastDisconnect?.error?.output?.statusCode
          ?? lastDisconnect?.error?.statusCode
          ?? 0;
      }

      const loggedOut = code === DisconnectReason.loggedOut || code === 401;
      console.warn("Connection closed ❌ code:", code, loggedOut ? "(logged out)" : "");

      if (loggedOut) {
        // limpia credenciales para forzar QR limpio en próximo arranque
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
        console.warn("[baileys] Logged out → removed authPath. No auto-reconnect.");
        return;
      }

      // reconexión para caídas transitorias
      setTimeout(() => {
        console.warn("[baileys] Reconnecting...");
        startBaileys(onQr, onSock, authPath).catch((e) =>
          console.error("[baileys] Reconnect error:", e)
        );
      }, 2000);
    }
  });

  // (opcionales) logs útiles
  sock.ev.on("chats.set", ({ chats }) => console.log("[chats.set]", chats?.length || 0));
  sock.ev.on("messages.upsert", ({ messages, type }) =>
    console.log("[messages.upsert]", type, messages?.length || 0)
  );

  return sock;
}
