// --- DOM Elements ---
const joinOverlay = document.getElementById('join-overlay');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');

const songSelection = document.getElementById('song-selection');
const songsContainer = document.getElementById('songs-container');
const downloadStatus = document.getElementById('download-status');
const startGameBtn = document.getElementById('start-game-btn');

const resultsOverlay = document.getElementById('results-overlay');
const resultsTitle = document.getElementById('results-title');
const resultsSongTitle = document.getElementById('results-song-title');
const resultsDiff = document.getElementById('results-diff');
const resultsScore = document.getElementById('results-score');
const resultsProgress = document.getElementById('results-progress');
const resultsMaxCombo = document.getElementById('results-max-combo');
const resultsExcellent = document.getElementById('results-excellent');
const resultsGood = document.getElementById('results-good');
const resultsFast = document.getElementById('results-fast');
const resultsLate = document.getElementById('results-late');
const resultsMiss = document.getElementById('results-miss');
const resultsCloseBtn = document.getElementById('results-close-btn');

const scoreDisplay = document.getElementById('score-display');
const comboDisplay = document.getElementById('combo-display');
const progressDisplay = document.getElementById('progress-display');
const finalScoreEl = document.getElementById('final-score');
const playersList = document.getElementById('players-list');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const leaderboardList = document.getElementById('leaderboard-list');
const audioFileInput = document.getElementById('audio-file-input');
const onlineTrackNameInput = document.getElementById('online-track-name');
const onlineUrlInput = document.getElementById('online-url');
const registerOnlineBtn = document.getElementById('register-online-btn');

// --- Game Constants ---
const DIR_VECS = [
    { x: 1, y: 0 },   // dir 0: right (+x)
    { x: 0, y: -1 }   // dir 1: up (-y)
];
let SPEED_PER_SEC = 160;
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
let musicGainNode = null;
let musicVolumeBoost = 1.0;

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
let selectedDifficulty = 3; // 1: Easy, 2: Medium, 3: Hard (default)
let diff5Unlocked = false;
let latency = 0;
let calibrationOffset = -0.08; // default -80ms

let gameState = 'idle'; // idle | starting | playing | dead
let alive = true;
let score = 0;
let combo = 0;
let totalDuration = 0;
let judgmentCounts = { excellent: 0, Good: 0, Fast: 0, Late: 0, MISS: 0 };
let maxCombo = 0;
let finished = false;

let gameStartTime = 0; 
let zoomStartTime = 0;
let drawReqId;
let localPredictionActive = false;

// Judgment Popups System
let judgmentPopups = [];
function showJudgmentPopup(text, color, x, y) {
    judgmentPopups.push({
        text,
        color,
        x,
        y,
        createdAt: Date.now(),
        duration: 800 // 800ms
    });
}
function getJudgmentColor(judgment) {
    switch (judgment) {
        case 'excellent': return '#00e5ff'; // Cyan
        case 'Good':      return '#ffb300'; // Amber/Gold
        case 'Fast':      return '#ff3d00'; // Red-Orange
        case 'Late':      return '#2979ff'; // Blue
        case 'MISS':      return '#ff1744'; // Red
        default:          return '#ffffff';
    }
}

// Pitch Detection and Harmonization System
let precalculatedPitches = [];
const NOTE_FREQS = [];
for (let i = -48; i <= 48; i++) {
    NOTE_FREQS.push(440 * Math.pow(2, i / 12));
}

function snapToNote(freq) {
    let closest = NOTE_FREQS[0];
    let minDist = Math.abs(freq - closest);
    for (let i = 1; i < NOTE_FREQS.length; i++) {
        const dist = Math.abs(freq - NOTE_FREQS[i]);
        if (dist < minDist) {
            minDist = dist;
            closest = NOTE_FREQS[i];
        }
    }
    return closest;
}

