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
const COLORS = ['#00e676', '#00b0ff', '#ff1744', '#ffea00', '#aa00ff', '#ff9100'];

wss.on('connection', (ws) => {
    const id = Math.random().toString(36).substr(2, 9);
    const color = COLORS[nextSpawnIndex % COLORS.length];
    const spawnIndex = nextSpawnIndex++;

    players[id] = { id, color, spawnIndex, score: 0, alive: true };
    ws.playerId = id;

    // Send init to new client
    ws.send(JSON.stringify({ type: 'init', id, color, spawnIndex, players }));

    // Notify others
    broadcast({ type: 'playerJoined', player: players[id] });

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'startRequest': {
                // Synchronize: 4s delay gives 2s zoom + 2s pause before first beat
                broadcast({ type: 'startGame', startDelay: 4000 });
                // Reset all
                for (const pid in players) {
                    players[pid].alive = true;
                    players[pid].score = 0;
                }
                break;
            }
            case 'playerUpdate': {
                // Relay to all other clients
                const msg = { ...data, id };
                wss.clients.forEach(c => {
                    if (c !== ws && c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify(msg));
                    }
                });
                if (data.score !== undefined) players[id].score = data.score;
                break;
            }
            case 'dead': {
                players[id].alive = false;
                broadcast({ type: 'playerDead', id });
                break;
            }
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
server.listen(PORT, () => console.log(`beat_maze server on http://localhost:${PORT}`));
