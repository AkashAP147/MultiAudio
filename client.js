/**
 * =============================================================================
 * MULTIAUDIO - WebRTC Client
 * =============================================================================
 * 
 * This file handles all WebRTC logic for live audio streaming.
 * 
 * Key Concepts:
 * - HOST: Captures microphone audio and sends to all listeners
 * - LISTENER: Receives audio stream from host and plays it
 * - One-to-Many: Host creates a separate RTCPeerConnection for each listener
 * 
 * WebRTC Flow:
 * 1. Host captures audio with getUserMedia()
 * 2. When listener joins, host creates offer
 * 3. Listener receives offer and creates answer
 * 4. ICE candidates are exchanged
 * 5. Direct P2P audio stream is established
 * 
 * Audio Settings:
 * - echoCancellation: false (for music quality)
 * - noiseSuppression: false (for music quality)
 * - autoGainControl: false (for consistent volume)
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * WebRTC configuration optimized for LOWEST LATENCY
 */
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ],
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0
};

/**
 * Audio constraints optimized for LOW LATENCY streaming
 */
const AUDIO_CONSTRAINTS = {
    audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
    },
    video: false
};

/**
 * Display media constraints for capturing system/tab audio
 * This captures audio from screen share or browser tab
 */
const DISPLAY_MEDIA_CONSTRAINTS = {
    video: {
        width: 1,      // Minimal video (we only want audio)
        height: 1,
        frameRate: 1
    },
    audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000
    },
    // Prefer audio only, suppress video if possible
    preferCurrentTab: false,
    selfBrowserSurface: 'include',
    systemAudio: 'include',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include'
};

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/**
 * Application state
 */
const state = {
    socket: null,           // Socket.IO connection
    roomId: null,           // Current room ID
    isHost: false,          // Am I the host?
    isStreaming: false,     // Is audio streaming active?
    localStream: null,      // Local audio stream (host only)
    tabStream: null,        // Tab/system audio stream
    micStream: null,        // Microphone stream (optional)
    micEnabled: false,      // Is mic mixed in?
    
    // Audio source type: 'file', 'youtube', 'mic', 'url', 'tab'
    audioSource: 'file',    // Default to file for easy use
    audioElement: null,     // For URL/file streaming
    selectedFile: null,     // Selected media file
    
    // Host maintains connections to all listeners
    // Map<listenerId, RTCPeerConnection>
    peerConnections: new Map(),
    
    // Listener has single connection to host
    hostConnection: null,
    hostId: null,           // Store host ID for reconnection
    
    // Audio context for visualization
    audioContext: null,
    analyser: null,
    
    // Audio enabled flag (user has tapped)
    audioEnabled: false,
    
    // Remote stream reference
    remoteStream: null,
    
    // Audio mixer nodes
    mixerDestination: null,
    
    // Pending rejoin room ID (for session restore)
    pendingRejoin: null,
    
    // QR Scanner state
    scannerStream: null,
    scannerActive: false,
    scannerAnimationId: null,
    
    // Mobile detection
    isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
    
    // Reconnection state
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 2000,
    reconnectTimer: null,
    isReconnecting: false,
    lastOffer: null,        // Store last offer for reconnection
    connectionHealthCheck: null,
    
    // Low-latency playback context for listener
    playbackContext: null,
    
    // Keep track of ICE gathering state
    iceGatheringComplete: new Map()
};

// =============================================================================
// DOM ELEMENTS
// =============================================================================

const elements = {
    // Screens
    screenHome: document.getElementById('screen-home'),
    screenHost: document.getElementById('screen-host'),
    screenJoin: document.getElementById('screen-join'),
    screenListener: document.getElementById('screen-listener'),
    screenScanner: document.getElementById('screen-scanner'),
    
    // Buttons
    btnCreateRoom: document.getElementById('btn-create-room'),
    btnJoinRoom: document.getElementById('btn-join-room'),
    btnScanQr: document.getElementById('btn-scan-qr'),
    btnBackHost: document.getElementById('btn-back-host'),
    btnBackJoin: document.getElementById('btn-back-join'),
    btnBackListener: document.getElementById('btn-back-listener'),
    btnBackScanner: document.getElementById('btn-back-scanner'),
    btnConnect: document.getElementById('btn-connect'),
    btnStartStream: document.getElementById('btn-start-stream'),
    btnStopStream: document.getElementById('btn-stop-stream'),
    btnCopyCode: document.getElementById('btn-copy-code'),
    btnEnableAudio: document.getElementById('btn-enable-audio'),
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    btnOpenScanner: document.getElementById('btn-open-scanner'),
    btnEnterCodeInstead: document.getElementById('btn-enter-code-instead'),
    
    // Audio source buttons
    btnSourceTab: document.getElementById('btn-source-tab'),
    btnSourceMic: document.getElementById('btn-source-mic'),
    btnSourceUrl: document.getElementById('btn-source-url'),
    btnSourceFile: document.getElementById('btn-source-file'),
    btnSourceYoutube: document.getElementById('btn-source-youtube'),
    audioUrlContainer: document.getElementById('audio-url-container'),
    inputAudioUrl: document.getElementById('input-audio-url'),
    mobileNotice: document.getElementById('mobile-notice'),
    
    // File input elements
    fileInputContainer: document.getElementById('file-input-container'),
    inputMediaFile: document.getElementById('input-media-file'),
    btnChooseFile: document.getElementById('btn-choose-file'),
    selectedFileName: document.getElementById('selected-file-name'),
    
    // YouTube input elements
    youtubeUrlContainer: document.getElementById('youtube-url-container'),
    inputYoutubeUrl: document.getElementById('input-youtube-url'),
    
    // Media player elements
    mediaPlayerContainer: document.getElementById('media-player-container'),
    localMediaPlayer: document.getElementById('local-media-player'),
    btnPlayerPlay: document.getElementById('btn-player-play'),
    btnPlayerPause: document.getElementById('btn-player-pause'),
    btnPlayerBack: document.getElementById('btn-player-back'),
    btnPlayerForward: document.getElementById('btn-player-forward'),
    playerVolume: document.getElementById('player-volume'),
    playerCurrentTime: document.getElementById('player-current-time'),
    playerDuration: document.getElementById('player-duration'),
    
    // Inputs
    inputRoomCode: document.getElementById('input-room-code'),
    
    // Displays
    roomCodeDisplay: document.getElementById('room-code-display'),
    hostListenerCount: document.getElementById('host-listener-count'),
    listenerListenerCount: document.getElementById('listener-listener-count'),
    listenerRoomCode: document.getElementById('listener-room-code'),
    
    // Status elements
    homeConnectionDot: document.getElementById('home-connection-dot'),
    homeConnectionText: document.getElementById('home-connection-text'),
    hostConnectionDot: document.getElementById('host-connection-dot'),
    hostConnectionText: document.getElementById('host-connection-text'),
    hostStreamStatus: document.getElementById('host-stream-status'),
    hostMessage: document.getElementById('host-message'),
    listenerConnectionDot: document.getElementById('listener-connection-dot'),
    listenerConnectionText: document.getElementById('listener-connection-text'),
    listenerStatus: document.getElementById('listener-status'),
    
    // Visualizers
    hostVisualizer: document.getElementById('host-visualizer'),
    listenerVisualizer: document.getElementById('listener-visualizer'),
    
    // Audio
    remoteAudio: document.getElementById('remote-audio'),
    
    // Mute button
    listenerMuteBtn: document.getElementById('listener-mute-btn'),
    muteIconOff: document.getElementById('mute-icon-off'),
    muteIconOn: document.getElementById('mute-icon-on'),
    
    // Overlays
    tapOverlay: document.getElementById('tap-overlay'),
    joinError: document.getElementById('join-error'),
    
    // QR Code
    qrcode: document.getElementById('qrcode'),
    
    // QR Scanner
    scannerVideo: document.getElementById('scanner-video'),
    scannerContainer: document.getElementById('scanner-container'),
    scannerStatus: document.getElementById('scanner-status')
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Show a specific screen, hide all others
 */
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
}

/**
 * Update connection status display
 */
function updateConnectionStatus(isHost, connected, text) {
    const dot = isHost ? elements.hostConnectionDot : elements.listenerConnectionDot;
    const textEl = isHost ? elements.hostConnectionText : elements.listenerConnectionText;
    
    if (dot && textEl) {
        dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
        textEl.textContent = text;
    }
    
    // Also update home screen status
    if (elements.homeConnectionDot && elements.homeConnectionText) {
        elements.homeConnectionDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
        elements.homeConnectionText.textContent = connected ? 'Connected to server' : (text || 'Disconnected');
    }
}

// =============================================================================
// LOW LATENCY AUDIO FUNCTIONS
// =============================================================================



/**
 * Generate QR code for room URL
 * Uses qrcode-generator library
 */