function detectPitch(buffer, time) {
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);
    const startSample = Math.floor(time * sampleRate);
    const fftSize = 2048;
    
    if (startSample < 0 || startSample + fftSize > channelData.length) {
        return 440;
    }
    
    const signal = channelData.subarray(startSample, startSample + fftSize);
    let r = new Float32Array(fftSize);
    for (let lag = 0; lag < fftSize / 2; lag++) {
        let sum = 0;
        for (let i = 0; i < fftSize / 2; i++) {
            sum += signal[i] * signal[i + lag];
        }
        r[lag] = sum;
    }
    
    let threshold = 0.9 * r[0];
    let peakLag = -1;
    let searchStart = 0;
    for (let lag = 1; lag < fftSize / 2; lag++) {
        if (r[lag] < threshold) {
            searchStart = lag;
            break;
        }
    }
    
    let maxVal = -1;
    for (let lag = searchStart; lag < fftSize / 2; lag++) {
        if (r[lag] > maxVal && r[lag] > r[lag - 1] && r[lag] > r[lag + 1]) {
            maxVal = r[lag];
            peakLag = lag;
        }
    }
    
    if (peakLag > -1) {
        const frequency = sampleRate / peakLag;
        if (frequency >= 200 && frequency <= 1200) {
            return frequency;
        }
    }
    return 440;
}


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
    
    ws.onopen = () => {
        startPingLoop();
    };
    
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
                    selectedDifficulty = data.selectedDifficulty || 3;
                    updatePlayersList();
                    updateStartButtonText();
                    updateDifficultyUI();
                    
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
                    
                case 'difficultySelected':
                    console.log("difficultySelected received:", data.difficulty);
                    selectedDifficulty = data.difficulty;
                    updateDifficultyUI();
                    break;
                    
                case 'pong':
                    const rtt = Date.now() - data.sendTime;
                    latency = rtt / 2;
                    break;
                    
                case 'leaderboardUpdate':
                    console.log("leaderboardUpdate received:", data, "selectedSongId:", selectedSongId, "selectedDifficulty:", selectedDifficulty);
                    if (data.songId === selectedSongId && Number(data.difficulty) === Number(selectedDifficulty)) {
                        currentLeaderboard = data.leaderboard || [];
                        renderLeaderboard();
                    }
                    break;
                    
                case 'unlocksUpdate':
                    diff5Unlocked = data.diff5Unlocked;
                    updateDifficultyUI();
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
                        stopGame();
                    }
                    break;
                    
                case 'startGame': {
                    const adjustedDelay = Math.max(0, data.startDelay - latency);
                    handleStartGame(adjustedDelay, data.segments);
                    break;
                }
                
                case 'startSpectating': {
                    handleStartSpectating(data.elapsedT, data.segments);
                    break;
                }
                    
                case 'playerUpdate': {
                    if (gameState === 'idle') break;
                    
                    const serverPlayers = data.players;
                    const serverT = data.t;
                    
                    for (const pid in serverPlayers) {
                        if (!players[pid]) players[pid] = {};
                        
                        if (pid === localId && localPredictionActive) {
                            // Protect locally predicted state until server catches up
                            const serverData = serverPlayers[pid];
                            const serverTI = serverData.turnIndex ?? 0;
                            const localTI = players[pid].turnIndex ?? 0;
                            
                            if (serverTI >= localTI) {
                                // Server confirmed prediction - accept full state
                                Object.assign(players[pid], serverData);
                                localPredictionActive = false;
                            } else {
                                // Server hasn't processed tap yet - only update authoritative fields
                                players[pid].alive = serverData.alive;
                                players[pid].score = serverData.score;
                                players[pid].combo = serverData.combo;
                                players[pid].finished = serverData.finished;
                            }
                        } else {
                            Object.assign(players[pid], serverPlayers[pid]);
                        }
                    }
                    
                    const localP = serverPlayers[localId];
                    if (localP) {
                        alive = localP.alive;
                        score = localP.score;
                        combo = localP.combo;
                        if (combo > maxCombo) {
                            maxCombo = combo;
                        }
                        updateHUD(serverT);
                        
                        if (localP.finished && !finished) {
                            triggerClear();
                        }
                    }
                    break;
                }
                    
                case 'playerDead':
                    if (players[data.id]) players[data.id].alive = false;
                    if (data.id === localId) {
                        triggerDeath();
                    }
                    break;
                    
                case 'hit':
                    if (data.id === localId) {
                        const judgment = data.judgment;
                        if (judgment === 'MISS') {
                            // Server rejected tap - clear prediction so next playerUpdate corrects state
                            localPredictionActive = false;
                            showJudgmentPopup('MISS', getJudgmentColor('MISS'), data.x, data.y);
                            judgmentCounts.MISS++;
                        } else {
                            playLocalTurnFeedback(judgment, data.turnIndex);
                            showJudgmentPopup(judgment, getJudgmentColor(judgment), data.x, data.y);
                            if (judgment === 'excellent') judgmentCounts.excellent++;
                            else if (judgment === 'Good') judgmentCounts.Good++;
                            else if (judgment === 'Fast') judgmentCounts.Fast++;
                            else if (judgment === 'Late') judgmentCounts.Late++;
                        }
                    } else {
                        if (data.judgment !== 'MISS' && data.judgment !== 'Fast' && data.judgment !== 'Late') playEcho();
                    }
                    break;
            }
        } catch (e) {
            console.error("WS Message Error:", e);
        }
    };
}
initWebSocket();

