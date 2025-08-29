// whatsapp_baileys_multi.js  (ESM)
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import pino from 'pino';
import * as baileys from '@whiskeysockets/baileys';

const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} = baileys;

const makeWASocket =
  // garante compatibilidade entre versões do pacote (default vs named)
  (baileys.makeWASocket || baileys.default || baileys);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// id -> { sock, qr, lastQrAt, connected, state, saveCreds }
const instances = new Map();

// utils
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (...xs) => path.join(...xs);
const jidFromNumber = (n) => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`;

async function destroyAuth(id) {
  const p = j(SESSIONS_DIR, String(id));
  if (fs.existsSync(p)) {
    await fsp.rm(p, { recursive: true, force: true });
  }
}

async function ensureInstance(id, { forceNew = false } = {}) {
  id = String(id);
  if (forceNew) {
    try {
      await destroyAuth(id);
    } catch {}
    if (instances.has(id)) {
      try {
        await instances.get(id).sock?.logout?.();
      } catch {}
      instances.delete(id);
    }
  }

  if (instances.has(id)) return instances.get(id);

  const authPath = j(SESSIONS_DIR, id);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'error' }); // silencioso no server
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    // opção deprecada — mantemos false para não poluir terminal
    printQRInTerminal: false,
    browser: Browsers.appropriate('Chrome'),
  });

  const data = {
    sock,
    qr: null,
    lastQrAt: null,
    connected: false,
    state: 'starting',
    saveCreds,
  };
  instances.set(id, data);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        const dataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
        data.qr = dataUrl;
        data.lastQrAt = Date.now();
        data.state = 'qr';
      } catch {
        data.qr = null;
      }
    }

    if (connection === 'open') {
      data.connected = true;
      data.state = 'open';
      data.qr = null;
    }

    if (connection === 'close') {
      data.connected = false;
      data.state = 'close';
      const reason =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.code;
      // tenta reconectar exceto se foi logout explícito
      if (reason !== DisconnectReason.loggedOut) {
        await wait(1000);
        try {
          ensureInstance(id);
        } catch {}
      }
    }
  });

  return data;
}

/* ============ ROTAS ============ */

// health
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'whatsapp-baileys',
    sessionsDir: SESSIONS_DIR,
    up: true,
  });
});

// status com QR embutido
app.get('/status/:id', async (req, res) => {
  const { id } = req.params;
  const inst = instances.get(String(id));
  res.json({
    success: true,
    exists: !!inst,
    connected: !!inst?.connected,
    state: inst?.state || 'none',
    qrCode: inst?.qr || null,
    lastQrAt: inst?.lastQrAt || null,
  });
});

// QR dedicado
app.get('/qr/:id', (req, res) => {
  const { id } = req.params;
  const inst = instances.get(String(id));
  if (!inst?.qr) {
    return res.json({ success: false, error: 'QR not available' });
  }
  res.json({ success: true, qrCode: inst.qr, lastQrAt: inst.lastQrAt });
});

// conectar/reconectar rápido
app.post('/reconnect/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureInstance(id);
    res.json({ success: true, message: 'Reconnecting/connecting…' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// força novo QR (responde já; recria sessão em background)
app.post('/force-qr/:id', async (req, res) => {
  const { id } = req.params;
  res.json({ success: true, message: 'Forcing new QR in background' });
  try {
    await ensureInstance(id, { forceNew: true });
  } catch {}
});

// pairing code (se suportado)
app.post('/pairing-code/:id', async (req, res) => {
  const { id } = req.params;
  const phone = (req.body?.phoneNumber || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ success: false, error: 'phoneNumber required' });

  try {
    const inst = await ensureInstance(id);
    if (typeof inst.sock?.requestPairingCode !== 'function') {
      return res.json({ success: false, error: 'pairing-code not supported in this version' });
    }
    const code = await inst.sock.requestPairingCode(phone);
    res.json({ success: true, pairingCode: code });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// enviar mensagem
app.post('/send/:id', async (req, res) => {
  const { id } = req.params;
  const { number, message } = req.body || {};
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'number and message required' });
  }

  try {
    const inst = await ensureInstance(id);
    const jid = jidFromNumber(number);
    const sent = await inst.sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// desconectar
app.post('/disconnect/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const inst = instances.get(String(id));
    if (inst?.sock?.logout) await inst.sock.logout();
    instances.delete(String(id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp service listening on :${PORT}`);
});