function generateQRCode(roomId) {
    const url = `${window.location.origin}?room=${roomId}`;
    console.log('[QR] Generating QR code for:', url);
    
    // Clear existing QR code
    elements.qrcode.innerHTML = '';
    
    try {
        // qrcode-generator library exposes itself as 'qrcode' function
        if (typeof qrcode === 'function') {
            // Type 0 = auto-detect, Error correction level L
            const qr = qrcode(0, 'M');
            qr.addData(url);
            qr.make();
            
            // Create image from QR code
            const img = document.createElement('img');
            img.src = qr.createDataURL(4, 4); // cell size 4, margin 4
            img.alt = 'Room QR Code';
            img.style.cssText = 'border-radius: 8px; background: white;';
            
            elements.qrcode.appendChild(img);
            console.log('[QR] QR code generated successfully');
        } else {
            console.warn('[QR] qrcode-generator not loaded');
            createFallbackQR(url);
        }
    } catch (err) {
        console.error('[QR] Error generating QR code:', err);
        createFallbackQR(url);
    }
}

/**
 * Create a fallback text display if QR library fails
 */
function createFallbackQR(url) {
    const fallback = document.createElement('div');
    fallback.style.cssText = 'background:#fff; color:#333; padding:15px; border-radius:8px; text-align:center; font-size:12px; word-break:break-all;';
    fallback.innerHTML = `<strong>Share this link:</strong><br><br>${url}`;
    elements.qrcode.appendChild(fallback);
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        return true;
    }
}

// =============================================================================
// SOCKET.IO CONNECTION
// =============================================================================

/**
 * Initialize Socket.IO connection with robust reconnection handling
 */
function initSocket() {
    // Connect to signaling server with optimized settings
    state.socket = io({
        transports: ['websocket', 'polling'], // WebSocket preferred, polling fallback
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        forceNew: false
    });

    // Connection established
    state.socket.on('connect', () => {
        console.log('[Socket] Connected:', state.socket.id);
        state.reconnectAttempts = 0;
        state.isReconnecting = false;
        updateConnectionStatus(state.isHost, true, 'Connected');
        removeReconnectingIndicator();
        
        // If we have a pending rejoin from session restore, do it now
        if (state.pendingRejoin) {
            completeSessionRestore();
        }
        
        // If we were in a room and got disconnected, try to rejoin
        if (state.roomId && !state.isHost && !state.pendingRejoin) {
            console.log('[Socket] Reconnected, rejoining room:', state.roomId);
            rejoinRoom();
        }
    });

    // Connection lost
    state.socket.on('disconnect', (reason) => {
        console.log('[Socket] Disconnected:', reason);
        updateConnectionStatus(state.isHost, false, 'Disconnected');
        
        // Show reconnecting indicator if we were in a room
        if (state.roomId) {
            showReconnectingIndicator();
        }
    });
    
    // Reconnection attempt
    state.socket.on('reconnect_attempt', (attemptNumber) => {
        console.log('[Socket] Reconnection attempt:', attemptNumber);
        state.isReconnecting = true;
        updateConnectionStatus(state.isHost, false, `Reconnecting (${attemptNumber})...`);
    });
    
    // Reconnection failed
    state.socket.on('reconnect_failed', () => {
        console.log('[Socket] Reconnection failed');
        updateConnectionStatus(state.isHost, false, 'Connection failed');
        showConnectionError('Unable to connect. Please check your network and refresh the page.');
    });
    
    // Connection error
    state.socket.on('connect_error', (error) => {
        console.log('[Socket] Connection error:', error.message);
    });

    // ==========================================================================
    // HOST-SPECIFIC EVENTS
    // ==========================================================================

    /**
     * New listener joined - create WebRTC connection
     */
    state.socket.on('listener-joined', async ({ listenerId }) => {
        console.log('[Host] Listener joined:', listenerId);
        
        if (state.isHost && state.isStreaming && state.localStream) {
            console.log('[Host] Creating connection to new listener');
            await createConnectionToListener(listenerId);
        } else {
            console.log('[Host] Not streaming yet, will connect when streaming starts');
        }
        
        elements.hostMessage.textContent = 'Listener connected!';
        elements.hostMessage.className = 'message success';
    });

    /**
     * Received list of existing listeners when streaming starts
     */
    state.socket.on('existing-listeners', async ({ listenerIds }) => {
        console.log('[Host] Existing listeners:', listenerIds);
        
        if (state.isHost && state.isStreaming && state.localStream) {
            for (const listenerId of listenerIds) {
                if (!state.peerConnections.has(listenerId)) {
                    console.log('[Host] Creating connection to existing listener:', listenerId);
                    await createConnectionToListener(listenerId);
                }
            }
        }
    });

    /**
     * Listener left - clean up connection
     */
    state.socket.on('listener-left', ({ listenerId }) => {
        console.log('[Host] Listener left:', listenerId);
        
        const pc = state.peerConnections.get(listenerId);
        if (pc) {
            pc.close();
            state.peerConnections.delete(listenerId);
        }
        state.iceGatheringComplete.delete(listenerId);
    });

    /**
     * Listener requesting reconnection - create new connection
     */
    state.socket.on('listener-reconnect', async ({ listenerId }) => {
        console.log('[Host] Listener requesting reconnection:', listenerId);
        
        // Close existing connection if any
        const existingPc = state.peerConnections.get(listenerId);
        if (existingPc) {
            existingPc.close();
            state.peerConnections.delete(listenerId);
        }
        
        // Create new connection if we're streaming
        if (state.isHost && state.isStreaming && state.localStream) {
            await createConnectionToListener(listenerId);
        }
    });

    /**
     * Received answer from listener
     */
    state.socket.on('answer', async ({ answer, listenerId }) => {
        console.log('[Host] Received answer from:', listenerId);
        
        const pc = state.peerConnections.get(listenerId);
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log('[Host] Remote description set for:', listenerId);
            } catch (err) {
                console.error('[Host] Error setting remote description:', err);
            }
        }
    });

    // ==========================================================================
    // LISTENER-SPECIFIC EVENTS
    // ==========================================================================

    /**
     * Received offer from host
     */
    state.socket.on('offer', async ({ offer, hostId }) => {
        console.log('[Listener] Received offer from host:', hostId);
        console.log('[Listener] Offer type:', offer.type);
        
        if (!state.isHost) {
            // Store host ID for potential reconnection
            state.hostId = hostId;
            await handleOfferFromHost(offer, hostId);
        }
    });

    /**
     * Host streaming status changed
     */
    state.socket.on('host-streaming', ({ isStreaming }) => {
        console.log('[Listener] Host streaming status:', isStreaming);
        
        if (isStreaming) {
            elements.listenerStatus.textContent = 'Host started streaming! Connecting...';
            elements.listenerStatus.className = 'message success';
            // Host will send an offer soon
        } else {
            elements.listenerStatus.textContent = 'Host stopped streaming';
            elements.listenerStatus.className = 'message warning';
            elements.listenerVisualizer.classList.remove('active');
            // Close connection
            if (state.hostConnection) {
                state.hostConnection.close();
                state.hostConnection = null;
            }
            elements.remoteAudio.srcObject = null;
            state.remoteStream = null;
        }
    });

    /**
     * Room was closed by host
     */
    state.socket.on('room-closed', ({ reason }) => {
        console.log('[Listener] Room closed:', reason);
        alert('Room closed: ' + reason);
        leaveRoom();
    });

    // ==========================================================================
    // COMMON EVENTS
    // ==========================================================================

    /**
     * ICE candidate received
     */
    state.socket.on('ice-candidate', async ({ candidate, senderId }) => {
        console.log('[WebRTC] ICE candidate from:', senderId);
        
        let pc;
        if (state.isHost) {
            pc = state.peerConnections.get(senderId);
        } else {
            pc = state.hostConnection;
        }
        
        if (pc && candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('[WebRTC] Error adding ICE candidate:', err);
            }
        }
    });

    /**
     * Listener count update
     */
    state.socket.on('listener-count', ({ count }) => {
        console.log('[Room] Listener count:', count);
        elements.hostListenerCount.textContent = count;
        elements.listenerListenerCount.textContent = count;
    });

    /**
     * Server shutdown
     */
    state.socket.on('server-shutdown', () => {
        alert('Server is shutting down. Please refresh when server is back.');
    });
}

// =============================================================================
// HOST FUNCTIONS
// =============================================================================

/**
 * Create a new room as host
 */
async function createRoom() {
    // Check if socket is connected
    if (!state.socket || !state.socket.connected) {
        console.error('[Host] Socket not connected');
        alert('Not connected to server. Please wait for connection and try again.');
        return;
    }
    
    state.isHost = true;
    
    console.log('[Host] Creating room...');
    state.socket.emit('create-room', (response) => {
        console.log('[Host] Create room response:', response);
        
        if (response.success) {
            state.roomId = response.roomId;
            
            // Update UI
            elements.roomCodeDisplay.textContent = state.roomId;
            elements.hostListenerCount.textContent = '0';
            updateConnectionStatus(true, true, 'Connected');
            
            // Generate QR code
            generateQRCode(state.roomId);
            
            // Show host screen
            showScreen('screen-host');
            
            console.log('[Host] Room created:', state.roomId);
            
            // Check mobile and set default audio source
            initAudioSourceUI();
        } else {
            console.error('[Host] Failed to create room:', response.error || 'Unknown error');
            alert('Failed to create room: ' + (response.error || 'Unknown error'));
        }
    });
}

