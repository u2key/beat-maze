const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exec, execFile } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
}));

// --- SQLite Database Setup ---
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath);

// Create table and migrate if needed
db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id TEXT NOT NULL,
                difficulty INTEGER NOT NULL,
                player_name TEXT NOT NULL,
                percent REAL NOT NULL,
                score INTEGER NOT NULL,
                date TEXT NOT NULL,
                UNIQUE(song_id, difficulty, player_name)
            )
        `, (err) => {
            if (err) {
                console.error("Failed to create leaderboard table:", err);
                return;
            }
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS custom_maps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id TEXT NOT NULL,
                creator_name TEXT NOT NULL,
                title TEXT NOT NULL,
                segments TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        `, (err) => {
            if (err) {
                console.error("Failed to create custom_maps table:", err);
            }
        });
        
        db.run(`ALTER TABLE leaderboard ADD COLUMN max_combo INTEGER DEFAULT 0`, (err) => {
            // Ignore error if column already exists
        });
        
        // Auto-migration from leaderboard.json
        const jsonPath = path.join(__dirname, 'leaderboard.json');
        if (fs.existsSync(jsonPath)) {
            console.log("Found leaderboard.json, starting migration to SQLite...");
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                
                // Read available songs for canonical ID matching
                const songsDir = path.join(__dirname, 'songs');
                let availableSongIds = [];
                if (fs.existsSync(songsDir)) {
                    availableSongIds = fs.readdirSync(songsDir)
                        .filter(f => f.endsWith('.json'))
                        .map(f => f.replace('.json', ''));
                }
                
                function getCanonicalSongId(oldId) {
                    const stripped = oldId.toLowerCase().replace(/_/g, '');
                    for (const sId of availableSongIds) {
                        if (sId.toLowerCase().replace(/_/g, '') === stripped) {
                            return sId;
                        }
                    }
                    return oldId;
                }
                
                const mergedData = {};
                for (const key in data) {
                    const entries = data[key];
                    if (!Array.isArray(entries)) continue;
                    
                    let oldSongId = key;
                    let difficulty = 3;
                    
                    const match = key.match(/^(.*)_diff(\d+)$/);
                    if (match) {
                        oldSongId = match[1];
                        difficulty = parseInt(match[2]);
                    }
                    
                    const canonicalId = getCanonicalSongId(oldSongId);
                    
                    entries.forEach(entry => {
                        const mergeKey = `${canonicalId}_${difficulty}_${entry.name}`;
                        if (!mergedData[mergeKey]) {
                            mergedData[mergeKey] = { canonicalId, difficulty, entry };
                        } else {
                            const existing = mergedData[mergeKey].entry;
                            if (entry.percent > existing.percent || (entry.percent === existing.percent && entry.score > existing.score)) {
                                mergedData[mergeKey] = { canonicalId, difficulty, entry };
                            }
                        }
                    });
                }
                
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO leaderboard (song_id, difficulty, player_name, percent, score, date) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                
                let migratedCount = 0;
                for (const k in mergedData) {
                    const d = mergedData[k];
                    stmt.run(d.canonicalId, d.difficulty, d.entry.name, d.entry.percent, d.entry.score, d.entry.date);
                    migratedCount++;
                }
                
                stmt.finalize();
                db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                        console.error("Migration commit failed:", commitErr);
                    } else {
                        console.log(`Migrated ${migratedCount} unique records to SQLite. Renaming leaderboard.json to .bak`);
                        fs.renameSync(jsonPath, jsonPath + '.bak');
                    }
                });
                
            } catch(e) {
                console.error("Migration failed:", e);
                db.run("ROLLBACK");
            }
        }
});

function broadcastLeaderboard(songId, difficulty, wsOnly = null) {
    db.all(
        `SELECT player_name as name, percent, score, max_combo, date FROM leaderboard 
         WHERE song_id = ? AND difficulty = ?
         ORDER BY percent DESC, score DESC, CAST(date AS INTEGER) ASC LIMIT 10`,
        [songId, difficulty],
        (err, rows) => {
            if (err) {
                console.error("Failed to fetch leaderboard:", err);
                return;
            }
            const payload = {
                type: 'leaderboardUpdate',
                songId,
                difficulty,
                leaderboard: rows || []
            };
            if (wsOnly) {
                if (wsOnly.readyState === 1) wsOnly.send(JSON.stringify(payload));
            } else {
                broadcast(payload);
            }
        }
    );
}

