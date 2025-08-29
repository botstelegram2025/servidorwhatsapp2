// whatsapp_baileys_multi.js  (ESM)
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import P from 'pino';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const instances = new Map();      // id -> { sock, qr, lastQrAt, connected, state, saveCreds }
const ensureLocks = new Map();    // id -> Promise (evita corrida/duplicidade)

// util
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const j = (...xs) => path.join(...xs);
const jidFromNumber = (n) => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`;

async function destroyAuth(id) {
  const p = j(SESSIONS_DIR, String(id));
  if (fs.existsSync(p)) await fsp.rm(p, { recursive: true, force: true });
}

async function _reallyEnsureInstance(id, { forceNew = false } = {}) {
  id = String(id);

  if (forceNew) {
    try { await destroyAuth(id); } catch {}
    const prev = instances.get(id);
    if (prev?.sock?.logout) {
      try { await prev.sock.logout(); } catch {}
    }
    instances.delete(id);
  }

  if (instances.has(id)) return instances.get(id);

  const authPath = j(SESSIONS_DIR, id);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const logger = P({ level: 'error' }); // silencioso
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false, // deprecado
    browser: Browsers.appropriate('Chrome')
  });

  const data = {
    sock,
    qr: null,
    lastQrAt: null,
    connected: false,
    state: 'starting',
    saveCreds
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

      const err = lastDisconnect?.error;
      const code =
        err?.output?.statusCode ??
        err?.status ??
        err?.code ??
        err;

      // Se foi logout, apaga sessão; senão tenta reconectar
      if (code === DisconnectReason.loggedOut || code === 401) {
        try { await destroyAuth(id); } catch {}
        instances.delete(id);
      } else {
        await wait(1000);
        try { await ensureInstance(id); } catch {}
      }
    }
  });

  return data;
}

async function ensureInstance(id, opts = {}) {
  id = String(id);
  if (ensureLocks.has(id)) {
    return ensureLocks.get(id);
  }
  const p = _reallyEnsureInstance(id, opts)
    .finally(() => ensureLocks.delete(id));
  ensureLocks.set(id, p);
  return p;
}

/* ------------------- ROTAS ------------------- */

// saúde
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'whatsapp-baileys', sessionsDir: SESSIONS_DIR, uptime: process.uptime() });
});
app.head('/health', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => res.status(200).send('OK'));

// status geral (sem id)
app.get('/status', (_req, res) => {
  res.json({
    success: true,
    instances: Array.from(instances.entries()).map(([id, inst]) => ({
      id,
      connected: !!inst.connected,
      state: inst.state,
      lastQrAt: inst.lastQrAt ?? null
    }))
  });
});

// status + QR embutido (lazy-start: cria instância se não existir)
app.get('/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    let inst = instances.get(String(id));
    if (!inst) inst = await ensureInstance(id); // inicia se não existir
    res.json({
      success: true,
      exists: !!inst,
      connected: !!inst?.connected,
      state: inst?.state || 'none',
      qrCode: inst?.qr || null,
      lastQrAt: inst?.lastQrAt || null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// QR dedicado (lazy-start também)
app.get('/qr/:id', async (req, res) => {
  const { id } = req.params;
  try {
    let inst = instances.get(String(id));
    if (!inst) inst = await ensureInstance(id);
    if (!inst?.qr) return res.json({ success: false, error: 'QR not available' });
    res.json({ success: true, qrCode: inst.qr, lastQrAt: inst.lastQrAt });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// QR como PNG (útil para testar no browser)
app.get('/qr/:id.png', async (req, res) => {
  const { id } = req.params;
  try {
    let inst = instances.get(String(id));
    if (!inst) inst = await ensureInstance(id);
    if (!inst?.qr) return res.status(404).send('QR not available');
    const base64 = inst.qr.split(',')[1];
    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', 'image/png').send(buf);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// reconectar (rápido)
app.post('/reconnect/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureInstance(id);
    res.json({ success: true, message: 'Reconnecting/connecting…' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// restaurar (equivalente a reconectar sem apagar sessão)
app.post('/restore/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureInstance(id, { forceNew: false });
    res.json({ success: true, message: 'Restore triggered' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// forçar novo QR (apaga sessão e reinicia em background)
app.post('/force-qr/:id', async (req, res) => {
  const { id } = req.params;
  res.json({ success: true, message: 'Forcing new QR in background' });
  try {
    await ensureInstance(id, { forceNew: true });
  } catch { /* silencia */ }
});

// pairing code (para aparelhos compatíveis)
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
  if (!number || !message) return res.status(400).json({ success: false, error: 'number and message required' });

  try {
    const inst = await ensureInstance(id);
    if (!inst.connected) {
      return res.status(409).json({ success: false, error: 'not connected', state: inst.state });
    }
    const jid = jidFromNumber(number);
    const sent = await inst.sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: sent?.key?.id || null });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// desconectar (mantém/limpa sessão opcionalmente)
app.post('/disconnect/:id', async (req, res) => {
  const { id } = req.params;
  const { clearSession = false } = req.body || {};
  try {
    const inst = instances.get(String(id));
    if (inst?.sock?.logout) {
      try { await inst.sock.logout(); } catch {}
    }
    instances.delete(String(id));
    if (clearSession) {
      try { await destroyAuth(id); } catch {}
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp service listening on :${PORT}`);
});
