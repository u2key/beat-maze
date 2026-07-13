const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const jsonPath = path.join(__dirname, 'leaderboard.json');
const dbPath = path.join(__dirname, 'leaderboard.db');

if (!fs.existsSync(jsonPath)) {
    console.error("Error: leaderboard.json not found.");
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const db = new sqlite3.Database(dbPath);

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
            console.error("Failed to create table:", err);
            return;
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
                console.log(`Migrated ${migratedCount} unique records to SQLite successfully!`);
                console.log("You can safely delete or backup leaderboard.json now.");
            }
            db.close();
        });
    });
});