/**
 * Initialize audio source UI based on device
 */
function initAudioSourceUI() {
    console.log('[Host] Device is mobile:', state.isMobile);
    
    // Show mobile notice if on mobile
    if (state.isMobile && elements.mobileNotice) {
        elements.mobileNotice.classList.remove('hidden');
    }
    
    // Disable tab audio on mobile
    if (state.isMobile && elements.btnSourceTab) {
        elements.btnSourceTab.classList.add('disabled');
        const desc = elements.btnSourceTab.querySelector('.desc');
        if (desc) desc.textContent = 'Not available on mobile devices';
    }
    
    // Set default source - file is best for most users
    state.audioSource = 'file';
    updateAudioSourceUI();
}

/**
 * Update audio source button UI
 */
function updateAudioSourceUI() {
    // Remove active class from all source buttons
    const sourceButtons = [
        elements.btnSourceTab,
        elements.btnSourceMic,
        elements.btnSourceUrl,
        elements.btnSourceFile,
        elements.btnSourceYoutube
    ];
    sourceButtons.forEach(btn => {
        if (btn) btn.classList.remove('active');
    });
    
    // Hide all input containers
    if (elements.audioUrlContainer) elements.audioUrlContainer.classList.add('hidden');
    if (elements.fileInputContainer) elements.fileInputContainer.classList.add('hidden');
    if (elements.youtubeUrlContainer) elements.youtubeUrlContainer.classList.add('hidden');
    if (elements.mediaPlayerContainer) elements.mediaPlayerContainer.classList.add('hidden');
    
    // Activate selected source and show relevant input
    switch (state.audioSource) {
        case 'file':
            if (elements.btnSourceFile) elements.btnSourceFile.classList.add('active');
            if (elements.fileInputContainer) elements.fileInputContainer.classList.remove('hidden');
            break;
        case 'youtube':
            if (elements.btnSourceYoutube) elements.btnSourceYoutube.classList.add('active');
            if (elements.youtubeUrlContainer) elements.youtubeUrlContainer.classList.remove('hidden');
            break;
        case 'mic':
            if (elements.btnSourceMic) elements.btnSourceMic.classList.add('active');
            break;
        case 'url':
            if (elements.btnSourceUrl) elements.btnSourceUrl.classList.add('active');
            if (elements.audioUrlContainer) elements.audioUrlContainer.classList.remove('hidden');
            break;
        case 'tab':
            if (elements.btnSourceTab) elements.btnSourceTab.classList.add('active');
            break;
    }
}

/**
 * Start audio streaming based on selected source
 */
async function startStreaming() {
    console.log('[Host] Starting streaming with source:', state.audioSource);
    
    try {
        switch (state.audioSource) {
            case 'file':
                await startFileStreaming();
                break;
            case 'youtube':
                await startYoutubeStreaming();
                break;
            case 'tab':
                await startTabAudioStreaming();
                break;
            case 'mic':
                await startMicStreaming();
                break;
            case 'url':
                await startUrlStreaming();
                break;
            default:
                throw new Error('Unknown audio source');
        }
    } catch (err) {
        console.error('[Host] Error starting stream:', err);
        elements.hostMessage.textContent = err.message || 'Failed to start streaming';
        elements.hostMessage.className = 'message error';
    }
}

/**
 * Start streaming from local file
 */
async function startFileStreaming() {
    if (!state.selectedFile) {
        throw new Error('Please select an audio or video file first');
    }
    
    console.log('[Host] Starting file streaming:', state.selectedFile.name);
    
    // Create object URL for the file
    const fileUrl = URL.createObjectURL(state.selectedFile);
    
    // Set up the media player
    const player = elements.localMediaPlayer;
    player.src = fileUrl;
    player.loop = true;
    
    // Wait for media to load
    await new Promise((resolve, reject) => {
        player.onloadedmetadata = resolve;
        player.onerror = () => reject(new Error('Failed to load media file'));
        setTimeout(() => reject(new Error('Media file loading timeout')), 10000);
    });
    
    // Create audio context for capture
    if (!state.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.audioContext = new AudioContextClass();
    }
    const ctx = state.audioContext;
    
    // Resume if suspended
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    
    // For video/audio element, capture the stream
    let stream;
    if (player.captureStream) {
        stream = player.captureStream();
    } else if (player.mozCaptureStream) {
        stream = player.mozCaptureStream();
    } else {
        // Fallback: use MediaElementSource with low-latency destination
        const source = ctx.createMediaElementSource(player);
        const destination = ctx.createMediaStreamDestination();
        source.connect(destination);
        source.connect(ctx.destination); // Also play locally
        stream = destination.stream;
    }
    
    // Get only audio tracks
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
        throw new Error('No audio track in the media file');
    }
    
    state.localStream = new MediaStream(audioTracks);
    state.audioElement = player;
    
    // Show player and start playback
    if (elements.mediaPlayerContainer) {
        elements.mediaPlayerContainer.classList.remove('hidden');
    }
    
    await player.play();
    
    finishStreamingSetup('File streaming');
}

/**
 * Start streaming from YouTube via server proxy
 */
async function startYoutubeStreaming() {
    const url = elements.inputYoutubeUrl?.value?.trim();
    
    if (!url) {
        throw new Error('Please enter a YouTube URL');
    }
    
    // Extract video ID to validate URL format
    const videoId = extractYoutubeVideoId(url);
    if (!videoId) {
        throw new Error('Invalid YouTube URL. Please use a valid YouTube video link.');
    }
    
    console.log('[Host] YouTube video ID:', videoId);
    elements.hostMessage.textContent = 'Loading YouTube video info...';
    elements.hostMessage.className = 'message info';
    
    try {
        // Get video info from server
        const infoResponse = await fetch(`/youtube-info?url=${encodeURIComponent(url)}`);
        if (!infoResponse.ok) {
            const errorData = await infoResponse.json();
            throw new Error(errorData.error || 'Failed to get video info');
        }
        const videoInfo = await infoResponse.json();
        console.log('[Host] Video info:', videoInfo);
        
        elements.hostMessage.textContent = `Loading: ${videoInfo.title}...`;
        
        // Use proxied audio stream (bypasses CORS)
        const audioUrl = `/youtube-audio?url=${encodeURIComponent(url)}`;
        
        // Create audio context
        if (!state.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioContext = new AudioContextClass();
        }
        const audioContext = state.audioContext;
        
        // Resume if suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Create audio element with proxied URL
        const player = elements.localMediaPlayer;
        player.src = audioUrl;
        
        if (elements.mediaPlayerContainer) {
            elements.mediaPlayerContainer.classList.remove('hidden');
            // Update title display
            const titleEl = elements.mediaPlayerContainer.querySelector('.media-title');
            if (titleEl) {
                titleEl.textContent = videoInfo.title;
            }
        }
        
        // Wait for audio to be ready
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('YouTube audio loading timeout')), 60000);
            
            player.oncanplay = () => {
                clearTimeout(timeout);
                resolve();
            };
            
            player.onerror = (e) => {
                clearTimeout(timeout);
                reject(new Error('Failed to load YouTube audio. The video may be restricted.'));
            };
            
            player.load();
        });
        
        console.log('[Host] YouTube audio loaded');
        
        // Create media stream from audio element
        let audioTracks;
        
        if (player.captureStream) {
            const mediaStream = player.captureStream();
            audioTracks = mediaStream.getAudioTracks();
        } else if (player.mozCaptureStream) {
            const mediaStream = player.mozCaptureStream();
            audioTracks = mediaStream.getAudioTracks();
        } else {
            // Fallback: use Web Audio API
            console.log('[Host] Using Web Audio API fallback for YouTube');
            const source = audioContext.createMediaElementSource(player);
            const destination = audioContext.createMediaStreamDestination();
            source.connect(destination);
            source.connect(audioContext.destination); // Also play locally
            audioTracks = destination.stream.getAudioTracks();
        }
        
        if (!audioTracks || audioTracks.length === 0) {
            throw new Error('Could not capture audio from YouTube stream');
        }
        
        state.localStream = new MediaStream(audioTracks);
        state.audioElement = player;
        
        // Start playback
        await player.play();
        
        finishStreamingSetup(`YouTube: ${videoInfo.title}`);
        
    } catch (err) {
        console.error('[Host] YouTube error:', err);
        
        // Show helpful alternatives if proxy fails
        elements.hostMessage.innerHTML = `
            <strong>YouTube Error:</strong> ${err.message}<br><br>
            <strong>Alternatives:</strong><br>
            • Use "Browser Tab" - open YouTube in another tab and share audio<br>
            • Use "Local File" - download the audio and stream it<br>
            • Use "Microphone" - play on speaker and capture via mic
        `;
        elements.hostMessage.className = 'message error';
        
        throw err;
    }
}

/**
 * Extract YouTube video ID from URL
 */
function extractYoutubeVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/v\/([^&\n?#]+)/,
        /youtube\.com\/shorts\/([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

/**
 * Format seconds to mm:ss or hh:mm:ss
 */
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Start streaming from browser tab (Desktop only)
 */
async function startTabAudioStreaming() {
    console.log('[Host] Requesting screen/tab audio capture...');
    
    // Request display media - this allows capturing tab or system audio
    state.tabStream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
    
    console.log('[Host] Display media access granted');
    
    // Check if we got audio
    const audioTracks = state.tabStream.getAudioTracks();
    if (audioTracks.length === 0) {
        throw new Error('No audio track captured. Make sure to check "Share audio" or "Share tab audio" in the dialog.');
    }
    
    console.log('[Host] Audio tracks:', audioTracks);
    
    // Stop video track if present (we only need audio)
    const videoTracks = state.tabStream.getVideoTracks();
    videoTracks.forEach(track => track.stop());
    
    // Create audio-only stream from tab
    state.tabStream = new MediaStream(audioTracks);
    
    // Handle track ending (user stops sharing)
    audioTracks[0].onended = () => {
        console.log('[Host] Audio track ended');
        stopStreaming();
    };
    
    // Use tab audio as the main stream
    state.localStream = state.tabStream;
    
    finishStreamingSetup('Tab audio streaming');
}

/**
 * Start streaming from microphone
 */
async function startMicStreaming() {
    console.log('[Host] Requesting microphone access...');
    
    state.micStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    
    console.log('[Host] Microphone access granted');
    
    const audioTracks = state.micStream.getAudioTracks();
    console.log('[Host] Mic audio tracks:', audioTracks);
    
    // Handle track ending
    audioTracks[0].onended = () => {
        console.log('[Host] Microphone track ended');
        stopStreaming();
    };
    
    state.localStream = state.micStream;
    state.micEnabled = true;
    
    finishStreamingSetup('Microphone streaming');
}

/**
 * Start streaming from audio URL
 */
async function startUrlStreaming() {
    const url = elements.inputAudioUrl?.value?.trim();
    
    if (!url) {
        throw new Error('Please enter an audio URL');
    }
    
    console.log('[Host] Starting URL audio stream:', url);
    
    // Create audio element
    state.audioElement = document.createElement('audio');
    state.audioElement.crossOrigin = 'anonymous';
    state.audioElement.src = url;
    state.audioElement.loop = true;
    
    // Wait for audio to be loadable
    await new Promise((resolve, reject) => {
        state.audioElement.oncanplay = resolve;
        state.audioElement.onerror = () => reject(new Error('Failed to load audio URL. Check if the URL is valid and allows cross-origin access.'));
        setTimeout(() => reject(new Error('Audio URL loading timeout')), 10000);
    });
    
    // Create audio context for capture
    if (!state.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.audioContext = new AudioContextClass();
    }
    const ctx = state.audioContext;
    
    // Resume if suspended
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    
    const source = ctx.createMediaElementSource(state.audioElement);
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    source.connect(ctx.destination); // Also play locally
    
    state.localStream = destination.stream;
    
    // Start playing
    await state.audioElement.play();
    
    finishStreamingSetup('URL audio streaming');
}

/**
 * Finish streaming setup (common for all sources)
 */
function finishStreamingSetup(message) {
    state.isStreaming = true;
    state.micEnabled = state.audioSource === 'mic';
    
    // Update UI
    elements.btnStartStream.classList.add('hidden');
    elements.btnStopStream.classList.remove('hidden');
    
    // Only show mic toggle for tab streaming
    if (state.audioSource === 'tab') {
        elements.btnToggleMic.classList.remove('hidden');
    }
    
    // Hide audio source options while streaming
    const sourceOptions = document.getElementById('audio-source-options');
    if (sourceOptions) sourceOptions.style.display = 'none';
    if (elements.audioUrlContainer) elements.audioUrlContainer.classList.add('hidden');
    
    elements.hostStreamStatus.textContent = 'Streaming';
    elements.hostVisualizer.classList.add('active');
    elements.hostMessage.textContent = message + ' active!';
    elements.hostMessage.className = 'message success';
    
    updateMicButtonState();
    
    // Notify server
    state.socket.emit('streaming-started');
    
    // Set up audio visualization
    setupAudioVisualization(state.localStream, 'host');
}

/**
 * Update mic button visual state
 */
function updateMicButtonState() {
    if (state.micEnabled) {
        elements.btnToggleMic.innerHTML = '<svg class="icon-svg" style="width:1em;height:1em;margin-right:4px;"><use href="#icon-mic"/></svg> Mic ON';
        elements.btnToggleMic.className = 'btn btn-success mt-sm';
    } else {
        elements.btnToggleMic.innerHTML = '<svg class="icon-svg" style="width:1em;height:1em;margin-right:4px;"><use href="#icon-mic-off"/></svg> Mic OFF';
        elements.btnToggleMic.className = 'btn btn-secondary mt-sm';
    }
}

/**
 * Toggle microphone on/off
 * Mixes mic audio with tab audio when enabled
 */
async function toggleMicrophone() {
    if (!state.isStreaming || !state.tabStream) {
        console.log('[Host] Cannot toggle mic - not streaming');
        return;
    }
    
    if (state.micEnabled) {
        // Turn OFF mic
        console.log('[Host] Turning OFF microphone');
        
        // Stop mic stream
        if (state.micStream) {
            state.micStream.getTracks().forEach(t => t.stop());
            state.micStream = null;
        }
        
        // Use tab audio only
        state.localStream = state.tabStream;
        state.micEnabled = false;
        
        // Update all peer connections with tab-only stream
        await updatePeerConnectionsTracks();
        
        elements.hostMessage.textContent = '🎵 Streaming tab audio only. Mic is OFF.';
        
    } else {
        // Turn ON mic
        console.log('[Host] Turning ON microphone');
        
        try {
            // Get microphone
            state.micStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
            console.log('[Host] Microphone access granted');
            
            // Mix tab + mic audio
            state.localStream = await mixAudioStreams(state.tabStream, state.micStream);
            state.micEnabled = true;
            
            // Update all peer connections with mixed stream
            await updatePeerConnectionsTracks();
            
            elements.hostMessage.textContent = '🎵🎙️ Streaming tab audio + mic. Mic is ON.';
            
        } catch (err) {
            console.error('[Host] Error accessing microphone:', err);
            elements.hostMessage.textContent = 'Could not access microphone: ' + err.message;
            elements.hostMessage.className = 'message error';
            return;
        }
    }
    
    updateMicButtonState();
    setupAudioVisualization(state.localStream, 'host');
}

/**
 * Mix two audio streams into one using Web Audio API
 */
async function mixAudioStreams(stream1, stream2) {
    console.log('[Host] Mixing audio streams');
    
    // Create audio context
    if (!state.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.audioContext = new AudioContextClass();
    }
    const ctx = state.audioContext;
    
    // Create sources from both streams
    const source1 = ctx.createMediaStreamSource(stream1);
    const source2 = ctx.createMediaStreamSource(stream2);
    
    // Create a gain node for mic (can adjust volume)
    const micGain = ctx.createGain();
    micGain.gain.value = 1.0; // Mic volume
    
    // Create a gain node for tab audio
    const tabGain = ctx.createGain();
    tabGain.gain.value = 1.0; // Tab volume
    
    // Create destination
    const destination = ctx.createMediaStreamDestination();
    state.mixerDestination = destination;
    
    // Connect: tab -> tabGain -> destination
    source1.connect(tabGain);
    tabGain.connect(destination);
    
    // Connect: mic -> micGain -> destination
    source2.connect(micGain);
    micGain.connect(destination);
    
    console.log('[Host] Audio streams mixed');
    
    return destination.stream;
}

/**
 * Update tracks on all existing peer connections
 */
async function updatePeerConnectionsTracks() {
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (!audioTrack) {
        console.error('[Host] No audio track to update');
        return;
    }
    
    console.log('[Host] Updating', state.peerConnections.size, 'peer connections with new track');
    
    for (const [listenerId, pc] of state.peerConnections) {
        try {
            const senders = pc.getSenders();
            const audioSender = senders.find(s => s.track?.kind === 'audio');
            
            if (audioSender) {
                await audioSender.replaceTrack(audioTrack);
                console.log('[Host] Replaced track for listener:', listenerId);
            } else {
                // No existing audio sender, add the track
                pc.addTrack(audioTrack, state.localStream);
                console.log('[Host] Added track for listener:', listenerId);
            }
        } catch (err) {
            console.error('[Host] Error updating track for', listenerId, ':', err);
        }
    }
}

/**
 * Stop audio streaming
 */
function stopStreaming() {
    console.log('[Host] Stopping stream...');
    
    // Stop tab stream
    if (state.tabStream) {
        state.tabStream.getTracks().forEach(track => track.stop());
        state.tabStream = null;
    }
    
    // Stop mic stream
    if (state.micStream) {
        state.micStream.getTracks().forEach(track => track.stop());
        state.micStream = null;
    }
    
    // Stop local stream
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    
    // Stop audio element if URL streaming
    if (state.audioElement) {
        state.audioElement.pause();
        state.audioElement.src = '';
        state.audioElement = null;
    }
    
    // Reset selected file
    state.selectedFile = null;
    
    // Hide media player container
    if (elements.mediaPlayerContainer) {
        elements.mediaPlayerContainer.classList.add('hidden');
    }
    
    // Close all peer connections
    state.peerConnections.forEach((pc, listenerId) => {
        pc.close();
    });
    state.peerConnections.clear();
    
    // Reset mixer
    state.mixerDestination = null;
    
    // Update state
    state.isStreaming = false;
    state.micEnabled = false;
    
    // Update UI
    elements.btnStartStream.classList.remove('hidden');
    elements.btnStopStream.classList.add('hidden');
    elements.btnToggleMic.classList.add('hidden');
    elements.hostStreamStatus.textContent = 'Not streaming';
    elements.hostVisualizer.classList.remove('active');
    elements.hostMessage.textContent = 'Streaming stopped. Select a source to start again.';
    elements.hostMessage.className = 'message info';
    
    // Show audio source options again
    const sourceOptions = document.getElementById('audio-source-options');
    if (sourceOptions) sourceOptions.style.display = '';
    updateAudioSourceUI();
    
    // Notify server
    state.socket.emit('streaming-stopped');
}

/**
 * Create WebRTC connection to a specific listener
 */
async function createConnectionToListener(listenerId) {
    console.log('[Host] Creating connection to listener:', listenerId);
    
    // Create new peer connection
    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.peerConnections.set(listenerId, pc);
    
    // Add local audio track to connection with low latency settings
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, state.localStream);
            
            // Set encoding parameters for low latency
            if (sender && sender.setParameters) {
                setTimeout(async () => {
                    try {
                        const params = sender.getParameters();
                        if (!params.encodings || params.encodings.length === 0) {
                            params.encodings = [{}];
                        }
                        // Ultra-low latency encoding settings
                        params.encodings[0].maxBitrate = 128000;      // 128kbps
                        params.encodings[0].priority = 'high';         // High priority
                        params.encodings[0].networkPriority = 'high';  // Network priority
                        params.encodings[0].active = true;
                        // Disable scalability for consistent low latency
                        if ('scalabilityMode' in params.encodings[0]) {
                            delete params.encodings[0].scalabilityMode;
                        }
                        await sender.setParameters(params);
                        console.log('[Host] Low-latency encoding params set for:', listenerId);
                    } catch (e) {
                        console.log('[Host] Could not set encoding params:', e.message);
                    }
                }, 100);
            }
            console.log('[Host] Added track:', track.kind);
        });
    }
    
    // Handle ICE candidates - send immediately for faster connection
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            state.socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: listenerId
            });
        }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        console.log('[Host] Connection state with', listenerId, ':', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
            console.log('[Host] Successfully connected to listener:', listenerId);
            state.iceGatheringComplete.delete(listenerId);
        } else if (pc.connectionState === 'failed') {
            console.log('[Host] Connection failed with listener:', listenerId);
            // Try to restart ICE
            if (pc.restartIce) {
                console.log('[Host] Attempting ICE restart for:', listenerId);
                pc.restartIce();
            } else {
                pc.close();
                state.peerConnections.delete(listenerId);
                state.iceGatheringComplete.delete(listenerId);
            }
        } else if (pc.connectionState === 'disconnected') {
            console.log('[Host] Connection disconnected with listener:', listenerId);
            // Wait a bit before closing - might recover
            setTimeout(() => {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                    console.log('[Host] Connection not recovered, cleaning up:', listenerId);
                    pc.close();
                    state.peerConnections.delete(listenerId);
                    state.iceGatheringComplete.delete(listenerId);
                }
            }, 5000);
        }
    };
    
    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log('[Host] ICE state with', listenerId, ':', pc.iceConnectionState);
    };
    
    try {
        // Create offer with low latency settings
        const offer = await pc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
            voiceActivityDetection: false // Disable VAD for continuous audio
        });
        
        // Simple low-latency SDP modification
        let sdp = offer.sdp;
        sdp = sdp.replace(
            /a=fmtp:111 /g,
            'a=fmtp:111 minptime=10;useinbandfec=0;'
        );
        
        // Set local description
        await pc.setLocalDescription({ type: 'offer', sdp: sdp });
        
        // Send offer to listener
        console.log('[Host] Sending offer to:', listenerId);
        state.socket.emit('offer', {
            offer: pc.localDescription,
            targetId: listenerId
        });
        
    } catch (err) {
        console.error('[Host] Error creating offer:', err);
        pc.close();
        state.peerConnections.delete(listenerId);
    }
}

