const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const players = {};
let nextSpawnIndex = 0;
// Distinct vibrant colors for players
const colors = ['#00e676', '#00b0ff', '#ff1744', '#ffea00', '#aa00ff', '#ff9100'];

let sharedCombo = 0;

wss.on('connection', (ws) => {
    const id = Math.random().toString(36).substr(2, 9);
    const color = colors[nextSpawnIndex % colors.length];
    const spawnIndex = nextSpawnIndex++;
    
    players[id] = { id, color, spawnIndex, score: 0, lives: 3 };
    ws.id = id;

    // Send initialization data to the new client
    ws.send(JSON.stringify({ type: 'init', id, color, spawnIndex, players }));
    
    // Notify others
    broadcast({ type: 'playerJoined', player: players[id] });

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        if (data.type === 'hit') {
            const diffMs = data.diffMs;
            if (Math.abs(diffMs) <= 30) sharedCombo++;
            else if (Math.abs(diffMs) > 120) sharedCombo = 0;

            if (data.score !== undefined) players[id].score = data.score;
            if (data.lives !== undefined) players[id].lives = data.lives;

            broadcast({ type: 'hit', id, diffMs, combo: sharedCombo, score: data.score, lives: data.lives });
        } else if (data.type === 'startRequest') {
            // Give clients exactly 4000ms delay to orchestrate the zoom and wait
            const startDelay = 4000; 
            broadcast({ type: 'startGame', startDelay });
        } else if (data.type === 'dead') {
            players[id].lives = 0;
            broadcast({ type: 'playerDead', id });
        }
    });

    ws.on('close', () => {
        delete players[id];
        broadcast({ type: 'playerLeft', id });
    });
});

function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(str);
    });
}

const PORT = process.env.PORT || 25561;
server.listen(PORT, () => console.log(`beat_echo multiplayer server running on port ${PORT}`));