// Load username from localStorage if exists
const storedUsername = localStorage.getItem('beat_maze_username');
if (storedUsername) {
    usernameInput.value = storedUsername;
}

// --- Join Lobby Username Logic ---
function joinLobby() {
    const name = usernameInput.value.trim();
    if (!name) {
        alert("Please enter a username.");
        return;
    }
    
    // Save username in localStorage
    localStorage.setItem('beat_maze_username', name);
    
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
        
        // Clear background processing status if song list was successfully updated
        if (downloadStatus.textContent.includes("Processing")) {
            downloadStatus.textContent = "Processing complete! Song added.";
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
        const durationMin = Math.floor(song.duration / 60);
        const durationSec = Math.floor(song.duration % 60).toString().padStart(2, '0');
        const durationStr = song.duration ? `${durationMin}:${durationSec}` : 'N/A';
        
        textDiv.innerHTML = `
            <div class="song-title">${song.title}</div>
            <div class="song-meta">${song.bpm} BPM | Duration: ${durationStr}</div>
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
    const leaderboardTitle = document.querySelector('#leaderboard-panel h3');
    if (leaderboardTitle) {
        const diffStars = selectedDifficulty === 1 ? '★' : (selectedDifficulty === 2 ? '★★' : (selectedDifficulty === 3 ? '★★★' : '★★★★★'));
        leaderboardTitle.textContent = `Leaderboard (${diffStars})`;
    }
    
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
        const maxComboDisplay = entry.max_combo !== undefined ? entry.max_combo : 0;
        div.innerHTML = `
            <div class="rank-num">${idx + 1}</div>
            <div class="rank-name">${entry.name}</div>
            <div style="text-align: right;">
                <div class="rank-pct">${entry.percent}%</div>
                <div class="rank-score">Score: ${entry.score} | Max Combo: <span style="color: #00e5ff;">${maxComboDisplay}</span></div>
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
        
        downloadStatus.textContent = `Analyzing audio & notes...`;
        // 1. Calculate RMS to normalize volume
        try {
            const channelData = loadedAudioBuffer.getChannelData(0);
            let sum = 0;
            const samplePoints = 10000;
            const step = Math.max(1, Math.floor(channelData.length / samplePoints));
            let count = 0;
            for (let i = 0; i < channelData.length; i += step) {
                sum += channelData[i] * channelData[i];
                count++;
            }
            const rms = Math.sqrt(sum / count);
            const targetRMS = 0.18;
            musicVolumeBoost = rms > 0 ? targetRMS / rms : 1.0;
            // Max boost 3.5x, min 0.8x
            musicVolumeBoost = Math.max(0.8, Math.min(3.5, musicVolumeBoost));
            console.log(`Audio RMS: ${rms.toFixed(4)}, Auto volume boost: ${musicVolumeBoost.toFixed(2)}x`);
        } catch (err) {
            console.error("Failed to calculate RMS volume boost:", err);
            musicVolumeBoost = 1.0;
        }

        // 2. Precalculate note pitches matching melody at turn points
        try {
            precalculatedPitches = [];
            if (loadedTrackData && loadedTrackData.segments) {
                for (let i = 0; i < loadedTrackData.segments.length; i++) {
                    const t = loadedTrackData.segments[i].time;
                    const rawPitch = detectPitch(loadedAudioBuffer, t);
                    const snapped = snapToNote(rawPitch);
                    precalculatedPitches.push(snapped);
                }
            }
        } catch (err) {
            console.error("Failed to precalculate pitches:", err);
        }
        
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

// Upload file handler (chunked upload to bypass proxy size limits)
audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const CHUNK_SIZE = 500 * 1024; // 500 KB chunks
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = Math.random().toString(36).substring(2, 15);
    
    downloadStatus.textContent = `Preparing upload...`;
    startGameBtn.style.display = 'none';
    
    try {
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);
            
            const formData = new FormData();
            formData.append('filename', file.name);
            formData.append('uploadId', uploadId);
            formData.append('chunkIndex', chunkIndex);
            formData.append('totalChunks', totalChunks);
            formData.append('audioChunk', chunkBlob);
            
            const pct = Math.round((chunkIndex / totalChunks) * 100);
            downloadStatus.textContent = `Uploading: ${pct}% (Chunk ${chunkIndex + 1}/${totalChunks})`;
            
            const res = await fetch('./api/songs/upload-chunk', {
                method: 'POST',
                body: formData
            });
            
            if (!res.ok) {
                downloadStatus.textContent = `Upload failed at chunk ${chunkIndex + 1} (Status ${res.status})`;
                console.error("Chunk upload failed:", res.status, res.statusText);
                audioFileInput.value = '';
                return;
            }
            
            const result = await res.json();
            
            if (result.completed) {
                downloadStatus.textContent = "Upload successful! Processing audio in background...";
            } else if (!result.success) {
                downloadStatus.textContent = result.error || "Chunk upload rejected.";
                audioFileInput.value = '';
                return;
            }
        }
    } catch(err) {
        downloadStatus.textContent = "Upload failed. Connection error.";
        console.error(err);
    }
    
    audioFileInput.value = '';
});

