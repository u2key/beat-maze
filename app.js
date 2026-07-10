// --- DOM Elements ---
const joinOverlay = document.getElementById('join-overlay');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');

const songSelection = document.getElementById('song-selection');
const songsContainer = document.getElementById('songs-container');
const downloadStatus = document.getElementById('download-status');
const startGameBtn = document.getElementById('start-game-btn');
const retryBtn = document.getElementById('retry-btn');
const gameoverOverlay = document.getElementById('gameover-overlay');
const scoreDisplay = document.getElementById('score-display');
const comboDisplay = document.getElementById('combo-display');
const progressDisplay = document.getElementById('progress-display');
const finalScoreEl = document.getElementById('final-score');
const playersList = document.getElementById('players-list');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const leaderboardList = document.getElementById('leaderboard-list');
const audioFileInput = document.getElementById('audio-file-input');

// --- Game Constants ---
const DIR_VECS = [
    { x: 1, y: 0 },   // dir 0: right (+x)
    { x: 0, y: -1 }   // dir 1: up (-y)
];
const SPEED_PER_SEC = 160;
const WALL_HALF_WIDTH = 25;

const SPAWN_OFFSETS = [
    { x: 0, y: 0 },
    { x: -200, y: 100 },
    { x: 200, y: 100 },
    { x: -100, y: 200 },
    { x: 100, y: -200 },
    { x: 0, y: 200 },
];

// --- Audio Config & State ---
let audioContext;
let audioUnlocked = false;
let loadedAudioBuffer = null;
let audioSource = null;

// --- Multiplayer & State ---
let ws;
let localId = null;
let localColor = '#00e676';
let localSpawnIndex = 0;
let players = {};
let songList = [];
let selectedSongId = null;
let loadedTrackData = null;
let precalculatedTracks = {}; // playerId -> array of points
let currentLeaderboard = [];

let gameState = 'idle'; // idle | starting | playing | dead
let alive = true;
let score = 0;
let combo = 0;
let totalDuration = 0;

let gameStartTime = 0; 
let zoomStartTime = 0;
let drawReqId;

