const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

let sharedCombo = 0;

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Send initial combo
    ws.send(JSON.stringify({ type: 'combo', value: sharedCombo }));

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received');
            return;
        }

        if (parsedMessage.type === 'hit') {
            const diffMs = parsedMessage.diffMs;
            
            // 判定: Perfect(<=30ms)ならコンボ増加、Bad(>80ms)ならリセット
            if (Math.abs(diffMs) <= 30) {
                sharedCombo++;
            } else if (Math.abs(diffMs) > 80) {
                sharedCombo = 0;
            }

            // 打鍵音(エコー)は他のクライアントにのみブロードキャスト
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'hit', diffMs }));
                }
            });

            // コンボ数は全員にブロードキャスト
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'combo', value: sharedCombo }));
                }
            });
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 25561;
server.listen(PORT, () => {
    console.log(`beat_echo server running on http://localhost:${PORT}`);
});
