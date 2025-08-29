const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Railway environment detection
const isRailway = process.env.RAILWAY_ENVIRONMENT_NAME !== undefined;
console.log(`🌍 Environment: ${isRailway ? 'Railway' : 'Local'}`);

if (isRailway) {
    console.log('⚡ Railway environment detected - optimizing for cloud deployment');
}

// Map para armazenar sessões de cada usuário
const userSessions = new Map();

// Semáforo para controlar conexões simultâneas
class ConnectionSemaphore {
    constructor(maxConcurrent = 3) {
        this.maxConcurrent = maxConcurrent;
        this.current = 0;
        this.queue = [];
    }
    
    async acquire() {
        return new Promise((resolve) => {
            if (this.current < this.maxConcurrent) {
                this.current++;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    
    release() {
        this.current--;
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            this.current++;
            next();
        }
    }
}

const connectionSemaphore = new ConnectionSemaphore(2); // Max 2 conexões simultâneas

// Estrutura de dados para cada sessão de usuário
class UserWhatsAppSession {
    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.qrCodeData = null;
        this.isConnected = false;
        this.connectionState = 'disconnected';
        this.authFolder = `auth_info_baileys_user_${userId}`;
        this.reconnectTimeout = null;
        this.heartbeatInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.pairingCode = null; // Store pairing code
        this.phoneNumber = null; // Store phone number for pairing
    }
    
    async start(forceNew = false) {
        // Acquire semaphore to limit concurrent connections
        await connectionSemaphore.acquire();
        
        try {
            console.log(`🔄 Starting connection for user ${this.userId}, forceNew: ${forceNew}`);
            
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
            }
            
            // Force clean start to always generate QR when requested
            if (forceNew) {
                // Backup existing session before cleaning
                const authPath = path.join(__dirname, 'sessions', this.authFolder);
                if (fs.existsSync(authPath)) {
                    const backupPath = path.join(__dirname, 'sessions', `backup_${this.authFolder}_${Date.now()}`);
                    try {
                        fs.cpSync(authPath, backupPath, { recursive: true });
                        console.log(`💾 Backup created for user ${this.userId} at ${backupPath}`);
                    } catch (e) {
                        console.log(`⚠️ Could not create backup for user ${this.userId}: ${e.message}`);
                    }
                    
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log(`🧹 Cleaned auth for user ${this.userId} - will generate new QR`);
                }
                this.qrCodeData = null;
                this.connectionState = 'generating_qr';
            }
            
            // Ensure sessions directory exists
            const sessionsDir = path.join(__dirname, 'sessions');
            if (!fs.existsSync(sessionsDir)) {
                fs.mkdirSync(sessionsDir, { recursive: true });
            }
            
            const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions', this.authFolder));
            
            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                defaultQueryTimeoutMs: 180000, // Railway optimized timeout
                connectTimeoutMs: 180000, // Railway needs longer timeout
                browser: [`User_${this.userId}`, 'Chrome', '22.04.4'], // Unique browser per user
                syncFullHistory: false,
                markOnlineOnConnect: true, // Keep connection visible
                generateHighQualityLinkPreview: false,
                retryRequestDelayMs: 5000, // Railway optimized retry delay
                maxMsgRetryCount: 5, // More retries
                shouldSyncHistoryMessage: () => false,
                keepAliveIntervalMs: 30000, // More frequent keepalive
                emitOwnEvents: false,
                msgRetryCounterCache: new Map(),
                shouldIgnoreJid: () => false,
                // Enhanced connection stability options
                qrTimeout: 180000, // Railway extended QR timeout
                connectCooldownMs: 8000, // Railway longer cooldown
                userDevicesCache: new Map(),
                transactionOpts: {
                    maxCommitRetries: 5, // More retries
                    delayBetweenTriesMs: 2000 // Longer delay
                },
            });

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;
                
                if (qr) {
                    console.log(`✅ QR Code gerado para usuário ${this.userId}`);
                    this.qrCodeData = await QRCode.toDataURL(qr);
                    this.connectionState = 'qr_generated';
                }
                
                // Generate pairing code if it's a new login
                if (isNewLogin && !this.pairingCode && this.phoneNumber) {
                    try {
                        const code = await this.sock.requestPairingCode(this.phoneNumber);
                        this.pairingCode = code;
                        this.connectionState = 'pairing_code_generated';
                        console.log(`🔐 Pairing Code gerado para usuário ${this.userId} (${this.phoneNumber}): ${code}`);
                    } catch (error) {
                        console.log(`⚠️ Could not generate pairing code for user ${this.userId}:`, error.message);
                    }
                }
                
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                    
                    // Enhanced reconnection logic with specific error handling
                    const shouldReconnect = ![
                        DisconnectReason.loggedOut,
                        DisconnectReason.badSession,
                        DisconnectReason.multideviceMismatch
                    ].includes(statusCode);
                    
                    console.log(`❌ Conexão fechada para usuário ${this.userId}, status: ${statusCode}, erro: "${errorMessage}", reconectando: ${shouldReconnect}`);
                    
                    this.isConnected = false;
                    this.connectionState = 'disconnected';
                    
                    // Preserve QR data for longer to avoid unnecessary regeneration
                    if (statusCode !== 408 && statusCode !== 428) {
                        this.qrCodeData = null;
                    }
                    
                    // Enhanced error handling with specific recovery strategies
                    if (statusCode === 515 || errorMessage.includes('stream errored')) {
                        // Stream error - gradual reconnection
                        console.log(`🔄 Stream error for user ${this.userId}, attempting gentle reconnection...`);
                        this.reconnectTimeout = setTimeout(() => this.start(false), 8000);
                    } else if (statusCode === 408) {
                        // QR timeout - preserve session and retry
                        console.log(`⏰ QR timeout for user ${this.userId}, preserving session...`);
                        this.reconnectTimeout = setTimeout(() => this.start(false), 3000);
                    } else if (statusCode === 428 || errorMessage.includes('Connection Terminated')) {
                        // Connection terminated by server - wait before retry
                        console.log(`🛑 Connection terminated by server for user ${this.userId}, waiting before retry...`);
                        this.reconnectTimeout = setTimeout(() => this.start(false), 10000);
                    } else if (statusCode === 401) {
                        // Unauthorized - ALWAYS force new QR for auth errors
                        console.log(`🔐 Auth error 401 for user ${this.userId}, forcing clean QR generation...`);
                        // Clean corrupted session
                        try {
                            if (fs.existsSync(this.authPath)) {
                                fs.unlinkSync(this.authPath);
                                console.log(`🗑️ Removed corrupted session file for user ${this.userId}`);
                            }
                        } catch (cleanError) {
                            console.log(`⚠️ Error removing session file: ${cleanError.message}`);
                        }
                        this.reconnectTimeout = setTimeout(() => this.start(true), 2000);
                    } else if (statusCode === 440) {
                        // Conflict error - wait longer to avoid conflicts
                        console.log(`⚡ Conflict error for user ${this.userId}, backing off...`);
                        this.reconnectTimeout = setTimeout(() => this.start(false), 15000);
                    } else if (shouldReconnect) {
                        // Normal reconnection with progressive backoff
                        const delay = Math.min(5000 + (Math.random() * 5000), 20000); // 5-10s with max 20s
                        console.log(`🔄 Auto-reconnecting user ${this.userId} in ${delay}ms...`);
                        this.reconnectTimeout = setTimeout(() => this.start(false), delay);
                    } else {
                        console.log(`❌ User ${this.userId} requires manual reconnection`);
                    }
                } else if (connection === 'connecting') {
                    console.log(`🔄 WhatsApp conectando para usuário ${this.userId}...`);
                    this.connectionState = 'connecting';
                } else if (connection === 'open') {
                    console.log(`✅ WhatsApp conectado com sucesso para usuário ${this.userId}!`);
                    this.isConnected = true;
                    this.connectionState = 'connected';
                    this.qrCodeData = null;
                    this.pairingCode = null; // Clear pairing code when connected
                    this.reconnectAttempts = 0; // Reset reconnect attempts
                    
                    // Clear any reconnection timeouts
                    if (this.reconnectTimeout) {
                        clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = null;
                    }
                    
                    // Start heartbeat to maintain connection
                    this.startHeartbeat();
                }
            });

            this.sock.ev.on('creds.update', saveCreds);
            
        } catch (error) {
            console.error(`❌ Erro ao iniciar WhatsApp para usuário ${this.userId}:`, error);
            this.connectionState = 'error';
        } finally {
            // Always release semaphore
            connectionSemaphore.release();
        }
    }
    
    async sendMessage(number, message) {
        // If socket doesn't exist, definitely can't send
        if (!this.sock) {
            throw new Error('WhatsApp não conectado para este usuário');
        }
        
        // If we think we're disconnected but socket exists, try to send anyway
        if (!this.isConnected) {
            console.log(`⚠️ User ${this.userId} marked as disconnected but attempting to send anyway...`);
        }
        
        // Formatar número para WhatsApp
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('55')) {
            formattedNumber = '55' + formattedNumber;
        }
        formattedNumber += '@s.whatsapp.net';
        
        try {
            const result = await this.sock.sendMessage(formattedNumber, { text: message });
            console.log(`📤 Mensagem enviada pelo usuário ${this.userId} para ${number}: ${message}`);
            
            // If send was successful but we thought we were disconnected, update status
            if (!this.isConnected) {
                console.log(`✅ Message sent successfully for user ${this.userId}, updating connection status`);
                this.isConnected = true;
                this.connectionState = 'connected';
            }
            
            return result;
        } catch (error) {
            console.log(`❌ Erro ao enviar mensagem para usuário ${this.userId}:`, error.message);
            
            // If connection is closed, mark as disconnected
            if (error.message.includes('Connection Closed') || error.message.includes('closed') || error.message.includes('ECONNRESET')) {
                console.log(`🔄 Connection lost during message send for user ${this.userId}, marking as disconnected...`);
                this.isConnected = false;
                this.connectionState = 'disconnected';
                
                // Clear heartbeat to avoid conflicts
                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }
                
                // Try to reconnect automatically
                console.log(`🔄 Attempting automatic reconnection for user ${this.userId}...`);
                setTimeout(async () => {
                    try {
                        await this.start(false); // Try to reconnect without new QR
                        console.log(`✅ Auto-reconnection successful for user ${this.userId}`);
                    } catch (reconnectError) {
                        console.log(`❌ Auto-reconnection failed for user ${this.userId}: ${reconnectError.message}`);
                    }
                }, 3000); // Wait 3 seconds before reconnecting
            }
            
            // Re-throw the error so the caller knows it failed
            throw error;
        }
    }
    
    async disconnect() {
        // Clear all timers
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        if (this.sock) {
            await this.sock.logout();
        }
        
        this.isConnected = false;
        this.connectionState = 'disconnected';
        this.qrCodeData = null;
        this.pairingCode = null;
        this.sock = null;
    }
    
    startHeartbeat() {
        // Clear any existing heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Track consecutive heartbeat failures
        this.heartbeatFailures = this.heartbeatFailures || 0;
        
        // Send a heartbeat every 90 seconds to maintain connection
        this.heartbeatInterval = setInterval(async () => {
            if (this.isConnected && this.sock) {
                try {
                    // Simple ping to keep connection alive
                    console.log(`💓 Heartbeat for user ${this.userId} (failures: ${this.heartbeatFailures})`);
                    
                    await Promise.race([
                        this.sock.query({
                            tag: 'iq',
                            attrs: {
                                type: 'get',
                                xmlns: 'w:profile:picture'
                            }
                        }),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Heartbeat timeout')), 15000)
                        )
                    ]);
                    
                    // Heartbeat success - reset failure count
                    this.heartbeatFailures = 0;
                    
                } catch (error) {
                    this.heartbeatFailures++;
                    console.log(`💔 Heartbeat failed for user ${this.userId} (${this.heartbeatFailures}/3): ${error.message}`);
                    
                    // Only disconnect after 3 consecutive failures
                    if (this.heartbeatFailures >= 3) {
                        console.log(`❌ Too many heartbeat failures for user ${this.userId}, marking as disconnected`);
                        
                        // Mark connection as failed
                        this.isConnected = false;
                        this.connectionState = 'disconnected';
                        
                        // Clear heartbeat to avoid conflicts
                        if (this.heartbeatInterval) {
                            clearInterval(this.heartbeatInterval);
                            this.heartbeatInterval = null;
                        }
                        
                        // Reset failure count
                        this.heartbeatFailures = 0;
                        
                        // Only auto-reconnect for serious connection errors
                        if (error.message.includes('Connection Closed') || error.message.includes('closed')) {
                            console.log(`🔄 Connection lost for user ${this.userId}, initiating auto-reconnect...`);
                            setTimeout(async () => {
                                try {
                                    console.log(`🔄 Auto-reconnecting user ${this.userId} after connection loss...`);
                                    await this.start(false); // Reconnect without forcing new QR
                                } catch (reconnectError) {
                                    console.log(`❌ Auto-reconnect failed for user ${this.userId}:`, reconnectError.message);
                                }
                            }, 10000); // Wait 10 seconds before reconnecting
                        }
                    }
                }
            }
        }, 90000); // Every 90 seconds
    }
    
    async reconnect() {
        await this.disconnect();
        
        // ALWAYS force new QR on reconnect
        await this.start(true);
    }
    
    async requestPairingCode(phoneNumber) {
        return new Promise(async (resolve, reject) => {
            try {
                console.log(`🔐 Pairing code requested for user ${this.userId} with phone ${phoneNumber}`);
                
                // STOP ALL existing connections and intervals
                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                    this.reconnectTimeout = null;
                }
                
                // Force disconnect and cleanup
                if (this.sock) {
                    try {
                        // Properly close WebSocket without triggering error events
                        if (this.sock.ws && this.sock.ws.readyState === 1) {
                            this.sock.ws.close();
                        }
                        await this.sock.end();
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec
                    } catch (e) {
                        // Ignore expected WebSocket close errors during forced disconnect
                        console.log(`⚠️ Expected close error for user ${this.userId}: ${e.message}`);
                    }
                    this.sock = null;
                }
                
                this.isConnected = false;
                this.connectionState = 'generating_pairing_code';
                this.qrCodeData = null;
                this.pairingCode = null;
                
                // COMPLETELY clean auth data for fresh start
                const authPath = path.join(__dirname, 'sessions', this.authFolder);
                const backupPath = path.join(__dirname, 'sessions', `backup_pairing_${this.authFolder}_${Date.now()}`);
                
                if (fs.existsSync(authPath)) {
                    // Backup existing session before deletion
                    try {
                        fs.cpSync(authPath, backupPath, { recursive: true });
                        console.log(`💾 Backup created before pairing: ${backupPath}`);
                    } catch (e) {
                        console.log(`⚠️ Backup failed: ${e.message}`);
                    }
                    
                    // Clean everything
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log(`🧹 Completely cleaned auth for user ${this.userId} - fresh pairing start`);
                }
                
                // Wait a moment to ensure cleanup
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Create new session for pairing code
                const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions', this.authFolder));
                
                this.sock = makeWASocket({
                    auth: state,
                    printQRInTerminal: false,
                    browser: [`PairingBot_${this.userId}`, 'Chrome', '22.04.4'],
                    connectTimeoutMs: 60000,
                    defaultQueryTimeoutMs: 60000,
                    emitOwnEvents: true,
                    retryRequestDelayMs: 250,
                    maxMsgRetryCount: 3,
                    shouldSyncHistoryMessage: false
                });
                
                // Set up event listeners BEFORE requesting pairing code
                this.sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, isNewLogin } = update;
                    
                    console.log(`🔐 Pairing connection update for user ${this.userId}: ${connection}`);
                    
                    if (connection === 'open') {
                        console.log(`✅ WhatsApp conectado via pairing code para usuário ${this.userId}!`);
                        this.isConnected = true;
                        this.connectionState = 'connected';
                        this.qrCodeData = null;
                        this.pairingCode = null;
                        this.startHeartbeat();
                    } else if (connection === 'close') {
                        console.log(`❌ Pairing connection closed for user ${this.userId}`);
                        this.isConnected = false;
                        this.connectionState = 'disconnected';
                        
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        if (statusCode !== 401 && statusCode !== 515) {
                            // Only resolve with error if it's not a pairing-related disconnect
                            if (!this.pairingCode) {
                                resolve({ success: false, error: 'Connection failed before pairing code generation' });
                            }
                        }
                    }
                });
                
                this.sock.ev.on('creds.update', saveCreds);
                
                // Wait for socket to be ready, then request pairing code
                setTimeout(async () => {
                    try {
                        // Format phone number - remove any non-digit characters and ensure proper format
                        let formattedPhone = phoneNumber.replace(/\D/g, '');
                        
                        // Ensure it starts with country code (55 for Brazil)
                        if (formattedPhone.length === 11 && formattedPhone.startsWith('61')) {
                            formattedPhone = '55' + formattedPhone; // Add Brazil country code
                        } else if (formattedPhone.length === 13 && formattedPhone.startsWith('55')) {
                            // Already has country code, use as is
                        } else {
                            throw new Error(`Invalid phone number format: ${phoneNumber}. Use format: 5561999887766`);
                        }
                        
                        console.log(`🔐 Requesting pairing code for user ${this.userId} with formatted phone: ${formattedPhone}...`);
                        const code = await this.sock.requestPairingCode(formattedPhone);
                        this.pairingCode = code;
                        this.connectionState = 'pairing_code_generated';
                        console.log(`🔐 Pairing code generated for user ${this.userId}: ${code}`);
                        resolve({ success: true, pairingCode: code });
                    } catch (error) {
                        console.error(`❌ Error requesting pairing code for user ${this.userId}:`, error);
                        resolve({ success: false, error: error.message });
                    }
                }, 3000); // Wait 3 seconds for socket to be ready
                
                // Timeout after 30 seconds
                setTimeout(() => {
                    if (!this.pairingCode) {
                        resolve({ success: false, error: 'Timeout generating pairing code' });
                    }
                }, 30000);
                
            } catch (error) {
                console.error(`❌ Error in pairing code setup for user ${this.userId}:`, error);
                resolve({ success: false, error: error.message });
            }
        });
    }
    
    async forceQR() {
        try {
            console.log(`🚀 Force QR requested for user ${this.userId}`);
            
            // Clear any existing timeouts
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }
            
            // Disconnect if connected
            if (this.sock) {
                try {
                    // Properly close WebSocket without triggering error events
                    if (this.sock.ws && this.sock.ws.readyState === 1) {
                        this.sock.ws.close();
                    }
                    await this.sock.end();
                } catch (e) {
                    // Ignore expected WebSocket close errors during forced disconnect
                    console.log(`⚠️ Expected close error for user ${this.userId}: ${e.message}`);
                }
                this.sock = null;
            }
            
            this.isConnected = false;
            this.connectionState = 'generating_qr';
            this.qrCodeData = null;
            this.pairingCode = null;
            
            // Start with force new QR
            await this.start(true);
            
            // Wait for QR generation with timeout
            return new Promise((resolve, reject) => {
                let attempts = 0;
                const maxAttempts = 20; // 10 seconds max
                
                const checkQR = () => {
                    attempts++;
                    if (this.qrCodeData) {
                        resolve({ success: true, qrCode: this.qrCodeData });
                    } else if (attempts >= maxAttempts) {
                        reject(new Error('QR generation timeout'));
                    } else if (this.connectionState === 'error') {
                        reject(new Error('Connection error during QR generation'));
                    } else {
                        setTimeout(checkQR, 500);
                    }
                };
                
                // Start checking immediately
                setTimeout(checkQR, 100);
            });
            
        } catch (error) {
            console.error(`❌ Error in forceQR for user ${this.userId}:`, error);
            return { success: false, error: error.message };
        }
    }
    
    getStatus() {
        // Do a more thorough connection check
        let actuallyConnected = this.isConnected;
        
        // If we think we're connected but sock is null, we're actually disconnected
        if (this.isConnected && !this.sock) {
            console.log(`⚠️ User ${this.userId} marked as connected but socket is null, correcting status...`);
            this.isConnected = false;
            this.connectionState = 'disconnected';
            actuallyConnected = false;
        }
        
        return {
            userId: this.userId,
            connected: actuallyConnected,
            state: this.connectionState,
            qrCode: this.qrCodeData,
            qrCodeExists: !!this.qrCodeData,
            pairingCode: this.pairingCode,
            pairingCodeExists: !!this.pairingCode
        };
    }
}

