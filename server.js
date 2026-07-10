const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

// Get the list of all available songs in the songs/ directory
function getSongsList() {
    const songsDir = path.join(__dirname, 'songs');
    if (!fs.existsSync(songsDir)) {
        fs.mkdirSync(songsDir);
    }
    const files = fs.readdirSync(songsDir);
    const list = [];
    files.forEach(file => {
        if (file.endsWith('.json')) {
            try {
                const jsonPath = path.join(songsDir, file);
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const id = file.replace('.json', '');
                
                // Verify the corresponding MP3 file exists
                const mp3Exists = fs.existsSync(path.join(songsDir, `${id}.mp3`));
                
                if (mp3Exists) {
                    list.push({
                        id: id,
                        title: data.title || id,
                        bpm: data.bpm || 120,
                        leadIn: data.leadIn || 2.5,
                        mp3: `/songs/${id}.mp3`,
                        json: `/songs/${id}.json`
                    });
                }
            } catch (e) {
                console.error("Error reading song json:", file, e);
            }
        }
    });
    return list;
}

app.get('/api/songs', (req, res) => {
    res.json(getSongsList());
});

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

// --- Server-managed Game State ---
const players = {};
let nextSpawnIndex = 0;
const COLORS = ['#00e676', '#00b0ff', '#ff1744', '#ffea00', '#aa00ff', '#ff9100'];

let selectedSong = null;
let gameStartTime = 0;
let gameInterval = null;
let trackSegments = [];
let trackTurnPoints = {}; // playerId -> array of precalculated absolute points
let sharedCombo = 0;
let gameState = 'idle'; // idle | starting | playing

// Helper math for collision
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

// WS connection handling
wss.on('connection', (ws) => {
    const id = Math.random().toString(36).substr(2, 9);
    const color = COLORS[nextSpawnIndex % COLORS.length];
    const spawnIndex = nextSpawnIndex++;

    players[id] = {
        id,
        color,
        spawnIndex,
        score: 0,
        combo: 0,
        alive: true,
        x: 0,
        y: 0,
        currentDir: 0,
        turnIndex: 0,
        trail: [],
        anchor: { x: 0, y: 0, time: 0.0 }
    };
    ws.playerId = id;

    // Send init state to new client
    ws.send(JSON.stringify({
        type: 'init',
        id,
        color,
        spawnIndex,
        players,
        selectedSong: selectedSong ? selectedSong.id : null
    }));

    // Notify other players
    broadcast({ type: 'playerJoined', player: players[id] });

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'selectSong': {
                const songs = getSongsList();
                const song = songs.find(s => s.id === data.songId);
                if (song) {
                    selectedSong = song;
                    // Load the track segments from JSON
                    try {
                        const jsonPath = path.join(__dirname, 'songs', `${song.id}.json`);
                        const songData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                        trackSegments = songData.segments;
                        broadcast({ type: 'songSelected', songId: song.id, title: song.title });
                    } catch (err) {
                        console.error("Failed to load song segments", err);
                    }
                }
                break;
            }
            
            case 'startRequest': {
                if (gameState === 'playing' || !selectedSong) return;
                
                // Synchronized start sequence: 4 seconds delay
                // 2 seconds zoom-out to zoom-in, 2 seconds count down
                const startDelay = 4000;
                gameStartTime = Date.now() + startDelay;
                gameState = 'starting';
                sharedCombo = 0;
                
                // Precalculate trajectories for all players
                trackTurnPoints = {};
                for (const pid in players) {
                    const p = players[pid];
                    const pts = precalculatePathPoints(trackSegments, p.spawnIndex);
                    trackTurnPoints[pid] = pts;
                    
                    p.alive = true;
                    p.score = 0;
                    p.combo = 0;
                    p.x = pts[0].x;
                    p.y = pts[0].y;
                    p.currentDir = pts[0].dir;
                    p.turnIndex = 0;
                    p.trail = [{ x: p.x, y: p.y }];
                    p.anchor = { x: p.x, y: p.y, time: 0.0 };
                    p.deathTime = null;
                }
                
                broadcast({ type: 'startGame', startDelay });
                
                // Start the server authoritative update loop
                if (gameInterval) clearInterval(gameInterval);
                
                setTimeout(() => {
                    gameState = 'playing';
                }, startDelay);
                
                gameInterval = setInterval(updatePhysics, 40); // 25 Hz update loop
                break;
            }
            
            case 'tap': {
                if (gameState !== 'playing') return;
                const p = players[id];
                if (!p || !p.alive) return;
                
                const t = (Date.now() - gameStartTime) / 1000;
                const turnPoints = trackTurnPoints[id];
                if (!turnPoints) return;
                
                const nextTurn = turnPoints[p.turnIndex + 1];
                if (!nextTurn) return; // End of track
                
                const diff = t - nextTurn.time;
                const newDir = 1 - p.currentDir;
                
                // Check if tap timing is within tolerance (220ms) and direction is correct
                if (Math.abs(diff) <= 0.22 && newDir === nextTurn.dir) {
                    p.turnIndex++;
                    p.currentDir = newDir;
                    // Snap exactly to corner point to avoid drift
                    p.x = nextTurn.x;
                    p.y = nextTurn.y;
                    p.anchor = { x: p.x, y: p.y, time: nextTurn.time };
                    p.trail.push({ x: p.x, y: p.y });
                    
                    // Score logic
                    const diffMs = Math.abs(diff) * 1000;
                    let scoreAdd = 100;
                    let judgment = "GOOD";
                    if (diffMs < 50) {
                        scoreAdd = 300;
                        judgment = "PERFECT";
                        sharedCombo++;
                    } else if (diffMs < 120) {
                        scoreAdd = 200;
                        judgment = "GREAT";
                        sharedCombo++;
                    } else {
                        sharedCombo++;
                    }
                    p.score += scoreAdd;
                    p.combo = sharedCombo;
                    
                    broadcast({ 
                        type: 'hit', 
                        id, 
                        diffMs, 
                        combo: sharedCombo, 
                        score: p.score, 
                        x: p.x, 
                        y: p.y, 
                        judgment 
                    });
                } else {
                    // Turn immediately where they tapped (leads to crash out of corridor)
                    p.currentDir = newDir;
                    p.anchor = { x: p.x, y: p.y, time: t };
                    p.trail.push({ x: p.x, y: p.y });
                    sharedCombo = 0;
                    broadcast({ type: 'hit', id, combo: 0, score: p.score, x: p.x, y: p.y, judgment: "MISS" });
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        delete players[id];
        delete trackTurnPoints[id];
        broadcast({ type: 'playerLeft', id });
        
        // Stop server loop if lobby is empty
        if (Object.keys(players).length === 0) {
            clearInterval(gameInterval);
            gameInterval = null;
            gameState = 'idle';
        }
    });
});

