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

const addTrackBtn = document.getElementById('add-track-btn');
const addTrackModal = document.getElementById('add-track-modal');
const closeAddTrackBtn = document.getElementById('close-add-track-btn');
const tabUploadBtn = document.getElementById('tab-upload-btn');
const tabOnlineBtn = document.getElementById('tab-online-btn');
const tabUploadContent = document.getElementById('tab-upload-content');
const tabOnlineContent = document.getElementById('tab-online-content');

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
let precalculatedPaths = {}; // playerId -> Path2D (full path; used sparingly)
// Scratch vectors reused each frame to reduce GC pressure (mid-song freezes)
const _scratchPos = { x: 0, y: 0 };
const _scratchPos2 = { x: 0, y: 0 };
let lastHudScore = null;
let lastHudCombo = null;
let lastHudPct = null;

// Prebuilt short click buffers for turn feedback (avoids createOscillator GC storms)
let feedbackBuffers = null; // { excellent, good, miss } AudioBuffers
let feedbackBus = null; // shared GainNode

let currentLeaderboard = [];
let selectedDifficulty = 3; // 1: Easy, 2: Medium, 3: Hard (default)
let currentPlaybackRate = 1.0;
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
let notesHitCount = 0;

// --- Editor Mode State ---
let isEditorMode = false;
let editorSongId = null;
let editorMapId = null; // null = create new; number = editing existing map
let editorSegments = [];
let editorTracks = [];
let editorPath2D = null;
let editorCurrentTime = 0.0;
let editorIsPlaying = false;
let editorAudioSource = null;
let editorPlayWallTime = 0;
let editorSongAtPlayStart = 0;
let editorZoomScale = 1.0;
let editorBPM = 120;
let editorPlaybackRate = 1.0;
let editorBaseSegments = null; // original song segments for difficulty import
let draggedTurnIndex = null;
let initialTurnTime = 0.0;
let initialMouseX = 0;
let initialMouseY = 0;
let hasDragged = false;
let lastCheckedEditorTime = 0.0;

function getLocalPlayerName() {
    if (localId && players[localId] && players[localId].name) {
        return players[localId].name;
    }
    return localStorage.getItem('beat_maze_username') || '';
}

function getSongTime(wallNow = (audioContext ? audioContext.currentTime : 0)) {
    return (wallNow - gameStartTime) * currentPlaybackRate;
}

function getEditorSongTime(wallNow = (audioContext ? audioContext.currentTime : 0)) {
    if (!editorIsPlaying) return editorCurrentTime;
    return editorSongAtPlayStart + (wallNow - editorPlayWallTime) * editorPlaybackRate;
}

function clampPlaybackRate(rate) {
    const r = Number(rate);
    if (!Number.isFinite(r)) return 1.0;
    return Math.max(0.5, Math.min(2.0, Math.round(r * 100) / 100));
}

function filterSegmentsByDifficultyClient(originalSegments, bpm, difficulty) {
    if (!originalSegments || originalSegments.length === 0) {
        return [{ time: 0.0, dir: 0 }];
    }
    if (difficulty === 3 || difficulty === 5 || originalSegments.length <= 2) {
        return originalSegments.map(s => ({ time: s.time, dir: s.dir }));
    }

    const beatDuration = 60.0 / (bpm || 120);
    const minGap = (difficulty === 2) ? beatDuration : (2.0 * beatDuration);

    const filtered = [];
    filtered.push({ time: originalSegments[0].time, dir: originalSegments[0].dir });

    let lastKeptTime = originalSegments[0].time;
    let currentDir = originalSegments[0].dir;

    for (let i = 1; i < originalSegments.length - 1; i++) {
        const seg = originalSegments[i];
        if (seg.time - lastKeptTime >= minGap) {
            currentDir = 1 - currentDir;
            filtered.push({ time: seg.time, dir: currentDir });
            lastKeptTime = seg.time;
        }
    }

    const lastSeg = originalSegments[originalSegments.length - 1];
    currentDir = 1 - currentDir;
    filtered.push({ time: lastSeg.time, dir: currentDir });
    return filtered;
}

// Judgment Popups System
let judgmentPopups = [];
const MAX_JUDGMENT_POPUPS = 12;
function showJudgmentPopup(text, color, x, y) {
    if (judgmentPopups.length >= MAX_JUDGMENT_POPUPS) {
        judgmentPopups.shift();
    }
    judgmentPopups.push({
        text,
        color,
        x,
        y,
        createdAt: Date.now(),
        duration: 800 // 800ms
    });
}

