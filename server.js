/**
 * =============================================================================
 * MULTIAUDIO - WebRTC Audio Streaming Server (HTTPS)
 * =============================================================================
 * 
 * This server handles SIGNALING ONLY - no audio passes through here.
 * All audio is streamed peer-to-peer via WebRTC.
 * 
 * Architecture:
 * - Express serves the static files (HTML, CSS, JS)
 * - Socket.IO handles WebRTC signaling (offer/answer/ICE candidates)
 * - Rooms are managed in memory (no database needed)
 * - HTTPS enabled with self-signed certificate for secure context
 * 
 * Flow:
 * 1. Host creates a room → joins Socket.IO room
 * 2. Listener joins room → requests connection from host
 * 3. Host creates WebRTC offer → sends via Socket.IO
 * 4. Listener creates answer → sends via Socket.IO
 * 5. ICE candidates exchanged → P2P connection established
 * 6. Audio streams directly from Host to Listener (no server)
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

// =============================================================================
// SSL CERTIFICATE SETUP
// =============================================================================

/**
 * Generate self-signed certificate if not exists
 * This allows HTTPS without external certificate tools
 */
const certsDir = path.join(__dirname, 'certs');
const keyPath = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');

// Check if we need to generate certificates
let sslOptions = null;

try {
    // Try to load existing certificates
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        console.log('[SSL] Loaded existing certificates from ./certs/');
    }
} catch (err) {
    console.log('[SSL] Could not load certificates:', err.message);
}

// If no certificates, generate self-signed ones using Node.js crypto
if (!sslOptions) {
    console.log('[SSL] Generating self-signed certificate...');
    
    // Ensure certs directory exists
    if (!fs.existsSync(certsDir)) {
        fs.mkdirSync(certsDir, { recursive: true });
    }
    
    // Generate certificate using Node.js built-in crypto
    const { generateKeyPairSync, createSign, randomBytes } = require('crypto');
    
    // Generate RSA key pair
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    // Create a simple self-signed certificate
    // For a proper cert, we need to build it manually
    const forge = createSelfSignedCert();
    
    fs.writeFileSync(keyPath, forge.privateKey);
    fs.writeFileSync(certPath, forge.certificate);
    
    sslOptions = {
        key: forge.privateKey,
        cert: forge.certificate
    };
    
    console.log('[SSL] Self-signed certificate generated');
}

/**
 * Create a self-signed certificate using pure Node.js
 * This creates a valid X.509 certificate without OpenSSL
 */
function createSelfSignedCert() {
    const crypto = require('crypto');
    
    // Generate key pair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    // Create certificate using Node's built-in X509Certificate (Node 15+)
    // For older Node versions, we'll use a simpler approach with the selfsigned package
    // Since we want no external dependencies, we'll include a minimal cert generator
    
    const certPem = generateMinimalCert(privateKey, publicKey);
    
    return {
        privateKey: privateKey,
        certificate: certPem
    };
}

/**
 * Generate a minimal self-signed X.509 certificate
 * Compatible with all Node.js versions
 */
