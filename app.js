// ========================================================================
//  beat_maze — Dancing Line Style Rhythm Game Engine
//  Core mechanic: Line auto-advances. Tap to turn 90°. Walls kill you.
// ========================================================================

// --- DOM ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const joinOverlay = document.getElementById('join-overlay');
const startBtn = document.getElementById('start-game-btn');
const retryBtn = document.getElementById('retry-btn');
const gameoverOverlay = document.getElementById('gameover-overlay');
const scoreDisplay = document.getElementById('score-display');
const comboDisplay = document.getElementById('combo-display');
const progressDisplay = document.getElementById('progress-display');
const finalScoreEl = document.getElementById('final-score');
const playersList = document.getElementById('players-list');

// --- Canvas sizing ---
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ========================================================================
//  TRACK DEFINITION
//  Each segment: { beats: duration_in_beats, dir: 0|1 }
//  dir 0 = "primary direction" (right), dir 1 = "secondary direction" (up)
//  The line always moves; a tap toggles between dir 0 and dir 1.
//  Walls are auto-generated along the correct path.
// ========================================================================

// Direction vectors: dir0 = right (+x), dir1 = up (-y)
const DIR_VECS = [
    { x: 1, y: 0 },   // dir 0: right
    { x: 0, y: -1 },  // dir 1: up
];

// BPM changes over the track for variety
const BPM_SCHEDULE = [
    { beat: 0,  bpm: 100 },
    { beat: 16, bpm: 120 },
    { beat: 32, bpm: 140 },
    { beat: 48, bpm: 160 },
    { beat: 56, bpm: 120 },
    { beat: 64, bpm: 140 },
    { beat: 80, bpm: 100 },
];

// Track segments: the correct path the line should follow.
// Each segment says "go in direction X for N beats".
// A turn point is where direction changes.
const TRACK_SEGMENTS = [
    // === Intro: steady, slow (BPM 100) ===
    { beats: 4, dir: 0 },   // right 4
    { beats: 4, dir: 1 },   // up 4
    { beats: 4, dir: 0 },   // right 4
    { beats: 4, dir: 1 },   // up 4

    // === Section 2: speed up (BPM 120) ===
    { beats: 2, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 2, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 2, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 2, dir: 0 },
    { beats: 2, dir: 1 },

    // === Section 3: rapid fire (BPM 140) ===
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 3, dir: 1 },   // surprise long
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 2, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },

    // === Section 4: intense (BPM 160) ===
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },

    // === Section 5: cool-down (BPM 120) ===
    { beats: 4, dir: 0 },
    { beats: 4, dir: 1 },

    // === Section 6: mixed (BPM 140) ===
    { beats: 2, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 2, dir: 0 },
    { beats: 1, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 2, dir: 1 },
    { beats: 1, dir: 0 },
    { beats: 1, dir: 1 },

    // === Outro: slow down (BPM 100) ===
    { beats: 4, dir: 0 },
    { beats: 4, dir: 1 },
    { beats: 4, dir: 0 },
    { beats: 4, dir: 1 },
];

// ========================================================================
//  PRE-COMPUTE TRACK GEOMETRY
//  turnPoints[i] = { beat, x, y, newDir }
//  Each turn point is where the direction changes.
// ========================================================================
const PIXELS_PER_BEAT = 60; // How many pixels the line moves per beat
const WALL_HALF_WIDTH = 25; // Half-width of the corridor

let turnPoints = [];     // { beat, x, y, newDir }
let totalBeats = 0;
let wallSegments = [];   // { x1,y1, x2,y2 } for collision detection

function buildTrackGeometry(offsetX, offsetY) {
    const points = [];
    let x = offsetX, y = offsetY, beat = 0;

    // First turn point is the start
    points.push({ beat: 0, x, y, newDir: TRACK_SEGMENTS[0].dir });

    for (let i = 0; i < TRACK_SEGMENTS.length; i++) {
        const seg = TRACK_SEGMENTS[i];
        const dist = seg.beats * PIXELS_PER_BEAT;
        const dv = DIR_VECS[seg.dir];
        x += dv.x * dist;
        y += dv.y * dist;
        beat += seg.beats;

        const nextDir = (i + 1 < TRACK_SEGMENTS.length) ? TRACK_SEGMENTS[i + 1].dir : seg.dir;
        points.push({ beat, x, y, newDir: nextDir });
    }

    return { points, totalBeats: beat };
}

