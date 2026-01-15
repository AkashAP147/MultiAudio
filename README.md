# 🎵 MultiAudio - Live WebRTC Audio Streaming

A mobile-first web application for streaming live audio from one device (HOST) to multiple other devices (LISTENERS) in real-time using WebRTC.

## ✨ Features

- **One-to-Many Streaming**: Single host streams to unlimited listeners
- **True P2P Audio**: Audio flows directly between devices (no server relay)
- **Mobile-First UI**: Designed for mobile browsers
- **Music Quality**: Echo cancellation & noise suppression disabled
- **QR Code Join**: Scan to join a room instantly
- **Live Listener Count**: See how many people are listening
- **Connection Status**: Real-time connection feedback

## 🏗️ Architecture

```
┌─────────────┐         ┌─────────────────┐         ┌─────────────┐
│    HOST     │         │    SERVER       │         │  LISTENERS  │
│  (Phone A)  │         │  (Signaling)    │         │  (Phone B+) │
├─────────────┤         ├─────────────────┤         ├─────────────┤
│ Microphone  │         │ Socket.IO       │         │ Audio Out   │
│     ↓       │         │ Room Management │         │     ↑       │
│ getUserMedia│◄───────►│ Offer/Answer    │◄───────►│ RTCPeer     │
│     ↓       │ Signal  │ ICE Candidates  │ Signal  │ Connection  │
│ WebRTC     ─┼─────────┼─────────────────┼─────────┼─►WebRTC     │
│ Audio Track │  P2P Audio (Direct)       │         │ Audio Track │
└─────────────┘                                     └─────────────┘
```

**Key Points:**
- Server handles **signaling only** (WebSocket messages)
- Audio flows **directly** between Host and Listeners (P2P)
- No audio touches the server = low latency + privacy

## 📋 Prerequisites

- Node.js 16+ installed
- Modern browser (Chrome, Firefox, Safari, Edge)
- Microphone access

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd d:\MULTIAUDIO
npm install
```

### 2. Start the Server

```bash
npm start
```

You'll see:
```
============================================================
  MULTIAUDIO - WebRTC Audio Streaming Server
============================================================
  Local:    http://localhost:3000
  
  For mobile testing on same network:
  1. Find your computer's local IP (ipconfig / ifconfig)
  2. Open http://YOUR_IP:3000 on mobile
  
  NOTE: For HTTPS (required for mic access on mobile),
  use ngrok: ngrok http 3000
============================================================
```

### 3. Open in Browser

**For local testing:**
- Open `http://localhost:3000` in your browser

**For mobile testing (same network):**
1. Find your computer's IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Open `http://YOUR_IP:3000` on your phone

**For mobile testing (different networks):**
Use ngrok to create a secure tunnel:
```bash
ngrok http 3000
```
Then use the HTTPS URL provided by ngrok.

## 📱 How to Use

### As a HOST (Streamer)

1. Open the app
2. Click **"Create Room"**
3. Share the 6-character room code with listeners
4. Click **"Start Streaming"**
5. Allow microphone access when prompted
6. Audio is now streaming live!

### As a LISTENER

1. Open the app
2. Click **"Join Room"**
3. Enter the 6-character room code
4. Click **"Connect"**
5. Tap to enable audio (browser policy)
6. Enjoy the live audio stream!

## 🔧 Technical Details

### Audio Constraints (Optimized for Music)

```javascript
{
    echoCancellation: false,    // Capture ambient audio
    noiseSuppression: false,    // Preserve audio quality
    autoGainControl: false,     // Prevent volume changes
    channelCount: 2,            // Stereo
    sampleRate: 48000,          // High quality
    sampleSize: 16              // 16-bit audio
}
```

### WebRTC Configuration

```javascript
{
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // ... more STUN servers for NAT traversal
    ]
}
```

### Signaling Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `create-room` | Client → Server | Host creates a new room |
| `join-room` | Client → Server | Listener joins a room |
| `offer` | Host → Listener | WebRTC session offer |
| `answer` | Listener → Host | WebRTC session answer |
| `ice-candidate` | Bidirectional | ICE candidate exchange |
| `listener-joined` | Server → Host | New listener notification |
| `listener-count` | Server → All | Updated listener count |

## 📁 File Structure

```
MULTIAUDIO/
├── package.json      # Node.js dependencies
├── server.js         # Express + Socket.IO signaling server
├── index.html        # Mobile-first UI
├── client.js         # WebRTC audio streaming logic
└── README.md         # This file
```

## ⚠️ Important Notes

### HTTPS Requirement

Modern browsers require **HTTPS** for `getUserMedia()` (microphone access) except on `localhost`. Options for mobile testing:

1. **Same network**: Use local IP (some browsers allow this)
2. **ngrok**: `ngrok http 3000` (provides HTTPS URL)
3. **Self-signed certificate**: Configure Express with HTTPS

### Browser Autoplay Policy

Browsers block audio autoplay. Listeners must tap "Enable Audio" once. This is handled automatically by the app.

### Mobile Safari Notes

- iOS Safari requires user gesture to start audio
- Make sure to tap the "Enable Audio" button

## 🐛 Troubleshooting

### "Microphone access denied"
- Check browser permissions
- Ensure HTTPS or localhost
- Try a different browser

### "Room not found"
- Verify the 6-character code
- Make sure host hasn't closed the room
- Check if host is still connected

### "No audio heard"
- Listener: Tap "Enable Audio" button
- Check device volume
- Verify host is streaming

### "Connection failed"
- Check network connectivity
- Firewall may be blocking WebRTC
- Try a different network

## 🔒 Security Considerations

- Room codes are random 6-character strings
- No authentication (anyone with code can join)
- Audio is encrypted in transit (WebRTC DTLS-SRTP)
- Server never handles audio data

## 📈 Scaling

For production with many concurrent rooms:

1. Add Redis for room state
2. Use TURN servers for relay fallback
3. Implement load balancing
4. Add authentication
5. Consider SFU for large audiences

## 📄 License

MIT License - Feel free to use and modify!

---

Built with ❤️ using WebRTC, Socket.IO, and vanilla JavaScript.