function generateMinimalCert(privateKeyPem, publicKeyPem) {
    const crypto = require('crypto');
    
    // Helper to encode length in ASN.1 DER format
    function encodeLength(len) {
        if (len < 128) return Buffer.from([len]);
        if (len < 256) return Buffer.from([0x81, len]);
        return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
    }
    
    // Helper to create ASN.1 sequence
    function sequence(...items) {
        const content = Buffer.concat(items);
        return Buffer.concat([Buffer.from([0x30]), encodeLength(content.length), content]);
    }
    
    // Helper to create ASN.1 set
    function set(...items) {
        const content = Buffer.concat(items);
        return Buffer.concat([Buffer.from([0x31]), encodeLength(content.length), content]);
    }
    
    // Helper for OID
    function oid(oidStr) {
        const parts = oidStr.split('.').map(Number);
        const bytes = [parts[0] * 40 + parts[1]];
        for (let i = 2; i < parts.length; i++) {
            let val = parts[i];
            if (val < 128) {
                bytes.push(val);
            } else {
                const encoded = [];
                while (val > 0) {
                    encoded.unshift(val & 0x7f);
                    val >>= 7;
                }
                for (let j = 0; j < encoded.length - 1; j++) {
                    encoded[j] |= 0x80;
                }
                bytes.push(...encoded);
            }
        }
        const content = Buffer.from(bytes);
        return Buffer.concat([Buffer.from([0x06]), encodeLength(content.length), content]);
    }
    
    // Helper for PrintableString
    function printableString(str) {
        const content = Buffer.from(str, 'ascii');
        return Buffer.concat([Buffer.from([0x13]), encodeLength(content.length), content]);
    }
    
    // Helper for UTF8String
    function utf8String(str) {
        const content = Buffer.from(str, 'utf8');
        return Buffer.concat([Buffer.from([0x0c]), encodeLength(content.length), content]);
    }
    
    // Helper for INTEGER
    function integer(num) {
        let hex = num.toString(16);
        if (hex.length % 2) hex = '0' + hex;
        const bytes = Buffer.from(hex, 'hex');
        // Add leading zero if high bit set
        const content = (bytes[0] & 0x80) ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
        return Buffer.concat([Buffer.from([0x02]), encodeLength(content.length), content]);
    }
    
    // Helper for BIT STRING
    function bitString(data) {
        const content = Buffer.concat([Buffer.from([0]), data]); // 0 unused bits
        return Buffer.concat([Buffer.from([0x03]), encodeLength(content.length), content]);
    }
    
    // Helper for UTCTime
    function utcTime(date) {
        const str = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
        const content = Buffer.from(str, 'ascii');
        return Buffer.concat([Buffer.from([0x17]), encodeLength(content.length), content]);
    }
    
    // Extract public key DER from PEM
    const pubKeyBase64 = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s/g, '');
    const pubKeyDer = Buffer.from(pubKeyBase64, 'base64');
    
    // Build certificate components
    const serialNumber = integer(Date.now());
    
    // Signature algorithm: SHA256 with RSA
    const signatureAlgorithm = sequence(
        oid('1.2.840.113549.1.1.11'), // sha256WithRSAEncryption
        Buffer.from([0x05, 0x00]) // NULL
    );
    
    // Issuer and Subject: CN=localhost
    const commonName = sequence(
        oid('2.5.4.3'), // commonName
        utf8String('localhost')
    );
    const name = sequence(set(commonName));
    
    // Validity: 1 year
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);
    const validity = sequence(utcTime(notBefore), utcTime(notAfter));
    
    // Version: v3 (2)
    const version = Buffer.concat([
        Buffer.from([0xa0, 0x03]), // context tag 0
        integer(2)
    ]);
    
    // TBS Certificate
    const tbsCertificate = sequence(
        version,
        serialNumber,
        signatureAlgorithm,
        name, // issuer
        validity,
        name, // subject
        pubKeyDer // subjectPublicKeyInfo
    );
    
    // Sign the TBS certificate
    const sign = crypto.createSign('SHA256');
    sign.update(tbsCertificate);
    const signature = sign.sign(privateKeyPem);
    
    // Complete certificate
    const certificate = sequence(
        tbsCertificate,
        signatureAlgorithm,
        bitString(signature)
    );
    
    // Convert to PEM
    const certBase64 = certificate.toString('base64');
    const certPem = '-----BEGIN CERTIFICATE-----\n' +
        certBase64.match(/.{1,64}/g).join('\n') +
        '\n-----END CERTIFICATE-----\n';
    
    return certPem;
}

// =============================================================================
// SERVER SETUP
// =============================================================================

const app = express();

// Create HTTPS server
const server = https.createServer(sslOptions, app);

// Also create HTTP server for redirect
const httpApp = express();
const httpServer = http.createServer(httpApp);

const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for mobile access
        methods: ["GET", "POST"]
    },
    // Keep connection alive settings - optimized for stability
    pingTimeout: 30000,      // 30 seconds before considering connection dead
    pingInterval: 10000,     // Send ping every 10 seconds for faster detection
    upgradeTimeout: 30000,   // 30 seconds to upgrade connection
    transports: ['websocket', 'polling'], // Prefer WebSocket
    allowUpgrades: true,
    // Connection recovery settings
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true
    }
});

const PORT = process.env.PORT || 3000;
const HTTP_PORT = 3080; // HTTP redirect port

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// =============================================================================
// YOUTUBE AUDIO STREAMING ENDPOINT (using yt-dlp)
// =============================================================================

/**
 * Validate YouTube URL
 */