function buildWalls(points) {
    const walls = [];
    const W = WALL_HALF_WIDTH;

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;

        // Normal perpendicular to segment
        const nx = -dy / len;
        const ny = dx / len;

        // Two wall lines on each side of the corridor
        walls.push({
            x1: p0.x + nx * W, y1: p0.y + ny * W,
            x2: p1.x + nx * W, y2: p1.y + ny * W,
        });
        walls.push({
            x1: p0.x - nx * W, y1: p0.y - ny * W,
            x2: p1.x - nx * W, y2: p1.y - ny * W,
        });
    }
    return walls;
}

// ========================================================================
//  BPM → time mapping
//  Since BPM changes mid-track, we need beat → audioTime conversion.
// ========================================================================
function beatToTime(beat, gameStartTime) {
    let time = gameStartTime;
    let prevBeat = 0;
    for (let i = 0; i < BPM_SCHEDULE.length; i++) {
        const curr = BPM_SCHEDULE[i];
        const nextBeat = (i + 1 < BPM_SCHEDULE.length) ? BPM_SCHEDULE[i + 1].beat : Infinity;
        const segEnd = Math.min(beat, nextBeat);
        if (segEnd > prevBeat) {
            const dur = (segEnd - Math.max(prevBeat, curr.beat)) * (60.0 / curr.bpm);
            time += dur;
        }
        prevBeat = nextBeat;
        if (beat <= nextBeat) break;
    }
    return time;
}

function timeToBeat(audioTime, gameStartTime) {
    let elapsed = audioTime - gameStartTime;
    if (elapsed <= 0) return 0;
    let beat = 0;
    for (let i = 0; i < BPM_SCHEDULE.length; i++) {
        const curr = BPM_SCHEDULE[i];
        const nextBeat = (i + 1 < BPM_SCHEDULE.length) ? BPM_SCHEDULE[i + 1].beat : Infinity;
        const segBeats = nextBeat - curr.beat;
        const secPerBeat = 60.0 / curr.bpm;
        const segDuration = segBeats * secPerBeat;

        if (elapsed <= segDuration || nextBeat === Infinity) {
            beat = curr.beat + elapsed / secPerBeat;
            break;
        }
        elapsed -= segDuration;
    }
    return beat;
}

function getBPMAtBeat(beat) {
    let bpm = BPM_SCHEDULE[0].bpm;
    for (const s of BPM_SCHEDULE) {
        if (beat >= s.beat) bpm = s.bpm;
    }
    return bpm;
}

// ========================================================================
//  AUDIO
// ========================================================================
let audioContext;
let audioUnlocked = false;

function unlockAudio() {
    if (audioUnlocked) return;
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    // Silent buffer to force unlock on iOS
    const b = audioContext.createBuffer(1, 1, 22050);
    const s = audioContext.createBufferSource();
    s.buffer = b; s.connect(audioContext.destination); s.start(0);
    audioUnlocked = true;
}

// ========================================================================
//  DYNAMIC MUSIC SYSTEM - Web Audio API based
// ========================================================================
let musicGainNode = null;
let bassGainNode = null;
let drumGainNode = null;
let musicScheduler = null;
let lastMusicBeat = -1;

function initializeMusic() {
    if (!audioContext) return;
    
    // Create gain nodes for volume control
    if (!musicGainNode) {
        musicGainNode = audioContext.createGain();
        musicGainNode.connect(audioContext.destination);
        musicGainNode.gain.value = 0.15;
    }
    if (!bassGainNode) {
        bassGainNode = audioContext.createGain();
        bassGainNode.connect(audioContext.destination);
        bassGainNode.gain.value = 0.12;
    }
    if (!drumGainNode) {
        drumGainNode = audioContext.createGain();
        drumGainNode.connect(audioContext.destination);
        drumGainNode.gain.value = 0.1;
    }
}

function playMelodyNote(freq, duration, startTime) {
    if (!audioContext) return;
    
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    
    osc.connect(env);
    env.connect(musicGainNode);
    
    env.setValueAtTime(0, startTime);
    env.linearRampToValueAtTime(0.3, startTime + 0.01);
    env.exponentialRampToValueAtTime(0.01, startTime + duration * 0.8);
    env.linearRampToValueAtTime(0, startTime + duration);
    
    osc.start(startTime);
    osc.stop(startTime + duration);
}

