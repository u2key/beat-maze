const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
}));

// --- Leaderboard Database (JSON file persistence) ---
let leaderboard = {};
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

function loadLeaderboard() {
    if (fs.existsSync(LEADERBOARD_FILE)) {
        try {
            leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
        } catch (e) {
            console.error("Failed to parse leaderboard.json:", e);
            leaderboard = {};
        }
    } else {
        leaderboard = {};
    }
}
loadLeaderboard();

function saveLeaderboard() {
    try {
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
    } catch (e) {
        console.error("Failed to save leaderboard.json:", e);
    }
}

function recordScore(songId, playerName, pct, score) {
    if (!songId || !playerName) return;
    
    if (!leaderboard[songId]) {
        leaderboard[songId] = [];
    }
    
    // Check if player already has an entry
    const existingIndex = leaderboard[songId].findIndex(entry => entry.name === playerName);
    
    if (existingIndex !== -1) {
        const existing = leaderboard[songId][existingIndex];
        // Only update if current run has a higher completion percentage, or equal percentage but higher score
        if (pct > existing.percent || (pct === existing.percent && score > existing.score)) {
            leaderboard[songId][existingIndex] = {
                name: playerName,
                percent: pct,
                score: score,
                date: new Date().toLocaleDateString()
            };
        }
    } else {
        leaderboard[songId].push({
            name: playerName,
            percent: pct,
            score: score,
            date: new Date().toLocaleDateString()
        });
    }
    
    // Sort descending by percentage, then descending by score
    leaderboard[songId].sort((a, b) => {
        if (b.percent !== a.percent) return b.percent - a.percent;
        return b.score - a.score;
    });
    
    // Keep top 10 rankings
    leaderboard[songId] = leaderboard[songId].slice(0, 10);
    
    saveLeaderboard();
    broadcast({ type: 'leaderboardUpdate', songId, leaderboard: leaderboard[songId] });
}

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
                const mp3Exists = fs.existsSync(path.join(songsDir, `${id}.mp3`));
                
                if (mp3Exists) {
                    list.push({
                        id: id,
                        title: data.title || id,
                        bpm: data.bpm || 120,
                        leadIn: data.leadIn || 2.5,
                        mp3: `songs/${id}.mp3`,
                        json: `songs/${id}.json`
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

// Configure Multer for MP3 uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'songs'));
    },
    filename: function (req, file, cb) {
        const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, cleanedName);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        if (!file.originalname.toLowerCase().endsWith('.mp3')) {
            return cb(new Error('Only MP3 audio files are allowed.'));
        }
        cb(null, true);
    }
});

// Configure Multer for chunked memory storage
const memoryStorage = multer.memoryStorage();
const uploadChunk = multer({ storage: memoryStorage });

