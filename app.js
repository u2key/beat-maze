// --- DOM Elements ---
const viewCalib = document.getElementById('view-calib');
const viewGame = document.getElementById('view-game');
const btnTabCalib = document.getElementById('btn-tab-calib');
const btnTabGame = document.getElementById('btn-tab-game');

const beatCircle = document.getElementById('beat-circle');
const hitResultEl = document.getElementById('hit-result');
const comboCountEl = document.getElementById('combo-count');
const offsetDisplay = document.getElementById('offset-display');
const startBtn = document.getElementById('start-btn');

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const startGameBtn = document.getElementById('start-game-btn');
const livesDisplay = document.getElementById('lives-display');
const scoreDisplay = document.getElementById('score-display');

// --- Global Rhythm Config ---
const BPM = 140;
const QUARTER_NOTE_SEC = 60.0 / BPM;
const TICK_SEC = QUARTER_NOTE_SEC / 2; // 8th note scheduling
const SPEED = 140; // Pixels per beat

// --- Global State ---
let activeMode = 'game'; 
let audioContext;
let isPlaying = false;
let currentNote = 0;
let nextNoteTime = 0.0;
const lookahead = 25.0;
const scheduleAheadTime = 0.1;
let timerID;
let startTime = 0;
let drawReqId;

// WebSocket Sync & Multiplayer
let ws;
let sharedCombo = 0;
let localId = null;
let localPlayer = null;
let players = {};
let otherPlayersPaths = {};

// Synchronization
const scheduledBeats = [];
const notesInQueue = [];
let lastDrawnNote = -1;
let calibrationOffsetMs = 0;
const recentOffsets = [];

// Game State
let gameState = 'idle'; // idle, starting, playing, over
let lives = 3;
let score = 0;
let pathNodes = []; 
let hitEffects = []; 
let zoomAnimStart = 0;

// --- Track Data (Rich variations) ---
const sharedPath = [
    { interval: 2, dirX: 1, dirY: 0 },   // Beat 4->6 (RIGHT)
    { interval: 2, dirX: 0, dirY: -1 },  // Beat 6->8 (UP)
    { interval: 1, dirX: -1, dirY: 0 },  // Beat 8->9 (LEFT, faster)
    { interval: 1, dirX: 0, dirY: -1 },  // Beat 9->10 (UP)
    { interval: 0.5, dirX: 1, dirY: 0 }, // 10->10.5 (RIGHT, rapid 8th)
    { interval: 0.5, dirX: 0, dirY: -1 },// 10.5->11 (UP)
    { interval: 1, dirX: -1, dirY: 0 },  // 11->12 (LEFT)
    { interval: 2, dirX: 0, dirY: -1 },  // 12->14 (UP)
    { interval: 0.5, dirX: 1, dirY: 0 }, // 14->14.5
    { interval: 0.5, dirX: 0, dirY: -1 },// 14.5->15
    { interval: 0.5, dirX: -1, dirY: 0 },// 15->15.5
    { interval: 0.5, dirX: 0, dirY: -1 },// 15.5->16
    { interval: 4, dirX: 1, dirY: 0 },   // 16->20 (Long pause, steady path)
    { interval: 4, dirX: 0, dirY: -1 },  // 20->24
    { interval: 1, dirX: -1, dirY: 0 },  
    { interval: 1, dirX: 0, dirY: 1 },   // DOWN!
    { interval: 1, dirX: 1, dirY: 0 },
    { interval: 1, dirX: 0, dirY: -1 }
];