function playBassNote(freq, duration, startTime) {
    if (!audioContext) return;
    
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    
    osc.connect(env);
    env.connect(bassGainNode);
    
    env.setValueAtTime(0, startTime);
    env.linearRampToValueAtTime(0.3, startTime + 0.02);
    env.exponentialRampToValueAtTime(0.05, startTime + duration);
    
    osc.start(startTime);
    osc.stop(startTime + duration);
}

function playKickDrum(startTime) {
    if (!audioContext) return;
    
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.type = 'sine';
    
    osc.connect(env);
    env.connect(drumGainNode);
    
    const kickDuration = 0.3;
    osc.frequency.setValueAtTime(150, startTime);
    osc.frequency.exponentialRampToValueAtTime(0.01, startTime + kickDuration);
    
    env.setValueAtTime(0.5, startTime);
    env.exponentialRampToValueAtTime(0.01, startTime + kickDuration);
    
    osc.start(startTime);
    osc.stop(startTime + kickDuration);
}

function playHiHat(startTime) {
    if (!audioContext) return;
    
    const bufSize = audioContext.sampleRate * 0.1;
    const buf = audioContext.createBuffer(1, bufSize, audioContext.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    
    const src = audioContext.createBufferSource();
    const env = audioContext.createGain();
    src.buffer = buf;
    src.connect(env);
    env.connect(drumGainNode);
    
    env.setValueAtTime(0.4, startTime);
    env.exponentialRampToValueAtTime(0.01, startTime + 0.1);
    
    src.start(startTime);
}

// Frequency mappings for melody
const NOTE_FREQS = {
    'E3': 164.81, 'G3': 196.00, 'B3': 246.94,
    'E4': 329.63, 'G4': 392.00, 'B4': 493.88,
    'D5': 587.33, 'E5': 659.25, 'G5': 783.99, 'B5': 987.77,
    'B1': 61.74, 'D2': 73.42, 'A1': 55.00, 'A2': 110.00,
    'E2': 82.41, 'G2': 98.00, 'B2': 123.47,
    'C4': 261.63, 'C5': 523.25
};

let nextScheduledMusicBeat = 0;
let musicSchedulerTimer = null;

function scheduleBackgroundMusic() {
    if (!isPlaying || !audioContext) return;
    
    const now = audioContext.currentTime;
    
    while (true) {
        const beatTime = beatToTime(nextScheduledMusicBeat, gameStartTime);
        if (beatTime > now + 0.15) break; // lookahead 150ms
        
        if (beatTime >= now - 0.01) {
            const beatFloor = nextScheduledMusicBeat;
            const bpm = getBPMAtBeat(beatFloor);
            const noteDuration = (60.0 / bpm) * 0.8;
            
            // Get pattern based on current BPM
            const sectionBeat = Math.floor(beatFloor) % 4;
            
            // Melody patterns
            const melodyNotes = [
                ['E4', 'G4', 'B4', 'D5'],
                ['B4', 'G4', 'E4', 'D4'],
                ['G4', 'B4', 'E5', 'G5'],
                ['D5', 'E5', 'B4', 'G4']
            ];
            
            // Bass notes
            const bassNotes = ['E2', 'B1', 'D2', 'A1'];
            
            // Play melody
            const melodyNote = melodyNotes[sectionBeat % melodyNotes.length][sectionBeat];
            if (melodyNote && NOTE_FREQS[melodyNote]) {
                playMelodyNote(NOTE_FREQS[melodyNote], noteDuration, beatTime);
            }
            
            // Play bass
            const bassNote = bassNotes[Math.floor(beatFloor) % bassNotes.length];
            if (bassNote && NOTE_FREQS[bassNote]) {
                playBassNote(NOTE_FREQS[bassNote], noteDuration * 2, beatTime);
            }
            
            // Drums: Kick on full beats, hihat on half beats
            if (beatFloor % 1 === 0) {
                playKickDrum(beatTime);
            } else if (bpm > 120) {
                playHiHat(beatTime);
            }
        }
        
        nextScheduledMusicBeat += 0.5;
    }
    
    musicSchedulerTimer = setTimeout(scheduleBackgroundMusic, 25);
}

function stopMusicPlayback() {
    nextScheduledMusicBeat = 0;
    if (musicSchedulerTimer) clearTimeout(musicSchedulerTimer);
}

// Schedule metronome clicks. We schedule ahead in real time.
let nextScheduledBeat = 0;
let schedulerTimer = null;
const SCHEDULE_AHEAD_SEC = 0.15;
const SCHEDULER_INTERVAL_MS = 25;

function scheduleAudio() {
    if (!audioContext || !isPlaying) return;
    const now = audioContext.currentTime;

    while (true) {
        const noteTime = beatToTime(nextScheduledBeat, gameStartTime);
        if (noteTime > now + SCHEDULE_AHEAD_SEC) break;
        if (noteTime >= now - 0.01) { // don't play notes far in the past
            playMetronomeClick(noteTime, nextScheduledBeat);
        }
        // Advance by the smallest rhythmic unit
        const bpm = getBPMAtBeat(nextScheduledBeat);
        nextScheduledBeat += 1; // one beat
    }
    schedulerTimer = setTimeout(scheduleAudio, SCHEDULER_INTERVAL_MS);
}

function playMetronomeClick(time, beat) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);

    // Check if this beat is a turn point
    const isTurnBeat = turnPoints.some(tp => Math.abs(tp.beat - beat) < 0.01 && tp.beat > 0);

    if (beat % 4 === 0) {
        osc.frequency.value = 880; env.gain.value = 0.6;
    } else if (isTurnBeat) {
        osc.frequency.value = 660; env.gain.value = 0.5;
        osc.type = 'triangle';
    } else {
        osc.frequency.value = 440; env.gain.value = 0.15;
    }
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.start(time); osc.stop(time + 0.05);
}