// Chunked upload endpoint
app.post('/api/songs/upload-chunk', uploadChunk.single('audioChunk'), (req, res) => {
    const logPath = path.join(__dirname, 'server.log');
    
    if (!req.file) {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Error: No chunk uploaded in request.\n`);
        return res.status(400).json({ error: 'No chunk uploaded' });
    }
    
    const { filename, uploadId, chunkIndex, totalChunks } = req.body;
    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    
    // Clean filename
    const cleanedName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const id = cleanedName.replace(/\.[^/.]+$/, ""); // strip extension
    
    const tmpPath = path.join(__dirname, 'songs', `tmp_${uploadId}.mp3`);
    
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Received chunk ${idx + 1}/${total} for ${filename} (uploadId: ${uploadId})\n`);
    
    try {
        // Append chunk buffer to the temp file
        fs.appendFileSync(tmpPath, req.file.buffer);
        
        // If it is the last chunk, finalize the file and run the note generator
        if (idx === total - 1) {
            const finalMp3Path = path.join(__dirname, 'songs', `${id}.mp3`);
            const finalJsonPath = path.join(__dirname, 'songs', `${id}.json`);
            
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] Finalizing file. Renaming temp file to ${finalMp3Path}\n`);
            
            // Rename temp file to final location (overwrite if exists)
            if (fs.existsSync(finalMp3Path)) {
                fs.unlinkSync(finalMp3Path);
            }
            fs.renameSync(tmpPath, finalMp3Path);
            
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] Starting note generator in background...\n`);
            
            // Respond immediately to prevent gateway timeout
            res.json({ success: true, completed: true, status: 'processing' });
            
            // Run generator in background
            exec(`python3 generate_notes.py "${finalMp3Path}" "${finalJsonPath}"`, (error, stdout, stderr) => {
                if (error) {
                    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Python error: ${error}\nstdout: ${stdout}\nstderr: ${stderr}\n`);
                    fs.appendFileSync(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] Python error: ${error}\nstdout: ${stdout}\nstderr: ${stderr}\n`);
                    try { fs.unlinkSync(finalMp3Path); } catch(e) {}
                    return;
                }
                
                fs.appendFileSync(logPath, `[${new Date().toISOString()}] Successfully processed song in background: ${id}\n`);
                broadcast({ type: 'songsUpdated' });
            });
        } else {
            // Chunk received successfully
            res.json({ success: true, completed: false, chunkIndex: idx });
        }
    } catch (e) {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Chunk upload exception: ${e.message}\n${e.stack}\n`);
        fs.appendFileSync(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] Chunk upload error: ${e.message}\n${e.stack}\n`);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(err) {}
        res.status(500).json({ error: e.message });
    }
});

