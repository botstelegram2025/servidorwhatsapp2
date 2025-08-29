// whatsapp_baileys_multi.js  (ESM)
import express from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import path from "node:path";
import fs from "node:fs/promises";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json());

// Config
const PORT = process.env.PORT || 3001;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "/data/sessions";
const QR_TTL_MS = 60_000; // mantém o QR por 60s
await fs.mkdir(SESSIONS_DIR, { recursive: true });

// Mapa de instâncias
const instances = new Map();
/*
instances.set(id, {
  sock,
  state, saveCreds,
  lastQr: { code, dataUrl, ts },
  connected: boolean,
  phone: string|null,
  stateStr: "open"/"connecting"/"close"/"unknown"
});
*/

function asId(v) {
  // normaliza id (string sempre)
  return String(v).trim();
}

async function ensureInstance(id) {
  id = asId(id);

  if (instances.has(id)) {
    return instances.get(id);
  }

  const sessionPath = path.join(SESSIONS_DIR, id);
  await fs.mkdir(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // deprecado
    browser: ["Railway", "Chrome", "20.0"]
  });

  const ctx = {
    sock,
    state,
    saveCreds,
    lastQr: null,
    connected: false,
    phone: null,
    stateStr: "connecting"
  };
  instances.set(id, ctx);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Guarda o QR e também gera dataURL para front (se quiser)
      const dataUrl = await QRCode.toDataURL(qr).catch(() => null);
      ctx.lastQr = { code: qr, dataUrl, ts: Date.now() };
      log.info({ id }, "QR atualizado para a instância");
      // Expira o QR após TTL (evita servir QR velho)
      setTimeout(() => {
        if (ctx.lastQr && Date.now() - ctx.lastQr.ts >= QR_TTL_MS) {
          ctx.lastQr = null;
        }
      }, QR_TTL_MS + 1000);
    }

    if (connection === "open") {
      ctx.connected = true;
      ctx.stateStr = "open";
      // tenta obter o número logado
      try {
        const me = await sock.user;
        ctx.phone = me?.id || me?.jid || null;
      } catch {}
      log.info({ id, phone: ctx.phone }, "Conectado ao WhatsApp");
    }

    if (connection === "close") {
      ctx.connected = false;
      ctx.stateStr = "close";
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status || lastDisconnect?.error?.code;
      log.warn({ id, code }, "Conexão encerrada");
      // reconecta automaticamente exceto em banimento ou logout explícito
      const shouldReconnect =
        code !== DisconnectReason.loggedOut && code !== DisconnectReason.badSession;
      if (shouldReconnect) {
        setTimeout(async () => {
          try {
            // recria do zero para forçar QR novo
            instances.delete(id);
            await ensureInstance(id);
            log.info({ id }, "Instância recriada após close");
          } catch (err) {
            log.error({ id, err }, "Falha ao recriar instância");
          }
        }, 1500);
      }
    }
  });

  sock.ev.on("messages.upsert", (m) => {
    // opcional: logs resumidos
    const count = m?.messages?.length || 0;
    if (count) log.debug({ id, count, type: m.type }, "messages.upsert");
  });

  return ctx;
}

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok", uptime: process.uptime() });
});

app.get("/status/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    const ctx = await ensureInstance(id);
    res.json({
      success: true,
      instance: id,
      connected: !!ctx.connected,
      state: ctx.stateStr,
      phone: ctx.phone,
      qrCode: ctx.lastQr?.code || null,
      qrDataUrl: ctx.lastQr?.dataUrl || null
    });
  } catch (err) {
    log.error({ err }, "status error");
    res.status(500).json({ success: false, error: "status_failed" });
  }
});

app.get("/qr/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    const ctx = await ensureInstance(id);

    if (ctx.connected) {
      return res.json({ success: true, connected: true, qrCode: null, qrDataUrl: null });
    }
    if (!ctx.lastQr) {
      return res.status(404).json({ success: false, error: "qr_not_ready" });
    }
    res.json({
      success: true,
      connected: false,
      qrCode: ctx.lastQr.code,
      qrDataUrl: ctx.lastQr.dataUrl
    });
  } catch (err) {
    log.error({ err }, "qr error");
    res.status(500).json({ success: false, error: "qr_failed" });
  }
});

app.post("/force-qr/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    // sempre recria para forçar QR novo
    instances.delete(id);
    const ctx = await ensureInstance(id);

    // aguarda até pintar o primeiro QR (ou 10s timeout)
    const startedAt = Date.now();
    while (!ctx.lastQr && Date.now() - startedAt < 10_000) {
      // pequeno delay
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }

    if (ctx.lastQr) {
      return res.json({
        success: true,
        instance: id,
        qrCode: ctx.lastQr.code,
        qrDataUrl: ctx.lastQr.dataUrl
      });
    }
    return res.status(202).json({ success: true, instance: id, message: "qr_pending" });
  } catch (err) {
    log.error({ err }, "force-qr error");
    res.status(500).json({ success: false, error: "force_qr_failed" });
  }
});

app.post("/send/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    const { number, message } = req.body || {};
    if (!number || !message) {
      return res.status(400).json({ success: false, error: "number_and_message_required" });
    }

    const ctx = await ensureInstance(id);
    if (!ctx.connected) {
      return res
        .status(409)
        .json({ success: false, error: "not_connected", hint: "scan_qr_first" });
    }

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    const sent = await ctx.sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: sent?.key?.id || null });
  } catch (err) {
    log.error({ err }, "send error");
    res.status(500).json({ success: false, error: "send_failed" });
  }
});

app.post("/disconnect/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    const ctx = instances.get(id);
    if (ctx?.sock) {
      try { await ctx.sock.logout(); } catch {}
      try { ctx.sock.end?.(); } catch {}
    }
    instances.delete(id);
    // não apaga credenciais (para manter login); se quiser “limpar”, remova a pasta:
    // await fs.rm(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, "disconnect error");
    res.status(500).json({ success: false, error: "disconnect_failed" });
  }
});

app.post("/reconnect/:id", async (req, res) => {
  try {
    const id = asId(req.params.id);
    instances.delete(id);
    const ctx = await ensureInstance(id);
    res.json({ success: true, connected: ctx.connected, state: ctx.stateStr });
  } catch (err) {
    log.error({ err }, "reconnect error");
    res.status(500).json({ success: false, error: "reconnect_failed" });
  }
});

app.listen(PORT, () => log.info(`WhatsApp service listening on :${PORT}`));