// Canvas resizing
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// --- WebSocket Setup ---
function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}${location.pathname}`);
    
    ws.onmessage = async (ev) => {
        try {
            const data = JSON.parse(ev.data);
            switch (data.type) {
                case 'init':
                    localId = data.id;
                    localColor = data.color;
                    localSpawnIndex = data.spawnIndex;
                    players = data.players;
                    selectedSongId = data.selectedSong;
                    gameState = data.gameState || 'idle';
                    
                    // Retrieve list of songs from server
                    fetchSongsList();
                    break;
                    
                case 'playerJoined':
                    players[data.player.id] = data.player;
                    updatePlayersList();
                    break;
                    
                case 'playerLeft':
                    delete players[data.id];
                    delete precalculatedTracks[data.id];
                    updatePlayersList();
                    break;
                    
                case 'songSelected':
                    selectedSongId = data.songId;
                    downloadStatus.textContent = `Host selected song. Downloading...`;
                    currentLeaderboard = [];
                    renderLeaderboard();
                    await downloadSongData(data.songId);
                    break;
                    
                case 'songsUpdated':
                    fetchSongsList();
                    break;
                    
                case 'leaderboardUpdate':
                    if (data.songId === selectedSongId) {
                        currentLeaderboard = data.leaderboard || [];
                        renderLeaderboard();
                    }
                    break;
                    
                case 'gameStateChange':
                    gameState = data.gameState;
                    if (data.players) {
                        players = data.players;
                        updatePlayersList();
                    }
                    updateStartButtonText();
                    
                    if (gameState === 'idle') {
                        // Match ended: return to song selection automatically
                        songSelection.style.display = 'flex';
                        gameoverOverlay.style.display = 'none';
                        stopGame();
                    }
                    break;
                    
                case 'startGame':
                    handleStartGame(data.startDelay);
                    break;
                    
                case 'playerUpdate':
                    if (gameState === 'idle') break;
                    
                    const serverPlayers = data.players;
                    const serverT = data.t;
                    
                    for (const pid in serverPlayers) {
                        if (!players[pid]) players[pid] = {};
                        Object.assign(players[pid], serverPlayers[pid]);
                    }
                    
                    const localP = serverPlayers[localId];
                    if (localP) {
                        alive = localP.alive;
                        score = localP.score;
                        combo = localP.combo;
                        updateHUD(serverT);
                    }
                    break;
                    
                case 'playerDead':
                    if (players[data.id]) players[data.id].alive = false;
                    if (data.id === localId) {
                        triggerDeath();
                    }
                    break;
                    
                case 'hit':
                    if (data.judgment === 'PERFECT' || data.judgment === 'GREAT' || data.judgment === 'GOOD') {
                        if (data.id !== localId) playEcho();
                        else playLocalTurnFeedback(data.judgment);
                    }
                    break;
            }
        } catch (e) {
            console.error("WS Message Error:", e);
        }
    };
}
initWebSocket();

// --- Join Lobby Username Logic ---
function joinLobby() {
    const name = usernameInput.value.trim();
    if (!name) {
        alert("Please enter a username.");
        return;
    }
    
    unlockAudio();
    
    // Register username with server
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'registerName', name }));
    }
    
    joinOverlay.style.display = 'none';
    songSelection.style.display = 'flex';
}

joinBtn.addEventListener('click', joinLobby);
usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        joinLobby();
    }
});

// --- Songs Management ---
async function fetchSongsList() {
    try {
        const res = await fetch('./api/songs');
        songList = await res.json();
        renderSongsList();
        
        // Auto-download currently selected song if set
        if (selectedSongId) {
            downloadSongData(selectedSongId);
        }
    } catch (e) {
        console.error("Failed to fetch songs list:", e);
    }
}

function renderSongsList() {
    songsContainer.innerHTML = '';
    songList.forEach(song => {
        const div = document.createElement('div');
        div.className = `song-item ${selectedSongId === song.id ? 'selected' : ''}`;
        
        const textDiv = document.createElement('div');
        textDiv.innerHTML = `
            <div class="song-title">${song.title}</div>
            <div class="song-meta">${song.bpm} BPM | ${song.leadIn.toFixed(1)}s Lead-in</div>
        `;
        div.appendChild(textDiv);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.style.background = 'none';
        deleteBtn.style.border = 'none';
        deleteBtn.style.color = '#ff5252';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.style.fontSize = '1.2rem';
        deleteBtn.style.padding = '5px 10px';
        deleteBtn.style.transition = 'transform 0.2s';
        
        deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.transform = 'scale(1.2)');
        deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.transform = 'scale(1.0)');
        
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete ${song.title}?`)) {
                downloadStatus.textContent = `Deleting song...`;
                try {
                    const res = await fetch(`./api/songs/${song.id}`, { method: 'DELETE' });
                    const result = await res.json();
                    if (result.success) {
                        downloadStatus.textContent = "Song deleted.";
                    } else {
                        downloadStatus.textContent = result.error || "Failed to delete.";
                    }
                } catch(err) {
                    downloadStatus.textContent = "Failed to delete.";
                    console.error(err);
                }
            }
        });
        
        div.appendChild(deleteBtn);
        
        div.addEventListener('click', () => {
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'selectSong', songId: song.id }));
            }
        });
        songsContainer.appendChild(div);
    });
}

function renderLeaderboard() {
    leaderboardList.innerHTML = '';
    
    if (!selectedSongId) {
        leaderboardList.innerHTML = `<div style="color: #b0bec5; font-style: italic; text-align: center; margin-top: 40px;">Select a song to load rankings</div>`;
        return;
    }
    
    if (currentLeaderboard.length === 0) {
        leaderboardList.innerHTML = `<div style="color: #b0bec5; font-style: italic; text-align: center; margin-top: 40px;">No rankings yet. Be the first!</div>`;
        return;
    }
    
    currentLeaderboard.forEach((entry, idx) => {
        const div = document.createElement('div');
        let rankClass = '';
        if (idx === 0) rankClass = 'rank-1';
        else if (idx === 1) rankClass = 'rank-2';
        else if (idx === 2) rankClass = 'rank-3';
        
        div.className = `leaderboard-item ${rankClass}`;
        div.innerHTML = `
            <div class="rank-num">${idx + 1}</div>
            <div class="rank-name">${entry.name}</div>
            <div style="text-align: right;">
                <div class="rank-pct">${entry.percent}%</div>
                <div class="rank-score">Score: ${entry.score}</div>
            </div>
        `;
        leaderboardList.appendChild(div);
    });
}

async function downloadSongData(songId) {
    const song = songList.find(s => s.id === songId);
    if (!song) return;
    
    document.querySelectorAll('.song-item').forEach(item => {
        const title = item.querySelector('.song-title').textContent;
        item.classList.toggle('selected', title === song.title);
    });
    
    try {
        downloadStatus.textContent = `Downloading notes...`;
        const jsonRes = await fetch(song.json);
        loadedTrackData = await jsonRes.json();
        totalDuration = loadedTrackData.segments[loadedTrackData.segments.length - 1].time;
        
        downloadStatus.textContent = `Downloading audio...`;
        const audioRes = await fetch(song.mp3);
        const arrayBuffer = await audioRes.arrayBuffer();
        
        downloadStatus.textContent = `Decoding audio...`;
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        loadedAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        downloadStatus.textContent = `Ready to play!`;
        updateStartButtonText();
    } catch (e) {
        downloadStatus.textContent = `Failed to load song files.`;
        console.error(e);
    }
}