function recordScore(songId, difficulty, playerName, pct, score, maxCombo) {
    if (!songId || !playerName) return;
    
    db.get(
        `SELECT percent, score, max_combo FROM leaderboard 
         WHERE song_id = ? AND difficulty = ? AND player_name = ?`,
        [songId, difficulty, playerName],
        (err, row) => {
            if (err) return;
            
            const dateStr = Date.now().toString();
            if (row) {
                if (pct > row.percent || (pct === row.percent && score > row.score)) {
                    db.run(
                        `UPDATE leaderboard 
                         SET percent = ?, score = ?, max_combo = ?, date = ? 
                         WHERE song_id = ? AND difficulty = ? AND player_name = ?`,
                        [pct, score, maxCombo, dateStr, songId, difficulty, playerName],
                        (updateErr) => { if (!updateErr) finishRecordScore(); }
                    );
                }
            } else {
                db.run(
                    `INSERT INTO leaderboard (song_id, difficulty, player_name, percent, score, max_combo, date) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [songId, difficulty, playerName, pct, score, maxCombo, dateStr],
                    (insertErr) => { if (!insertErr) finishRecordScore(); }
                );
            }
            
            function finishRecordScore() {
                broadcastLeaderboard(songId, difficulty);
                if (difficulty === 3 && pct === 100) {
                    wss.clients.forEach(client => {
                        if (client.readyState === 1 && client.playerId) {
                            sendUnlocksUpdate(client, client.playerId);
                        }
                    });
                }
            }
        }
    );
}

function isDiff5Unlocked(songId, playerName, callback) {
    if (!songId || !playerName) return callback(false);
    db.get(
        `SELECT id FROM leaderboard 
         WHERE song_id = ? AND player_name = ? AND difficulty = 3 AND percent = 100`,
        [songId, playerName],
        (err, row) => {
            callback(!!row);
        }
    );
}

function sendUnlocksUpdate(ws, playerId) {
    const p = players[playerId];
    if (!p || !selectedSong) return;
    isDiff5Unlocked(selectedSong.id, p.name, (unlocked) => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'unlocksUpdate',
                diff5Unlocked: unlocked
            }));
        }
    });
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
                    const duration = data.segments && data.segments.length > 0 
                        ? data.segments[data.segments.length - 1].time 
                        : 0;
                    list.push({
                        id: id,
                        title: data.title || id,
                        bpm: data.bpm || 120,
                        leadIn: data.leadIn || 2.5,
                        duration: duration,
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

app.get('/api/custom-maps', (req, res) => {
    const songId = req.query.song_id;
    if (!songId) return res.status(400).json({ error: "song_id is required" });
    db.all(
        `SELECT id, song_id, creator_name, title, segments, created_at FROM custom_maps WHERE song_id = ? ORDER BY id DESC`,
        [songId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.post('/api/custom-maps', (req, res) => {
    const { song_id, creator_name, title, segments } = req.body;
    if (!song_id || !creator_name || !title || !segments) {
        return res.status(400).json({ error: "song_id, creator_name, title, and segments are required." });
    }
    const createdAt = new Date().toISOString();
    const segmentsStr = typeof segments === 'string' ? segments : JSON.stringify(segments);
    db.run(
        `INSERT INTO custom_maps (song_id, creator_name, title, segments, created_at) VALUES (?, ?, ?, ?, ?)`,
        [song_id, creator_name, title, segmentsStr, createdAt],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.delete('/api/custom-maps/:id', (req, res) => {
    const id = req.params.id;
    db.run(
        `DELETE FROM custom_maps WHERE id = ?`,
        [id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Endpoint to register online sound source via ffmpeg-video and yt-dlp
app.post('/api/songs/register-online', (req, res) => {
    const { url, name } = req.body;
    if (!url || !name) {
        return res.status(400).json({ error: 'URL and Name are required.' });
    }

    const logPath = path.join(__dirname, 'server.log');
    
    // Clean name/id
    const cleanedName = name.replace(/[^\p{L}\p{N}.\-_]/gu, '_');
    const id = cleanedName.replace(/\.[^/.]+$/, "");
    
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Registering online track: ${name} from URL: ${url}\n`);
    
    // Respond immediately to avoid gateway timeout (client updates in bg)
    res.json({ success: true, status: 'processing' });
    
    // Background download and conversion task
    const finalMp3Path = path.join(__dirname, 'songs', `${id}.mp3`);
    const finalJsonPath = path.join(__dirname, 'songs', `${id}.json`);
    
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Running yt-dlp audio-only download...\n`);
    
    const ytDlpPath = '/home/ubuntu/favorite-configurations/scripts/yt-dlp';
    const ytDlpArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', finalMp3Path, url];
    
    execFile(ytDlpPath, ytDlpArgs, { maxBuffer: 50 * 1024 * 1024 }, (err1, stdout1, stderr1) => {
        if (err1) {
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] yt-dlp download failed: ${err1}\nstderr: ${stderr1}\n`);
            return;
        }
        
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Audio extraction succeeded. Generating notes...\n`);
        
        // Run notes generator
        execFile('python3', ['generate_notes.py', finalMp3Path, finalJsonPath], { maxBuffer: 50 * 1024 * 1024 }, (err3, stdout3, stderr3) => {
            if (err3) {
                fs.appendFileSync(logPath, `[${new Date().toISOString()}] Notes generator failed: ${err3}\nstderr: ${stderr3}\n`);
                try { fs.unlinkSync(finalMp3Path); } catch(e) {}
                return;
            }
            
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] Note generation complete. Song registered: ${id}\n`);
            broadcast({ type: 'songsUpdated' });
        });
    });
});

