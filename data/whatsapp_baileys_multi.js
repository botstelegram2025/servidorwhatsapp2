import express from "express"
import cors from "cors"
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys"

import P from "pino"
import fs from "fs"
import path from "path"

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001

// Armazena instâncias de sockets por usuário
const sessions = new Map()
const qrCodes = new Map()

// Função para inicializar sessão de usuário
async function startSession(userId) {
  const sessionPath = path.join("./sessions", userId.toString())

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      qrCodes.set(userId, qr)
      console.log(`📲 Novo QR para user ${userId}`)
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log(`❌ Conexão fechada para ${userId}. Motivo:`, reason)

      if (reason !== DisconnectReason.loggedOut) {
        console.log(`🔄 Tentando reconectar ${userId}...`)
        startSession(userId)
      } else {
        console.log(`🛑 Usuário ${userId} deslogado`)
        sessions.delete(userId)
      }
    } else if (connection === "open") {
      console.log(`✅ Sessão ${userId} conectada com sucesso`)
    }
  })

  sessions.set(userId, sock)
  return sock
}

// ------------------ ROTAS REST ------------------

// Obter QR Code atual
app.get("/qr/:userId", (req, res) => {
  const { userId } = req.params
  const qr = qrCodes.get(userId)

  if (qr) {
    res.json({ success: true, qrCode: qr })
  } else {
    res.json({ success: false, error: "QR Code não disponível" })
  }
})

// Enviar mensagem
app.post("/send/:userId", async (req, res) => {
  try {
    const { userId } = req.params
    const { number, message } = req.body

    let sock = sessions.get(userId)
    if (!sock) sock = await startSession(userId)

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net"

    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: number, message })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Status da sessão
app.get("/status/:userId", async (req, res) => {
  const { userId } = req.params
  const sock = sessions.get(userId)

  if (sock?.user) {
    res.json({
      success: true,
      connected: true,
      state: "open",
      user: sock.user
    })
  } else {
    res.json({
      success: true,
      connected: false,
      state: "disconnected"
    })
  }
})

// Desconectar sessão
app.post("/disconnect/:userId", (req, res) => {
  const { userId } = req.params
  const sock = sessions.get(userId)

  if (sock) {
    sock.logout()
    sessions.delete(userId)
    res.json({ success: true, message: "Sessão desconectada" })
  } else {
    res.json({ success: false, error: "Sessão não encontrada" })
  }
})

// Reconectar sessão
app.post("/reconnect/:userId", async (req, res) => {
  const { userId } = req.params
  try {
    await startSession(userId)
    res.json({ success: true, message: "Reconexão iniciada" })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Restaurar sessão (se já existir)
app.post("/restore/:userId", async (req, res) => {
  const { userId } = req.params
  try {
    await startSession(userId)
    res.json({ success: true, message: "Sessão restaurada" })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// Forçar novo QR
app.post("/force-qr/:userId", async (req, res) => {
  const { userId } = req.params
  qrCodes.delete(userId)
  await startSession(userId)

  setTimeout(() => {
    const qr = qrCodes.get(userId)
    if (qr) {
      res.json({ success: true, qrCode: qr })
    } else {
      res.json({ success: false, error: "QR ainda não gerado" })
    }
  }, 3000)
})

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok", sessions: [...sessions.keys()] })
})

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp server rodando na porta ${PORT}`)
})