/** Compact expired popups in-place (no Array.filter allocation every frame). */
function pruneJudgmentPopups(nowMs) {
    let w = 0;
    for (let i = 0; i < judgmentPopups.length; i++) {
        if (nowMs - judgmentPopups[i].createdAt < judgmentPopups[i].duration) {
            judgmentPopups[w++] = judgmentPopups[i];
        }
    }
    judgmentPopups.length = w;
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

// Reused autocorrelation buffer to avoid allocating Float32Array per note during pitch analysis
const _pitchCorr = new Float32Array(1024);

function detectPitch(buffer, time) {
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);
    const startSample = Math.floor(time * sampleRate);
    // Smaller window + coarser lag step: enough for musical pitch, far cheaper on long charts
    const fftSize = 1024;
    const half = fftSize >> 1;
    
    if (startSample < 0 || startSample + fftSize > channelData.length) {
        return 440;
    }
    
    const signal = channelData.subarray(startSample, startSample + fftSize);
    const r = _pitchCorr;
    for (let lag = 0; lag < half; lag++) {
        let sum = 0;
        // Step by 2: ~2x faster, still stable for 200–1200 Hz
        for (let i = 0; i < half; i += 2) {
            sum += signal[i] * signal[i + lag];
        }
        r[lag] = sum;
    }
    
    let threshold = 0.9 * r[0];
    let peakLag = -1;
    let searchStart = 1;
    for (let lag = 1; lag < half; lag++) {
        if (r[lag] < threshold) {
            searchStart = lag;
            break;
        }
    }
    
    let maxVal = -1;
    const searchEnd = half - 1;
    for (let lag = searchStart; lag < searchEnd; lag++) {
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

/** Yield to the browser so pitch analysis doesn't freeze the UI on long maps. */
function yieldToMain() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function precalculateNotePitches(segments, audioBuffer) {
    const pitches = new Array(segments.length);
    const CHUNK = 24;
    for (let i = 0; i < segments.length; i++) {
        pitches[i] = snapToNote(detectPitch(audioBuffer, segments[i].time));
        if (i > 0 && (i % CHUNK) === 0) {
            await yieldToMain();
        }
    }
    return pitches;
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
                    // Fetch songs first so lobby list still loads even if UI helpers throw
                    fetchSongsList();
                    updatePlayersList();
                    updateStartButtonText();
                    updateDifficultyUI();
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
                    currentPlaybackRate = clampPlaybackRate(data.playbackRate == null ? 1.0 : data.playbackRate);
                    updateDifficultyUI();
                    if (selectedDifficulty >= 100 && selectedSongId) {
                        const song = songList.find(s => s.id === selectedSongId);
                        fetch(`./api/custom-maps?song_id=${selectedSongId}`)
                            .then(res => res.json())
                            .then(maps => {
                                const customMapId = selectedDifficulty - 100;
                                const map = maps.find(m => m.id === customMapId);
                                if (map && song) {
                                    const segments = typeof map.segments === 'string' ? JSON.parse(map.segments) : map.segments;
                                    currentPlaybackRate = clampPlaybackRate(map.playback_rate == null ? currentPlaybackRate : map.playback_rate);
                                    loadedTrackData = {
                                        title: map.title,
                                        bpm: song.bpm || 120,
                                        leadIn: song.leadIn || 2.5,
                                        segments: segments,
                                        playback_rate: currentPlaybackRate
                                    };
                                    totalDuration = segments[segments.length - 1].time;
                                }
                                renderSongsList();
                            });
                    } else {
                        currentPlaybackRate = 1.0;
                        renderSongsList();
                    }
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
                    currentPlaybackRate = clampPlaybackRate(data.playbackRate == null ? currentPlaybackRate : data.playbackRate);
                    const adjustedDelay = Math.max(0, data.startDelay - latency);
                    handleStartGame(adjustedDelay, data.segments);
                    break;
                }
                
                case 'startSpectating': {
                    currentPlaybackRate = clampPlaybackRate(data.playbackRate == null ? currentPlaybackRate : data.playbackRate);
                    handleStartSpectating(data.elapsedT, data.segments);
                    break;
                }
                    
                case 'playerUpdate':
                    // Real-time position updates removed for optimization
                    break;
                    
                case 'statusUpdate': {
                    const serverPlayers = data.players;
                    for (const pid in serverPlayers) {
                        if (pid === localId) continue;
                        if (!players[pid]) players[pid] = {};
                        
                        if (players[pid].alive && !serverPlayers[pid].alive) {
                            players[pid].deathTime = Date.now();
                        }
                        
                        Object.assign(players[pid], serverPlayers[pid]);
                    }
                    break;
                }

                case 'playerFinished':
                    if (players[data.id]) {
                        players[data.id].finished = true;
                    }
                    if (data.id === localId && !finished) {
                        triggerClear();
                    }
                    break;
                    
                case 'playerDead':
                    if (players[data.id]) {
                        players[data.id].alive = false;
                        players[data.id].deathTime = Date.now();
                    }
                    if (data.id === localId) {
                        triggerDeath();
                    }
                    break;
                    
                case 'hit': {
                    const judgment = data.judgment;
                    if (data.id === localId) {
                        if (judgment === 'MISS') {
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
                            
                            // Update local player values
                            score = data.score;
                            combo = data.combo;
                            if (combo > maxCombo) maxCombo = combo;
                            
                            // Server confirmed the turn — accept authoritative state
                            localPredictionActive = false;
                            const localP = players[localId];
                            if (localP) {
                                localP.score = data.score;
                                localP.combo = data.combo;
                                localP.turnIndex = data.turnIndex;
                                const pts = precalculatedTracks[localId];
                                if (pts && pts[data.turnIndex]) {
                                    const tp = pts[data.turnIndex];
                                    localP.x = tp.x;
                                    localP.y = tp.y;
                                    localP.anchor = { x: tp.x, y: tp.y, time: tp.time };
                                    localP.currentDir = tp.dir;
                                }
                            }
                            
                            // Send statusReport every 5 notes
                            notesHitCount++;
                            if (notesHitCount % 5 === 0 && ws && ws.readyState === 1) {
                                ws.send(JSON.stringify({
                                    type: 'statusReport',
                                    score: score,
                                    combo: combo
                                }));
                            }
                        }
                    } else {
                        // Other player hit
                        if (players[data.id]) {
                            players[data.id].score = data.score;
                            players[data.id].combo = data.combo;
                            // Only update turnIndex if defined (MISS doesn't include it)
                            if (data.turnIndex !== undefined) {
                                players[data.id].turnIndex = data.turnIndex;
                            }
                        }
                        if (judgment !== 'MISS' && judgment !== 'Fast' && judgment !== 'Late') {
                            playEcho();
                        }
                    }
                    break;
                }
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
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        songList = Array.isArray(data) ? data : [];
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
        const isSelected = selectedSongId === song.id;
        const div = document.createElement('div');
        div.className = `song-item ${isSelected ? 'selected' : ''}`;
        
        const isCustom = (selectedDifficulty === 'custom' || selectedDifficulty >= 100);
        if (isSelected && isCustom) {
            div.style.flexDirection = 'column';
            div.style.alignItems = 'stretch';
        }
        
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.width = '100%';
        
        const textDiv = document.createElement('div');
        const durationMin = Math.floor(song.duration / 60);
        const durationSec = Math.floor(song.duration % 60).toString().padStart(2, '0');
        const durationStr = song.duration ? `${durationMin}:${durationSec}` : 'N/A';
        
        textDiv.innerHTML = `
            <div class="song-title">${song.title}</div>
            <div class="song-meta">${song.bpm} BPM | Duration: ${durationStr}</div>
        `;
        row.appendChild(textDiv);
        
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
        
        row.appendChild(deleteBtn);
        div.appendChild(row);
        
        if (isSelected && isCustom) {
            const customContainer = document.createElement('div');
            customContainer.className = 'custom-maps-list';
            customContainer.style.marginTop = '10px';
            customContainer.style.padding = '10px';
            customContainer.style.background = 'rgba(0,0,0,0.3)';
            customContainer.style.borderRadius = '8px';
            customContainer.style.border = '1px solid rgba(255,255,255,0.1)';
            customContainer.style.display = 'flex';
            customContainer.style.flexDirection = 'column';
            customContainer.style.gap = '8px';
            
            customContainer.innerHTML = '<div style="color: #b0bec5; font-style: italic; font-size: 0.9rem;">Loading custom maps...</div>';
            div.appendChild(customContainer);
            
            fetch(`./api/custom-maps?song_id=${song.id}`)
                .then(res => res.json())
                .then(maps => {
                    customContainer.innerHTML = '';
                    if (maps.length === 0) {
                        customContainer.innerHTML = '<div style="color: #b0bec5; font-style: italic; font-size: 0.85rem; padding: 5px;">No custom maps found.</div>';
                    } else {
                        maps.forEach(map => {
                            const mapItem = document.createElement('div');
                            const isMapSelected = selectedDifficulty === 100 + map.id;
                            mapItem.style.padding = '8px 12px';
                            mapItem.style.borderRadius = '6px';
                            mapItem.style.background = isMapSelected ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255,255,255,0.03)';
                            mapItem.style.border = isMapSelected ? '1px solid #00e676' : '1px solid rgba(255,255,255,0.05)';
                            mapItem.style.cursor = 'pointer';
                            mapItem.style.display = 'flex';
                            mapItem.style.justifyContent = 'space-between';
                            mapItem.style.alignItems = 'center';
                            mapItem.style.transition = 'all 0.2s';
                            
                            const rateLabel = clampPlaybackRate(map.playback_rate == null ? 1.0 : map.playback_rate);
                            mapItem.innerHTML = `
                                <div style="text-align: left; flex: 1; min-width: 0;">
                                    <div style="font-weight: 700; font-size: 0.9rem; color: ${isMapSelected ? '#00e676' : '#fff'};">${map.title}</div>
                                    <div style="font-size: 0.75rem; color: #b0bec5;">by ${map.creator_name}${rateLabel !== 1 ? ` · ${rateLabel.toFixed(2)}x` : ''}</div>
                                </div>
                            `;

                            const actions = document.createElement('div');
                            actions.style.display = 'flex';
                            actions.style.alignItems = 'center';
                            actions.style.gap = '2px';
                            actions.style.flexShrink = '0';

                            const localName = getLocalPlayerName();
                            const isOwner = localName && map.creator_name === localName;

                            if (isOwner) {
                                const editMapBtn = document.createElement('button');
                                editMapBtn.innerHTML = '✏️';
                                editMapBtn.title = 'Edit map';
                                editMapBtn.style.background = 'none';
                                editMapBtn.style.border = 'none';
                                editMapBtn.style.color = '#ffeb3b';
                                editMapBtn.style.cursor = 'pointer';
                                editMapBtn.style.fontSize = '1.0rem';
                                editMapBtn.style.padding = '2px 6px';
                                editMapBtn.style.transition = 'transform 0.2s';
                                editMapBtn.addEventListener('mouseenter', () => editMapBtn.style.transform = 'scale(1.2)');
                                editMapBtn.addEventListener('mouseleave', () => editMapBtn.style.transform = 'scale(1.0)');
                                editMapBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    enterEditorMode(song.id, map);
                                });
                                actions.appendChild(editMapBtn);

                                const deleteMapBtn = document.createElement('button');
                                deleteMapBtn.innerHTML = '🗑️';
                                deleteMapBtn.title = 'Delete map';
                                deleteMapBtn.style.background = 'none';
                                deleteMapBtn.style.border = 'none';
                                deleteMapBtn.style.color = '#ff5252';
                                deleteMapBtn.style.cursor = 'pointer';
                                deleteMapBtn.style.fontSize = '1.0rem';
                                deleteMapBtn.style.padding = '2px 6px';
                                deleteMapBtn.style.transition = 'transform 0.2s';
                                deleteMapBtn.addEventListener('mouseenter', () => deleteMapBtn.style.transform = 'scale(1.2)');
                                deleteMapBtn.addEventListener('mouseleave', () => deleteMapBtn.style.transform = 'scale(1.0)');
                                deleteMapBtn.addEventListener('click', async (e) => {
                                    e.stopPropagation();
                                    if (confirm(`Are you sure you want to delete custom map "${map.title}"?`)) {
                                        try {
                                            const res = await fetch(`./api/custom-maps/${map.id}`, {
                                                method: 'DELETE',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ creator_name: localName })
                                            });
                                            const result = await res.json();
                                            if (result.success) {
                                                renderSongsList();
                                            } else {
                                                alert(result.error || "Failed to delete custom map.");
                                            }
                                        } catch (err) {
                                            console.error(err);
                                            alert("Failed to delete custom map.");
                                        }
                                    }
                                });
                                actions.appendChild(deleteMapBtn);
                            }

                            mapItem.appendChild(actions);
                            
                            mapItem.addEventListener('click', (e) => {
                                e.stopPropagation();
                                selectCustomMap(map);
                            });
                            
                            customContainer.appendChild(mapItem);
                        });
                    }
                    
                    const createNewBtn = document.createElement('button');
                    createNewBtn.textContent = '＋ 新規作成';
                    createNewBtn.style.padding = '8px';
                    createNewBtn.style.background = 'rgba(0, 230, 118, 0.2)';
                    createNewBtn.style.border = '1px dashed #00e676';
                    createNewBtn.style.color = '#00e676';
                    createNewBtn.style.borderRadius = '6px';
                    createNewBtn.style.cursor = 'pointer';
                    createNewBtn.style.fontWeight = '700';
                    createNewBtn.style.fontFamily = 'Outfit';
                    createNewBtn.style.fontSize = '0.85rem';
                    createNewBtn.style.width = '100%';
                    createNewBtn.style.marginTop = '5px';
                    createNewBtn.style.transition = 'all 0.2s';
                    
                    createNewBtn.addEventListener('mouseenter', () => createNewBtn.style.background = 'rgba(0, 230, 118, 0.3)');
                    createNewBtn.addEventListener('mouseleave', () => createNewBtn.style.background = 'rgba(0, 230, 118, 0.2)');
                    createNewBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        enterEditorMode(song.id, null);
                    });
                    customContainer.appendChild(createNewBtn);
                })
                .catch(err => {
                    console.error(err);
                    customContainer.innerHTML = '<div style="color: #ff5252; font-size: 0.85rem;">Failed to load custom maps.</div>';
                });
        }
        
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
        let diffStars = '★★★';
        if (selectedDifficulty === 1) diffStars = '★';
        else if (selectedDifficulty === 2) diffStars = '★★';
        else if (selectedDifficulty === 3) diffStars = '★★★';
        else if (selectedDifficulty === 5) diffStars = '★★★★★';
        else if (selectedDifficulty === 'custom' || selectedDifficulty >= 100) diffStars = 'Custom';
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
        
        if (selectedDifficulty >= 100) {
            try {
                const mapsRes = await fetch(`./api/custom-maps?song_id=${songId}`);
                const maps = await mapsRes.json();
                const customMapId = selectedDifficulty - 100;
                const map = maps.find(m => m.id === customMapId);
                if (map) {
                    const segments = typeof map.segments === 'string' ? JSON.parse(map.segments) : map.segments;
                    loadedTrackData.title = map.title;
                    loadedTrackData.segments = segments;
                    currentPlaybackRate = clampPlaybackRate(map.playback_rate == null ? 1.0 : map.playback_rate);
                    loadedTrackData.playback_rate = currentPlaybackRate;
                }
            } catch (err) {
                console.error("Failed to load custom map segments during download:", err);
            }
        } else {
            currentPlaybackRate = 1.0;
        }
        
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

        // 2. Precalculate note pitches (chunked async — full-song sync analysis caused multi-second freezes)
        try {
            precalculatedPitches = [];
            if (loadedTrackData && loadedTrackData.segments && loadedTrackData.segments.length) {
                downloadStatus.textContent = `Analyzing pitches...`;
                precalculatedPitches = await precalculateNotePitches(loadedTrackData.segments, loadedAudioBuffer);
            }
        } catch (err) {
            console.error("Failed to precalculate pitches:", err);
            precalculatedPitches = [];
        }

        // Warm turn-feedback buffers while still in lobby
        ensureFeedbackAudio();
        
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
    
    // Close modal
    if (addTrackModal) addTrackModal.style.display = 'none';
    
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
    
    // Close modal
    if (addTrackModal) addTrackModal.style.display = 'none';
    
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