/**
 * Leave room as host
 */
function leaveRoomAsHost() {
    // Stop streaming if active
    if (state.isStreaming) {
        stopStreaming();
    }
    
    // Disconnect socket (will notify listeners)
    if (state.socket) {
        state.socket.disconnect();
        state.socket.connect();
    }
    
    // Reset state
    state.roomId = null;
    state.isHost = false;
    
    // Return to home screen
    showScreen('screen-home');
}

// =============================================================================
// LISTENER FUNCTIONS
// =============================================================================

/**
 * Join an existing room as listener
 */
async function joinRoom(roomId) {
    state.isHost = false;
    state.roomId = roomId.toUpperCase();
    
    state.socket.emit('join-room', { roomId: state.roomId }, (response) => {
        if (response.success) {
            console.log('[Listener] Joined room:', state.roomId);
            
            // Save session for hot refresh
            saveSession();
            
            // Update UI
            elements.listenerRoomCode.textContent = state.roomId;
            elements.listenerListenerCount.textContent = response.listenerCount;
            updateConnectionStatus(false, true, 'Connected');
            
            if (response.isStreaming) {
                elements.listenerStatus.textContent = 'Host is streaming! Connecting...';
                elements.listenerStatus.className = 'message success';
            } else {
                elements.listenerStatus.textContent = 'Waiting for host to start streaming...';
                elements.listenerStatus.className = 'message info';
            }
            
            // Show listener screen
            showScreen('screen-listener');
            
            // Hide error
            elements.joinError.classList.add('hidden');
            
        } else {
            console.log('[Listener] Failed to join room:', response.error);
            elements.joinError.textContent = response.error || 'Room not found';
            elements.joinError.classList.remove('hidden');
            // Clear invalid session
            clearSession();
        }
    });
}

/**
 * Handle WebRTC offer from host
 */
async function handleOfferFromHost(offer, hostId) {
    console.log('[Listener] Processing offer from host');
    
    // Close existing connection if any
    if (state.hostConnection) {
        state.hostConnection.close();
    }
    
    // Create new peer connection
    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.hostConnection = pc;
    
    // Handle incoming audio stream - direct playback
    pc.ontrack = (event) => {
        console.log('[Listener] Received audio track:', event.track.kind);
        
        // Store remote stream
        state.remoteStream = event.streams[0];
        
        // Get audio element and set stream directly
        const audioEl = elements.remoteAudio;
        audioEl.srcObject = event.streams[0];
        audioEl.volume = 1.0;
        audioEl.muted = false;
        
        // Try to play immediately
        playAudio();
        
        // Update UI
        elements.listenerStatus.textContent = 'Receiving audio stream!';
        elements.listenerStatus.className = 'message success';
        elements.listenerVisualizer.classList.add('active');
        
        // Set up visualization
        setupAudioVisualization(event.streams[0], 'listener');
    };
    
    // Handle ICE candidates - send immediately
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            state.socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: hostId
            });
        }
    };
    
    // Handle connection state changes with reconnection support
    pc.onconnectionstatechange = () => {
        console.log('[Listener] Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
            updateConnectionStatus(false, true, 'Streaming');
            elements.listenerConnectionDot.classList.add('streaming');
            elements.listenerConnectionDot.classList.remove('connection-reconnecting');
            state.reconnectAttempts = 0;
            clearReconnectTimer();
            startConnectionHealthCheck();
        } else if (pc.connectionState === 'disconnected') {
            updateConnectionStatus(false, false, 'Reconnecting...');
            elements.listenerConnectionDot.classList.add('connection-reconnecting');
            elements.listenerVisualizer.classList.remove('active');
            elements.listenerStatus.textContent = 'Connection interrupted. Attempting to reconnect...';
            elements.listenerStatus.className = 'message warning';
            
            // Wait before considering it failed
            setTimeout(() => {
                if (pc.connectionState === 'disconnected') {
                    attemptReconnection();
                }
            }, 3000);
        } else if (pc.connectionState === 'failed') {
            updateConnectionStatus(false, false, 'Connection Lost');
            elements.listenerVisualizer.classList.remove('active');
            elements.listenerStatus.textContent = 'Connection lost. Reconnecting...';
            elements.listenerStatus.className = 'message error';
            attemptReconnection();
        }
    };
    
    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log('[Listener] ICE state:', pc.iceConnectionState);
    };
    
    try {
        // Set remote description (the offer)
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        // Create answer
        const answer = await pc.createAnswer();
        
        // Apply simple low-latency SDP modifications
        let sdp = answer.sdp.replace(/a=fmtp:111 /g, 'a=fmtp:111 minptime=10;useinbandfec=0;');
        
        // Set local description with modified SDP
        await pc.setLocalDescription({ type: 'answer', sdp: sdp });
        
        // Send answer to host
        console.log('[Listener] Sending answer to host');
        state.socket.emit('answer', {
            answer: pc.localDescription,
            targetId: hostId
        });
        
    } catch (err) {
        console.error('[Listener] Error handling offer:', err);
        elements.listenerStatus.textContent = 'Connection error: ' + err.message;
        elements.listenerStatus.className = 'message error';
    }
}