// Delete song endpoint
app.delete('/api/songs/:id', (req, res) => {
    const id = req.params.id;
    const mp3Path = path.join(__dirname, 'songs', `${id}.mp3`);
    const jsonPath = path.join(__dirname, 'songs', `${id}.json`);
    
    console.log(`Deleting song: ${id}`);
    
    try {
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        
        if (selectedSong && selectedSong.id === id) {
            selectedSong = null;
            broadcast({ type: 'songSelected', songId: null, title: null });
        }
        
        // Remove from local leaderboard DB too
        if (leaderboard[id]) {
            delete leaderboard[id];
            saveLeaderboard();
        }
        
        broadcast({ type: 'songsUpdated' });
        res.json({ success: true, songs: getSongsList() });
    } catch (e) {
        console.error("Failed to delete song files:", e);
        res.status(500).json({ error: "Failed to delete song files." });
    }
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
let trackTurnPoints = {}; // playerId -> array of points
let sharedCombo = 0;
let gameState = 'idle'; // idle | starting | playing
let selectedDifficulty = 3; // 1: Easy (★), 2: Medium (★★), 3: Hard (★★★)

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

    const isSpectator = gameState !== 'idle';
    players[id] = {
        id,
        color,
        spawnIndex,
        name: '', // Set on registerName
        score: 0,
        combo: 0,
        alive: !isSpectator,
        spectator: isSpectator,
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
        selectedSong: selectedSong ? selectedSong.id : null,
        gameState,
        selectedDifficulty
    }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'registerName': {
                const p = players[id];
                if (p) {
                    p.name = data.name.trim() || `P${p.spawnIndex + 1}`;
                    
                    // Broadcast player joined only after name is registered
                    broadcast({ type: 'playerJoined', player: p });
                    
                    // Send current leaderboard to this specific client if song is selected
                    if (selectedSong) {
                        ws.send(JSON.stringify({
                            type: 'leaderboardUpdate',
                            songId: selectedSong.id,
                            leaderboard: leaderboard[selectedSong.id] || []
                        }));
                    }
                }
                break;
            }
            
            case 'selectSong': {
                const songs = getSongsList();
                const song = songs.find(s => s.id === data.songId);
                if (song) {
                    selectedSong = song;
                    try {
                        const jsonPath = path.join(__dirname, 'songs', `${song.id}.json`);
                        const songData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                        trackSegments = songData.segments;
                        broadcast({ type: 'songSelected', songId: song.id, title: song.title });
                        
                        // Broadcast leaderboard for the newly selected song
                        broadcast({
                            type: 'leaderboardUpdate',
                            songId: song.id,
                            leaderboard: leaderboard[song.id] || []
                        });
                    } catch (err) {
                        console.error("Failed to load song segments", err);
                    }
                }
                break;
            }
            
            case 'selectDifficulty': {
                if (gameState === 'idle') {
                    selectedDifficulty = parseInt(data.difficulty) || 3;
                    broadcast({ type: 'difficultySelected', difficulty: selectedDifficulty });
                }
                break;
            }
            
            case 'ping': {
                ws.send(JSON.stringify({ type: 'pong', sendTime: data.sendTime }));
                break;
            }
            
            case 'startRequest': {
                if (gameState !== 'idle' || !selectedSong) return;
                
                const startDelay = 4000;
                gameStartTime = Date.now() + startDelay;
                gameState = 'starting';
                sharedCombo = 0;
                
                broadcast({ type: 'gameStateChange', gameState });
                
                // Filter track segments based on selected difficulty
                const filteredSegments = filterSegmentsByDifficulty(trackSegments, selectedSong.bpm, selectedDifficulty);
                
                // Reset and precalculate paths for active players
                trackTurnPoints = {};
                for (const pid in players) {
                    const p = players[pid];
                    p.spectator = false;
                    const pts = precalculatePathPoints(filteredSegments, p.spawnIndex);
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
                    p.finished = false;
                }
                
                broadcast({ type: 'startGame', startDelay, segments: filteredSegments });
                
                if (gameInterval) clearInterval(gameInterval);
                
                setTimeout(() => {
                    gameState = 'playing';
                }, startDelay);
                
                gameInterval = setInterval(updatePhysics, 40);
                break;
            }
            
            case 'tap': {
                if (gameState !== 'playing') return;
                const p = players[id];
                if (!p || !p.alive || p.spectator) return;
                
                const serverT = (Date.now() - gameStartTime) / 1000;
                const t = (typeof data.time === 'number') ? data.time : serverT;
                
                // Cheat prevention: reject if client time deviates by more than 1.0s from server time
                if (Math.abs(t - serverT) > 1.0) {
                    return;
                }
                
                const turnPoints = trackTurnPoints[id];
                if (!turnPoints) return;
                
                const nextTurn = turnPoints[p.turnIndex + 1];
                if (!nextTurn) return;
                
                const diff = t - nextTurn.time;
                const newDir = 1 - p.currentDir;
                
                if (Math.abs(diff) <= 0.22 && newDir === nextTurn.dir) {
                    p.turnIndex++;
                    p.currentDir = newDir;
                    p.x = nextTurn.x;
                    p.y = nextTurn.y;
                    p.anchor = { x: p.x, y: p.y, time: nextTurn.time };
                    p.trail.push({ x: p.x, y: p.y });
                    
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
        
        const activePlayersCount = Object.values(players).filter(p => !p.spectator).length;
        if (activePlayersCount === 0 && gameInterval) {
            clearInterval(gameInterval);
            gameInterval = null;
            gameState = 'idle';
            for (const pid in players) {
                players[pid].spectator = false;
                players[pid].alive = true;
                players[pid].x = 0;
                players[pid].y = 0;
                players[pid].trail = [];
            }
            broadcast({ type: 'gameStateChange', gameState: 'idle', players });
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
        if (p.spectator) continue;
        
        const turnPoints = trackTurnPoints[id];
        if (!p || !turnPoints) continue;
        
        if (p.alive) {
            anyAlive = true;
            
            if (t >= 0) {
                const elapsed = t - p.anchor.time;
                const dist = elapsed * SPEED_PER_SEC;
                const dv = DIR_VECS[p.currentDir];
                
                p.x = p.anchor.x + dv.x * dist;
                p.y = p.anchor.y + dv.y * dist;
                
                const lastTrail = p.trail[p.trail.length - 1];
                if (!lastTrail || Math.hypot(p.x - lastTrail.x, p.y - lastTrail.y) > 4) {
                    p.trail.push({ x: p.x, y: p.y });
                }
                
                // Missed turn point
                const nextTurn = turnPoints[p.turnIndex + 1];
                const totalTime = turnPoints[turnPoints.length - 1].time;
                
                if (nextTurn && t > nextTurn.time + 0.45) {
                    p.alive = false;
                    p.deathTime = t;
                    broadcast({ type: 'playerDead', id });
                    
                    const pct = Math.min(100, Math.floor((t / totalTime) * 100));
                    recordScore(selectedSong.id, p.name, pct, p.score);
                }
                
                // Wall crash
                if (p.alive && t > 0.5 && !isInsideCorridor(p.x, p.y, turnPoints)) {
                    p.alive = false;
                    p.deathTime = t;
                    broadcast({ type: 'playerDead', id });
                    
                    const pct = Math.min(100, Math.floor((t / totalTime) * 100));
                    recordScore(selectedSong.id, p.name, pct, p.score);
                }
                
                // Finished level
                if (p.alive) {
                    const lastTurn = turnPoints[turnPoints.length - 1];
                    if (t >= lastTurn.time) {
                        if (!p.finished) {
                            p.finished = true;
                            recordScore(selectedSong.id, p.name, 100, p.score);
                        }
                    } else {
                        allFinished = false;
                    }
                }
            } else {
                allFinished = false;
            }
        }
    }
    
    // Broadcast positions
    broadcast({
        type: 'playerUpdate',
        t,
        players: Object.keys(players).reduce((acc, id) => {
            const p = players[id];
            acc[id] = {
                id: p.id,
                name: p.name,
                x: p.x,
                y: p.y,
                alive: p.alive,
                score: p.score,
                combo: p.combo,
                currentDir: p.currentDir,
                trail: p.trail,
                finished: p.finished,
                anchor: p.anchor
            };
            return acc;
        }, {})
    });
    
    if ((allFinished || !anyAlive) && t > 1.0) {
        clearInterval(gameInterval);
        gameInterval = null;
        gameState = 'idle';
        
        // Reset player properties for the lobby
        for (const pid in players) {
            const p = players[pid];
            p.alive = true;
            p.spectator = false;
            p.score = 0;
            p.combo = 0;
            p.x = 0;
            p.y = 0;
            p.trail = [];
        }
        
        broadcast({ type: 'gameStateChange', gameState: 'idle', players });
    }
}

function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(str);
    });
}