// --- Add Track Modal Logic ---
if (addTrackBtn) {
    addTrackBtn.addEventListener('click', () => {
        addTrackModal.style.display = 'flex';
        // Reset tabs to upload content
        tabUploadContent.style.display = 'flex';
        tabOnlineContent.style.display = 'none';
        tabUploadBtn.style.color = '#00e676';
        tabUploadBtn.style.borderBottom = '2px solid #00e676';
        tabOnlineBtn.style.color = '#b0bec5';
        tabOnlineBtn.style.borderBottom = 'none';
    });
}

if (closeAddTrackBtn) {
    closeAddTrackBtn.addEventListener('click', () => {
        addTrackModal.style.display = 'none';
    });
}

if (tabUploadBtn && tabOnlineBtn) {
    tabUploadBtn.addEventListener('click', () => {
        tabUploadContent.style.display = 'flex';
        tabOnlineContent.style.display = 'none';
        tabUploadBtn.style.color = '#00e676';
        tabUploadBtn.style.borderBottom = '2px solid #00e676';
        tabOnlineBtn.style.color = '#b0bec5';
        tabOnlineBtn.style.borderBottom = 'none';
    });
    
    tabOnlineBtn.addEventListener('click', () => {
        tabUploadContent.style.display = 'none';
        tabOnlineContent.style.display = 'flex';
        tabOnlineBtn.style.color = '#00e676';
        tabOnlineBtn.style.borderBottom = '2px solid #00e676';
        tabUploadBtn.style.color = '#b0bec5';
        tabUploadBtn.style.borderBottom = 'none';
    });
}

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

function ensureFeedbackAudio() {
    if (!audioContext) return false;
    if (!feedbackBus) {
        feedbackBus = audioContext.createGain();
        feedbackBus.gain.value = 1.0;
        feedbackBus.connect(audioContext.destination);
    }
    if (feedbackBuffers) return true;

    // Offline-render short triangle blips once — replay via BufferSource (cheaper GC profile than Oscillator spam)
    const makeBlip = (freq, peakGain, durationSec) => {
        const sr = audioContext.sampleRate;
        const n = Math.max(1, Math.floor(sr * durationSec));
        const buf = audioContext.createBuffer(1, n, sr);
        const data = buf.getChannelData(0);
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const env = Math.exp(-t * 28) * peakGain;
            // triangle-ish wave
            const phase = (t * freq) % 1;
            const tri = phase < 0.5 ? (phase * 4 - 1) : (3 - phase * 4);
            data[i] = tri * env;
        }
        return buf;
    };

    feedbackBuffers = {
        excellent: makeBlip(660, 0.45, 0.14),
        good: makeBlip(440, 0.35, 0.14),
        soft: makeBlip(330, 0.2, 0.14),
        echo: makeBlip(520, 0.15, 0.16)
    };
    return true;
}

function playBufferedBlip(buffer, playbackRate = 1.0, gain = 1.0) {
    if (!ensureFeedbackAudio() || !buffer) return;
    const now = audioContext.currentTime;
    const src = audioContext.createBufferSource();
    const env = audioContext.createGain();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;
    env.gain.value = gain;
    src.connect(env);
    env.connect(feedbackBus);
    src.start(now);
    src.stop(now + buffer.duration / Math.max(0.01, playbackRate) + 0.02);
    src.onended = () => {
        try { src.disconnect(); } catch (e) {}
        try { env.disconnect(); } catch (e) {}
    };
}