/**
 * Toggle listener mute state
 */
function toggleListenerMute() {
    const audioEl = elements.remoteAudio;
    
    if (audioEl.muted) {
        // Unmute
        audioEl.muted = false;
        elements.listenerMuteBtn.classList.remove('muted');
        elements.muteIconOff.classList.remove('hidden');
        elements.muteIconOn.classList.add('hidden');
        console.log('[Listener] Audio unmuted');
    } else {
        // Mute
        audioEl.muted = true;
        elements.listenerMuteBtn.classList.add('muted');
        elements.muteIconOff.classList.add('hidden');
        elements.muteIconOn.classList.remove('hidden');
        console.log('[Listener] Audio muted');
    }
}

/**
 * Attempt to play audio (handles browser autoplay policy)
 * Uses low-latency audio context
 */
async function playAudio() {
    const audioEl = elements.remoteAudio;
    
    console.log('[Listener] Attempting to play audio...');
    
    // Create low-latency audio context if needed
    if (!state.audioContext) {
        try {
            // Request low latency audio context
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioContext = new AudioContextClass({
                latencyHint: 'interactive', // Lowest latency mode
                sampleRate: 48000
            });
            console.log('[Listener] Created low-latency AudioContext, latency:', state.audioContext.baseLatency);
        } catch (e) {
            console.log('[Listener] Could not create AudioContext:', e);
        }
    }
    
    // Resume audio context if suspended
    if (state.audioContext && state.audioContext.state === 'suspended') {
        try {
            await state.audioContext.resume();
            console.log('[Listener] Audio context resumed');
        } catch (e) {
            console.log('[Listener] Could not resume audio context:', e);
        }
    }
    
    // If user already enabled audio, play immediately
    if (state.audioEnabled) {
        try {
            audioEl.muted = false;
            await audioEl.play();
            console.log('[Listener] Audio playing (already enabled)');
            elements.tapOverlay.classList.remove('active');
            return;
        } catch (err) {
            console.log('[Listener] Play failed even with audioEnabled:', err);
        }
    }
    
    try {
        audioEl.muted = false;
        await audioEl.play();
        console.log('[Listener] Audio playing successfully');
        state.audioEnabled = true;
        elements.tapOverlay.classList.remove('active');
    } catch (err) {
        console.log('[Listener] Audio play blocked:', err.name, err.message);
        // Show tap-to-enable overlay
        elements.tapOverlay.classList.add('active');
    }
}

/**
 * Leave room as listener
 */
function leaveRoom() {
    // Clear saved session
    clearSession();
    
    // Close peer connection
    if (state.hostConnection) {
        state.hostConnection.close();
        state.hostConnection = null;
    }
    
    // Stop audio
    elements.remoteAudio.srcObject = null;
    state.remoteStream = null;
    
    // Disconnect and reconnect socket
    if (state.socket) {
        state.socket.disconnect();
        state.socket.connect();
    }
    
    // Reset state
    state.roomId = null;
    state.isHost = false;
    
    // Hide overlay
    elements.tapOverlay.classList.remove('active');
    
    // Return to home screen
    showScreen('screen-home');
}

// =============================================================================
// AUDIO VISUALIZATION
// =============================================================================

/**
 * Set up basic audio visualization
 * Uses Web Audio API to analyze audio levels
 */
function setupAudioVisualization(stream, type) {
    try {
        // Create audio context if not exists
        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // Create analyser
        const analyser = state.audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        // Connect stream to analyser
        const source = state.audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        // Get visualizer element
        const visualizer = type === 'host' ? elements.hostVisualizer : elements.listenerVisualizer;
        const bars = visualizer.querySelectorAll('.bar');
        
        // Animation loop
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        function animate() {
            if (!state.isStreaming && type === 'host') return;
            if (!state.hostConnection && type === 'listener') return;
            
            analyser.getByteFrequencyData(dataArray);
            
            // Map frequency data to bars
            const step = Math.floor(dataArray.length / bars.length);
            bars.forEach((bar, i) => {
                const value = dataArray[i * step];
                const height = Math.max(10, (value / 255) * 50);
                bar.style.height = `${height}px`;
            });
            
            requestAnimationFrame(animate);
        }
        
        animate();
        
    } catch (err) {
        console.log('[Visualization] Could not set up visualization:', err);
    }
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

/**
 * Initialize all event listeners
 */
function initEventListeners() {
    // ----- Home Screen -----
    
    elements.btnCreateRoom.addEventListener('click', () => {
        createRoom();
    });
    
    elements.btnJoinRoom.addEventListener('click', () => {
        showScreen('screen-join');
    });
    
    // QR Scanner button on home screen
    if (elements.btnScanQr) {
        elements.btnScanQr.addEventListener('click', () => {
            showScreen('screen-scanner');
            startQRScanner();
        });
    }
    
    // ----- Host Screen -----
    
    elements.btnBackHost.addEventListener('click', () => {
        if (confirm('Are you sure you want to close the room?')) {
            leaveRoomAsHost();
        }
    });
    
    // Audio source selection
    if (elements.btnSourceTab) {
        elements.btnSourceTab.addEventListener('click', () => {
            if (!state.isMobile && !state.isStreaming) {
                state.audioSource = 'tab';
                updateAudioSourceUI();
            }
        });
    }
    
    if (elements.btnSourceMic) {
        elements.btnSourceMic.addEventListener('click', () => {
            if (!state.isStreaming) {
                state.audioSource = 'mic';
                updateAudioSourceUI();
            }
        });
    }
    
    if (elements.btnSourceUrl) {
        elements.btnSourceUrl.addEventListener('click', () => {
            if (!state.isStreaming) {
                state.audioSource = 'url';
                updateAudioSourceUI();
            }
        });
    }
    
    // File source button
    if (elements.btnSourceFile) {
        elements.btnSourceFile.addEventListener('click', () => {
            if (!state.isStreaming) {
                state.audioSource = 'file';
                updateAudioSourceUI();
            }
        });
    }
    
    // YouTube source button
    if (elements.btnSourceYoutube) {
        elements.btnSourceYoutube.addEventListener('click', () => {
            if (!state.isStreaming) {
                state.audioSource = 'youtube';
                updateAudioSourceUI();
            }
        });
    }
    
    // File chooser button
    if (elements.btnChooseFile) {
        elements.btnChooseFile.addEventListener('click', () => {
            elements.inputMediaFile?.click();
        });
    }
    
    // File input change
    if (elements.inputMediaFile) {
        elements.inputMediaFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                state.selectedFile = file;
                if (elements.selectedFileName) {
                    elements.selectedFileName.textContent = file.name;
                }
                console.log('[Host] File selected:', file.name, file.type);
            }
        });
    }
    
    // Media player controls
    if (elements.btnPlayerPlay) {
        elements.btnPlayerPlay.addEventListener('click', () => {
            elements.localMediaPlayer?.play();
        });
    }
    
    if (elements.btnPlayerPause) {
        elements.btnPlayerPause.addEventListener('click', () => {
            elements.localMediaPlayer?.pause();
        });
    }
    
    // Seek backward 10 seconds
    if (elements.btnPlayerBack) {
        elements.btnPlayerBack.addEventListener('click', () => {
            if (elements.localMediaPlayer) {
                elements.localMediaPlayer.currentTime = Math.max(0, elements.localMediaPlayer.currentTime - 10);
            }
        });
    }
    
    // Seek forward 10 seconds
    if (elements.btnPlayerForward) {
        elements.btnPlayerForward.addEventListener('click', () => {
            if (elements.localMediaPlayer) {
                elements.localMediaPlayer.currentTime = Math.min(
                    elements.localMediaPlayer.duration || 0,
                    elements.localMediaPlayer.currentTime + 10
                );
            }
        });
    }
    
    if (elements.playerVolume) {
        elements.playerVolume.addEventListener('input', (e) => {
            if (elements.localMediaPlayer) {
                elements.localMediaPlayer.volume = e.target.value / 100;
            }
        });
    }
    
    // Update time display
    if (elements.localMediaPlayer) {
        elements.localMediaPlayer.addEventListener('timeupdate', () => {
            if (elements.playerCurrentTime) {
                elements.playerCurrentTime.textContent = formatTime(elements.localMediaPlayer.currentTime);
            }
        });
        
        elements.localMediaPlayer.addEventListener('loadedmetadata', () => {
            if (elements.playerDuration) {
                elements.playerDuration.textContent = formatTime(elements.localMediaPlayer.duration);
            }
        });
        
        elements.localMediaPlayer.addEventListener('durationchange', () => {
            if (elements.playerDuration) {
                elements.playerDuration.textContent = formatTime(elements.localMediaPlayer.duration);
            }
        });
    }
    
    elements.btnStartStream.addEventListener('click', () => {
        startStreaming();
    });
    
    elements.btnStopStream.addEventListener('click', () => {
        stopStreaming();
    });
    
    elements.btnToggleMic.addEventListener('click', () => {
        toggleMicrophone();
    });
    
    elements.btnCopyCode.addEventListener('click', async () => {
        const success = await copyToClipboard(state.roomId);
        if (success) {
            const originalHtml = elements.btnCopyCode.innerHTML;
            elements.btnCopyCode.innerHTML = '<svg class="icon-svg" style="width:1em;height:1em;margin-right:4px;"><use href="#icon-check"/></svg> Copied!';
            setTimeout(() => {
                elements.btnCopyCode.innerHTML = originalHtml;
            }, 2000);
        }
    });
    
    // ----- Join Screen -----
    
    elements.btnBackJoin.addEventListener('click', () => {
        showScreen('screen-home');
        elements.joinError.classList.add('hidden');
        elements.inputRoomCode.value = '';
    });
    
    elements.btnConnect.addEventListener('click', () => {
        const code = elements.inputRoomCode.value.trim().toUpperCase();
        if (code.length === 6) {
            joinRoom(code);
        } else {
            elements.joinError.textContent = 'Please enter a valid 6-character code';
            elements.joinError.classList.remove('hidden');
        }
    });
    
    // Auto-uppercase and validate input
    elements.inputRoomCode.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        elements.joinError.classList.add('hidden');
    });
    
    // Allow Enter key to join
    elements.inputRoomCode.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            elements.btnConnect.click();
        }
    });
    
    // ----- Listener Screen -----
    
    elements.btnBackListener.addEventListener('click', () => {
        leaveRoom();
    });
    
    // Listener mute button
    if (elements.listenerMuteBtn) {
        elements.listenerMuteBtn.addEventListener('click', () => {
            toggleListenerMute();
        });
    }
    
    // ----- Audio Enable Overlay -----
    
    elements.btnEnableAudio.addEventListener('click', async () => {
        console.log('[Audio] User tapped enable button');
        
        try {
            // Create audio context if needed (user gesture required)
            if (!state.audioContext) {
                state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            // Resume audio context (required by some browsers)
            if (state.audioContext.state === 'suspended') {
                await state.audioContext.resume();
                console.log('[Audio] Context resumed');
            }
            
            // Mark audio as enabled
            state.audioEnabled = true;
            
            // Configure and play audio
            const audioEl = elements.remoteAudio;
            audioEl.muted = false;
            audioEl.volume = 1.0;
            
            // If we have a stream, ensure it's set
            if (state.remoteStream) {
                audioEl.srcObject = state.remoteStream;
            }
            
            await audioEl.play();
            elements.tapOverlay.classList.remove('active');
            console.log('[Audio] Enabled and playing by user tap');
            
            // Update status
            elements.listenerStatus.textContent = 'Audio playing!';
            elements.listenerStatus.className = 'message success';
            
        } catch (err) {
            console.error('[Audio] Still blocked:', err);
            elements.listenerStatus.textContent = 'Tap again to enable audio';
            elements.listenerStatus.className = 'message warning';
        }
    });
    
    // Also allow tapping anywhere on overlay
    elements.tapOverlay.addEventListener('click', (e) => {
        if (e.target === elements.tapOverlay) {
            elements.btnEnableAudio.click();
        }
    });
    
    // ----- QR Scanner Screen -----
    
    if (elements.btnBackScanner) {
        elements.btnBackScanner.addEventListener('click', () => {
            stopQRScanner();
            showScreen('screen-home');
        });
    }
    
    if (elements.btnOpenScanner) {
        elements.btnOpenScanner.addEventListener('click', () => {
            showScreen('screen-scanner');
            startQRScanner();
        });
    }
    
    if (elements.btnEnterCodeInstead) {
        elements.btnEnterCodeInstead.addEventListener('click', () => {
            stopQRScanner();
            showScreen('screen-join');
        });
    }
}