function generatePlayerPath(spawnIndex) {
    const laneOffsets = [-15, 15, -30, 30, -45, 45];
    const offsetX = laneOffsets[spawnIndex % laneOffsets.length];
    
    // At beat 4, all join the shared progression but retain their offset
    const beat4X = offsetX;
    const beat4Y = -4 * SPEED;
    let path = [];
    
    // Initial approaching segment to converge at beat 4
    if (spawnIndex % 4 === 0) {
        path.push({ beat: 0, x: beat4X - 4*SPEED, y: beat4Y, dirX: 1, dirY: 0, turned: true, missed: false });
    } else if (spawnIndex % 4 === 1) {
        path.push({ beat: 0, x: beat4X + 4*SPEED, y: beat4Y, dirX: -1, dirY: 0, turned: true, missed: false });
    } else if (spawnIndex % 4 === 2) {
        path.push({ beat: 0, x: beat4X, y: beat4Y + 4*SPEED, dirX: 0, dirY: -1, turned: true, missed: false });
    } else {
        path.push({ beat: 0, x: beat4X, y: beat4Y - 4*SPEED, dirX: 0, dirY: 1, turned: true, missed: false });
    }
    
    // Join node at beat 4
    path.push({ beat: 4, x: beat4X, y: beat4Y, dirX: sharedPath[0].dirX, dirY: sharedPath[0].dirY, turned: false, missed: false });
    
    let curX = beat4X; let curY = beat4Y; let curBeat = 4;
    for (let i = 0; i < sharedPath.length; i++) {
        const seg = sharedPath[i];
        const dist = seg.interval * SPEED;
        curX += seg.dirX * dist;
        curY += seg.dirY * dist;
        curBeat += seg.interval;
        
        const nextDirX = (i + 1 < sharedPath.length) ? sharedPath[i+1].dirX : seg.dirX;
        const nextDirY = (i + 1 < sharedPath.length) ? sharedPath[i+1].dirY : seg.dirY;
        path.push({ beat: curBeat, x: curX, y: curY, dirX: nextDirX, dirY: nextDirY, turned: false, missed: false });
    }
    return path;
}

// --- Init ---
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'init') {
                localId = data.id;
                players = data.players;
                localPlayer = players[localId];
            } else if (data.type === 'playerJoined') {
                players[data.player.id] = data.player;
                if (gameState === 'starting' || gameState === 'playing') {
                    otherPlayersPaths[data.player.id] = generatePlayerPath(data.player.spawnIndex);
                }
            } else if (data.type === 'playerLeft') {
                delete players[data.id];
                delete otherPlayersPaths[data.id];
            } else if (data.type === 'startGame') {
                handleStartGame(data.startDelay);
            } else if (data.type === 'hit') {
                if (data.id !== localId) playEcho();
                if (data.combo !== undefined) {
                    sharedCombo = data.combo;
                    comboCountEl.textContent = sharedCombo;
                    comboCountEl.style.transform = 'scale(1.5)';
                    setTimeout(() => comboCountEl.style.transform = 'scale(1)', 100);
                }
                if (players[data.id]) {
                    players[data.id].score = data.score;
                    players[data.id].lives = data.lives;
                }
            } else if (data.type === 'playerDead') {
                if (players[data.id]) players[data.id].lives = 0;
            }
        } catch(e) {}
    };
}
initWebSocket();

// --- Tab & UI ---
btnTabCalib.addEventListener('click', () => switchTab('calib'));
btnTabGame.addEventListener('click', () => switchTab('game'));
function switchTab(mode) {
    if (isPlaying) stopAudio();
    activeMode = mode;
    btnTabCalib.classList.toggle('active', mode === 'calib');
    btnTabGame.classList.toggle('active', mode === 'game');
    viewCalib.classList.toggle('active', mode === 'calib');
    viewGame.classList.toggle('active', mode === 'game');
    if (mode === 'game') drawGame(0);
}

function updateGameUI() {
    livesDisplay.textContent = '❤️'.repeat(lives) + '🖤'.repeat(3 - lives);
    scoreDisplay.textContent = `Score: ${score}`;
}

function createHitEffect(x, y, text, color) {
    if (!audioContext) return;
    hitEffects.push({ x, y, text, time: audioContext.currentTime, color });
}

