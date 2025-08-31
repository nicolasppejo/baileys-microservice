// bailey​s.js (ESM)
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

/**
 * Arranca una sesión de Baileys y configura eventos.
 * @param {(qr: string) => void} onQr - Callback para QR (string)
 * @param {(sock: any) => void} onReady - Callback cuando abre la conexión
 * @param {string} authFolder - Carpeta para guardar credenciales (por sesión)
 * @returns {Promise<any>} sock
 */
export async function startBaileys(onQr, onReady, authFolder) {
  // 1) Estado de auth (persistente por carpeta)
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // 2) Versión recomendada de WhatsApp Web
  const { version } = await fetchLatestBaileysVersion();

  // 3) Logger *** DEBE SER pino() ***
  //    Usa 'info' si quieres ver más logs en Railway; 'silent' para menos ruido.
  const logger = pino({ level: "info" });

  // 4) Crear el socket
  const sock = makeWASocket({
    version,
    auth: state,
    logger, // <— ¡Importante! No pasar console ni objetos “simples”
    browser: ["Veroz", "Chrome", "120"], // etiqueta opcional
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  // 5) Guardar credenciales en disco cuando cambian
  sock.ev.on("creds.update", saveCreds);

  // 6) Conexión / QR / Reintentos
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && onQr) onQr(qr);

    if (connection === "open") {
      onReady?.(sock);
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error &&
          new Boom(lastDisconnect.error)?.output?.statusCode !==
            DisconnectReason.loggedOut) ||
        !lastDisconnect?.error;

      if (shouldReconnect) {
        // Pequeño backoff para no ciclar muy rápido
        setTimeout(() => startBaileys(onQr, onReady, authFolder), 2000);
      }
    }
  });

  return sock;
}