function isValidYoutubeUrl(url) {
    const patterns = [
        /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
        /^https?:\/\/youtu\.be\//,
        /^https?:\/\/(www\.)?youtube\.com\/embed\//,
        /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
        /^https?:\/\/(www\.)?youtube\.com\/v\//
    ];
    return patterns.some(pattern => pattern.test(url));
}

/**
 * Get YouTube video info using yt-dlp
 */
app.get('/youtube-info', async (req, res) => {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    if (!isValidYoutubeUrl(videoUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    try {
        console.log(`[YouTube Info] Getting info for: ${videoUrl}`);
        
        // Use yt-dlp to get video info as JSON
        const result = execSync(`yt-dlp --dump-json --no-warnings "${videoUrl}"`, {
            encoding: 'utf-8',
            timeout: 30000
        });
        
        const info = JSON.parse(result);
        
        res.json({
            title: info.title,
            duration: info.duration,
            author: info.uploader || info.channel,
            thumbnail: info.thumbnail
        });
        
    } catch (err) {
        console.error('[YouTube Info] Error:', err.message);
        res.status(500).json({ error: 'Failed to get video info' });
    }
});

/**
 * Stream YouTube audio using yt-dlp
 * Extracts direct audio URL and streams it to client
 */
app.get('/youtube-audio', async (req, res) => {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    if (!isValidYoutubeUrl(videoUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    try {
        console.log(`[YouTube] Streaming audio for: ${videoUrl}`);
        
        // Set headers for audio streaming
        res.setHeader('Content-Type', 'audio/webm');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        
        // Use yt-dlp to stream audio directly to response
        // -f bestaudio: best audio quality
        // -o -: output to stdout
        // --no-warnings: suppress warnings
        const ytdlp = spawn('yt-dlp', [
            '-f', 'bestaudio',
            '-o', '-',
            '--no-warnings',
            '--no-playlist',
            videoUrl
        ]);
        
        ytdlp.stdout.pipe(res);
        
        ytdlp.stderr.on('data', (data) => {
            console.log(`[YouTube] yt-dlp: ${data.toString()}`);
        });
        
        ytdlp.on('error', (err) => {
            console.error('[YouTube] yt-dlp error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream audio' });
            }
        });
        
        ytdlp.on('close', (code) => {
            if (code !== 0) {
                console.error(`[YouTube] yt-dlp exited with code ${code}`);
            }
        });
        
        // Handle client disconnect
        req.on('close', () => {
            ytdlp.kill('SIGTERM');
        });
        
    } catch (err) {
        console.error('[YouTube] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

/**
 * Get direct audio URL from YouTube (alternative endpoint)
 * Returns the URL that client can use directly
 */
app.get('/youtube-direct-url', async (req, res) => {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    if (!isValidYoutubeUrl(videoUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    try {
        console.log(`[YouTube] Getting direct URL for: ${videoUrl}`);
        
        // Get the direct audio URL using yt-dlp
        const result = execSync(`yt-dlp -f bestaudio -g --no-warnings "${videoUrl}"`, {
            encoding: 'utf-8',
            timeout: 30000
        });
        
        const directUrl = result.trim();
        console.log(`[YouTube] Direct URL obtained`);
        
        res.json({ url: directUrl });
        
    } catch (err) {
        console.error('[YouTube Direct URL] Error:', err.message);
        res.status(500).json({ error: 'Failed to get direct URL' });
    }
});

// =============================================================================
// ROOM MANAGEMENT
// =============================================================================

/**
 * rooms Map structure:
 * {
 *   roomId: {
 *     hostId: string (socket.id of host),
 *     listeners: Set<string> (socket.ids of listeners),
 *     isStreaming: boolean
 *   }
 * }
 */
const rooms = new Map();

/**
 * Generate a random 6-character room ID
 * Uses alphanumeric characters for easy sharing
 */
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars (0,O,1,I)
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Get listener count for a room
 */
function getListenerCount(roomId) {
    const room = rooms.get(roomId);
    return room ? room.listeners.size : 0;
}

/**
 * Broadcast listener count update to all participants in a room
 */
function broadcastListenerCount(roomId) {
    const count = getListenerCount(roomId);
    io.to(roomId).emit('listener-count', { count });
    console.log(`[Room ${roomId}] Listener count: ${count}`);
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on('connection', (socket) => {
    console.log(`[Connect] Client connected: ${socket.id}`);

    // -------------------------------------------------------------------------
    // ROOM CREATION (Host)
    // -------------------------------------------------------------------------
    
    /**
     * Host requests to create a new room
     * - Generates unique room ID
     * - Registers host in room
     * - Joins Socket.IO room for messaging
     */
    socket.on('create-room', (callback) => {
        // Generate unique room ID
        let roomId = generateRoomId();
        while (rooms.has(roomId)) {
            roomId = generateRoomId();
        }

        // Create room with this socket as host
        rooms.set(roomId, {
            hostId: socket.id,
            listeners: new Set(),
            isStreaming: false
        });

        // Join the Socket.IO room
        socket.join(roomId);
        
        // Store room ID on socket for cleanup
        socket.roomId = roomId;
        socket.isHost = true;

        console.log(`[Room ${roomId}] Created by host ${socket.id}`);
        
        // Return room ID to host
        callback({ success: true, roomId });
    });

    // -------------------------------------------------------------------------
    // ROOM JOINING (Listener)
    // -------------------------------------------------------------------------
    
    /**
     * Listener requests to join an existing room
     * - Validates room exists
     * - Adds listener to room
     * - Notifies host of new listener
     */
    socket.on('join-room', ({ roomId }, callback) => {
        const room = rooms.get(roomId);

        // Validate room exists
        if (!room) {
            console.log(`[Join] Room ${roomId} not found`);
            callback({ success: false, error: 'Room not found' });
            return;
        }

        // Add listener to room
        room.listeners.add(socket.id);
        socket.join(roomId);
        
        // Store room ID on socket for cleanup
        socket.roomId = roomId;
        socket.isHost = false;

        console.log(`[Room ${roomId}] Listener ${socket.id} joined`);

        // Notify host of new listener (so host can create WebRTC offer)
        io.to(room.hostId).emit('listener-joined', { 
            listenerId: socket.id 
        });

        // Update listener count for all participants
        broadcastListenerCount(roomId);

        // Return success with streaming status
        callback({ 
            success: true, 
            isStreaming: room.isStreaming,
            listenerCount: room.listeners.size
        });
    });

    // -------------------------------------------------------------------------
    // WEBRTC SIGNALING
    // -------------------------------------------------------------------------
    
    /**
     * Host sends WebRTC offer to a specific listener
     * This is the first step in establishing a peer connection
     */
    socket.on('offer', ({ offer, targetId }) => {
        console.log(`[Signaling] Offer from ${socket.id} to ${targetId}`);
        io.to(targetId).emit('offer', { 
            offer, 
            hostId: socket.id 
        });
    });

    /**
     * Listener sends WebRTC answer back to host
     * This completes the offer/answer exchange
     */
    socket.on('answer', ({ answer, targetId }) => {
        console.log(`[Signaling] Answer from ${socket.id} to ${targetId}`);
        io.to(targetId).emit('answer', { 
            answer, 
            listenerId: socket.id 
        });
    });

    /**
     * ICE candidate exchange
     * These are sent by both host and listeners during connection setup
     * ICE candidates help establish the optimal P2P path
     */
    socket.on('ice-candidate', ({ candidate, targetId }) => {
        console.log(`[Signaling] ICE candidate from ${socket.id} to ${targetId}`);
        io.to(targetId).emit('ice-candidate', { 
            candidate, 
            senderId: socket.id 
        });
    });

    // -------------------------------------------------------------------------
    // STREAMING STATUS
    // -------------------------------------------------------------------------
    
    /**
     * Host notifies that streaming has started
     * Listeners use this to update their UI
     */
    socket.on('streaming-started', () => {
        const room = rooms.get(socket.roomId);
        if (room && socket.isHost) {
            room.isStreaming = true;
            socket.to(socket.roomId).emit('host-streaming', { isStreaming: true });
            console.log(`[Room ${socket.roomId}] Streaming started`);
            
            // Send list of existing listeners to host so it can create connections
            const listenerIds = Array.from(room.listeners);
            socket.emit('existing-listeners', { listenerIds });
            console.log(`[Room ${socket.roomId}] Notifying host of ${listenerIds.length} existing listeners`);
        }
    });

    /**
     * Host notifies that streaming has stopped
     */
    socket.on('streaming-stopped', () => {
        const room = rooms.get(socket.roomId);
        if (room && socket.isHost) {
            room.isStreaming = false;
            socket.to(socket.roomId).emit('host-streaming', { isStreaming: false });
            console.log(`[Room ${socket.roomId}] Streaming stopped`);
        }
    });

    // -------------------------------------------------------------------------
    // DISCONNECTION HANDLING
    // -------------------------------------------------------------------------
    
    /**
     * Clean up when a client disconnects
     * - If host: close room and notify all listeners
     * - If listener: remove from room and update count
     */
    socket.on('disconnect', () => {
        console.log(`[Disconnect] Client disconnected: ${socket.id}`);

        const roomId = socket.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        if (socket.isHost) {
            // Host disconnected - close the entire room
            console.log(`[Room ${roomId}] Host disconnected, closing room`);
            
            // Notify all listeners that room is closed
            socket.to(roomId).emit('room-closed', { 
                reason: 'Host disconnected' 
            });
            
            // Remove room from memory
            rooms.delete(roomId);
        } else {
            // Listener disconnected - remove from room
            room.listeners.delete(socket.id);
            
            // Notify host that listener left
            io.to(room.hostId).emit('listener-left', { 
                listenerId: socket.id 
            });
            
            // Update listener count
            broadcastListenerCount(roomId);
            
            console.log(`[Room ${roomId}] Listener ${socket.id} left`);
        }
    });

    // -------------------------------------------------------------------------
    // UTILITY EVENTS
    // -------------------------------------------------------------------------
    
    /**
     * Request current listener count (for UI updates)
     */
    socket.on('get-listener-count', (callback) => {
        const count = getListenerCount(socket.roomId);
        callback({ count });
    });

    /**
     * Check if a room exists (for join validation)
     */
    socket.on('check-room', ({ roomId }, callback) => {
        const exists = rooms.has(roomId);
        callback({ exists });
    });

    /**
     * Handle reconnection request from listener
     * Asks host to send a new offer to the listener
     */
    socket.on('request-reconnect', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            callback({ success: false, error: 'Room not found' });
            return;
        }
        
        if (!room.isStreaming) {
            callback({ success: false, error: 'Host not streaming' });
            return;
        }
        
        console.log(`[Reconnect] Listener ${socket.id} requesting reconnect to room ${roomId}`);
        
        // Make sure listener is still in the room
        if (!room.listeners.has(socket.id)) {
            room.listeners.add(socket.id);
        }
        
        // Ask host to create new connection
        io.to(room.hostId).emit('listener-reconnect', { 
            listenerId: socket.id 
        });
        
        callback({ success: true });
    });

    /**
     * Heartbeat/ping to keep connection alive
     */
    socket.on('heartbeat', (callback) => {
        if (callback) callback({ timestamp: Date.now() });
    });
});

// =============================================================================
// START SERVER
// =============================================================================

// HTTP redirect to HTTPS
httpApp.get('*', (req, res) => {
    const host = req.headers.host.split(':')[0];
    res.redirect(`https://${host}:${PORT}${req.url}`);
});

// Start HTTPS server
server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('  MULTIAUDIO - WebRTC Audio Streaming Server (HTTPS)');
    console.log('='.repeat(60));
    console.log(`  HTTPS:    https://localhost:${PORT}`);
    console.log(`  HTTP:     http://localhost:${HTTP_PORT} (redirects to HTTPS)`);
    console.log('');
    console.log('  For mobile testing on same network:');
    console.log('  1. Find your computer\'s local IP (ipconfig / ifconfig)');
    console.log('  2. Open https://YOUR_IP:' + PORT + ' on mobile');
    console.log('  3. Accept the self-signed certificate warning');
    console.log('');
    console.log('  NOTE: Self-signed cert - browser will show warning.');
    console.log('  Click "Advanced" → "Proceed" to continue.');
    console.log('='.repeat(60));
});

// Start HTTP redirect server
httpServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP] Redirect server on port ${HTTP_PORT}`);
});

// Graceful shutdown - use 'once' to prevent multiple calls
let isShuttingDown = false;
process.once('SIGINT', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log('\n[Server] Shutting down...');
    io.emit('server-shutdown');
    
    // Force close after 3 seconds
    setTimeout(() => {
        console.log('[Server] Force closing...');
        process.exit(0);
    }, 3000);
    
    server.close(() => {
        httpServer.close(() => {
            console.log('[Server] Closed');
            process.exit(0);
        });
    });
});