// Configure Multer for MP3 uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'songs'));
    },
    filename: function (req, file, cb) {
        const cleanedName = file.originalname.replace(/[^\p{L}\p{N}.\-_]/gu, '_');
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
    const cleanedName = filename.replace(/[^\p{L}\p{N}.\-_]/gu, '_');
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
            execFile('python3', ['generate_notes.py', finalMp3Path, finalJsonPath], { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
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
        db.run("DELETE FROM leaderboard WHERE song_id = ?", [id]);
        
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

// --- Server-managed Game State ---
const players = {};
let nextSpawnIndex = 0;
const COLORS = ['#00e676', '#00b0ff', '#ff1744', '#ffea00', '#aa00ff', '#ff9100'];

let selectedSong = null;
let gameStartTime = 0;
let gameInterval = null;
let trackSegments = [];
let customTrackSegments = null;
let trackTurnPoints = {}; // playerId -> array of points
let sharedCombo = 0;
let gameState = 'idle'; // idle | starting | playing
let selectedDifficulty = 3; // 1: Easy (★), 2: Medium (★★), 3: Hard (★★★)
let gameEndTimeout = null;

// Helper math for collision
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isInsideCorridor(px, py, turnPoints, turnIndex = 0) {
    const startIdx = Math.max(0, turnIndex - 2);
    const endIdx = Math.min(turnPoints.length - 1, turnIndex + 2);
    for (let i = startIdx; i < endIdx; i++) {
        const p0 = turnPoints[i];
        const p1 = turnPoints[i + 1];
        const dist = pointToSegmentDist(px, py, p0.x, p0.y, p1.x, p1.y);
        if (dist < Math.max(10, WALL_HALF_WIDTH - 2)) return true;
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
    ws.isAlive = true;
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
        maxCombo: 0,
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
                    
                    // Send unlocks state to this client
                    sendUnlocksUpdate(ws, id);
                    
                    // Send current leaderboard to this specific client if song is selected
                    if (selectedSong) {
                        broadcastLeaderboard(selectedSong.id, selectedDifficulty, ws);
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
                        broadcastLeaderboard(song.id, selectedDifficulty);

                        // Update unlocks for all connected clients since the song changed
                        wss.clients.forEach(client => {
                            if (client.readyState === 1 && client.playerId) {
                                sendUnlocksUpdate(client, client.playerId);
                            }
                        });
                    } catch (err) {
                        console.error("Failed to load song segments", err);
                    }
                }
                break;
            }
            
            case 'selectDifficulty': {
                if (gameState === 'idle') {
                    const diff = parseInt(data.difficulty) || 3;
                    
                    const finishDifficultySelect = (customSegments) => {
                        selectedDifficulty = diff;
                        SPEED_PER_SEC = selectedDifficulty === 5 ? 360 : 160;
                        if (customSegments) {
                            customTrackSegments = customSegments;
                        } else {
                            customTrackSegments = null;
                        }
                        broadcast({ type: 'difficultySelected', difficulty: selectedDifficulty });
                        
                        if (selectedSong) {
                            broadcastLeaderboard(selectedSong.id, selectedDifficulty);
                        }
                    };

                    if (diff >= 100) {
                        const customMapId = diff - 100;
                        db.get(`SELECT segments FROM custom_maps WHERE id = ?`, [customMapId], (err, row) => {
                            if (row) {
                                try {
                                    const customSegments = JSON.parse(row.segments);
                                    finishDifficultySelect(customSegments);
                                } catch (e) {
                                    console.error("Failed to parse custom map segments:", e);
                                    finishDifficultySelect(null);
                                }
                            } else {
                                finishDifficultySelect(null);
                            }
                        });
                    } else if (diff === 5) {
                        const p = players[id];
                        if (!p || !selectedSong) return;
                        isDiff5Unlocked(selectedSong.id, p.name, (unlocked) => {
                            if (unlocked) finishDifficultySelect();
                        });
                    } else {
                        finishDifficultySelect();
                    }
                }
                break;
            }
            
            case 'ping': {
                ws.isAlive = true;
                ws.send(JSON.stringify({ type: 'pong', sendTime: data.sendTime }));
                break;
            }
            
            case 'startRequest': {
                if (gameState !== 'idle') {
                    // Redirect to spectate if game is already running
                    const p = players[id];
                    if (p && selectedSong) {
                        p.spectator = true;
                        p.alive = false;
                        p.finished = false;
                        let filteredSegments;
                        if (selectedDifficulty >= 100 && customTrackSegments) {
                            filteredSegments = customTrackSegments;
                        } else {
                            filteredSegments = filterSegmentsByDifficulty(trackSegments, selectedSong.bpm, selectedDifficulty);
                        }
                        trackTurnPoints[id] = precalculatePathPoints(filteredSegments, p.spawnIndex);
                        const currentT = (Date.now() - gameStartTime) / 1000;
                        ws.send(JSON.stringify({
                            type: 'startSpectating',
                            segments: filteredSegments,
                            elapsedT: currentT
                        }));
                    }
                    return;
                }
                if (!selectedSong) return;
                
                if (gameEndTimeout) {
                    clearTimeout(gameEndTimeout);
                    gameEndTimeout = null;
                }
                
                const startDelay = 4000;
                gameStartTime = Date.now() + startDelay;
                gameState = 'starting';
                sharedCombo = 0;
                
                broadcast({ type: 'gameStateChange', gameState });
                
                // Filter track segments based on selected difficulty or custom segments
                let filteredSegments;
                if (selectedDifficulty >= 100 && customTrackSegments) {
                    filteredSegments = customTrackSegments;
                } else {
                    filteredSegments = filterSegmentsByDifficulty(trackSegments, selectedSong.bpm, selectedDifficulty);
                }
                
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
            
            case 'spectateRequest': {
                if (gameState === 'idle' || !selectedSong) return;
                
                const p = players[id];
                if (p) {
                    p.spectator = true;
                    p.alive = false;
                    p.finished = false;
                    
                    const filteredSegments = filterSegmentsByDifficulty(trackSegments, selectedSong.bpm, selectedDifficulty);
                    trackTurnPoints[id] = precalculatePathPoints(filteredSegments, p.spawnIndex);
                    
                    const currentT = (Date.now() - gameStartTime) / 1000;
                    ws.send(JSON.stringify({
                        type: 'startSpectating',
                        segments: filteredSegments,
                        elapsedT: currentT
                    }));
                }
                break;
            }
            
            case 'syncRequest': {
                // Client tab became active, resync state to prevent stale UI
                const p = players[id];
                ws.send(JSON.stringify({
                    type: 'init',
                    id,
                    gameState,
                    players,
                    song: selectedSong ? { id: selectedSong.id, title: selectedSong.title } : null,
                    difficulty: selectedDifficulty
                }));
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
                    let judgment = "Good";
                    if (diffMs < 80) {
                        scoreAdd = 300;
                        judgment = "excellent";
                        sharedCombo++;
                    } else {
                        scoreAdd = 150;
                        judgment = "Good";
                        sharedCombo++;
                    }
                    p.score += scoreAdd + (sharedCombo * 10);
                    p.combo = sharedCombo;
                    p.maxCombo = Math.max(p.maxCombo || 0, p.combo);
                    
                    broadcast({ 
                        type: 'hit', 
                        id, 
                        diffMs, 
                        combo: sharedCombo, 
                        score: p.score, 
                        x: p.x, 
                        y: p.y, 
                        judgment,
                        turnIndex: p.turnIndex
                    });
                } else {
                    const distToTurn = Math.hypot(p.x - nextTurn.x, p.y - nextTurn.y);
                    if (newDir === nextTurn.dir && distToTurn < 60) {
                        p.turnIndex++;
                        p.currentDir = newDir;
                        p.x = nextTurn.x;
                        p.y = nextTurn.y;
                        p.anchor = { x: p.x, y: p.y, time: nextTurn.time };
                        p.trail.push({ x: p.x, y: p.y });
                        sharedCombo = 0;
                        
                        // Snap turn but combo breaks: judge Fast if clicked early, Late if clicked late
                        const judgment = (diff < 0) ? "Fast" : "Late";
                        broadcast({ 
                            type: 'hit', 
                            id, 
                            diffMs: Math.abs(diff) * 1000, 
                            combo: 0, 
                            score: p.score, 
                            x: p.x, 
                            y: p.y, 
                            judgment,
                            turnIndex: p.turnIndex
                        });
                    } else {
                        p.currentDir = newDir;
                        p.anchor = { x: p.x, y: p.y, time: t };
                        p.trail.push({ x: p.x, y: p.y });
                        sharedCombo = 0;
                        broadcast({ type: 'hit', id, combo: 0, score: p.score, x: p.x, y: p.y, judgment: "MISS", turnIndex: p.turnIndex });
                    }
                }
                break;
            }
            case 'statusReport': {
                const p = players[id];
                if (!p) return;
                // Do NOT overwrite p.alive — only the server physics loop controls alive state
                p.score = data.score !== undefined ? data.score : p.score;
                p.combo = data.combo !== undefined ? data.combo : p.combo;
                p.maxCombo = Math.max(p.maxCombo || 0, p.combo);
                
                broadcast({
                    type: 'statusUpdate',
                    players: Object.keys(players).reduce((acc, pid) => {
                        const pl = players[pid];
                        acc[pid] = {
                            id: pl.id,
                            name: pl.name,
                            alive: pl.alive,
                            score: pl.score,
                            combo: pl.combo,
                            maxCombo: pl.maxCombo,
                            finished: pl.finished,
                            spawnIndex: pl.spawnIndex,
                            color: pl.color
                        };
                        return acc;
                    }, {})
                });
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
            if (gameEndTimeout) clearTimeout(gameEndTimeout);
            gameEndTimeout = null;
            
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
                
                // Optimizing trail: only store turn coordinates, not intermediate physics points to prevent lag
                const lastTrail = p.trail[p.trail.length - 1];
                if (!lastTrail) {
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
                    recordScore(selectedSong.id, selectedDifficulty, p.name, pct, p.score, p.maxCombo);
                }
                
                // Wall crash (only if not finished yet)
                if (p.alive && !p.finished && t > 0.5 && !isInsideCorridor(p.x, p.y, turnPoints, p.turnIndex)) {
                    p.alive = false;
                    p.deathTime = t;
                    broadcast({ type: 'playerDead', id });
                    
                    const pct = Math.min(100, Math.floor((t / totalTime) * 100));
                    recordScore(selectedSong.id, selectedDifficulty, p.name, pct, p.score, p.maxCombo);
                }
                
                // Finished level
                if (p.alive) {
                    const lastTurn = turnPoints[turnPoints.length - 1];
                    if (t >= lastTurn.time) {
                        if (!p.finished) {
                            p.finished = true;
                            recordScore(selectedSong.id, selectedDifficulty, p.name, 100, p.score, p.maxCombo);
                            broadcast({ type: 'playerFinished', id });
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
    
    if ((allFinished || !anyAlive) && t > 1.0) {
        if (!gameEndTimeout) {
            gameEndTimeout = setTimeout(() => {
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
                gameEndTimeout = null;
            }, 3000);
        }
    } else {
        if (gameEndTimeout) {
            clearTimeout(gameEndTimeout);
            gameEndTimeout = null;
        }
    }
}

function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(str);
    });
}

function filterSegmentsByDifficulty(originalSegments, bpm, difficulty) {
    if (difficulty === 3 || difficulty === 5 || originalSegments.length <= 2) return originalSegments;
    
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

// Heartbeat interval to detect stale connections and terminate them
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log(`Terminating stale/ghost client connection for player ID: ${ws.playerId}`);
            return ws.terminate();
        }
        ws.isAlive = false;
    });
}, 15000);

const PORT = process.env.PORT || 25561;
server.listen(PORT, () => console.log(`beat_maze server on http://localhost:${PORT}`));