// --- Audio Engine ---
function stopAudio() {
    isPlaying = false;
    clearTimeout(timerID);
    cancelAnimationFrame(drawReqId);
    if (activeMode === 'calib') {
        startBtn.textContent = 'START CALIB';
        beatCircle.style.background = '';
    } else {
        startGameBtn.textContent = 'START GAME';
        if (gameState !== 'idle') gameState = 'idle';
        drawGame(0);
    }
}

function startCalib() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    isPlaying = true; currentNote = 0;
    startTime = audioContext.currentTime + 0.1;
    nextNoteTime = startTime;
    scheduledBeats.length = 0; notesInQueue.length = 0; lastDrawnNote = -1;
    startBtn.textContent = 'STOP CALIB';
    scheduler();
    drawReqId = requestAnimationFrame(draw);
}

function handleStartGame(startDelayMs) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    
    lives = 3; score = 0; updateGameUI();
    gameState = 'starting';
    
    pathNodes = generatePlayerPath(localPlayer.spawnIndex);
    otherPlayersPaths = {};
    for (const id in players) {
        if (id !== localId) otherPlayersPaths[id] = generatePlayerPath(players[id].spawnIndex);
        players[id].lives = 3; players[id].score = 0; players[id].deathBeat = undefined;
    }
    
    zoomAnimStart = audioContext.currentTime;
    // Exactly schedule start time
    startTime = zoomAnimStart + (startDelayMs / 1000); 
    
    isPlaying = true; currentNote = 0;
    nextNoteTime = startTime; // nothing plays until startTime!
    scheduledBeats.length = 0; notesInQueue.length = 0; hitEffects = [];
    
    startGameBtn.textContent = 'STOP GAME';
    scheduler();
    if (!drawReqId) drawReqId = requestAnimationFrame(draw);
}

function playClick(time, noteIndex) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env); env.connect(audioContext.destination);
    
    // Quarter note strong click, eighth note weak tick
    if (noteIndex % 2 === 0) {
        osc.frequency.value = (noteIndex === 0) ? 880.0 : 440.0;
        env.gain.value = 1;
    } else {
        osc.frequency.value = 220.0;
        env.gain.value = 0.2;
    }
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    osc.start(time); osc.stop(time + 0.03);
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
        nextNote();
    }
    while (scheduledBeats.length && scheduledBeats[0].time < audioContext.currentTime - 2.0) {
        scheduledBeats.shift();
    }
    if (isPlaying) timerID = setTimeout(scheduler, lookahead);
}

// --- Input ---
function handleInput() {
    if (!isPlaying) return;
    
    const rawHitTime = audioContext.currentTime;
    const adjustedHitTime = rawHitTime - (calibrationOffsetMs / 1000);

    let minDiff = Infinity; let closestBeat = null;
    for (const b of scheduledBeats) {
        // Only target quarter notes for turns, unless track has 8th notes
        // Actually, matching exact available turns is best
        const diff = adjustedHitTime - b.time;
        if (Math.abs(diff) < Math.abs(minDiff)) {
            minDiff = diff; closestBeat = b;
        }
    }
    if (!closestBeat || minDiff === Infinity) return;
    const diffMs = Math.round(minDiff * 1000);

    if (activeMode === 'calib') {
        recentOffsets.push(diffMs);
        if (recentOffsets.length > 5) recentOffsets.shift();
        calibrationOffsetMs = Math.round(recentOffsets.reduce((a,b)=>a+b,0)/recentOffsets.length);
        offsetDisplay.textContent = `Avg Delay: ${calibrationOffsetMs} ms`;
        
        hitResultEl.className = '';
        if (Math.abs(diffMs) <= 30) { hitResultEl.textContent = `Perfect! (${diffMs}ms)`; hitResultEl.classList.add('perfect'); }
        else if (Math.abs(diffMs) <= 80) { hitResultEl.textContent = `Good (${diffMs}ms)`; hitResultEl.classList.add('good'); }
        else { hitResultEl.textContent = `Miss (${diffMs}ms)`; hitResultEl.classList.add('bad'); }
        
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'hit', diffMs}));

    } else if (activeMode === 'game' && gameState === 'playing') {
        const node = pathNodes.find(n => n.beat === closestBeat.beat && n.beat > 0);
        if (node && !node.turned && !node.missed) {
            if (Math.abs(diffMs) <= 120) {
                node.turned = true; score += 100; updateGameUI();
                createHitEffect(node.x, node.y, 'PERFECT', localPlayer.color);
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'hit', diffMs, score, lives}));
            } else {
                node.missed = true; lives--; updateGameUI();
                createHitEffect(node.x, node.y, 'MISS', '#ff5252');
                if (lives <= 0) {
                    gameState = 'over';
                    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'dead' }));
                }
            }
        }
    }
}