// Online song registration click handler
registerOnlineBtn.addEventListener('click', async () => {
    const name = onlineTrackNameInput.value.trim();
    const url = onlineUrlInput.value.trim();
    
    if (!name || !url) {
        alert("Please enter both Track Name and URL.");
        return;
    }
    
    downloadStatus.textContent = "Requesting download and registration from online source...";
    registerOnlineBtn.disabled = true;
    
    try {
        const res = await fetch('./api/songs/register-online', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, url })
        });
        
        if (!res.ok) {
            const errData = await res.json();
            downloadStatus.textContent = `Failed: ${errData.error || res.statusText}`;
            registerOnlineBtn.disabled = false;
            return;
        }
        
        const data = await res.json();
        if (data.success) {
            downloadStatus.textContent = "Download started! The track will be registered and processed in the background.";
            onlineTrackNameInput.value = '';
            onlineUrlInput.value = '';
        } else {
            downloadStatus.textContent = data.error || "Failed to start download.";
        }
    } catch (err) {
        downloadStatus.textContent = "Failed to connect to the server.";
        console.error(err);
    }
    
    registerOnlineBtn.disabled = false;
});

// --- Audio Controls & Synth ---
function unlockAudio() {
    try {
        if (audioUnlocked) return;
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        
        const b = audioContext.createBuffer(1, 1, 22050);
        const s = audioContext.createBufferSource();
        s.buffer = b; s.connect(audioContext.destination); s.start(0);
        audioUnlocked = true;
    } catch (e) {
        console.warn("Web Audio unlock failed or blocked by browser policies:", e);
    }
}

function playLocalTurnFeedback(judgment, turnIndex) {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    
    osc.connect(env); env.connect(audioContext.destination);
    osc.type = 'triangle';
    
    // Harmonization: match the melody note at this turn index
    const baseFreq = (typeof turnIndex === 'number' && precalculatedPitches[turnIndex]) 
        ? precalculatedPitches[turnIndex] 
        : 440; // Default A4 fallback
    
    let freq = baseFreq;
    if (judgment === 'excellent') {
        freq = baseFreq * 1.5; // Perfect fifth above - bright and harmonious
        env.gain.value = 0.45;
    } else if (judgment === 'Good') {
        freq = baseFreq; // Unison - matches melody root note
        env.gain.value = 0.35;
    } else {
        freq = baseFreq * 0.75; // Perfect fourth below - lower, signals error musically
        env.gain.value = 0.2;
    }
    
    osc.frequency.setValueAtTime(freq, now);
    env.gain.setValueAtTime(env.gain.value, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.start(now); osc.stop(now + 0.14);
}

// Handle tab visibility changes to prevent stale UI state when waking up
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'syncRequest' }));
        }
    }
});

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