function filterSegmentsByDifficulty(originalSegments, bpm, difficulty) {
    if (difficulty === 3 || originalSegments.length <= 2) return originalSegments;
    
    const beatDuration = 60.0 / bpm;
    // minGap: 1 (Easy) -> 2 beats, 2 (Medium) -> 1 beat
    const minGap = (difficulty === 2) ? beatDuration : (2.0 * beatDuration);
    
    const filtered = [];
    filtered.push(originalSegments[0]);
    
    let lastKeptTime = originalSegments[0].time;
    let currentDir = originalSegments[0].dir;
    
    for (let i = 1; i < originalSegments.length - 1; i++) {
        const seg = originalSegments[i];
        if (seg.time - lastKeptTime >= minGap) {
            currentDir = 1 - currentDir;
            filtered.push({
                time: seg.time,
                dir: currentDir
            });
            lastKeptTime = seg.time;
        }
    }
    
    // Always append the last segment to close the track
    const lastSeg = originalSegments[originalSegments.length - 1];
    currentDir = 1 - currentDir;
    filtered.push({
        time: lastSeg.time,
        dir: currentDir
    });
    
    return filtered;
}

const PORT = process.env.PORT || 25561;
server.listen(PORT, () => console.log(`beat_maze server on http://localhost:${PORT}`));
