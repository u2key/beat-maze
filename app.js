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

// --- Global State ---
let activeMode = 'game'; // 'calib' or 'game'
let audioContext;
let isPlaying = false;
let currentNote = 0;
let nextNoteTime = 0.0;
const lookahead = 25.0;
const scheduleAheadTime = 0.1;
const bpm = 120.0;
const secPerBeat = 60.0 / bpm;
let timerID;
let startTime = 0;
let drawReqId;

// WebSocket Sync
let ws;
let sharedCombo = 0;

// Synchronization & Calib
const scheduledBeats = [];
const notesInQueue = [];
let lastDrawnNote = -1;
let calibrationOffsetMs = 0;
const recentOffsets = [];

// Game State
let gameState = 'idle'; // idle, playing, over
let lives = 3;
let score = 0;
const speedPerBeat = 80; 
let pathNodes = []; // { beat: num, x, y, dirX, dirY, turned: bool, missed: bool }
let hitEffects = []; // { x, y, text, time, alpha, color }

// --- Initialization ---
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'hit') playEcho();
            else if (data.type === 'combo') {
                comboCountEl.textContent = data.value;
                comboCountEl.style.transform = 'scale(1.5)';
                setTimeout(() => comboCountEl.style.transform = 'scale(1)', 100);
            }
        } catch(e) {}
    };
}
initWebSocket();

// --- Tab Switching ---
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

// --- Audio Control ---
function stopAudio() {
    isPlaying = false;
    clearTimeout(timerID);
    cancelAnimationFrame(drawReqId);
    
    if (activeMode === 'calib') {
        startBtn.textContent = 'START CALIB';
        beatCircle.style.background = '';
    } else {
        startGameBtn.textContent = 'START GAME';
        if (gameState === 'playing') gameState = 'idle';
        drawGame(0);
    }
}

function startAudio() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    
    isPlaying = true;
    currentNote = 0;
    startTime = audioContext.currentTime + 0.1;
    nextNoteTime = startTime;
    scheduledBeats.length = 0;
    notesInQueue.length = 0;
    lastDrawnNote = -1;
    hitEffects = [];
    
    if (activeMode === 'game') {
        resetGame();
        gameState = 'playing';
        startGameBtn.textContent = 'STOP GAME';
    } else {
        startBtn.textContent = 'STOP CALIB';
    }
    
    scheduler();
    drawReqId = requestAnimationFrame(draw);
}

// --- Metronome Logic ---
function playClick(time) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.connect(env);
    env.connect(audioContext.destination);
    osc.frequency.value = (currentNote === 0) ? 880.0 : 440.0;
    env.gain.value = 1;
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    osc.start(time);
    osc.stop(time + 0.03);
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
        osc.connect(env);
        env.connect(audioContext.destination);
        osc.type = 'square';
        osc.frequency.value = 600.0;
        env.gain.value = 0.3;
        env.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
        osc.start(audioContext.currentTime);
        osc.stop(audioContext.currentTime + 0.1);
    }
}

function nextNote() {
    nextNoteTime += secPerBeat;
    currentNote = (currentNote + 1) % 4;
}

function scheduler() {
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        const globalBeat = Math.round((nextNoteTime - startTime) / secPerBeat);
        notesInQueue.push({ note: currentNote, time: nextNoteTime });
        scheduledBeats.push({ time: nextNoteTime, beat: globalBeat });
        
        playClick(nextNoteTime);
        
        if (activeMode === 'game' && gameState === 'playing') {
            generatePathIfNeeded(globalBeat + 4);
        }
        
        nextNote();
    }
    
    // Clean old beats
    while (scheduledBeats.length && scheduledBeats[0].time < audioContext.currentTime - 2.0) {
        scheduledBeats.shift();
    }
    
    if (isPlaying) timerID = setTimeout(scheduler, lookahead);
}

// --- Game Logic ---
function resetGame() {
    lives = 3;
    score = 0;
    updateGameUI();
    pathNodes = [];
    // Start node at beat 0 going UP
    pathNodes.push({ beat: 0, x: 0, y: 0, dirX: 0, dirY: -1, turned: true, missed: false });
}

