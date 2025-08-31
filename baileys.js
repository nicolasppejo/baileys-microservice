import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import fs from "fs";

export async function startBaileys(onQr, onSock, authPath = "./auth") {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: "silent" }); // << puedes usar "info"/"warn"

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: ["Railway", "Chrome", "124.0"],
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && onQr) onQr(qr);
    if (connection === "open") {
      console.log("WhatsApp connection opened ✅");
      onSock && onSock(sock);
    }
    if (connection === "close") {
      const code =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : 0;
      console.log("Connection closed ❌ code:", code);

      const loggedOut = code === DisconnectReason.loggedOut || code === 401;
      if (loggedOut) {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.warn("[baileys] Logged out → removed authPath");
        return;
      }

      // reconectar si no es logout
      setTimeout(() => {
        console.warn("[baileys] reconnecting...");
        startBaileys(onQr, onSock, authPath);
      }, 2000);
    }
  });

  return sock;
}
