import { Boom } from "@hapi/boom";
import qrcode from "qrcode";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ["ClientFlow", "Chrome", "1.0.0"],
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log("QR pronto!");
    if (connection === "open") console.log("✅ WhatsApp conectado");
    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Conexão fechada, status:", status);
      if (status !== DisconnectReason.loggedOut) {
        setTimeout(main, 2000); // reconectar
      } else {
        console.log("⚠️ Sessão deslogada: será necessário escanear novamente.");
      }
    }
  });
}

main().catch((e) => {
  console.error("Erro no Baileys:", e);
  process.exit(1);
});