function updateStartButtonText() {
    const localP = players[localId];
    const isSpectator = localP && localP.spectator;
    if (isSpectator || gameState !== 'idle') {
        startGameBtn.textContent = "SPECTATE";
    } else {
        startGameBtn.textContent = "START GAME";
    }
    
    if (loadedTrackData && loadedAudioBuffer) {
        startGameBtn.style.display = 'block';
    } else {
        startGameBtn.style.display = 'none';
    }
}

// Upload file handler
audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('audio', file);
    
    downloadStatus.textContent = "Uploading song to server...";
    startGameBtn.style.display = 'none';
    
    try {
        const res = await fetch('./api/songs/upload', {
            method: 'POST',
            body: formData
        });
        
        if (!res.ok) {
            if (res.status === 413) {
                downloadStatus.textContent = "Upload failed: File is too large! Please upload a smaller MP3 (under 2MB).";
            } else {
                downloadStatus.textContent = `Upload failed: Server error (Status ${res.status})`;
            }
            console.error("Upload error details:", res.status, res.statusText);
            return;
        }
        
        const result = await res.json();
        if (result.success) {
            downloadStatus.textContent = "Processing complete! Song added.";
        } else {
            downloadStatus.textContent = result.error || "Upload failed.";
        }
    } catch(err) {
        downloadStatus.textContent = "Upload failed. Connection error.";
        console.error(err);
    }
    audioFileInput.value = '';
});

// --- Audio Controls & Synth ---
function unlockAudio() {
    if (audioUnlocked) return;
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    
    const b = audioContext.createBuffer(1, 1, 22050);
    const s = audioContext.createBufferSource();
    s.buffer = b; s.connect(audioContext.destination); s.start(0);
    audioUnlocked = true;
}

function playLocalTurnFeedback(judgment) {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    
    osc.connect(env); env.connect(audioContext.destination);
    osc.type = 'triangle';
    
    if (judgment === 'PERFECT') {
        osc.frequency.value = 1000;
        env.gain.value = 0.4;
    } else if (judgment === 'GREAT') {
        osc.frequency.value = 880;
        env.gain.value = 0.3;
    } else {
        osc.frequency.value = 750;
        env.gain.value = 0.2;
    }
    
    env.gain.setValueAtTime(env.gain.value, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.start(now); osc.stop(now + 0.12);
}

function playEcho() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);
    osc.type = 'sine'; osc.frequency.value = 520;
    env.gain.value = 0.15;
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.start(now); osc.stop(now + 0.16);
}

function playCountdownTick(time, pitch) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);
    osc.frequency.value = pitch;
    env.gain.value = 0.3;
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.start(time); osc.stop(time + 0.1);
}

function playCrashSound() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const bufSize = audioContext.sampleRate * 0.25;
    const buf = audioContext.createBuffer(1, bufSize, audioContext.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
    
    const src = audioContext.createBufferSource();
    const env = audioContext.createGain();
    src.buffer = buf; src.connect(env); env.connect(audioContext.destination);
    env.gain.value = 0.6;
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    src.start(now);
}

// --- Game Loop and Visuals ---
function updatePlayersList() {
    playersList.innerHTML = '';
    // Local
    const localP = players[localId];
    if (localP && localP.name) {
        const local = document.createElement('div');
        local.className = 'player-tag';
        local.innerHTML = `<div class="player-dot" style="background:${localColor}"></div>${localP.name} (You)`;
        playersList.appendChild(local);
    }
    // Remotes
    for (const id in players) {
        if (id !== localId) {
            const rp = players[id];
            if (rp.name) {
                const el = document.createElement('div');
                el.className = 'player-tag';
                el.innerHTML = `<div class="player-dot" style="background:${rp.color}"></div>${rp.name}`;
                playersList.appendChild(el);
            }
        }
    }
}