// Função para obter ou criar sessão de usuário
function getUserSession(userId) {
    if (!userSessions.has(userId)) {
        const session = new UserWhatsAppSession(userId);
        userSessions.set(userId, session);
        
        // Check if session exists before forcing new QR
        const authPath = path.join(__dirname, 'sessions', session.authFolder);
        const hasExistingSession = fs.existsSync(authPath) && fs.existsSync(path.join(authPath, 'creds.json'));
        
        // Add random delay to prevent simultaneous connections
        const initDelay = Math.random() * 1000; // 0-1 second random delay
        
        setTimeout(() => {
            if (hasExistingSession) {
                console.log(`🔄 Found existing session for user ${userId}, attempting restore...`);
                session.start(false); // Try to restore existing session
            } else {
                console.log(`🆕 No existing session for user ${userId}, creating new...`);
                session.start(true); // Force new QR for first time
            }
        }, initDelay);
    }
    return userSessions.get(userId);
}

// API Endpoints
app.get('/status/:userId', async (req, res) => {
    const userId = req.params.userId;
    const session = getUserSession(userId);
    
    // Basic status
    const basicStatus = session.getStatus();
    
    // If claiming to be connected, do a real connection test
    if (basicStatus.connected && session.sock) {
        try {
            // Try a simple query to test if connection is really working
            await session.sock.query({
                tag: 'iq',
                attrs: {
                    type: 'get',
                    xmlns: 'w:profile:picture'
                }
            });
            // Connection test passed
        } catch (error) {
            console.log(`⚠️ Connection test failed for user ${userId}: ${error.message}`);
            // Connection test failed, update status
            session.isConnected = false;
            session.connectionState = 'disconnected';
            basicStatus.connected = false;
            basicStatus.state = 'disconnected';
        }
    }
    
    res.json({
        success: true,
        ...basicStatus
    });
});

