// baileys.js (drop-in robusto)
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger.js";
import { Boom } from "@hapi/boom";
import fs from "fs";

export async function startBaileys(onQr, onSock, authPath = "./auth") {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const logger = MAIN_LOGGER.child({});
  const { version } = await fetchLatestBaileysVersion(); // <<< importante

  const sock = makeWASocket({
    version,                                   // <<< fija versión WA Web
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: ["Railway", "Chrome", "124.0"],
    logger, // usa el logger de Baileys; ajusta nivel si quieres: logger.level = "warn"
  });

  // listeners básicos
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && onQr) {
      try { onQr(qr); } catch (e) { console.error("[onQr error]", e); }
    }

    if (connection) console.log("[connection.update]", connection);

    if (connection === "open") {
      console.log("WhatsApp connection opened ✅");
      try { onSock && onSock(sock); } catch (e) { console.error("[onSock error]", e); }
    }

    if (connection === "close") {
      // determina motivo
      let code = 0;
      if (lastDisconnect?.error instanceof Boom) {
        code = lastDisconnect.error.output?.statusCode ?? 0;
      } else {
        // algunos entornos no devuelven Boom
        code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode ??
          0;
      }

      console.warn("Connection closed ❌ code:", code);

      const loggedOut = code === DisconnectReason.loggedOut || code === 401;
      if (loggedOut) {
        // limpieza para forzar nuevo QR en próximo arranque
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
        console.warn("[baileys] Logged out → authPath removed. No auto-reconnect.");
        return; // no reconectar automáticamente en logout
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

  // algunos logs útiles (opcionales)
  sock.ev.on("chats.set", ({ chats }) => console.log("[chats.set]", chats?.length || 0));
  sock.ev.on("messages.upsert", ({ messages, type }) =>
    console.log("[messages.upsert]", type, messages?.length || 0)
  );

  return sock;
}