window.addEventListener('pointerdown', (e) => {
    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'CANVAS') handleInput();
});
canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); handleInput(); });
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); handleInput(); }
});

startBtn.addEventListener('click', () => isPlaying ? stopAudio() : startCalib());
startGameBtn.addEventListener('click', () => {
    if (isPlaying) stopAudio();
    else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'startRequest' }));
});

// --- Rendering ---
function getPlayerPositionAtBeat(exactBeat, pathData, pState) {
    if (pState.lives <= 0) {
        if (pState.deathBeat === undefined) pState.deathBeat = exactBeat;
        exactBeat = Math.min(exactBeat, pState.deathBeat);
    }
    let pX = pathData[0].x; let pY = pathData[0].y;
    for (let i = 0; i < pathData.length - 1; i++) {
        const curr = pathData[i]; const next = pathData[i+1];
        if (exactBeat >= curr.beat && exactBeat < next.beat) {
            const progress = exactBeat - curr.beat;
            if (curr.missed && i > 0) {
                const prev = pathData[i-1];
                pX = curr.x + prev.dirX * (progress * SPEED);
                pY = curr.y + prev.dirY * (progress * SPEED);
            } else {
                pX = curr.x + curr.dirX * (progress * SPEED);
                pY = curr.y + curr.dirY * (progress * SPEED);
            }
            return { x: pX, y: pY, currNode: curr };
        }
    }
    const last = pathData[pathData.length-1];
    pX = last.x + last.dirX * ((exactBeat - last.beat) * SPEED);
    pY = last.y + last.dirY * ((exactBeat - last.beat) * SPEED);
    return { x: pX, y: pY, currNode: last };
}

function draw() {
    const currentTime = audioContext ? audioContext.currentTime : 0;
    
    if (activeMode === 'calib') {
        let drawNote = lastDrawnNote;
        while (notesInQueue.length && notesInQueue[0].time < currentTime) {
            drawNote = notesInQueue[0].note;
            notesInQueue.shift();
        }
        if (drawNote !== lastDrawnNote) {
            if (drawNote % 2 === 0) {
                beatCircle.classList.add('beat-active');
                beatCircle.style.background = drawNote === 0 
                    ? 'radial-gradient(circle, #ff4081 0%, #c2185b 100%)' 
                    : 'radial-gradient(circle, #1e88e5 0%, #1565c0 100%)';
                setTimeout(() => {
                    beatCircle.classList.remove('beat-active');
                    beatCircle.style.background = '';
                }, 100);
            }
            lastDrawnNote = drawNote;
        }
    } else if (activeMode === 'game') {
        drawGame(currentTime);
    }
    
    if (isPlaying) drawReqId = requestAnimationFrame(draw);
}