app.get('/qr/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const session = getUserSession(userId);
        
        console.log(`📱 QR requested for user ${userId}, state: ${session.connectionState}, hasQR: ${!!session.qrCodeData}`);
        
        // If already connected, don't generate new QR
        if (session.isConnected) {
            return res.json({
                success: false,
                error: 'Already connected',
                connected: true
            });
        }
        
        // If QR exists and is fresh (not expired), return it
        if (session.qrCodeData && session.connectionState === 'qr_generated') {
            return res.json({
                success: true,
                qrCode: session.qrCodeData
            });
        }
        
        // Generate new QR
        try {
            const result = await session.forceQR();
            res.json(result);
        } catch (error) {
            console.error(`❌ QR generation failed for user ${userId}:`, error);
            res.json({
                success: false,
                message: 'Erro ao gerar QR Code',
                error: error.message
            });
        }
        
    } catch (error) {
        console.error('QR endpoint error:', error);
        res.json({
            success: false,
            error: 'Internal server error'
        });
    }
});

app.post('/send/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { number, message } = req.body;
        
        const session = userSessions.get(userId);
        
        if (!session) {
            return res.json({
                success: false,
                error: 'Sessão não encontrada para este usuário'
            });
        }
        
        // More lenient connection check - if sock exists, try to send
        if (!session.sock) {
            return res.json({
                success: false,
                error: 'WhatsApp não conectado para este usuário'
            });
        }
        
        // If we think we're disconnected but socket exists, try to send anyway
        if (!session.isConnected) {
            console.log(`⚠️ User ${userId} marked as disconnected but socket exists, attempting message send...`);
        }
        
        const result = await session.sendMessage(number, message);
        
        res.json({
            success: true,
            messageId: result.key.id,
            response: result
        });
        
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.post('/disconnect/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const session = userSessions.get(userId);
        
        if (session) {
            await session.disconnect();
            userSessions.delete(userId);
        }
        
        res.json({
            success: true,
            message: 'WhatsApp desconectado para o usuário'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.post('/reconnect/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const session = getUserSession(userId);
        
        // Force reconnect always generates new QR
        await session.reconnect();
        
        res.json({
            success: true,
            message: 'Gerando novo QR Code...'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Force QR endpoint
app.post('/force-qr/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const session = getUserSession(userId);
        
        const result = await session.forceQR();
        res.json(result);
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Endpoint para código de pareamento
app.post('/pairing-code/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.json({
                success: false,
                error: 'Número de telefone é obrigatório'
            });
        }
        
        const session = getUserSession(userId);
        // Set phone number in session for pairing code generation
        session.phoneNumber = phoneNumber;
        const result = await session.requestPairingCode(phoneNumber);
        
        res.json(result);
    } catch (error) {
        console.error('Pairing code endpoint error:', error);
        res.json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint para buscar código de pareamento existente
app.get('/pairing-code/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const session = userSessions.get(userId);
        
        if (!session) {
            return res.json({
                success: false,
                error: 'Sessão não encontrada'
            });
        }
        
        if (session.pairingCode) {
            res.json({
                success: true,
                pairingCode: session.pairingCode,
                state: session.connectionState
            });
        } else {
            res.json({
                success: false,
                message: 'Código de pareamento não disponível'
            });
        }
    } catch (error) {
        console.error('Get pairing code error:', error);
        res.json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint para listar todos os usuários conectados (admin)
app.get('/sessions', (req, res) => {
    const sessions = Array.from(userSessions.entries()).map(([userId, session]) => ({
        userId,
        ...session.getStatus()
    }));
    
    res.json({
        success: true,
        sessions,
        totalSessions: sessions.length
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    const connectedSessions = Array.from(userSessions.values()).filter(s => s.isConnected).length;
    const totalSessions = userSessions.size;
    
    res.json({
        success: true,
        status: 'healthy',
        connectedSessions,
        totalSessions,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Restore session endpoint (for manual recovery)
app.post('/restore/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const session = getUserSession(userId);
        
        // Check if session exists
        const authPath = path.join(__dirname, 'sessions', session.authFolder);
        const hasValidSession = fs.existsSync(authPath) && fs.existsSync(path.join(authPath, 'creds.json'));
        
        if (!hasValidSession) {
            return res.json({
                success: false,
                error: 'No valid session found for this user'
            });
        }
        
        // Force restart the session without clearing auth
        await session.start(false);
        
        res.json({
            success: true,
            message: 'Session restore initiated',
            hasSession: hasValidSession
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Auto-recovery system - check sessions every 5 minutes
setInterval(() => {
    console.log(`🔍 Health check: ${userSessions.size} active sessions`);
    
    userSessions.forEach((session, userId) => {
        if (!session.isConnected && session.connectionState === 'disconnected') {
            const authPath = path.join(__dirname, 'sessions', session.authFolder);
            const hasValidSession = fs.existsSync(authPath) && fs.existsSync(path.join(authPath, 'creds.json'));
            
            if (hasValidSession && !session.reconnectTimeout) {
                console.log(`🔄 Auto-recovering session for user ${userId}...`);
                session.start(false);
            }
        }
    });
}, 300000); // 5 minutes

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Graceful shutdown initiated...');
    
    const promises = Array.from(userSessions.values()).map(session => {
        if (session.reconnectTimeout) {
            clearTimeout(session.reconnectTimeout);
        }
        return session.sock?.end();
    });
    
    Promise.all(promises).finally(() => {
        console.log('✅ All sessions closed');
        process.exit(0);
    });
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Baileys Multi-User rodando na porta ${PORT}`);
    console.log(`✅ Sistema de recuperação automática ativo`);
    console.log(`💾 Sessões persistentes em ./sessions/`);
});