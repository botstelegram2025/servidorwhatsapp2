// whatsapp_baileys_multi.js  (ESM robusto)
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

function resolveMakeWASocket(mod) {
  // tenta nas formas comuns
  if (typeof mod?.default === 'function') return mod.default;
  if (typeof mod?.makeWASocket === 'function') return mod.makeWASocket;
  if (typeof mod?.default?.makeWASocket === 'function') return mod.default.makeWASocket;

  // último recurso: alguns bundles exportam tudo em "baileys" e a função vem com outro nome
  for (const k of Object.keys(mod || {})) {
    if (typeof mod[k] === 'function' && /make.*wa.*socket/i.test(k)) {
      return mod[k];
    }
  }
  return null;
}

const makeWASocket = resolveMakeWASocket(baileys);
const { useMultiFileAuthState, DisconnectReason } = baileys;

if (!makeWASocket) {
  console.error('Baileys exports:', Object.keys(baileys));
  throw new TypeError('makeWASocket não encontrado nos exports do @whiskeysockets/baileys');
}

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
        const status = lastDisconnect?.error?.output?.statusCode;
        console.log('❌ Conexão fechada. status:', status);
        if (status !== DisconnectReason.loggedOut) setTimeout(main, 1500);
        else console.log('⚠️ Sessão deslogada. Escaneie o QR novamente.');
      }
    });
  } catch (err) {
    console.error('Erro no Baileys:', err);
    process.exit(1);
  }
}

main();
