// ESM seguro com interop
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

async function main() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);

    const sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
      browser: ['ClientFlow', 'Chrome', '1.0.0'],
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) console.log('QR pronto! Escaneie no WhatsApp.');
      if (connection === 'open') console.log('✅ WhatsApp conectado');
      if (connection === 'close') {
        const status = (lastDisconnect?.error)?.output?.statusCode;
        console.log('❌ Conexão fechada. status:', status);
        if (status !== DisconnectReason.loggedOut) setTimeout(main, 2000);
        else console.log('⚠️ Sessão deslogada. Escaneie novamente o QR.');
      }
    });
  } catch (err) {
    console.error('Erro no Baileys:', err);
    process.exit(1);
  }
}

main();