function handleStartGame(startDelayMs) {
    unlockAudio();
    gameoverOverlay.style.display = 'none';
    songSelection.style.display = 'none';
    
    const localP = players[localId];
    const isSpectator = localP && localP.spectator;
    
    alive = !isSpectator;
    score = 0;
    combo = 0;
    updateHUD(0);
    
    // Precalculate paths
    precalculatedTracks = {};
    for (const id in players) {
        const p = players[id];
        precalculatedTracks[id] = precalculatePathPoints(loadedTrackData.segments, p.spawnIndex);
        
        p.alive = !p.spectator;
        p.score = 0;
        p.combo = 0;
        p.finished = false;
        p.x = precalculatedTracks[id][0].x;
        p.y = precalculatedTracks[id][0].y;
        p.trail = [{ x: p.x, y: p.y }];
        p.anchor = { x: p.x, y: p.y, time: 0.0 };
        p.currentDir = precalculatedTracks[id][0].dir;
    }
    
    zoomStartTime = audioContext.currentTime;
    gameStartTime = zoomStartTime + (startDelayMs / 1000);
    
    // Schedule countdown ticks
    playCountdownTick(zoomStartTime + 1.0, 440);
    playCountdownTick(zoomStartTime + 2.0, 440);
    playCountdownTick(zoomStartTime + 3.0, 440);
    playCountdownTick(zoomStartTime + 4.0, 880);
    
    // Schedule audio playback
    if (audioSource) {
        try { audioSource.stop(); } catch(e) {}
    }
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = loadedAudioBuffer;
    audioSource.connect(audioContext.destination);
    
    const nowTime = audioContext.currentTime;
    if (nowTime < gameStartTime) {
        audioSource.start(gameStartTime);
    } else {
        // Late join as spectator: align audio playback
        const offset = nowTime - gameStartTime;
        if (offset < loadedAudioBuffer.duration) {
            audioSource.start(nowTime, offset);
        }
    }
    
    gameState = 'starting';
    if (nowTime >= gameStartTime) gameState = 'playing';
    
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = requestAnimationFrame(gameLoop);
}

function stopGame() {
    gameState = 'idle';
    if (audioSource) {
        try { audioSource.stop(); } catch(e) {}
        audioSource = null;
    }
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = null;
}

function triggerDeath() {
    if (!alive) return;
    alive = false;
    playCrashSound();
    gameState = 'dead';
    finalScoreEl.textContent = `Score: ${score}`;
    
    setTimeout(() => {
        gameoverOverlay.style.display = 'flex';
        songSelection.style.display = 'flex';
        stopGame();
    }, 800);
}

function updateHUD(t) {
    scoreDisplay.textContent = `Score: ${score}`;
    comboDisplay.textContent = `Combo: ${combo}`;
    const pct = totalDuration > 0 ? Math.min(100, Math.floor((Math.max(0, t) / totalDuration) * 100)) : 0;
    progressDisplay.textContent = `${pct}%`;
}

function handleTap() {
    if (gameState !== 'playing' || !alive) return;
    
    const localP = players[localId];
    if (localP && localP.spectator) return;
    
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'tap' }));
    }
}

// Global Tapping Listeners
window.addEventListener('pointerdown', (e) => {
    if (joinOverlay.style.display !== 'none' && joinOverlay.style.display !== '') return;
    if (songSelection.style.display !== 'none') return;
    if (e.target.tagName === 'BUTTON') return;
    handleTap();
});
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
        if (songSelection.style.display !== 'none') return;
        e.preventDefault();
        handleTap();
    }
});

retryBtn.addEventListener('click', () => {
    gameoverOverlay.style.display = 'none';
    songSelection.style.display = 'flex';
});

startGameBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'startRequest' }));
    }
});

// --- Interpolation Calculation ---
function getSmoothPlayerPosition(p, t) {
    if (!p.alive || p.finished || t < 0) {
        return { x: p.x, y: p.y };
    }
    
    const elapsed = t - p.anchor.time;
    const dist = elapsed * SPEED_PER_SEC;
    const dv = DIR_VECS[p.currentDir];
    
    return {
        x: p.anchor.x + dv.x * dist,
        y: p.anchor.y + dv.y * dist
    };
}

function precalculatePathPoints(segments, spawnIndex) {
    const spawn = SPAWN_OFFSETS[spawnIndex % SPAWN_OFFSETS.length];
    const points = [];
    let x = spawn.x;
    let y = spawn.y;
    
    points.push({ time: 0.0, x, y, dir: segments[0].dir });
    
    for (let i = 0; i < segments.length - 1; i++) {
        const curr = segments[i];
        const next = segments[i+1];
        const dur = next.time - curr.time;
        const dist = dur * SPEED_PER_SEC;
        const dv = DIR_VECS[curr.dir];
        x += dv.x * dist;
        y += dv.y * dist;
        points.push({ time: next.time, x, y, dir: next.dir });
    }
    return points;
}