function playCrashSound() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    // Noise burst for crash
    const bufSize = audioContext.sampleRate * 0.15;
    const buf = audioContext.createBuffer(1, bufSize, audioContext.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const src = audioContext.createBufferSource();
    const env = audioContext.createGain();
    src.buffer = buf; src.connect(env); env.connect(audioContext.destination);
    env.gain.value = 0.7;
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    src.start(now);
}

function playTurnSound() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);
    osc.type = 'sine'; osc.frequency.value = 1200;
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.06);
    env.gain.value = 0.3;
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.start(now); osc.stop(now + 0.1);
}

// --- Melody Data (8th note steps matching level beats) ---
const MELODY = [
    // Intro: Beats 0 - 4
    57, 0, 60, 62, 64, 0, 62, 60,
    // Shared Path starts at Beat 4
    // Beat 4: Turn Right
    69, 0, 72, 74,
    // Beat 6: Turn Up
    76, 0, 74, 72,
    // Beat 8: Turn Left
    69, 0,
    // Beat 9: Turn Up
    65, 0,
    // Beat 10: Turn Right
    62, 
    // Beat 10.5: Turn Up
    64,
    // Beat 11: Turn Left
    65, 0,
    // Beat 12: Turn Up
    69, 0, 72, 74,
    // Beat 14: Turn Right
    76,
    // Beat 14.5: Turn Up
    77,
    // Beat 15: Turn Left
    76,
    // Beat 15.5: Turn Up
    74,
    // Beat 16: Turn Right (Long Segment)
    72, 0, 69, 0, 72, 0, 76, 0,
    // Beat 20: Turn Up (Long Segment)
    81, 0, 76, 0, 81, 0, 79, 0,
    // Beat 24: Turn Left
    77, 0,
    // Beat 25: Turn Down
    76, 0,
    // Beat 26: Turn Right
    74, 0,
    // Beat 27: Turn Up
    76, 0,
    // Beat 28: End
    81, 0, 0, 0
];

function playClick(time, noteIndex) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);
    
    // Quarter note strong click, eighth note weak tick
    if (noteIndex % 2 === 0) {
        osc.frequency.value = (noteIndex === 0) ? 880.0 : 440.0;
        env.gain.value = 0.5; // Slightly lower metronome volume so melody stands out
    } else {
        osc.frequency.value = 220.0;
        env.gain.value = 0.1;
    }
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    osc.start(time); osc.stop(time + 0.03);
}

function playClickSound(time, beat) {
    if (activeMode === 'calib') return;
    
    const step = Math.round(beat * 2);
    if (step < 0 || step >= MELODY.length) return;
    
    const midi = MELODY[step];
    if (!midi || midi === 0) return;
    
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    
    // Use warm triangle wave for the synth pluck melody
    osc.type = 'triangle';
    osc.frequency.value = freq;
    
    osc.connect(env);
    env.connect(audioContext.destination);
    
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.2, time + 0.005); // Rapid pluck attack
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.25); // Pluck decay
    
    osc.start(time);
    osc.stop(time + 0.3);
}