function drawGame(currentTime) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (gameState === 'idle') {
        ctx.fillStyle = 'white'; ctx.font = '700 20px Outfit'; ctx.textAlign = 'center';
        ctx.fillText('Waiting for players...', canvas.width/2, canvas.height/2 - 20);
        ctx.fillText('Tap START to begin', canvas.width/2, canvas.height/2 + 20);
        return;
    }
    
    const exactBeat = Math.max(0, (currentTime - startTime) / QUARTER_NOTE_SEC);
    
    const localPos = getPlayerPositionAtBeat(exactBeat, pathNodes, { lives });
    let playerX = localPos.x; let playerY = localPos.y;
    
    // Check misses for local player
    if (gameState === 'playing' && lives > 0) {
        const curr = localPos.currNode;
        if (curr && curr.beat !== 0 && exactBeat > curr.beat + 0.3 && !curr.turned && !curr.missed) {
            curr.missed = true; lives--; updateGameUI();
            createHitEffect(curr.x, curr.y, 'CRASH', '#ff5252');
            if (lives <= 0) {
                gameState = 'over';
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'dead' }));
            }
        }
    }
    
    let scale = 1.0; let camX = playerX; let camY = playerY;
    
    if (gameState === 'starting') {
        const elapsed = currentTime - zoomAnimStart;
        if (elapsed < 2.0) {
            const t = Math.min(1.0, elapsed / 2.0);
            const ease = t * t * (3 - 2 * t);
            scale = 0.2 + 0.8 * ease; // Zoom from 0.2 to 1.0
            // Camera pans from (0, -200) to local player's start pos
            camX = 0 + (pathNodes[0].x - 0) * ease;
            camY = (-200) + (pathNodes[0].y - (-200)) * ease;
        } else {
            scale = 1.0;
            camX = pathNodes[0].x; 
            camY = pathNodes[0].y;
            if (currentTime >= startTime) gameState = 'playing';
        }
    }

    ctx.save();
    ctx.translate(canvas.width/2, canvas.height*0.75);
    ctx.scale(scale, scale);
    ctx.translate(-camX, -camY);
    
    // Draw all players
    for (const id in players) {
        const pState = players[id];
        const pPath = (id === localId) ? pathNodes : otherPlayersPaths[id];
        if (!pPath) continue;
        
        ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < pPath.length; i++) {
            if (i === 0) ctx.moveTo(pPath[i].x, pPath[i].y);
            else ctx.lineTo(pPath[i].x, pPath[i].y);
        }
        ctx.strokeStyle = pState.color + '33'; // 20% opacity trace
        ctx.stroke();
        
        const pos = getPlayerPositionAtBeat(exactBeat, pPath, pState);
        
        // Turn nodes
        for (const node of pPath) {
            if (node.beat > 0 && node.beat <= exactBeat + 8) {
                ctx.fillStyle = node.turned ? pState.color : (node.missed ? '#ff5252' : '#ffffff');
                ctx.fillRect(node.x - 5, node.y - 5, 10, 10);
            }
        }
        
        // Player circle
        ctx.fillStyle = (pState.lives <= 0) ? '#555' : pState.color;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2); ctx.fill();
        if (pState.lives > 0) {
            ctx.shadowColor = pState.color; ctx.shadowBlur = 20; ctx.fill(); ctx.shadowBlur = 0;
        }
    }
    
    // Effects
    for (let i = hitEffects.length - 1; i >= 0; i--) {
        const eff = hitEffects[i];
        const age = currentTime - eff.time;
        if (age > 1.0) { hitEffects.splice(i, 1); continue; }
        ctx.fillStyle = eff.color; ctx.globalAlpha = 1.0 - age;
        ctx.font = '900 26px Outfit'; ctx.textAlign = 'center';
        ctx.fillText(eff.text, eff.x, eff.y - (age * 60) - 20);
        ctx.globalAlpha = 1.0;
    }
    
    ctx.restore();
    
    if (gameState === 'over') {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle = '#ff5252'; ctx.font = '900 45px Outfit'; ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', canvas.width/2, canvas.height/2);
    }
}
drawGame(0);