function generatePathIfNeeded(targetBeat) {
    if (pathNodes.length === 0) return;
    let lastNode = pathNodes[pathNodes.length - 1];
    
    while (lastNode.beat < targetBeat) {
        // Create turn every 2 beats
        const nextBeat = lastNode.beat + 2;
        const dist = 2 * speedPerBeat;
        const newX = lastNode.x + lastNode.dirX * dist;
        const newY = lastNode.y + lastNode.dirY * dist;
        
        const turns = [
            { dx: lastNode.dirY, dy: -lastNode.dirX }, // right turn
            { dx: -lastNode.dirY, dy: lastNode.dirX }  // left turn
        ];
        const turn = turns[Math.floor(Math.random() * turns.length)];
        
        pathNodes.push({
            beat: nextBeat, x: newX, y: newY,
            dirX: turn.dx, dirY: turn.dy,
            turned: false, missed: false
        });
        lastNode = pathNodes[pathNodes.length - 1];
    }
}

function updateGameUI() {
    livesDisplay.textContent = '❤️'.repeat(lives) + '🖤'.repeat(3 - lives);
    scoreDisplay.textContent = `Score: ${score}`;
    if (lives <= 0 && gameState === 'playing') {
        gameState = 'over';
        setTimeout(stopAudio, 1000); // Stop after showing explosion
    }
}

function createHitEffect(x, y, text, color) {
    if(!audioContext) return;
    hitEffects.push({ x, y, text, time: audioContext.currentTime, color });
}

// --- Input Handling (Any tap or space) ---
function handleInput() {
    if (!isPlaying) return;
    
    const rawHitTime = audioContext.currentTime;
    const adjustedHitTime = rawHitTime - (calibrationOffsetMs / 1000);

    let minDiff = Infinity;
    let closestBeat = null;
    for (const b of scheduledBeats) {
        const diff = adjustedHitTime - b.time;
        if (Math.abs(diff) < Math.abs(minDiff)) {
            minDiff = diff;
            closestBeat = b;
        }
    }
    if (!closestBeat || minDiff === Infinity) return;
    const diffMs = Math.round(minDiff * 1000);

    if (activeMode === 'calib') {
        // Update Auto Calibration
        recentOffsets.push(diffMs);
        if (recentOffsets.length > 5) recentOffsets.shift();
        calibrationOffsetMs = Math.round(recentOffsets.reduce((a,b)=>a+b,0)/recentOffsets.length);
        offsetDisplay.textContent = `Avg Delay: ${calibrationOffsetMs} ms`;
        
        // Judgment display
        hitResultEl.className = '';
        if (Math.abs(diffMs) <= 30) { hitResultEl.textContent = `Perfect! (${diffMs}ms)`; hitResultEl.classList.add('perfect'); }
        else if (Math.abs(diffMs) <= 80) { hitResultEl.textContent = `Good (${diffMs}ms)`; hitResultEl.classList.add('good'); }
        else { hitResultEl.textContent = `Miss (${diffMs}ms)`; hitResultEl.classList.add('bad'); }
        
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'hit', diffMs}));

    } else if (activeMode === 'game' && gameState === 'playing') {
        // Game tap handling
        const node = pathNodes.find(n => n.beat === closestBeat.beat && n.beat > 0);
        if (node && !node.turned && !node.missed) {
            if (Math.abs(diffMs) <= 120) {
                // Turn successful
                node.turned = true;
                score += 100;
                updateGameUI();
                createHitEffect(node.x, node.y, 'PERFECT', '#00e676');
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'hit', diffMs})); // also send to server for combo
            } else {
                // Early tap penalty? We just ignore or consider it a miss if way off
                if (Math.abs(diffMs) > 120) {
                    node.missed = true;
                    lives--;
                    updateGameUI();
                    createHitEffect(node.x, node.y, 'MISS', '#ff5252');
                }
            }
        }
    }
}

window.addEventListener('pointerdown', (e) => {
    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'CANVAS') {
        handleInput();
    }
});
canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleInput();
});
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        if (!e.repeat) {
            e.preventDefault();
            handleInput();
        }
    }
});