function playEcho() {
    if (activeMode === 'calib') {
        const ring = document.createElement('div');
        ring.className = 'echo-ring';
        beatCircle.appendChild(ring);
        setTimeout(() => ring.remove(), 600);
    }
    if (audioContext && isPlaying) {
        const osc = audioContext.createOscillator();
        const env = audioContext.createGain();
        osc.connect(env); env.connect(audioContext.destination);
        osc.type = 'square'; osc.frequency.value = 600.0;
        env.gain.value = 0.2;
        env.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
        osc.start(audioContext.currentTime); osc.stop(audioContext.currentTime + 0.1);
    }
}

function nextNote() {
    nextNoteTime += TICK_SEC;
    currentNote = (currentNote + 1) % 8;
}

function scheduler() {
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        const globalBeat = Math.round((nextNoteTime - startTime) / TICK_SEC) * 0.5;
        notesInQueue.push({ note: currentNote, time: nextNoteTime });
        scheduledBeats.push({ time: nextNoteTime, beat: globalBeat });
        
        playClick(nextNoteTime, currentNote);
        playMelodyNote(nextNoteTime, globalBeat);
        nextNote();
    }
    while (scheduledBeats.length && scheduledBeats[0].time < audioContext.currentTime - 2.0) {
        scheduledBeats.shift();
    }
    if (isPlaying) timerID = setTimeout(scheduler, lookahead);
}

// ========================================================================
//  MULTIPLAYER (WebSocket)
let ws;
let localId = null;
let localColor = '#00e676';
let localSpawnIndex = 0;
let remotePlayers = {}; // id -> { color, spawnIndex, alive, currentBeat, trail }