// =============================================================================
// RECONNECTION FUNCTIONS
// =============================================================================

/**
 * Attempt to reconnect to the room
 */
function attemptReconnection() {
    if (state.isReconnecting) {
        console.log('[Reconnect] Already attempting reconnection');
        return;
    }
    
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
        console.log('[Reconnect] Max attempts reached');
        elements.listenerStatus.textContent = 'Unable to reconnect. Please rejoin the room.';
        elements.listenerStatus.className = 'message error';
        return;
    }
    
    state.isReconnecting = true;
    state.reconnectAttempts++;
    
    console.log(`[Reconnect] Attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts}`);
    elements.listenerStatus.textContent = `Reconnecting... (attempt ${state.reconnectAttempts})`;
    elements.listenerStatus.className = 'message warning';
    
    // Close existing connection
    if (state.hostConnection) {
        state.hostConnection.close();
        state.hostConnection = null;
    }
    
    // Request new offer from host via server
    state.socket.emit('request-reconnect', { roomId: state.roomId }, (response) => {
        if (response.success) {
            console.log('[Reconnect] Server acknowledged, waiting for new offer');
        } else {
            console.log('[Reconnect] Server rejected:', response.error);
            state.isReconnecting = false;
            
            // Try again after delay
            state.reconnectTimer = setTimeout(() => {
                attemptReconnection();
            }, state.reconnectDelay * state.reconnectAttempts);
        }
    });
    
    // Set timeout for this attempt
    state.reconnectTimer = setTimeout(() => {
        if (state.isReconnecting) {
            console.log('[Reconnect] Attempt timed out');
            state.isReconnecting = false;
            attemptReconnection();
        }
    }, 10000);
}

/**
 * Rejoin room after socket reconnection
 */
function rejoinRoom() {
    if (!state.roomId) return;
    
    console.log('[Rejoin] Attempting to rejoin room:', state.roomId);
    
    state.socket.emit('join-room', { roomId: state.roomId }, (response) => {
        if (response.success) {
            console.log('[Rejoin] Successfully rejoined room');
            elements.listenerStatus.textContent = 'Reconnected to room!';
            elements.listenerStatus.className = 'message success';
            
            if (response.isStreaming) {
                elements.listenerStatus.textContent = 'Host is streaming! Connecting...';
            }
        } else {
            console.log('[Rejoin] Failed to rejoin:', response.error);
            elements.listenerStatus.textContent = 'Room no longer available';
            elements.listenerStatus.className = 'message error';
            clearSession();
        }
    });
}

/**
 * Clear reconnection timer
 */
function clearReconnectTimer() {
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
}

/**
 * Start connection health check
 */
function startConnectionHealthCheck() {
    stopConnectionHealthCheck();
    
    state.connectionHealthCheck = setInterval(() => {
        if (state.hostConnection) {
            const stats = state.hostConnection.getStats();
            stats.then(report => {
                let packetsReceived = 0;
                report.forEach(stat => {
                    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
                        packetsReceived = stat.packetsReceived;
                    }
                });
                console.log('[Health] Packets received:', packetsReceived);
            }).catch(() => {});
        }
    }, 10000);
}

/**
 * Stop connection health check
 */
function stopConnectionHealthCheck() {
    if (state.connectionHealthCheck) {
        clearInterval(state.connectionHealthCheck);
        state.connectionHealthCheck = null;
    }
}

/**
 * Show reconnecting indicator in UI
 */
function showReconnectingIndicator() {
    const dot = state.isHost ? elements.hostConnectionDot : elements.listenerConnectionDot;
    if (dot) {
        dot.classList.add('connection-reconnecting');
    }
}

/**
 * Remove reconnecting indicator from UI
 */
function removeReconnectingIndicator() {
    const dot = state.isHost ? elements.hostConnectionDot : elements.listenerConnectionDot;
    if (dot) {
        dot.classList.remove('connection-reconnecting');
    }
}

/**
 * Show connection error message
 */
function showConnectionError(message) {
    if (state.isHost) {
        elements.hostMessage.textContent = message;
        elements.hostMessage.className = 'message error';
    } else {
        elements.listenerStatus.textContent = message;
        elements.listenerStatus.className = 'message error';
    }
}

// =============================================================================
// QR CODE SCANNER
// =============================================================================

/**
 * Start the QR code scanner with improved mobile support
 */