// --- Main Loop ---
function gameLoop() {
    if (gameState === 'idle') return;
    drawReqId = requestAnimationFrame(gameLoop);
    
    const now = audioContext.currentTime;
    let t = now - gameStartTime;
    
    if (gameState === 'starting') {
        if (now >= gameStartTime) {
            gameState = 'playing';
            t = 0;
        }
    }
    
    let localPos = { x: 0, y: 0 };
    const localP = players[localId];
    
    if (localP && !localP.spectator && localP.alive) {
        localPos = getSmoothPlayerPosition(localP, t);
    } else {
        let followTarget = null;
        for (const id in players) {
            const p = players[id];
            if (p.alive && !p.spectator) {
                followTarget = p;
                break;
            }
        }
        if (followTarget) {
            localPos = getSmoothPlayerPosition(followTarget, t);
        } else {
            const startPt = precalculatedTracks[localId] ? precalculatedTracks[localId][0] : { x: 0, y: 0 };
            localPos = { x: startPt.x, y: startPt.y };
        }
    }
    
    render(t, localPos.x, localPos.y);
}

// --- Drawing ---
function render(t, camX, camY) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    let camScale = 1.0;
    
    if (gameState === 'starting') {
        const elapsed = audioContext.currentTime - zoomStartTime;
        const zoomDuration = (gameStartTime - zoomStartTime);
        const progress = Math.min(1, elapsed / zoomDuration);
        const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        
        camScale = 0.3 + 0.7 * ease;
        const startPt = precalculatedTracks[localId] ? precalculatedTracks[localId][0] : { x: 0, y: 0 };
        camX = 0 + (startPt.x - 0) * ease;
        camY = 0 + (startPt.y - 0) * ease;
        
        const remaining = gameStartTime - audioContext.currentTime;
        if (remaining > 0) {
            const countNum = Math.ceil(remaining);
            ctx.save();
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.font = `900 ${110 + (1 - (remaining % 1)) * 40}px Outfit`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countNum === 4 ? 'GET READY' : countNum, canvas.width / 2, canvas.height / 2);
            ctx.restore();
        }
    }
    
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camScale, camScale);
    ctx.translate(-camX, -camY);
    
    // 1. Draw corridors
    for (const pid in players) {
        const pts = precalculatedTracks[pid];
        if (!pts) continue;
        
        ctx.lineWidth = WALL_HALF_WIDTH * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1a1a2e';
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
            else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
        
        ctx.lineWidth = WALL_HALF_WIDTH * 2 + 4;
        ctx.strokeStyle = '#2a2a4a';
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
            else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
        
        ctx.lineWidth = WALL_HALF_WIDTH * 2 - 4;
        ctx.strokeStyle = '#12122a';
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
            else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
    }
    
    // 2. Draw turn diamonds
    if (loadedTrackData && precalculatedTracks[localId]) {
        const pts = precalculatedTracks[localId];
        const localP = players[localId];
        for (let i = 1; i < pts.length; i++) {
            const tp = pts[i];
            const collected = localP && i <= localP.turnIndex;
            ctx.save();
            ctx.translate(tp.x, tp.y);
            ctx.rotate(Math.PI / 4);
            const sz = collected ? 5 : 7;
            ctx.fillStyle = collected ? '#333' : '#ffeb3b';
            ctx.shadowColor = collected ? 'transparent' : '#ffeb3b';
            ctx.shadowBlur = collected ? 0 : 12;
            ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
            ctx.restore();
        }
    }
    
    // 3. Draw trails and player dots
    for (const id in players) {
        const p = players[id];
        const pathData = precalculatedTracks[id];
        if (!pathData) continue;
        
        const pos = getSmoothPlayerPosition(p, t);
        
        if (p.trail && p.trail.length >= 2) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = id === localId ? 6 : 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = id === localId ? 0.9 : 0.5;
            ctx.beginPath();
            ctx.moveTo(p.trail[0].x, p.trail[0].y);
            for (let i = 1; i < p.trail.length; i++) {
                ctx.lineTo(p.trail[i].x, p.trail[i].y);
            }
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }
        
        if (p.alive) {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = id === localId ? 25 : 10;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, id === localId ? 9 : 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            
            // Draw player name above the circle
            if (p.name) {
                ctx.save();
                ctx.fillStyle = '#fff';
                ctx.font = '700 12px Outfit';
                ctx.textAlign = 'center';
                ctx.shadowColor = '#000';
                ctx.shadowBlur = 4;
                ctx.fillText(p.name, pos.x, pos.y - 15);
                ctx.restore();
            }
        } else {
            ctx.fillStyle = '#ff5252';
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;
        }
    }
    
    ctx.restore();
}