function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/beat-maze/`);

    ws.onmessage = (ev) => {
        try {
            const data = JSON.parse(ev.data);
            switch (data.type) {
                case 'init':
                    localId = data.id;
                    localColor = data.color;
                    localSpawnIndex = data.spawnIndex;
                    // Populate remote players
                    for (const pid in data.players) {
                        if (pid !== localId) {
                            remotePlayers[pid] = {
                                ...data.players[pid],
                                alive: true, currentBeat: 0, trail: [],
                                turnIndex: 0, currentDir: 0,
                            };
                        }
                    }
                    updatePlayersList();
                    break;
                case 'playerJoined':
                    if (data.player.id !== localId) {
                        remotePlayers[data.player.id] = {
                            ...data.player,
                            alive: true, currentBeat: 0, trail: [],
                            turnIndex: 0, currentDir: 0,
                        };
                        updatePlayersList();
                    }
                    break;
                case 'playerLeft':
                    delete remotePlayers[data.id];
                    updatePlayersList();
                    break;
                case 'startGame':
                    handleStartGame(data.startDelay);
                    break;
                case 'playerUpdate':
                    if (data.id !== localId && remotePlayers[data.id]) {
                        const rp = remotePlayers[data.id];
                        rp.currentBeat = data.beat;
                        rp.alive = data.alive;
                        rp.currentDir = data.dir;
                        rp.turnIndex = data.turnIndex;
                        if (data.trail) rp.trail = data.trail;
                    }
                    break;
                case 'playerDead':
                    if (remotePlayers[data.id]) remotePlayers[data.id].alive = false;
                    break;
            }
        } catch (e) { console.error(e); }
    };
}
initWebSocket();

function updatePlayersList() {
    playersList.innerHTML = '';
    // Local
    const local = document.createElement('div');
    local.className = 'player-tag';
    local.innerHTML = `<div class="player-dot" style="background:${localColor}"></div>You`;
    playersList.appendChild(local);
    // Remotes
    for (const id in remotePlayers) {
        const rp = remotePlayers[id];
        const el = document.createElement('div');
        el.className = 'player-tag';
        el.innerHTML = `<div class="player-dot" style="background:${rp.color}"></div>P${rp.spawnIndex + 1}`;
        playersList.appendChild(el);
    }
}

function broadcastState() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
        type: 'playerUpdate',
        beat: currentBeat,
        alive: alive,
        dir: currentDir,
        turnIndex: turnIndex,
        trail: trail.slice(-50), // send recent trail
    }));
}

// ========================================================================
//  GAME STATE
// ========================================================================
let gameState = 'idle'; // idle | starting | playing | dead
let isPlaying = false;
let gameStartTime = 0; // audioContext.currentTime when beat 0 starts
let zoomStartTime = 0;

// Player state
let currentDir = 0;  // 0 or 1 (the two directions)
let turnIndex = 0;   // how many correct turns the player has made
let currentBeat = 0;
let playerX = 0, playerY = 0;
let alive = true;
let score = 0;
let combo = 0;
let trail = []; // [{x,y}] for the line the player draws
let drawReqId;
let lastBroadcastTime = 0;

// Spawn offsets for multiplayer (each player starts slightly offset)
const SPAWN_OFFSETS = [
    { x: 0, y: 0 },
    { x: -200, y: 100 },
    { x: 200, y: 100 },
    { x: -100, y: 200 },
    { x: 100, y: -200 },
    { x: 0, y: 200 },
];

function getSpawnOffset(spawnIndex) {
    return SPAWN_OFFSETS[spawnIndex % SPAWN_OFFSETS.length];
}

// ========================================================================
//  GAME LIFECYCLE
// ========================================================================

joinOverlay.addEventListener('pointerdown', () => {
    unlockAudio();
    joinOverlay.style.display = 'none';
});

startBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'startRequest' }));
    }
});

retryBtn.addEventListener('click', () => {
    gameoverOverlay.style.display = 'none';
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'startRequest' }));
    }
});

function handleStartGame(startDelayMs) {
    unlockAudio();
    initializeMusic(); // Initialize music system
    gameoverOverlay.style.display = 'none';
    startBtn.style.display = 'none';

    // Build track
    const spawn = getSpawnOffset(localSpawnIndex);
    const built = buildTrackGeometry(spawn.x, spawn.y);
    turnPoints = built.points;
    totalBeats = built.totalBeats;
    wallSegments = buildWalls(turnPoints);

    // Reset player
    currentDir = TRACK_SEGMENTS[0].dir;
    turnIndex = 0;
    currentBeat = 0;
    playerX = turnPoints[0].x;
    playerY = turnPoints[0].y;
    alive = true;
    score = 0;
    combo = 0;
    trail = [{ x: playerX, y: playerY }];
    updateHUD();

    // Timing
    zoomStartTime = audioContext.currentTime;
    gameStartTime = zoomStartTime + (startDelayMs / 1000);
    nextScheduledBeat = 0;

    gameState = 'starting';
    isPlaying = true;

    // Start music and scheduler
    scheduleBackgroundMusic();
    scheduleAudio();
    if (drawReqId) cancelAnimationFrame(drawReqId);
    drawReqId = requestAnimationFrame(gameLoop);
}

function stopGame() {
    isPlaying = false;
    stopMusicPlayback(); // Stop music when game ends
    clearTimeout(schedulerTimer);
    cancelAnimationFrame(drawReqId);
    drawReqId = null;
}

function die() {
    if (!alive) return;
    alive = false;
    gameState = 'dead';
    playCrashSound();

    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'dead' }));

    finalScoreEl.textContent = `Score: ${score}`;
    setTimeout(() => {
        gameoverOverlay.style.display = 'flex';
        startBtn.style.display = 'block';
        stopGame();
    }, 800);
}

function updateHUD() {
    scoreDisplay.textContent = `Score: ${score}`;
    comboDisplay.textContent = `Combo: ${combo}`;
    const pct = totalBeats > 0 ? Math.min(100, Math.floor((currentBeat / totalBeats) * 100)) : 0;
    progressDisplay.textContent = `${pct}%`;
}

// ========================================================================
//  INPUT: TAP TO TURN
// ========================================================================
function handleTap() {
    if (gameState !== 'playing' || !alive) return;

    // Toggle direction
    const newDir = 1 - currentDir;

    // Check if this is the correct turn
    // Find the next expected turn point
    const nextTP = turnPoints[turnIndex + 1];
    if (!nextTP) return;

    // How close are we to the turn point (in beats)?
    const diffBeats = Math.abs(currentBeat - nextTP.beat);
    const bpm = getBPMAtBeat(currentBeat);
    const diffMs = diffBeats * (60000 / bpm);

    if (diffMs < 200 && newDir === nextTP.newDir) {
        // Correct turn!
        currentDir = newDir;
        turnIndex++;
        playTurnSound();

        // Score based on precision
        if (diffMs < 40) {
            score += 300; combo++;
        } else if (diffMs < 100) {
            score += 200; combo++;
        } else {
            score += 100; combo++;
        }
        updateHUD();
    } else {
        // Wrong turn or wrong timing → just toggle, will hit wall soon
        currentDir = newDir;
        combo = 0;
        updateHUD();
    }

    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'playerUpdate', beat: currentBeat, alive, dir: currentDir, turnIndex }));
    }
}

// Tap anywhere = turn
window.addEventListener('pointerdown', (e) => {
    if (joinOverlay.style.display !== 'none' && joinOverlay.style.display !== '') return;
    if (e.target.tagName === 'BUTTON') return;
    handleTap();
});
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        handleTap();
    }
});

// ========================================================================
//  COLLISION DETECTION
// ========================================================================
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isInsideCorridor(px, py) {
    // Check if point is within WALL_HALF_WIDTH of any track segment centerline
    for (let i = 0; i < turnPoints.length - 1; i++) {
        const p0 = turnPoints[i], p1 = turnPoints[i + 1];
        const dist = pointToSegmentDist(px, py, p0.x, p0.y, p1.x, p1.y);
        if (dist < WALL_HALF_WIDTH - 2) return true;
    }
    return false;
}

// ========================================================================
//  GAME LOOP
// ========================================================================
function gameLoop(timestamp) {
    if (!isPlaying) return;
    drawReqId = requestAnimationFrame(gameLoop);

    const now = audioContext.currentTime;

    if (gameState === 'starting') {
        // During zoom-in, don't advance the player
        if (now >= gameStartTime) {
            gameState = 'playing';
        }
        render(now);
        return;
    }

    if (gameState === 'playing' && alive) {
        // Update beat position
        currentBeat = timeToBeat(now, gameStartTime);

        // Update player position based on current direction
        const bpm = getBPMAtBeat(currentBeat);
        const secPerBeat = 60.0 / bpm;
        const pixelsPerSec = PIXELS_PER_BEAT / secPerBeat;

        // Position from turnIndex's point + movement in currentDir
        const basePt = turnPoints[turnIndex];
        if (basePt) {
            const beatsFromTurn = currentBeat - basePt.beat;
            const dist = beatsFromTurn * PIXELS_PER_BEAT;
            const dv = DIR_VECS[currentDir];
            playerX = basePt.x + dv.x * dist;
            playerY = basePt.y + dv.y * dist;
        }

        // Record trail
        const lastTrail = trail[trail.length - 1];
        if (!lastTrail || Math.hypot(playerX - lastTrail.x, playerY - lastTrail.y) > 3) {
            trail.push({ x: playerX, y: playerY });
            if (trail.length > 2000) trail.shift();
        }

        // Collision: check if player is outside corridor
        if (currentBeat > 0.5 && !isInsideCorridor(playerX, playerY)) {
            die();
        }

        // Auto-miss: if we're past a turn point without turning
        const nextTP = turnPoints[turnIndex + 1];
        if (nextTP && currentBeat > nextTP.beat + 0.5) {
            // Missed the turn completely
            combo = 0;
            updateHUD();
        }

        // Check if level complete
        if (currentBeat >= totalBeats) {
            gameState = 'dead'; // reuse for "complete"
            alive = false;
            finalScoreEl.textContent = `CLEAR! Score: ${score}`;
            setTimeout(() => {
                gameoverOverlay.querySelector('h2').textContent = 'STAGE CLEAR!';
                gameoverOverlay.querySelector('h2').style.color = '#00e676';
                gameoverOverlay.style.display = 'flex';
                startBtn.style.display = 'block';
                stopGame();
            }, 500);
        }

        updateHUD();

        // Broadcast state periodically
        if (now - lastBroadcastTime > 0.1) {
            broadcastState();
            lastBroadcastTime = now;
        }
    }

    render(now);
}

// ========================================================================
//  RENDERING
// ========================================================================
function render(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Camera
    let camX = playerX, camY = playerY;
    let camScale = 1.0;

    if (gameState === 'idle') {
        // Draw title screen
        ctx.fillStyle = '#fff';
        ctx.font = '700 28px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for players...', canvas.width / 2, canvas.height / 2);
        return;
    }

    if (gameState === 'starting') {
        const elapsed = now - zoomStartTime;
        const zoomDuration = (gameStartTime - zoomStartTime);
        const t = Math.min(1, elapsed / zoomDuration);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

        // Start zoomed out showing all paths, then zoom in to player
        camScale = 0.3 + 0.7 * ease;
        const overviewX = turnPoints[Math.floor(turnPoints.length / 4)].x;
        const overviewY = turnPoints[Math.floor(turnPoints.length / 4)].y;
        camX = overviewX + (turnPoints[0].x - overviewX) * ease;
        camY = overviewY + (turnPoints[0].y - overviewY) * ease;

        // Countdown text
        const remaining = gameStartTime - now;
        if (remaining > 0) {
            const countNum = Math.ceil(remaining);
            ctx.save();
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = `900 ${120 + (1 - (remaining % 1)) * 30}px Outfit`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countNum, canvas.width / 2, canvas.height / 2);
            ctx.restore();
        }
    }

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camScale, camScale);
    ctx.translate(-camX, -camY);

    // --- Draw corridor (correct path with walls) ---
    // Floor
    ctx.lineWidth = WALL_HALF_WIDTH * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1a1a2e';
    ctx.beginPath();
    for (let i = 0; i < turnPoints.length; i++) {
        if (i === 0) ctx.moveTo(turnPoints[i].x, turnPoints[i].y);
        else ctx.lineTo(turnPoints[i].x, turnPoints[i].y);
    }
    ctx.stroke();

    // Wall edges (glow)
    ctx.lineWidth = WALL_HALF_WIDTH * 2 + 4;
    ctx.strokeStyle = '#2a2a4a';
    ctx.beginPath();
    for (let i = 0; i < turnPoints.length; i++) {
        if (i === 0) ctx.moveTo(turnPoints[i].x, turnPoints[i].y);
        else ctx.lineTo(turnPoints[i].x, turnPoints[i].y);
    }
    ctx.stroke();

    // Redraw floor on top
    ctx.lineWidth = WALL_HALF_WIDTH * 2 - 4;
    ctx.strokeStyle = '#12122a';
    ctx.beginPath();
    for (let i = 0; i < turnPoints.length; i++) {
        if (i === 0) ctx.moveTo(turnPoints[i].x, turnPoints[i].y);
        else ctx.lineTo(turnPoints[i].x, turnPoints[i].y);
    }
    ctx.stroke();

    // Turn point markers (diamonds/gems)
    for (let i = 1; i < turnPoints.length; i++) {
        const tp = turnPoints[i];
        const collected = i <= turnIndex;
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

    // --- Draw remote players' trails ---
    for (const id in remotePlayers) {
        const rp = remotePlayers[id];
        if (!rp.trail || rp.trail.length < 2) continue;
        ctx.strokeStyle = rp.color + '99';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(rp.trail[0].x, rp.trail[0].y);
        for (let i = 1; i < rp.trail.length; i++) {
            ctx.lineTo(rp.trail[i].x, rp.trail[i].y);
        }
        ctx.stroke();

        // Remote player dot
        const lastPt = rp.trail[rp.trail.length - 1];
        ctx.fillStyle = rp.alive ? rp.color : '#555';
        ctx.beginPath();
        ctx.arc(lastPt.x, lastPt.y, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- Draw local player trail ---
    if (trail.length >= 2) {
        // Trail gradient: fade old parts
        ctx.strokeStyle = localColor;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(trail[0].x, trail[0].y);
        for (let i = 1; i < trail.length; i++) {
            ctx.lineTo(trail[i].x, trail[i].y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1.0;
    }

    // --- Draw local player ---
    if (alive) {
        ctx.fillStyle = localColor;
        ctx.shadowColor = localColor;
        ctx.shadowBlur = 25;
        ctx.beginPath();
        ctx.arc(playerX, playerY, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    } else {
        // Explosion effect
        ctx.fillStyle = '#ff5252';
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(playerX, playerY, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    ctx.restore();
}

// Initial idle draw
function drawIdle() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = '700 28px Outfit';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for players...', canvas.width / 2, canvas.height / 2 - 20);
    ctx.fillStyle = '#b0bec5';
    ctx.font = '400 18px Outfit';
    ctx.fillText('Press START to begin', canvas.width / 2, canvas.height / 2 + 20);
}
drawIdle();