async function startQRScanner() {
    if (state.scannerActive) return;
    
    console.log('[Scanner] Starting QR scanner...');
    
    // Reset scanner state
    state.scannerActive = false;
    
    try {
        // Try to get the best camera configuration for QR scanning
        const constraints = {
            video: {
                facingMode: { ideal: 'environment' }, // Prefer back camera
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                focusMode: { ideal: 'continuous' },  // Auto-focus for QR scanning
                exposureMode: { ideal: 'continuous' }
            },
            audio: false
        };
        
        // Request camera access
        state.scannerStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Set video source
        const video = elements.scannerVideo;
        video.srcObject = state.scannerStream;
        video.setAttribute('playsinline', 'true'); // iOS requirement
        video.setAttribute('autoplay', 'true');
        
        // Wait for video to be ready
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Video load timeout')), 10000);
            
            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                video.play().then(resolve).catch(reject);
            };
            
            video.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Video load error'));
            };
        });
        
        state.scannerActive = true;
        elements.scannerStatus.textContent = 'Point camera at QR code...';
        
        console.log('[Scanner] Camera active:', video.videoWidth, 'x', video.videoHeight);
        
        // Apply camera enhancements if supported
        try {
            const track = state.scannerStream.getVideoTracks()[0];
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            
            if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
            if (capabilities.torch) {
                // Could enable torch/flashlight for dark environments
                console.log('[Scanner] Torch available');
            }
        } catch (e) {
            console.log('[Scanner] Camera enhancements not supported:', e.message);
        }
        
        // Start scanning loop with improved settings
        scanQRCode();
        
    } catch (err) {
        console.error('[Scanner] Camera error:', err);
        
        let errorMessage = 'Camera error';
        
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            errorMessage = 'Camera access denied. Please allow camera access in your browser settings.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            errorMessage = 'No camera found. Please use a device with a camera.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            errorMessage = 'Camera is in use by another app. Please close other camera apps.';
        } else if (err.name === 'OverconstrainedError') {
            // Try again with simpler constraints
            try {
                state.scannerStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                const video = elements.scannerVideo;
                video.srcObject = state.scannerStream;
                await video.play();
                state.scannerActive = true;
                elements.scannerStatus.textContent = 'Point camera at QR code...';
                scanQRCode();
                return;
            } catch (e) {
                errorMessage = 'Could not access camera. Please try again.';
            }
        } else {
            errorMessage = 'Camera error: ' + (err.message || 'Unknown error');
        }
        
        elements.scannerStatus.textContent = errorMessage;
    }
}

/**
 * Stop the QR code scanner
 */
function stopQRScanner() {
    console.log('[Scanner] Stopping QR scanner');
    
    state.scannerActive = false;
    
    // Stop animation frame
    if (state.scannerAnimationId) {
        cancelAnimationFrame(state.scannerAnimationId);
        state.scannerAnimationId = null;
    }
    
    // Stop camera stream
    if (state.scannerStream) {
        state.scannerStream.getTracks().forEach(track => track.stop());
        state.scannerStream = null;
    }
    
    // Clear video
    if (elements.scannerVideo) {
        elements.scannerVideo.srcObject = null;
    }
}

/**
 * Scan for QR codes in video feed with improved accuracy
 */
function scanQRCode() {
    if (!state.scannerActive) return;
    
    const video = elements.scannerVideo;
    
    // Wait for video to be ready
    if (video.readyState !== video.HAVE_ENOUGH_DATA || video.videoWidth === 0) {
        state.scannerAnimationId = requestAnimationFrame(scanQRCode);
        return;
    }
    
    // Create canvas to capture frame
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Use video dimensions
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Get image data for jsQR
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Try to detect QR code with different settings
    if (typeof jsQR !== 'undefined') {
        // Try multiple inversion modes for better detection
        let code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth' // Try both normal and inverted
        });
        
        if (code && code.data) {
            console.log('[Scanner] QR code detected:', code.data);
            handleScannedQRCode(code.data);
            return; // Stop scanning after successful scan
        }
    } else {
        console.error('[Scanner] jsQR library not loaded');
        elements.scannerStatus.textContent = 'QR scanner not available. Enter code manually.';
        return;
    }
    
    // Continue scanning at ~15fps for better performance on mobile
    setTimeout(() => {
        if (state.scannerActive) {
            state.scannerAnimationId = requestAnimationFrame(scanQRCode);
        }
    }, 66);
}

/**
 * Handle scanned QR code data with improved parsing
 */
function handleScannedQRCode(data) {
    console.log('[Scanner] Processing QR data:', data);
    
    // Extract room code from URL or direct code
    let roomCode = null;
    
    // Try parsing as URL first
    try {
        const url = new URL(data);
        roomCode = url.searchParams.get('room');
        if (!roomCode) {
            // Try hash-based routing
            const hash = url.hash;
            if (hash && hash.includes('room=')) {
                roomCode = hash.split('room=')[1].split('&')[0];
            }
        }
    } catch (e) {
        // Not a URL - check various formats
    }
    
    // If not found in URL, check if it's a direct code
    if (!roomCode) {
        // Check for 6-character alphanumeric code
        const codeMatch = data.match(/[A-Z0-9]{6}/i);
        if (codeMatch) {
            roomCode = codeMatch[0].toUpperCase();
        }
    }
    
    if (roomCode && /^[A-Z0-9]{6}$/i.test(roomCode)) {
        roomCode = roomCode.toUpperCase();
        console.log('[Scanner] Valid room code found:', roomCode);
        
        // Vibrate for feedback (if supported)
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }
        
        // Update status
        elements.scannerStatus.textContent = 'Room found! Connecting...';
        
        // Stop scanner
        stopQRScanner();
        
        // Join the room
        joinRoom(roomCode);
    } else {
        console.log('[Scanner] Invalid QR code - not a room code:', data);
        elements.scannerStatus.textContent = 'Not a valid room code. Try again...';
        
        // Continue scanning after a short delay
        setTimeout(() => {
            if (state.scannerActive) {
                elements.scannerStatus.textContent = 'Point camera at QR code...';
                state.scannerAnimationId = requestAnimationFrame(scanQRCode);
            }
        }, 1500);
    }
}

// =============================================================================
// URL PARAMETER HANDLING
// =============================================================================

/**
 * Check for room code in URL (for QR code / shared links)
 */
function checkUrlParameters() {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    
    if (roomCode && roomCode.length === 6) {
        console.log('[URL] Found room code:', roomCode);
        
        // Pre-fill room code and show join screen
        elements.inputRoomCode.value = roomCode.toUpperCase();
        showScreen('screen-join');
        
        // Auto-join after short delay
        setTimeout(() => {
            joinRoom(roomCode);
        }, 500);
    }
}

// =============================================================================
// SESSION PERSISTENCE (Hot Refresh Support)
// =============================================================================

/**
 * Save current session to sessionStorage
 * Called when joining/creating a room
 */
function saveSession() {
    if (state.roomId) {
        const session = {
            roomId: state.roomId,
            isHost: state.isHost,
            timestamp: Date.now()
        };
        sessionStorage.setItem('multiaudio_session', JSON.stringify(session));
        console.log('[Session] Saved:', session);
    }
}

/**
 * Clear saved session
 * Called when leaving a room
 */
function clearSession() {
    sessionStorage.removeItem('multiaudio_session');
    console.log('[Session] Cleared');
}

/**
 * Restore session after page refresh
 * Returns true if session was restored
 */
function restoreSession() {
    try {
        const saved = sessionStorage.getItem('multiaudio_session');
        if (!saved) return false;
        
        const session = JSON.parse(saved);
        
        // Check if session is still fresh (within 10 minutes)
        const age = Date.now() - session.timestamp;
        if (age > 10 * 60 * 1000) {
            console.log('[Session] Expired, clearing');
            clearSession();
            return false;
        }
        
        console.log('[Session] Found saved session:', session);
        
        if (session.isHost) {
            // Can't restore host session (would need new room)
            console.log('[Session] Host session cannot be restored');
            clearSession();
            return false;
        }
        
        // Store session data for later
        state.pendingRejoin = session.roomId;
        
        // Show listener screen immediately with "reconnecting" status
        elements.listenerRoomCode.textContent = session.roomId;
        elements.listenerStatus.textContent = 'Reconnecting to room...';
        elements.listenerStatus.className = 'message info';
        showScreen('screen-listener');
        
        return true;
    } catch (err) {
        console.error('[Session] Error restoring:', err);
        clearSession();
        return false;
    }
}

/**
 * Complete the session restore after socket connects
 */
function completeSessionRestore() {
    if (state.pendingRejoin) {
        const roomId = state.pendingRejoin;
        state.pendingRejoin = null;
        console.log('[Session] Completing rejoin to room:', roomId);
        joinRoom(roomId);
    }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the application
 */
function init() {
    console.log('='.repeat(50));
    console.log('  MultiAudio - WebRTC Audio Streaming Client');
    console.log('='.repeat(50));
    
    // Set initial connection status
    updateConnectionStatus(false, false, 'Connecting...');
    
    // Initialize Socket.IO
    initSocket();
    
    // Set up event listeners
    initEventListeners();
    
    // Check for URL parameters first
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    
    if (roomCode && roomCode.length === 6) {
        // URL has room code - use that
        checkUrlParameters();
    } else if (restoreSession()) {
        // Session restored - will auto-join
        console.log('[App] Restoring previous session...');
    } else {
        // No URL param, no session - show home
        showScreen('screen-home');
    }
    
    console.log('[App] Initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// =============================================================================
// DEBUG HELPERS (remove in production)
// =============================================================================

// Expose state for debugging
window.debugState = state;
window.debugElements = elements;