function handleStartGame(startDelayMs, serverSegments) {
    unlockAudio();
    localPredictionActive = false;
    resultsOverlay.style.display = 'none';
    songSelection.style.display = 'none';
    
    const localP = players[localId];
    const isSpectator = localP && localP.spectator;
    
    alive = !isSpectator;
    score = 0;
    combo = 0;
    maxCombo = 0;
    finished = false;
    judgmentCounts = { excellent: 0, Good: 0, Fast: 0, Late: 0, MISS: 0 };
    updateHUD(0);
    
    // Precalculate paths
    precalculatedTracks = {};
    for (const id in players) {
        const p = players[id];
        precalculatedTracks[id] = precalculatePathPoints(serverSegments, p.spawnIndex);
        
        p.alive = !p.spectator;
        p.score = 0;
        p.combo = 0;
        p.turnIndex = 0;
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
    
    musicGainNode = audioContext.createGain();
    musicGainNode.gain.setValueAtTime(musicVolumeBoost, audioContext.currentTime);
    audioSource.connect(musicGainNode);
    musicGainNode.connect(audioContext.destination);
    
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

function handleStartSpectating(elapsedT, serverSegments) {
    unlockAudio();
    localPredictionActive = false;
    resultsOverlay.style.display = 'none';
    songSelection.style.display = 'none';
    
    const localP = players[localId];
    if (localP) {
        localP.spectator = true;
        localP.alive = false;
        localP.finished = false;
    }
    
    precalculatedTracks = {};
    for (const id in players) {
        const p = players[id];
        precalculatedTracks[id] = precalculatePathPoints(serverSegments, p.spawnIndex);
    }
    
    if (audioSource) {
        try { audioSource.stop(); } catch(e) {}
    }
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = loadedAudioBuffer;
    
    musicGainNode = audioContext.createGain();
    musicGainNode.gain.setValueAtTime(musicVolumeBoost, audioContext.currentTime);
    audioSource.connect(musicGainNode);
    musicGainNode.connect(audioContext.destination);
    
    const nowTime = audioContext.currentTime;
    if (elapsedT < 0) {
        // Scheduled in the future (countdown period)
        gameStartTime = nowTime - elapsedT;
        audioSource.start(gameStartTime, 0);
    } else {
        gameStartTime = nowTime - elapsedT;
        if (elapsedT < loadedAudioBuffer.duration) {
            audioSource.start(nowTime, elapsedT);
        }
    }
    
    gameState = 'playing';
    
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = requestAnimationFrame(gameLoop);
}

function stopGame() {
    gameState = 'idle';
    localPredictionActive = false;
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
    
    setTimeout(() => {
        showResultsScreen(false);
        songSelection.style.display = 'flex';
        stopGame();
    }, 800);
}

function triggerClear() {
    if (finished) return;
    finished = true;
    gameState = 'finished';
    
    setTimeout(() => {
        showResultsScreen(true);
        songSelection.style.display = 'flex';
        stopGame();
    }, 800);
}

function showResultsScreen(isClear) {
    resultsTitle.textContent = isClear ? "STAGE CLEAR" : "STAGE CRASHED";
    resultsTitle.className = isClear ? "clear-title" : "crash-title";
    
    const song = songList.find(s => s.id === selectedSongId);
    resultsSongTitle.textContent = song ? (song.title || selectedSongId) : (selectedSongId || "Unknown Song");
    
    const diffStars = selectedDifficulty === 1 ? '★' : (selectedDifficulty === 2 ? '★★' : (selectedDifficulty === 3 ? '★★★' : '★★★★★'));
    resultsDiff.textContent = `Difficulty: ${diffStars}`;
    resultsDiff.style.color = (selectedDifficulty === 5) ? '#ff1744' : '#00e676';
    
    // Animate score count-up!
    resultsScore.textContent = "0";
    let currentScoreVal = 0;
    const targetScore = score;
    const duration = 1000; // 1s
    const startTime = performance.now();
    
    function animateScore(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = progress * (2 - progress);
        currentScoreVal = Math.floor(easeProgress * targetScore);
        resultsScore.textContent = currentScoreVal.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(animateScore);
        } else {
            resultsScore.textContent = targetScore.toLocaleString();
        }
    }
    requestAnimationFrame(animateScore);
    
    // Progress %
    let progressVal = 100;
    if (!isClear) {
        const t = (audioContext.currentTime - gameStartTime);
        const totalTime = precalculatedTracks[localId] 
            ? precalculatedTracks[localId][precalculatedTracks[localId].length - 1].time 
            : 1;
        progressVal = Math.min(99, Math.max(0, Math.floor((t / totalTime) * 100)));
    }
    resultsProgress.textContent = `${progressVal}%`;
    resultsMaxCombo.textContent = maxCombo.toLocaleString();
    
    // Judgments
    resultsExcellent.textContent = judgmentCounts.excellent.toLocaleString();
    resultsGood.textContent = judgmentCounts.Good.toLocaleString();
    resultsFast.textContent = judgmentCounts.Fast.toLocaleString();
    resultsLate.textContent = judgmentCounts.Late.toLocaleString();
    resultsMiss.textContent = judgmentCounts.MISS.toLocaleString();
    
    resultsOverlay.style.display = 'flex';
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
    
    const tapTime = audioContext.currentTime - gameStartTime;
    const calibratedTime = tapTime + calibrationOffset;
    
    // Client-side prediction: immediately update visual state for responsiveness
    // This eliminates the RTT delay between tapping and seeing the direction change
    const pts = precalculatedTracks[localId];
    if (pts && localP) {
        const nextIdx = (localP.turnIndex ?? 0) + 1;
        if (nextIdx < pts.length) {
            const nextTurn = pts[nextIdx];
            const diff = calibratedTime - nextTurn.time;
            const newDir = 1 - localP.currentDir;
            if (newDir === nextTurn.dir) {
                if (Math.abs(diff) <= 0.22) {
                    // Predict successful turn - update local state immediately
                    localP.turnIndex = nextIdx;
                    localP.currentDir = nextTurn.dir;
                    localP.x = nextTurn.x;
                    localP.y = nextTurn.y;
                    localP.anchor = { x: nextTurn.x, y: nextTurn.y, time: nextTurn.time };
                    localP.trail.push({ x: nextTurn.x, y: nextTurn.y });
                    localPredictionActive = true;
                } else {
                    // Timing missed, but if they are reasonably close to the turn (e.g. within 60 pixels), snap them back to center
                    const distToTurn = Math.hypot(localP.x - nextTurn.x, localP.y - nextTurn.y);
                    if (distToTurn < 60) {
                        // Snap to the correct turn point and keep going!
                        localP.turnIndex = nextIdx;
                        localP.currentDir = nextTurn.dir;
                        localP.x = nextTurn.x;
                        localP.y = nextTurn.y;
                        localP.anchor = { x: nextTurn.x, y: nextTurn.y, time: nextTurn.time };
                        localP.trail.push({ x: nextTurn.x, y: nextTurn.y });
                        localPredictionActive = true;
                    }
                }
            }
        }
    }
    
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'tap', time: calibratedTime }));
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
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
        if (songSelection.style.display !== 'none') return;
        e.preventDefault();
        handleTap();
    }
});