// UI Buttons
startBtn.addEventListener('click', () => isPlaying ? stopAudio() : startAudio());
startGameBtn.addEventListener('click', () => isPlaying ? stopAudio() : startAudio());

// --- Draw Loop ---
function draw() {
    const currentTime = audioContext ? audioContext.currentTime : 0;
    
    if (activeMode === 'calib') {
        // Sync circle
        let drawNote = lastDrawnNote;
        while (notesInQueue.length && notesInQueue[0].time < currentTime) {
            drawNote = notesInQueue[0].note;
            notesInQueue.shift();
        }
        if (drawNote !== lastDrawnNote) {
            beatCircle.classList.add('beat-active');
            beatCircle.style.background = drawNote === 0 
                ? 'radial-gradient(circle, #ff4081 0%, #c2185b 100%)' 
                : 'radial-gradient(circle, #1e88e5 0%, #1565c0 100%)';
            setTimeout(() => {
                beatCircle.classList.remove('beat-active');
                beatCircle.style.background = '';
            }, 100);
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
        ctx.fillStyle = 'white';
        ctx.font = '20px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText('Tap/Space to turn on the beat!', canvas.width/2, canvas.height/2);
        return;
    }
    
    const exactBeat = (currentTime - startTime) / secPerBeat;
    let playerX = 0; let playerY = 0;
    
    if (pathNodes.length > 0) {
        for (let i = 0; i < pathNodes.length - 1; i++) {
            const curr = pathNodes[i];
            const next = pathNodes[i+1];
            
            if (exactBeat >= curr.beat && exactBeat < next.beat) {
                // Check if player missed the turn by going past the threshold (0.3 beats)
                if (curr.beat !== 0 && exactBeat > curr.beat + 0.3 && !curr.turned && !curr.missed) {
                    curr.missed = true;
                    lives--;
                    updateGameUI();
                    createHitEffect(curr.x, curr.y, 'CRASH', '#ff5252');
                }
                
                const progress = exactBeat - curr.beat;
                // If they missed, they keep moving in the *previous* direction visually
                if (curr.missed && i > 0) {
                    const prev = pathNodes[i-1];
                    // keep going straight from prev turn
                    playerX = curr.x + prev.dirX * (progress * speedPerBeat);
                    playerY = curr.y + prev.dirY * (progress * speedPerBeat);
                } else {
                    playerX = curr.x + curr.dirX * (progress * speedPerBeat);
                    playerY = curr.y + curr.dirY * (progress * speedPerBeat);
                }
                break;
            }
        }
    }

    ctx.save();
    // Smooth camera tracking
    ctx.translate(canvas.width/2 - playerX, canvas.height*0.75 - playerY);
    
    // Draw Path
    ctx.lineWidth = 15;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < pathNodes.length; i++) {
        const p = pathNodes[i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        
        // Draw turn markers
        ctx.fillStyle = (p.turned) ? '#00e676' : (p.missed ? '#ff5252' : '#ffeb3b');
        ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.stroke();

    // Draw Player
    ctx.fillStyle = gameState === 'over' ? '#ff5252' : '#00e676';
    ctx.beginPath();
    ctx.arc(playerX, playerY, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 15;
    ctx.fill(); // double fill for glow
    
    // Draw Hit Effects
    for (let i = hitEffects.length - 1; i >= 0; i--) {
        const eff = hitEffects[i];
        const age = currentTime - eff.time;
        if (age > 1.0) { hitEffects.splice(i, 1); continue; }
        
        ctx.fillStyle = eff.color;
        ctx.globalAlpha = 1.0 - age;
        ctx.font = '900 24px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText(eff.text, eff.x, eff.y - (age * 50) - 20);
        ctx.globalAlpha = 1.0;
    }
    ctx.restore();
    
    if (gameState === 'over') {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle = '#ff5252';
        ctx.font = '900 40px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', canvas.width/2, canvas.height/2);
    }
}

// Draw initial idle canvas
drawGame(0);