// Update player positions, handle misses, check collisions
function updatePhysics() {
    if (gameState === 'idle') return;
    
    const t = (Date.now() - gameStartTime) / 1000;
    
    let allFinished = true;
    let anyAlive = false;
    
    for (const id in players) {
        const p = players[id];
        const turnPoints = trackTurnPoints[id];
        
        if (!p || !turnPoints) continue;
        
        if (p.alive) {
            anyAlive = true;
            
            // Calculate current position
            if (t >= 0) {
                const elapsed = t - p.anchor.time;
                const dist = elapsed * SPEED_PER_SEC;
                const dv = DIR_VECS[p.currentDir];
                
                p.x = p.anchor.x + dv.x * dist;
                p.y = p.anchor.y + dv.y * dist;
                
                // Add to trail if moved
                const lastTrail = p.trail[p.trail.length - 1];
                if (!lastTrail || Math.hypot(p.x - lastTrail.x, p.y - lastTrail.y) > 4) {
                    p.trail.push({ x: p.x, y: p.y });
                }
                
                // Check if they missed the next turn point (more than 300ms late)
                const nextTurn = turnPoints[p.turnIndex + 1];
                if (nextTurn && t > nextTurn.time + 0.3) {
                    p.alive = false;
                    p.deathTime = t;
                    broadcast({ type: 'playerDead', id });
                }
                
                // Check if they crashed into walls
                if (t > 0.5 && !isInsideCorridor(p.x, p.y, turnPoints)) {
                    p.alive = false;
                    p.deathTime = t;
                    broadcast({ type: 'playerDead', id });
                }
                
                // Check if they finished the track
                const lastTurn = turnPoints[turnPoints.length - 1];
                if (t >= lastTurn.time) {
                    p.finished = true;
                } else {
                    allFinished = false;
                }
            } else {
                allFinished = false;
            }
        }
    }
    
    // Broadcast positions to all clients
    broadcast({
        type: 'playerUpdate',
        t,
        players: Object.keys(players).reduce((acc, id) => {
            const p = players[id];
            acc[id] = {
                id: p.id,
                x: p.x,
                y: p.y,
                alive: p.alive,
                score: p.score,
                combo: p.combo,
                currentDir: p.currentDir,
                trail: p.trail,
                finished: p.finished
            };
            return acc;
        }, {})
    });
    
    // Check game over or complete
    if ((allFinished || !anyAlive) && t > 1.0) {
        clearInterval(gameInterval);
        gameInterval = null;
        gameState = 'idle';
    }
}

function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(str);
    });
}

const PORT = process.env.PORT || 25561;
server.listen(PORT, () => console.log(`beat_maze server on http://localhost:${PORT}`));