// Disable context menu during gameplay or calibration to allow right-click tapping
window.addEventListener('contextmenu', (e) => {
    if (songSelection.style.display === 'none' || calibActive) {
        e.preventDefault();
    }
});

resultsCloseBtn.addEventListener('click', () => {
    resultsOverlay.style.display = 'none';
    songSelection.style.display = 'flex';
});

startGameBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
        if (gameState !== 'idle') {
            ws.send(JSON.stringify({ type: 'spectateRequest' }));
        } else {
            ws.send(JSON.stringify({ type: 'startRequest' }));
        }
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

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isInsideCorridor(px, py, turnPoints) {
    for (let i = 0; i < turnPoints.length - 1; i++) {
        const p0 = turnPoints[i];
        const p1 = turnPoints[i + 1];
        const dist = pointToSegmentDist(px, py, p0.x, p0.y, p1.x, p1.y);
        if (dist < WALL_HALF_WIDTH - 2) return true;
    }
    return false;
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
        
        if (pathData && pathData.length > 0) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = id === localId ? 6 : 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = id === localId ? 0.9 : 0.5;
            ctx.beginPath();
            ctx.moveTo(pathData[0].x, pathData[0].y);
            const limit = Math.min(pathData.length - 1, p.turnIndex || 0);
            for (let i = 1; i <= limit; i++) {
                ctx.lineTo(pathData[i].x, pathData[i].y);
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
        }
    }
    // Render judgment popups (in world space)
    const nowTimeMs = Date.now();
    judgmentPopups = judgmentPopups.filter(pop => nowTimeMs - pop.createdAt < pop.duration);
    
    judgmentPopups.forEach(pop => {
        const elapsed = nowTimeMs - pop.createdAt;
        const progress = elapsed / pop.duration;
        
        // Float up (y gets smaller because up is negative y in canvas)
        const currentY = pop.y - progress * 50; 
        
        ctx.save();
        ctx.translate(pop.x, currentY);
        
        // Bounce scale effect at beginning
        let scale = 1.0;
        if (progress < 0.15) {
            scale = 1.0 + (0.15 - progress) * 2.5; 
        } else if (progress > 0.6) {
            // Shrink/fade towards the end
            scale = 1.0 - (progress - 0.6) * 2.5;
        }
        scale = Math.max(0, scale);
        ctx.scale(scale / camScale, scale / camScale); // Counteract camera scale so text size remains constant on screen
        
        const alpha = Math.max(0, 1 - progress);
        ctx.globalAlpha = alpha;
        
        ctx.font = "bold 22px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        // Text shadow/glow
        ctx.shadowColor = pop.color;
        ctx.shadowBlur = 10;
        
        // Draw outline
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 4;
        ctx.strokeText(pop.text, 0, 0);
        
        // Fill text
        ctx.fillStyle = pop.color;
        ctx.fillText(pop.text, 0, 0);
        
        ctx.restore();
    });
    
    ctx.restore();
}