function playLocalTurnFeedback(judgment, turnIndex) {
    if (!audioContext) return;

    // Pitch via playbackRate against a 440Hz-ish base buffer, matching melody when available
    const baseFreq = (typeof turnIndex === 'number' && precalculatedPitches[turnIndex])
        ? precalculatedPitches[turnIndex]
        : 440;

    let kind = 'good';
    let targetFreq = baseFreq;
    let gain = 0.9;
    if (judgment === 'excellent') {
        kind = 'excellent';
        targetFreq = baseFreq * 1.5;
        gain = 1.0;
    } else if (judgment === 'Good') {
        kind = 'good';
        targetFreq = baseFreq;
        gain = 0.85;
    } else {
        kind = 'soft';
        targetFreq = baseFreq * 0.75;
        gain = 0.7;
    }

    if (!ensureFeedbackAudio()) return;
    const refFreq = kind === 'excellent' ? 660 : (kind === 'soft' ? 330 : 440);
    const rate = Math.max(0.5, Math.min(2.0, targetFreq / refFreq));
    playBufferedBlip(feedbackBuffers[kind], rate, gain);
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
    if (!ensureFeedbackAudio()) return;
    playBufferedBlip(feedbackBuffers.echo, 1.0, 1.0);
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
    notesHitCount = 0;
    
    if (serverSegments && serverSegments.length) {
        totalDuration = serverSegments[serverSegments.length - 1].time;
    }
    
    // Precalculate paths
    precalculatedTracks = {};
    precalculatedPaths = {};
    lastHudScore = null;
    lastHudCombo = null;
    lastHudPct = null;
    judgmentPopups.length = 0;
    for (const id in players) {
        const p = players[id];
        precalculatedTracks[id] = precalculatePathPoints(serverSegments, p.spawnIndex);
        
        const pts = precalculatedTracks[id];
        const path = new Path2D();
        for (let i = 0; i < pts.length; i++) {
            if (i === 0) path.moveTo(pts[i].x, pts[i].y);
            else path.lineTo(pts[i].x, pts[i].y);
        }
        precalculatedPaths[id] = path;
        
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

    // Warm feedback audio so first hits don't allocate offline-render work mid-song
    ensureFeedbackAudio();
    
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
    audioSource.playbackRate.value = currentPlaybackRate;
    
    musicGainNode = audioContext.createGain();
    musicGainNode.gain.setValueAtTime(musicVolumeBoost, audioContext.currentTime);
    audioSource.connect(musicGainNode);
    musicGainNode.connect(audioContext.destination);
    
    const nowTime = audioContext.currentTime;
    if (nowTime < gameStartTime) {
        audioSource.start(gameStartTime);
    } else {
        // Late join as spectator: align audio playback (offset is song/buffer time)
        const wallOffset = nowTime - gameStartTime;
        const bufferOffset = wallOffset * currentPlaybackRate;
        if (bufferOffset < loadedAudioBuffer.duration) {
            audioSource.start(nowTime, bufferOffset);
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
    
    if (serverSegments && serverSegments.length) {
        totalDuration = serverSegments[serverSegments.length - 1].time;
    }
    
    precalculatedTracks = {};
    precalculatedPaths = {};
    judgmentPopups.length = 0;
    for (const id in players) {
        const p = players[id];
        precalculatedTracks[id] = precalculatePathPoints(serverSegments, p.spawnIndex);
        
        const pts = precalculatedTracks[id];
        const path = new Path2D();
        for (let i = 0; i < pts.length; i++) {
            if (i === 0) path.moveTo(pts[i].x, pts[i].y);
            else path.lineTo(pts[i].x, pts[i].y);
        }
        precalculatedPaths[id] = path;
    }

    ensureFeedbackAudio();
    
    if (audioSource) {
        try { audioSource.stop(); } catch(e) {}
    }
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = loadedAudioBuffer;
    audioSource.playbackRate.value = currentPlaybackRate;
    
    musicGainNode = audioContext.createGain();
    musicGainNode.gain.setValueAtTime(musicVolumeBoost, audioContext.currentTime);
    audioSource.connect(musicGainNode);
    musicGainNode.connect(audioContext.destination);
    
    const nowTime = audioContext.currentTime;
    const rate = currentPlaybackRate || 1.0;
    // elapsedT is song/buffer time from server
    if (elapsedT < 0) {
        // Still in countdown: song time is negative in rate-scaled units
        gameStartTime = nowTime - (elapsedT / rate);
        audioSource.start(gameStartTime, 0);
    } else {
        gameStartTime = nowTime - (elapsedT / rate);
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
    
    let diffStars = '★★★';
    if (selectedDifficulty === 1) diffStars = '★';
    else if (selectedDifficulty === 2) diffStars = '★★';
    else if (selectedDifficulty === 3) diffStars = '★★★';
    else if (selectedDifficulty === 5) diffStars = '★★★★★';
    else if (selectedDifficulty === 'custom' || selectedDifficulty >= 100) {
        const rateTxt = currentPlaybackRate !== 1 ? ` ${currentPlaybackRate.toFixed(2)}x` : '';
        diffStars = `Custom${rateTxt}`;
    }
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
        const t = getSongTime();
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
    // Only touch the DOM when values change — textContent writes force style/layout work
    if (score !== lastHudScore) {
        lastHudScore = score;
        scoreDisplay.textContent = `Score: ${score}`;
    }
    if (combo !== lastHudCombo) {
        lastHudCombo = combo;
        comboDisplay.textContent = `Combo: ${combo}`;
    }
    const pct = totalDuration > 0 ? Math.min(100, Math.floor((Math.max(0, t) / totalDuration) * 100)) : 0;
    if (pct !== lastHudPct) {
        lastHudPct = pct;
        progressDisplay.textContent = `${pct}%`;
    }
}

function handleTap() {
    if (gameState !== 'playing' || !alive) return;
    
    const localP = players[localId];
    if (localP && localP.spectator) return;
    
    const tapTime = getSongTime();
    // Calibration is wall-clock latency; scale into song-time at current playback rate
    const calibratedTime = tapTime + (calibrationOffset * currentPlaybackRate);
    
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
    if (e.target.closest('#editor-controls') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    
    if (isEditorMode) {
        if (editorIsPlaying) {
            placeEditorNoteAtSongTime(getEditorSongTime() + (calibrationOffset * editorPlaybackRate));
        }
        return;
    }
    handleTap();
});
window.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
        if (songSelection.style.display !== 'none') return;
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
        e.preventDefault();
        
        if (isEditorMode) {
            if (editorIsPlaying) {
                placeEditorNoteAtSongTime(getEditorSongTime() + (calibrationOffset * editorPlaybackRate));
            }
            return;
        }
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
/**
 * Write smooth position into `out` (reused scratch object) to avoid per-frame allocations.
 * Falls back to allocating only if out is omitted.
 */
function getSmoothPlayerPosition(p, t, out) {
    const result = out || { x: 0, y: 0 };
    if (!p.alive || p.finished || t < 0) {
        result.x = p.x;
        result.y = p.y;
        return result;
    }
    
    const elapsed = t - p.anchor.time;
    const dist = elapsed * SPEED_PER_SEC;
    const dv = DIR_VECS[p.currentDir];
    
    result.x = p.anchor.x + dv.x * dist;
    result.y = p.anchor.y + dv.y * dist;
    return result;
}

/** Binary search: largest i with pts[i].time <= t */
function findPathIndexAtTime(pts, t) {
    if (!pts || pts.length === 0) return 0;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pts[mid].time <= t) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * Stroke only nearby corridor segments (viewport window).
 * Full-path Path2D stroke of 500+ points × 3 layers every frame is a primary hitch source.
 */
function strokeCorridorWindow(pts, fromIdx, toIdx) {
    if (!pts || pts.length < 2) return;
    const start = Math.max(0, fromIdx);
    const end = Math.min(pts.length - 1, toIdx);
    if (end <= start) return;

    ctx.beginPath();
    ctx.moveTo(pts[start].x, pts[start].y);
    for (let i = start + 1; i <= end; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.lineWidth = WALL_HALF_WIDTH * 2;
    ctx.strokeStyle = '#1a1a2e';
    ctx.stroke();

    ctx.lineWidth = WALL_HALF_WIDTH * 2 + 4;
    ctx.strokeStyle = '#2a2a4a';
    ctx.stroke();

    ctx.lineWidth = WALL_HALF_WIDTH * 2 - 4;
    ctx.strokeStyle = '#12122a';
    ctx.stroke();
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
    
    if (isEditorMode) {
        if (editorIsPlaying) {
            editorCurrentTime = getEditorSongTime(now);
            const maxDur = loadedAudioBuffer ? loadedAudioBuffer.duration : 100;
            if (editorCurrentTime >= maxDur) {
                editorPause();
                editorCurrentTime = maxDur;
            }
            
            // Auto-play turns feedback sound (only notes crossed since last frame)
            if (editorTracks.length > 1 && editorCurrentTime > lastCheckedEditorTime) {
                const fromIdx = findPathIndexAtTime(editorTracks, lastCheckedEditorTime) + 1;
                const toIdx = findPathIndexAtTime(editorTracks, editorCurrentTime);
                for (let idx = Math.max(1, fromIdx); idx <= toIdx; idx++) {
                    const tp = editorTracks[idx];
                    if (tp.time > lastCheckedEditorTime && tp.time <= editorCurrentTime) {
                        playLocalTurnFeedback('excellent', idx);
                    }
                }
            }
            
            lastCheckedEditorTime = editorCurrentTime;
            
            // Update timeline UI
            const editorTimeline = document.getElementById('editor-timeline');
            if (editorTimeline) editorTimeline.value = editorCurrentTime;
            const timeCurrent = document.getElementById('editor-time-current');
            if (timeCurrent) timeCurrent.textContent = formatTime(editorCurrentTime);
        }
        
        const editorPos = getEditorPositionAtTime(editorCurrentTime);
        render(editorCurrentTime, editorPos.x, editorPos.y);
        return;
    }
    
    let t = getSongTime(now);
    
    if (gameState === 'starting') {
        if (now >= gameStartTime) {
            gameState = 'playing';
            t = 0;
        }
    }
    
    const localP = players[localId];
    let camX = 0, camY = 0;
    
    if (localP && !localP.spectator && localP.alive) {
        getSmoothPlayerPosition(localP, t, _scratchPos);
        camX = _scratchPos.x;
        camY = _scratchPos.y;
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
            getSmoothPlayerPosition(followTarget, t, _scratchPos);
            camX = _scratchPos.x;
            camY = _scratchPos.y;
        } else {
            const startPt = precalculatedTracks[localId] ? precalculatedTracks[localId][0] : null;
            camX = startPt ? startPt.x : 0;
            camY = startPt ? startPt.y : 0;
        }
    }
    
    if (gameState === 'playing') {
        updateHUD(t);
    }
    render(t, camX, camY);
}

// --- Drawing ---
function render(t, camX, camY) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Dynamic base scale: scales down on smaller screens (e.g., mobile) to maintain same field of view
    const baseScale = Math.max(0.4, Math.min(canvas.width, canvas.height) / 1000);
    let camScale = isEditorMode ? editorZoomScale : baseScale;
    
    if (gameState === 'starting') {
        const elapsed = audioContext.currentTime - zoomStartTime;
        const zoomDuration = (gameStartTime - zoomStartTime);
        const progress = Math.min(1, elapsed / zoomDuration);
        const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        
        camScale = baseScale * (0.3 + 0.7 * ease);
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
    
    // How far ahead/behind of the player to keep corridor geometry drawn
    const CORRIDOR_LOOKBEHIND = 24;
    const CORRIDOR_LOOKAHEAD = 48;
    // Trail is expensive late-game if rebuilt fully; only stroke recent segment window
    const TRAIL_LOOKBEHIND = 80;

    if (isEditorMode) {
        // Editor: windowed stroke around playhead (editor tracks can also grow large)
        if (editorTracks && editorTracks.length > 1) {
            const eIdx = findPathIndexAtTime(editorTracks, editorCurrentTime);
            strokeCorridorWindow(editorTracks, eIdx - CORRIDOR_LOOKBEHIND, eIdx + CORRIDOR_LOOKAHEAD);
        }
    } else {
        // 1. Draw corridors — only near the local (or followed) player. Full Path2D stroke
        // of 500+ points × 3 layers × N players every frame causes multi-frame hitches.
        let focusPts = precalculatedTracks[localId];
        if (!focusPts) {
            for (const pid in precalculatedTracks) {
                focusPts = precalculatedTracks[pid];
                break;
            }
        }
        if (focusPts) {
            const focusIdx = findPathIndexAtTime(focusPts, t);
            for (const pid in players) {
                const pts = precalculatedTracks[pid];
                if (!pts) continue;
                strokeCorridorWindow(pts, focusIdx - CORRIDOR_LOOKBEHIND, focusIdx + CORRIDOR_LOOKAHEAD);
            }
        }
    }
    
    // 2. Draw turn diamonds (viewport cull + no shadowBlur — shadows are a top hitch cost)
    if (isEditorMode) {
        const margin = (canvas.width / 2) / camScale + 100;
        const eIdx = findPathIndexAtTime(editorTracks, editorCurrentTime);
        const dStart = Math.max(1, eIdx - CORRIDOR_LOOKBEHIND);
        const dEnd = Math.min(editorTracks.length - 1, eIdx + CORRIDOR_LOOKAHEAD);
        ctx.fillStyle = '#ffeb3b';
        for (let i = dStart; i <= dEnd; i++) {
            const tp = editorTracks[i];
            if (Math.abs(tp.x - camX) > margin || Math.abs(tp.y - camY) > margin) continue;
            
            const passed = editorCurrentTime >= tp.time;
            const sz = passed ? 5 : 7;
            // Axis-aligned diamond via two triangles / rotated rect without save/restore when possible
            ctx.save();
            ctx.translate(tp.x, tp.y);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = passed ? '#333' : '#ffeb3b';
            ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
            ctx.restore();
        }
    } else if (loadedTrackData && precalculatedTracks[localId]) {
        const pts = precalculatedTracks[localId];
        const localP = players[localId];
        const margin = (canvas.width / 2) / camScale + 100;
        const focusIdx = findPathIndexAtTime(pts, t);
        const dStart = Math.max(1, focusIdx - CORRIDOR_LOOKBEHIND);
        const dEnd = Math.min(pts.length - 1, focusIdx + CORRIDOR_LOOKAHEAD);
        
        for (let i = dStart; i <= dEnd; i++) {
            const tp = pts[i];
            if (Math.abs(tp.x - camX) > margin || Math.abs(tp.y - camY) > margin) continue;
            
            const collected = localP && i <= localP.turnIndex;
            const sz = collected ? 5 : 7;
            ctx.save();
            ctx.translate(tp.x, tp.y);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = collected ? '#333' : '#ffeb3b';
            ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
            ctx.restore();
        }
    }
    
    // 3. Draw trails and player dots
    if (isEditorMode) {
        const editorPos = getEditorPositionAtTime(editorCurrentTime);
        ctx.fillStyle = '#00e676';
        // Soft glow via larger translucent circle instead of shadowBlur
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(editorPos.x, editorPos.y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        ctx.beginPath();
        ctx.arc(editorPos.x, editorPos.y, 9, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = '#fff';
        ctx.font = '700 12px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText("YOU", editorPos.x, editorPos.y - 15);
    } else {
        const localP = players[localId];
        let refP = (localP && !localP.spectator) ? localP : null;
        if (!refP) {
            for (const id in players) {
                const p = players[id];
                if (p.alive && !p.spectator) {
                    refP = p;
                    break;
                }
            }
        }
        const refPathData = refP ? precalculatedTracks[refP.id] : null;
        if (refP) {
            getSmoothPlayerPosition(refP, t, _scratchPos2);
        }

        for (const id in players) {
            const p = players[id];
            const pathData = precalculatedTracks[id];
            if (!pathData) continue;
            
            let posX, posY;
            let pTurnIndex = p.turnIndex || 0;
            let opacity = id === localId ? 0.9 : 0.5;
            let dotOpacity = 1.0;
            
            if (!p.alive) {
                const elapsed = Date.now() - (p.deathTime || Date.now());
                const fadeDuration = 500; // 500ms fadeout
                if (elapsed > fadeDuration) {
                    continue; // Do not draw this player at all
                }
                const ratio = 1 - (elapsed / fadeDuration);
                opacity = ratio * (id === localId ? 0.9 : 0.5);
                dotOpacity = ratio;
            }

            let diffX = 0, diffY = 0;
            if (id === localId) {
                getSmoothPlayerPosition(p, t, _scratchPos);
                posX = _scratchPos.x;
                posY = _scratchPos.y;
                pTurnIndex = p.turnIndex || 0;
            } else if (refP && refPathData) {
                diffX = SPAWN_OFFSETS[p.spawnIndex % SPAWN_OFFSETS.length].x - SPAWN_OFFSETS[refP.spawnIndex % SPAWN_OFFSETS.length].x;
                diffY = SPAWN_OFFSETS[p.spawnIndex % SPAWN_OFFSETS.length].y - SPAWN_OFFSETS[refP.spawnIndex % SPAWN_OFFSETS.length].y;
                posX = _scratchPos2.x + diffX;
                posY = _scratchPos2.y + diffY;
                pTurnIndex = refP.turnIndex || 0;
            } else {
                getSmoothPlayerPosition(p, t, _scratchPos);
                posX = _scratchPos.x;
                posY = _scratchPos.y;
                pTurnIndex = p.turnIndex || 0;
            }
            
            // Trail: only recent window + current head (avoids O(totalNotes) every frame late-song)
            if (pathData.length > 0) {
                const refPath = (id !== localId && refP && refPathData) ? refPathData : pathData;
                const refTurnIdx = (id !== localId && refP) ? (refP.turnIndex || 0) : pTurnIndex;
                const limit = Math.min(refPath.length - 1, refTurnIdx);
                const trailStart = Math.max(0, limit - TRAIL_LOOKBEHIND);

                ctx.strokeStyle = p.color;
                ctx.lineWidth = id === localId ? 6 : 4;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.globalAlpha = opacity;
                ctx.beginPath();
                ctx.moveTo(refPath[trailStart].x + diffX, refPath[trailStart].y + diffY);
                for (let i = trailStart + 1; i <= limit; i++) {
                    ctx.lineTo(refPath[i].x + diffX, refPath[i].y + diffY);
                }
                ctx.lineTo(posX, posY);
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }
            
            if (p.alive || opacity > 0) {
                ctx.globalAlpha = dotOpacity;
                ctx.fillStyle = p.alive ? p.color : '#ff5252';
                // Glow without shadowBlur (major main-thread cost on some GPUs/drivers)
                if (id === localId && p.alive) {
                    ctx.globalAlpha = dotOpacity * 0.35;
                    ctx.beginPath();
                    ctx.arc(posX, posY, 18, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = dotOpacity;
                }
                ctx.beginPath();
                ctx.arc(posX, posY, id === localId ? 9 : 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;
                
                if (p.name) {
                    ctx.globalAlpha = dotOpacity;
                    ctx.fillStyle = '#fff';
                    ctx.font = '700 12px Outfit';
                    ctx.textAlign = 'center';
                    ctx.fillText(p.name, posX, posY - 15);
                    ctx.globalAlpha = 1.0;
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
    }

    // Judgment popups (in world space) — in-place prune, no filter() allocation
    const nowTimeMs = Date.now();
    pruneJudgmentPopups(nowTimeMs);
    
    for (let pi = 0; pi < judgmentPopups.length; pi++) {
        const pop = judgmentPopups[pi];
        const elapsed = nowTimeMs - pop.createdAt;
        const progress = elapsed / pop.duration;
        const currentY = pop.y - progress * 50;
        
        ctx.save();
        ctx.translate(pop.x, currentY);
        
        let scale = 1.0;
        if (progress < 0.15) {
            scale = 1.0 + (0.15 - progress) * 2.5; 
        } else if (progress > 0.6) {
            scale = 1.0 - (progress - 0.6) * 2.5;
        }
        scale = Math.max(0, scale);
        ctx.scale(scale / camScale, scale / camScale);
        
        const alpha = Math.max(0, 1 - progress);
        ctx.globalAlpha = alpha;
        
        ctx.font = "bold 22px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 4;
        ctx.strokeText(pop.text, 0, 0);
        
        ctx.fillStyle = pop.color;
        ctx.fillText(pop.text, 0, 0);
        
        ctx.restore();
    }
    
    ctx.restore();
}

// --- Difficulty Selector Logic ---
const diffBtns = document.querySelectorAll('.diff-btn');
diffBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (gameState === 'idle') {
            const diffAttr = btn.getAttribute('data-diff');
            if (diffAttr === 'custom') {
                selectedDifficulty = 'custom';
                updateDifficultyUI();
                renderSongsList();
                return;
            }
            const diff = parseInt(diffAttr);
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
        const diffAttr = btn.getAttribute('data-diff');
        const isCustom = (selectedDifficulty === 'custom' || selectedDifficulty >= 100);
        const isActive = (diffAttr === 'custom' && isCustom) ||
                         (diffAttr !== 'custom' && parseInt(diffAttr) === selectedDifficulty);
        
        if (isActive) {
            btn.classList.add('active');
            btn.style.borderColor = (diffAttr === '5') ? '#ff1744' : '#00e676';
            btn.style.background = (diffAttr === '5') ? 'rgba(255, 23, 68, 0.1)' : 'rgba(0, 230, 118, 0.1)';
            btn.style.color = (diffAttr === '5') ? '#ff1744' : '#00e676';
        } else if (diffAttr === '5' && !diff5Unlocked) {
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

    const startGameBtn = document.getElementById('start-game-btn');
    if (startGameBtn) {
        if (selectedDifficulty === 'custom') {
            startGameBtn.style.display = 'none';
        } else {
            startGameBtn.style.display = selectedSongId ? 'block' : 'none';
        }
    }
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

// --- Custom Maps / Editor Mode Implementation ---

function selectCustomMap(map) {
    const diff = 100 + map.id;
    selectedDifficulty = diff;
    currentPlaybackRate = clampPlaybackRate(map.playback_rate == null ? 1.0 : map.playback_rate);
    
    try {
        const segments = typeof map.segments === 'string' ? JSON.parse(map.segments) : map.segments;
        loadedTrackData = {
            title: map.title,
            bpm: selectedSongId ? (songList.find(s => s.id === selectedSongId)?.bpm || 120) : 120,
            leadIn: selectedSongId ? (songList.find(s => s.id === selectedSongId)?.leadIn || 2.5) : 2.5,
            segments: segments,
            playback_rate: currentPlaybackRate
        };
        totalDuration = segments[segments.length - 1].time;
    } catch (e) {
        console.error("Failed to parse custom segments:", e);
    }
    
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'selectDifficulty', difficulty: diff }));
    }
    
    updateDifficultyUI();
    renderSongsList();
}

function setEditorPlaybackRateUI(rate) {
    editorPlaybackRate = clampPlaybackRate(rate);
    const slider = document.getElementById('editor-rate-slider');
    const label = document.getElementById('editor-rate-val');
    if (slider) slider.value = String(editorPlaybackRate);
    if (label) label.textContent = `${editorPlaybackRate.toFixed(2)}x`;
}

function applyEditorSegments(segments, { rebuild = true } = {}) {
    if (!segments || !segments.length) {
        editorSegments = [{ time: 0.0, dir: 0 }];
    } else {
        editorSegments = segments.map(s => ({ time: s.time, dir: s.dir || 0 }));
        if (editorSegments[0].time !== 0) {
            editorSegments.unshift({ time: 0.0, dir: 0 });
        }
    }
    if (rebuild) sortAndRebuildDirections();
}

function placeEditorNoteAtSongTime(calibratedTime) {
    const beatDuration = 60.0 / editorBPM;
    const stepSize = beatDuration / 4;

    let snappedTime;
    if (editorSegments.length <= 1) {
        snappedTime = calibratedTime;
    } else {
        const firstTime = editorSegments[1].time;
        snappedTime = firstTime + Math.round((calibratedTime - firstTime) / stepSize) * stepSize;
    }

    if (snappedTime > 0.05 && !editorSegments.some(s => Math.abs(s.time - snappedTime) < 0.05)) {
        editorSegments.push({ time: snappedTime, dir: 0 });
        sortAndRebuildDirections();
        playLocalTurnFeedback('excellent', editorSegments.length - 1);
    }
}

async function populateEditorImportOptions(songId, excludeMapId = null) {
    const select = document.getElementById('editor-import-select');
    if (!select) return;

    // Keep static options; rebuild dynamic custom map options
    select.innerHTML = `
        <option value="">Import chart...</option>
        <option value="blank">Empty</option>
        <option value="diff:1">★ Easy</option>
        <option value="diff:2">★★ Medium</option>
        <option value="diff:3">★★★ Hard</option>
        <option value="diff:5">★★★★★ Brutal</option>
    `;

    try {
        const res = await fetch(`./api/custom-maps?song_id=${encodeURIComponent(songId)}`);
        const maps = await res.json();
        if (Array.isArray(maps) && maps.length) {
            const group = document.createElement('optgroup');
            group.label = 'Custom maps';
            maps.forEach(map => {
                if (excludeMapId != null && map.id === excludeMapId) return;
                const opt = document.createElement('option');
                const rate = clampPlaybackRate(map.playback_rate == null ? 1.0 : map.playback_rate);
                opt.value = `custom:${map.id}`;
                opt.textContent = `${map.title} (by ${map.creator_name}${rate !== 1 ? `, ${rate.toFixed(2)}x` : ''})`;
                opt.dataset.segments = typeof map.segments === 'string' ? map.segments : JSON.stringify(map.segments);
                opt.dataset.rate = String(rate);
                group.appendChild(opt);
            });
            if (group.children.length) select.appendChild(group);
        }
    } catch (err) {
        console.error("Failed to load custom maps for import:", err);
    }
    select.value = '';
}

async function importEditorChart(sourceValue) {
    if (!sourceValue) return;

    if (sourceValue === 'blank') {
        applyEditorSegments([{ time: 0.0, dir: 0 }]);
        return;
    }

    if (sourceValue.startsWith('diff:')) {
        const diff = parseInt(sourceValue.split(':')[1], 10);
        let base = editorBaseSegments;
        if (!base || !base.length) {
            // Fall back to currently loaded track data or fetch song json
            if (loadedTrackData && loadedTrackData.segments && selectedSongId === editorSongId) {
                base = loadedTrackData.segments;
            } else {
                const song = songList.find(s => s.id === editorSongId);
                if (song) {
                    const res = await fetch(song.json);
                    const data = await res.json();
                    base = data.segments || [];
                    editorBaseSegments = base;
                    editorBPM = data.bpm || editorBPM;
                }
            }
        }
        const filtered = filterSegmentsByDifficultyClient(base, editorBPM, diff);
        applyEditorSegments(filtered);
        return;
    }

    if (sourceValue.startsWith('custom:')) {
        const select = document.getElementById('editor-import-select');
        const opt = select ? select.selectedOptions[0] : null;
        if (opt && opt.dataset.segments) {
            try {
                const segs = JSON.parse(opt.dataset.segments);
                applyEditorSegments(segs);
                if (opt.dataset.rate) {
                    setEditorPlaybackRateUI(opt.dataset.rate);
                    if (editorIsPlaying) editorSeek(editorCurrentTime);
                }
            } catch (e) {
                console.error("Failed to import custom map segments:", e);
                alert("Failed to import custom map.");
            }
        }
    }
}

async function enterEditorMode(songId, existingMap = null) {
    unlockAudio();

    // Ensure audio for this song is loaded
    if (selectedSongId !== songId || !loadedAudioBuffer) {
        selectedSongId = songId;
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'selectSong', songId }));
        }
        await downloadSongData(songId);
    }

    isEditorMode = true;
    editorSongId = songId;
    editorMapId = existingMap ? existingMap.id : null;

    const song = songList.find(s => s.id === songId);
    editorBPM = song ? (song.bpm || 120) : 120;
    editorBaseSegments = (loadedTrackData && loadedTrackData.segments && !existingMap)
        ? loadedTrackData.segments.map(s => ({ time: s.time, dir: s.dir }))
        : null;

    // Prefer original song segments for difficulty import (not custom overlay)
    try {
        if (song) {
            const res = await fetch(song.json);
            const data = await res.json();
            editorBaseSegments = data.segments || editorBaseSegments;
            editorBPM = data.bpm || editorBPM;
        }
    } catch (e) {
        console.warn("Could not load base song segments for import:", e);
    }

    if (existingMap) {
        const localName = getLocalPlayerName();
        if (!localName || existingMap.creator_name !== localName) {
            alert("Only the map creator can edit this map.");
            isEditorMode = false;
            editorMapId = null;
            return;
        }
        try {
            const segs = typeof existingMap.segments === 'string'
                ? JSON.parse(existingMap.segments)
                : existingMap.segments;
            applyEditorSegments(segs, { rebuild: false });
        } catch (e) {
            console.error(e);
            applyEditorSegments([{ time: 0.0, dir: 0 }], { rebuild: false });
        }
        setEditorPlaybackRateUI(existingMap.playback_rate == null ? 1.0 : existingMap.playback_rate);
        document.getElementById('editor-title-input').value = existingMap.title || '';
        document.getElementById('editor-creator-input').value = existingMap.creator_name || localName;
        document.getElementById('editor-creator-input').disabled = true;
        document.getElementById('editor-mode-label').textContent = 'EDIT MAP';
        document.getElementById('editor-save-btn').textContent = 'UPDATE MAP';
    } else {
        applyEditorSegments([{ time: 0.0, dir: 0 }], { rebuild: false });
        setEditorPlaybackRateUI(1.0);
        document.getElementById('editor-title-input').value = '';
        document.getElementById('editor-creator-input').value = getLocalPlayerName() || 'Creator';
        document.getElementById('editor-creator-input').disabled = false;
        document.getElementById('editor-mode-label').textContent = 'EDITOR MODE';
        document.getElementById('editor-save-btn').textContent = 'SAVE MAP';
    }

    editorTracks = precalculatePathPoints(editorSegments, 0);
    editorPath2D = new Path2D();
    editorCurrentTime = 0.0;
    editorIsPlaying = false;
    editorZoomScale = 1.0;
    draggedTurnIndex = null;
    lastCheckedEditorTime = 0.0;

    document.getElementById('editor-controls').style.display = 'flex';
    songSelection.style.display = 'none';
    resultsOverlay.style.display = 'none';

    const editorTimeline = document.getElementById('editor-timeline');
    if (loadedAudioBuffer) {
        editorTimeline.max = loadedAudioBuffer.duration;
        document.getElementById('editor-time-total').textContent = formatTime(loadedAudioBuffer.duration);
    } else {
        editorTimeline.max = 100;
        document.getElementById('editor-time-total').textContent = '0:00';
    }
    editorTimeline.value = 0;
    document.getElementById('editor-time-current').textContent = '0:00';
    document.getElementById('editor-play-btn').textContent = '▶️';

    await populateEditorImportOptions(songId, editorMapId);
    sortAndRebuildDirections();

    gameState = 'playing';
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = requestAnimationFrame(gameLoop);
}

function editorExit() {
    editorPause();
    isEditorMode = false;
    editorMapId = null;
    editorBaseSegments = null;
    document.getElementById('editor-controls').style.display = 'none';
    document.getElementById('editor-creator-input').disabled = false;
    document.getElementById('editor-mode-label').textContent = 'EDITOR MODE';
    document.getElementById('editor-save-btn').textContent = 'SAVE MAP';
    
    gameState = 'idle';
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = null;
    
    songSelection.style.display = 'flex';
    renderSongsList();
}

function editorPlay() {
    if (editorIsPlaying || !loadedAudioBuffer || !audioContext) return;
    if (editorCurrentTime >= loadedAudioBuffer.duration) {
        editorCurrentTime = 0;
    }
    
    editorAudioSource = audioContext.createBufferSource();
    editorAudioSource.buffer = loadedAudioBuffer;
    editorAudioSource.playbackRate.value = editorPlaybackRate;
    
    musicGainNode = audioContext.createGain();
    musicGainNode.gain.setValueAtTime(musicVolumeBoost || 1.0, audioContext.currentTime);
    editorAudioSource.connect(musicGainNode);
    musicGainNode.connect(audioContext.destination);
    
    editorAudioSource.start(0, editorCurrentTime);
    editorSongAtPlayStart = editorCurrentTime;
    editorPlayWallTime = audioContext.currentTime;
    editorIsPlaying = true;
    
    document.getElementById('editor-play-btn').textContent = "⏸️";
}

function editorPause() {
    if (!editorIsPlaying) return;
    editorCurrentTime = getEditorSongTime();
    try {
        if (editorAudioSource) editorAudioSource.stop();
    } catch(e) {}
    editorIsPlaying = false;
    
    document.getElementById('editor-play-btn').textContent = "▶️";
}

function editorSeek(targetTime) {
    const maxDur = loadedAudioBuffer ? loadedAudioBuffer.duration : 100;
    editorCurrentTime = Math.max(0, Math.min(maxDur, targetTime));
    lastCheckedEditorTime = editorCurrentTime;
    
    const editorTimeline = document.getElementById('editor-timeline');
    if (editorTimeline) editorTimeline.value = editorCurrentTime;
    const timeCurrent = document.getElementById('editor-time-current');
    if (timeCurrent) timeCurrent.textContent = formatTime(editorCurrentTime);
    
    if (editorIsPlaying && loadedAudioBuffer && audioContext) {
        try {
            if (editorAudioSource) editorAudioSource.stop();
        } catch(e) {}
        editorAudioSource = audioContext.createBufferSource();
        editorAudioSource.buffer = loadedAudioBuffer;
        editorAudioSource.playbackRate.value = editorPlaybackRate;
        
        musicGainNode = audioContext.createGain();
        musicGainNode.gain.setValueAtTime(musicVolumeBoost || 1.0, audioContext.currentTime);
        editorAudioSource.connect(musicGainNode);
        musicGainNode.connect(audioContext.destination);
        
        editorAudioSource.start(0, editorCurrentTime);
        editorSongAtPlayStart = editorCurrentTime;
        editorPlayWallTime = audioContext.currentTime;
    }
}

function formatTime(sec) {
    if (isNaN(sec) || sec === Infinity) return "0:00";
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

function sortAndRebuildDirections() {
    editorSegments.sort((a, b) => a.time - b.time);
    
    let currentDir = 0;
    editorSegments[0].dir = 0;
    for (let i = 1; i < editorSegments.length; i++) {
        currentDir = 1 - currentDir;
        editorSegments[i].dir = currentDir;
    }
    
    editorTracks = precalculatePathPoints(editorSegments, 0);
    
    editorPath2D = new Path2D();
    for (let i = 0; i < editorTracks.length; i++) {
        if (i === 0) editorPath2D.moveTo(editorTracks[i].x, editorTracks[i].y);
        else editorPath2D.lineTo(editorTracks[i].x, editorTracks[i].y);
    }
}

function getEditorPositionAtTime(time) {
    if (editorTracks.length === 0) return { x: 0, y: 0, dir: 0 };
    
    let idx = 0;
    for (let i = 0; i < editorTracks.length; i++) {
        if (editorTracks[i].time <= time) {
            idx = i;
        } else {
            break;
        }
    }
    
    const p0 = editorTracks[idx];
    const p1 = editorTracks[idx + 1];
    
    if (!p1) {
        const elapsed = time - p0.time;
        const dist = elapsed * SPEED_PER_SEC;
        const dv = DIR_VECS[p0.dir];
        return {
            x: p0.x + dv.x * dist,
            y: p0.y + dv.y * dist,
            dir: p0.dir
        };
    }
    
    const elapsed = time - p0.time;
    const dist = elapsed * SPEED_PER_SEC;
    const dv = DIR_VECS[p0.dir];
    return {
        x: p0.x + dv.x * dist,
        y: p0.y + dv.y * dist,
        dir: p0.dir
    };
}

function handleEditorCanvasPointerDown(e) {
    if (!isEditorMode) return;
    
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    const editorPos = getEditorPositionAtTime(editorCurrentTime);
    const camX = editorPos.x;
    const camY = editorPos.y;
    
    const worldX = (clickX - canvas.width / 2) / editorZoomScale + camX;
    const worldY = (clickY - canvas.height / 2) / editorZoomScale + camY;
    
    const margin = 20 / editorZoomScale;
    for (let i = 1; i < editorSegments.length; i++) {
        const seg = editorSegments[i];
        const tp = editorTracks[i];
        if (tp) {
            const dist = Math.hypot(worldX - tp.x, worldY - tp.y);
            if (dist < Math.max(15, margin)) {
                if (!editorIsPlaying) {
                    draggedTurnIndex = i;
                    initialTurnTime = seg.time;
                    initialMouseX = e.clientX;
                    initialMouseY = e.clientY;
                    hasDragged = false;
                }
                return;
            }
        }
    }
    
    if (!editorIsPlaying) {
        for (let i = 0; i < editorTracks.length - 1; i++) {
            const p0 = editorTracks[i];
            const p1 = editorTracks[i + 1];
            const dist = pointToSegmentDist(worldX, worldY, p0.x, p0.y, p1.x, p1.y);
            if (dist < WALL_HALF_WIDTH + 5) {
                const dx = p1.x - p0.x;
                const dy = p1.y - p0.y;
                const len2 = dx * dx + dy * dy;
                if (len2 > 0) {
                    let projT = ((worldX - p0.x) * dx + (worldY - p0.y) * dy) / len2;
                    projT = Math.max(0, Math.min(1, projT));
                    const clickTime = p0.time + projT * (p1.time - p0.time);
                    
                    const beatDuration = 60.0 / editorBPM;
                    const stepSize = beatDuration / 4;
                    const firstTime = editorSegments[1] ? editorSegments[1].time : clickTime;
                    const snappedTime = firstTime + Math.round((clickTime - firstTime) / stepSize) * stepSize;
                    
                    if (snappedTime > 0.05 && !editorSegments.some(s => Math.abs(s.time - snappedTime) < 0.02)) {
                        editorSegments.push({ time: snappedTime, dir: 0 });
                        sortAndRebuildDirections();
                    }
                }
                return;
            }
        }
    }
}

function handleEditorCanvasPointerMove(e) {
    if (!isEditorMode || draggedTurnIndex === null) return;
    
    const mouseDeltaX = e.clientX - initialMouseX;
    if (Math.abs(mouseDeltaX) > 3) {
        hasDragged = true;
    }
    
    const newTime = Math.max(0.05, initialTurnTime + mouseDeltaX * 0.01);
    
    const prevTime = editorSegments[draggedTurnIndex - 1] ? editorSegments[draggedTurnIndex - 1].time : 0;
    const nextTime = editorSegments[draggedTurnIndex + 1] ? editorSegments[draggedTurnIndex + 1].time : Infinity;
    
    editorSegments[draggedTurnIndex].time = Math.max(prevTime + 0.05, Math.min(nextTime - 0.05, newTime));
    sortAndRebuildDirections();
}

function handleEditorCanvasPointerUp(e) {
    if (!isEditorMode) return;
    
    if (draggedTurnIndex !== null) {
        if (!hasDragged) {
            editorSegments.splice(draggedTurnIndex, 1);
            sortAndRebuildDirections();
        }
        draggedTurnIndex = null;
    }
}

// Canvas scroll wheel zoom
canvas.addEventListener('wheel', (e) => {
    if (isEditorMode) {
        e.preventDefault();
        const zoomSpeed = 0.05;
        editorZoomScale = Math.max(0.2, Math.min(3.0, editorZoomScale - Math.sign(e.deltaY) * zoomSpeed));
    }
}, { passive: false });

// Touch pinch to zoom gesture controls
let touchStartDist = 0;
let initialZoomScale = 1.0;

canvas.addEventListener('touchstart', (e) => {
    if (isEditorMode && e.touches.length === 2) {
        touchStartDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        initialZoomScale = editorZoomScale;
    }
});

canvas.addEventListener('touchmove', (e) => {
    if (isEditorMode && e.touches.length === 2 && touchStartDist > 0) {
        e.preventDefault();
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const ratio = dist / touchStartDist;
        editorZoomScale = Math.max(0.2, Math.min(3.0, initialZoomScale * ratio));
    }
});

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        touchStartDist = 0;
    }
});

// Canvas pointer down/move/up for clicks/dragging diamonds
canvas.addEventListener('pointerdown', handleEditorCanvasPointerDown);
canvas.addEventListener('pointermove', handleEditorCanvasPointerMove);
canvas.addEventListener('pointerup', handleEditorCanvasPointerUp);

// Bottom panel button bindings
document.getElementById('editor-play-btn').addEventListener('click', () => {
    if (editorIsPlaying) {
        editorPause();
    } else {
        editorPlay();
    }
});

document.getElementById('editor-prev-btn').addEventListener('click', () => {
    editorSeek(editorCurrentTime - 5.0);
});

document.getElementById('editor-next-btn').addEventListener('click', () => {
    editorSeek(editorCurrentTime + 5.0);
});

document.getElementById('editor-timeline').addEventListener('input', (e) => {
    editorSeek(parseFloat(e.target.value));
});

document.getElementById('editor-save-btn').addEventListener('click', () => {
    const title = document.getElementById('editor-title-input').value.trim();
    const creator = document.getElementById('editor-creator-input').value.trim();
    if (!title || !creator) {
        alert("Please enter both Map Title and Creator Name!");
        return;
    }
    if (editorSegments.length <= 1) {
        alert("Please place at least one turn note to save!");
        return;
    }

    const payload = {
        song_id: editorSongId,
        creator_name: creator,
        title: title,
        segments: editorSegments,
        playback_rate: editorPlaybackRate
    };

    const isUpdate = editorMapId != null;
    const url = isUpdate ? `./api/custom-maps/${editorMapId}` : './api/custom-maps';
    const method = isUpdate ? 'PUT' : 'POST';
    
    fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(result => {
        if (result.success) {
            alert(isUpdate ? "Custom map updated successfully!" : "Custom map saved successfully!");
            editorExit();
        } else {
            alert("Failed to save map: " + (result.error || "unknown error"));
        }
    })
    .catch(err => {
        alert("Failed to save map: " + err.message);
    });
});

document.getElementById('editor-exit-btn').addEventListener('click', () => {
    if (confirm("Are you sure you want to exit without saving?")) {
        editorExit();
    }
});

document.getElementById('editor-import-select').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (!value) return;
    if (!confirm('Importing will replace the current chart notes. Continue?')) {
        e.target.value = '';
        return;
    }
    try {
        await importEditorChart(value);
    } catch (err) {
        console.error(err);
        alert('Failed to import chart: ' + err.message);
    }
    e.target.value = '';
});

document.getElementById('editor-rate-slider').addEventListener('input', (e) => {
    setEditorPlaybackRateUI(e.target.value);
    if (editorIsPlaying) {
        // Restart audio at new rate without moving the playhead
        editorSeek(editorCurrentTime);
    }
});
