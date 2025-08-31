import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger.js";
import { Boom } from "@hapi/boom";

export async function startBaileys(onQr, onSock, authPath = "./auth") {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const logger = MAIN_LOGGER.child({});

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: ["Railway", "Chrome", "121.0"]
  });

  onSock && onSock(sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && onQr) onQr(qr);
    if (connection === "open") console.log("WhatsApp connection opened ✅");
    if (connection === "close") {
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
      console.log("Connection closed ❌ code:", code);
      if (code != 401) await startBaileys(onQr, onSock, authPath);
    }
  });

  return sock;
}