// --- Difficulty Selector Logic ---
const diffBtns = document.querySelectorAll('.diff-btn');
diffBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (gameState === 'idle') {
            const diff = parseInt(btn.getAttribute('data-diff'));
            if (diff === 5 && !diff5Unlocked) {
                alert("Clear this song on ★★★ with 100% to unlock the brutal ★★★★★ mode!");
                return;
            }
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'selectDifficulty', difficulty: diff }));
            }
        }
    });
});

function updateDifficultyUI() {
    SPEED_PER_SEC = (selectedDifficulty === 5) ? 360 : 160;
    
    const diff5Btn = document.getElementById('diff5-btn');
    if (diff5Btn) {
        if (diff5Unlocked) {
            diff5Btn.textContent = '★★★★★';
            diff5Btn.style.cursor = 'pointer';
            diff5Btn.title = 'Unlock the brutal 5-star level!';
        } else {
            diff5Btn.textContent = '★★★★★ 🔒';
            diff5Btn.style.cursor = 'not-allowed';
            diff5Btn.title = 'Clear ★★★ level 100% to unlock!';
        }
    }

    diffBtns.forEach(btn => {
        const diff = parseInt(btn.getAttribute('data-diff'));
        
        if (diff === selectedDifficulty) {
            btn.classList.add('active');
            btn.style.borderColor = (diff === 5) ? '#ff1744' : '#00e676';
            btn.style.background = (diff === 5) ? 'rgba(255, 23, 68, 0.1)' : 'rgba(0, 230, 118, 0.1)';
            btn.style.color = (diff === 5) ? '#ff1744' : '#00e676';
        } else if (diff === 5 && !diff5Unlocked) {
            btn.classList.remove('active');
            btn.style.borderColor = 'rgba(255,255,255,0.1)';
            btn.style.background = 'rgba(255,255,255,0.05)';
            btn.style.color = 'rgba(255,255,255,0.3)';
        } else {
            btn.classList.remove('active');
            btn.style.borderColor = 'rgba(255,255,255,0.2)';
            btn.style.background = 'rgba(0,0,0,0.4)';
            btn.style.color = '#fff';
        }
    });
}

// --- Latency Calibration & Ping Logic ---
const calibrationSlider = document.getElementById('calibration-slider');
const calibrationVal = document.getElementById('calibration-val');
const autoCalibBtn = document.getElementById('auto-calib-btn');
const calibrationOverlay = document.getElementById('calibration-overlay');
const calibProgressBar = document.getElementById('calib-progress-bar');
const calibVisualFlash = document.getElementById('calib-visual-flash');
const calibStatusText = document.getElementById('calib-status-text');
const cancelCalibBtn = document.getElementById('cancel-calib-btn');

let calibActive = false;
let calibTicks = [];
let calibTaps = [];
let calibTickTimers = [];

calibrationSlider.addEventListener('input', (e) => {
    const ms = parseInt(e.target.value);
    calibrationOffset = ms / 1000;
    calibrationVal.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    localStorage.setItem('beat_maze_calibration', ms);
});

// Load calibration from localStorage on startup
const storedCalib = localStorage.getItem('beat_maze_calibration');
if (storedCalib !== null) {
    const ms = parseInt(storedCalib);
    calibrationSlider.value = ms;
    calibrationOffset = ms / 1000;
    calibrationVal.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
}

function startPingLoop() {
    setInterval(() => {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ping', sendTime: Date.now() }));
        }
    }, 3000);
}

// --- Semi-Automatic Calibration Routine ---
const handleCalibTap = (e) => {
    if (!calibActive) return;
    if (e.target === cancelCalibBtn) return;
    
    const now = audioContext.currentTime;
    calibTaps.push(now);
    
    // Visual Tap Feedback
    calibVisualFlash.style.transform = 'scale(1.15)';
    calibVisualFlash.style.background = 'rgba(0, 230, 118, 0.35)';
    calibVisualFlash.style.borderColor = '#00e676';
    calibVisualFlash.style.color = '#fff';
    setTimeout(() => {
        calibVisualFlash.style.transform = 'none';
        calibVisualFlash.style.background = 'rgba(255,255,255,0.02)';
        calibVisualFlash.style.borderColor = 'rgba(255,255,255,0.15)';
        calibVisualFlash.style.color = 'rgba(255,255,255,0.4)';
    }, 85);
};

const handleCalibKey = (e) => {
    if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        handleCalibTap(e);
    }
};

function cleanupCalib() {
    calibTickTimers.forEach(t => clearTimeout(t));
    calibTickTimers = [];
    window.removeEventListener('keydown', handleCalibKey);
    calibrationOverlay.removeEventListener('pointerdown', handleCalibTap);
}

function closeCalib() {
    calibActive = false;
    cleanupCalib();
    calibrationOverlay.style.display = 'none';
    calibProgressBar.style.width = '0%';
}

cancelCalibBtn.addEventListener('click', closeCalib);

autoCalibBtn.addEventListener('click', () => {
    if (calibActive) return;
    unlockAudio();
    
    calibActive = true;
    calibTicks = [];
    calibTaps = [];
    calibTickTimers = [];
    
    calibProgressBar.style.width = '0%';
    calibStatusText.textContent = "Get ready...";
    calibStatusText.style.color = "#ffea00";
    calibrationOverlay.style.display = 'flex';
    
    window.addEventListener('keydown', handleCalibKey);
    calibrationOverlay.addEventListener('pointerdown', handleCalibTap);
    
    const start = audioContext.currentTime + 1.2; // 1.2s lead-in
    const interval = 0.5; // 120 BPM (2 ticks per second)
    const totalTicks = 20; // 10 seconds total
    
    for (let i = 0; i < totalTicks; i++) {
        const time = start + i * interval;
        calibTicks.push(time);
        
        // Play synthetically generated metronome woodblock clack
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const filter = audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1200;
        filter.Q.value = 3;
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200, time);
        osc.frequency.exponentialRampToValueAtTime(600, time + 0.04);
        
        gain.gain.setValueAtTime(0.5, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
        
        osc.start(time);
        osc.stop(time + 0.05);
        
        // Visual flash and tick updates
        const delayMs = (time - audioContext.currentTime) * 1000;
        const tickNum = i + 1;
        const timerId = setTimeout(() => {
            if (!calibActive) return;
            calibStatusText.textContent = `Tap! (${tickNum} / ${totalTicks})`;
            calibStatusText.style.color = '#00e676';
            calibProgressBar.style.width = `${(tickNum / totalTicks) * 100}%`;
            
            // Metronome sync visual pulse
            calibVisualFlash.style.boxShadow = '0 0 25px rgba(0, 176, 255, 0.4)';
            setTimeout(() => {
                calibVisualFlash.style.boxShadow = 'none';
            }, 75);
        }, delayMs);
        calibTickTimers.push(timerId);
    }
    
    // Schedule calculation run after all ticks finish
    const finishDelayMs = (start + totalTicks * interval + 0.5 - audioContext.currentTime) * 1000;
    const endTimer = setTimeout(() => {
        if (!calibActive) return;
        
        calibActive = false;
        cleanupCalib();
        
        const diffs = [];
        calibTaps.forEach(tapTime => {
            let closestTick = null;
            let minDist = Infinity;
            calibTicks.forEach(tickTime => {
                const d = Math.abs(tapTime - tickTime);
                if (d < minDist) {
                    minDist = d;
                    closestTick = tickTime;
                }
            });
            
            // Only keep taps closer than 250ms to any beat tick (prevent random clicks)
            if (closestTick !== null && minDist < 0.25) {
                diffs.push(tapTime - closestTick);
            }
        });
        
        if (diffs.length < 5) {
            calibStatusText.textContent = "Calibration failed: Too few taps detected!";
            calibStatusText.style.color = "#ff1744";
            setTimeout(closeCalib, 2200);
            return;
        }
        
        // Calculate average difference (tapTime - tickTime)
        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        
        // Delay compensation (calibrating early/late taps)
        const offsetMs = Math.round(-avgDiff * 1000);
        const clampedOffsetMs = Math.max(-250, Math.min(250, offsetMs));
        
        calibrationOffset = clampedOffsetMs / 1000;
        calibrationSlider.value = clampedOffsetMs;
        calibrationVal.textContent = `${clampedOffsetMs > 0 ? '+' : ''}${clampedOffsetMs} ms`;
        localStorage.setItem('beat_maze_calibration', clampedOffsetMs);
        
        calibStatusText.textContent = `Success! Delay: ${clampedOffsetMs} ms`;
        calibStatusText.style.color = "#00e676";
        setTimeout(closeCalib, 2500);
    }, finishDelayMs);
    calibTickTimers.push(endTimer);
});
