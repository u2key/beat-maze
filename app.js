const startBtn = document.getElementById('start-btn');

let audioContext;
let isPlaying = false;
let currentNote = 0;
let nextNoteTime = 0.0; // 次の音が鳴るべき時間
const lookahead = 25.0; // スケジューリング関数を呼び出す頻度 (ミリ秒)
const scheduleAheadTime = 0.1; // どのくらい先までスケジュールするか (秒)
const bpm = 120.0;
let timerID;

// 視覚的な同期のためのキュー
const notesInQueue = []; // { note: currentNote, time: time }
const scheduledBeats = []; // 判定用のビート時刻を保持 (過去/未来のジャストタイミング)
const beatCircle = document.getElementById('beat-circle');
const hitResultEl = document.getElementById('hit-result');
const comboCountEl = document.getElementById('combo-count');
let lastDrawnNote = -1;
let drawReqId;

// --- WebSocket Setup ---
let ws;
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    
    ws.onopen = () => {
        console.log('Connected to server');
    };
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'hit') {
                playEcho();
            } else if (data.type === 'combo') {
                comboCountEl.textContent = data.value;
                comboCountEl.style.transform = 'scale(1.5)';
                setTimeout(() => {
                    comboCountEl.style.transform = 'scale(1)';
                }, 100);
            }
        } catch (e) {
            console.error(e);
        }
    };
}
initWebSocket();

function playEcho() {
    // 視覚的エコー
    const ring = document.createElement('div');
    ring.className = 'echo-ring';
    beatCircle.appendChild(ring);
    setTimeout(() => {
        ring.remove();
    }, 500);

    // 音響的エコー (他のプレイヤーの音)
    if (audioContext && isPlaying) {
        const osc = audioContext.createOscillator();
        const envelope = audioContext.createGain();
        osc.connect(envelope);
        envelope.connect(audioContext.destination);
        
        osc.type = 'square';
        osc.frequency.value = 600.0;
        
        envelope.gain.value = 0.3;
        envelope.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
        
        osc.start(audioContext.currentTime);
        osc.stop(audioContext.currentTime + 0.1);
    }
}

function nextNote() {
    const secondsPerBeat = 60.0 / bpm;
    nextNoteTime += secondsPerBeat;
    currentNote++;
    if (currentNote === 4) {
        currentNote = 0;
    }
}

function playClick(time) {
    // クリック音用のオシレーターを作成
    const osc = audioContext.createOscillator();
    const envelope = audioContext.createGain();

    osc.connect(envelope);
    envelope.connect(audioContext.destination);

    // 1拍目は高い音、それ以外は低い音
    if (currentNote === 0) {
        osc.frequency.value = 880.0; // A5
    } else {
        osc.frequency.value = 440.0; // A4
    }

    // アタックとディケイを設定して「カチッ」という短い音にする
    envelope.gain.value = 1;
    envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

    osc.start(time);
    osc.stop(time + 0.03);
}

function scheduler() {
    // 次のインターバルまでに鳴らすべき音を全てスケジュールする
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        notesInQueue.push({ note: currentNote, time: nextNoteTime });
        scheduledBeats.push(nextNoteTime);
        playClick(nextNoteTime);
        nextNote();
    }

    // 古いビート情報を削除 (1秒以上前のもの)
    while (scheduledBeats.length && scheduledBeats[0] < audioContext.currentTime - 1.0) {
        scheduledBeats.shift();
    }

    timerID = setTimeout(scheduler, lookahead);
}

function draw() {
    let drawNote = lastDrawnNote;
    const currentTime = audioContext ? audioContext.currentTime : 0;

    // 現在時刻を過ぎたノートをキューから取り出し、描画するノートを決定
    while (notesInQueue.length && notesInQueue[0].time < currentTime) {
        drawNote = notesInQueue[0].note;
        notesInQueue.splice(0, 1);
    }

    if (drawNote !== lastDrawnNote) {
        // ビートのタイミング
        beatCircle.classList.add('beat-active');
        if (drawNote === 0) {
            beatCircle.style.backgroundColor = '#ff4081'; // 1拍目
        } else {
            beatCircle.style.backgroundColor = '#1e88e5'; // それ以外
        }
        
        // 少し経ったら元に戻す
        setTimeout(() => {
            beatCircle.classList.remove('beat-active');
            beatCircle.style.backgroundColor = '#333';
        }, 100);

        lastDrawnNote = drawNote;
    }

    if (isPlaying) {
        drawReqId = requestAnimationFrame(draw);
    }
}

startBtn.addEventListener('click', () => {
    if (!isPlaying) {
        if (!audioContext) {
            // Web Audio APIの初期化
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // Autoplay Policy対策: Contextがsuspendedならresumeする
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        isPlaying = true;
        currentNote = 0;
        // 少し未来から開始することで安定させる
        nextNoteTime = audioContext.currentTime + 0.05;
        notesInQueue.length = 0;
        lastDrawnNote = -1;
        scheduler();
        drawReqId = requestAnimationFrame(draw);
        startBtn.textContent = 'Stop Metronome';
    } else {
        isPlaying = false;
        clearTimeout(timerID);
        cancelAnimationFrame(drawReqId);
        beatCircle.style.backgroundColor = '#333';
        startBtn.textContent = 'Start Metronome';
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // スペースキーによるスクロールを防止
        
        if (e.repeat) return; // 押しっぱなしによる連続発火を防止

        if (isPlaying && audioContext) {
            const hitTime = audioContext.currentTime;
            
            // 最も近いビート（ジャストタイミング）を探す
            let minDiff = Infinity;
            for (const beatTime of scheduledBeats) {
                const diff = hitTime - beatTime;
                if (Math.abs(diff) < Math.abs(minDiff)) {
                    minDiff = diff;
                }
            }

            if (minDiff === Infinity) return;

            // ズレをミリ秒に変換
            const diffMs = Math.round(minDiff * 1000);
            
            // サーバーへ打鍵情報を送信
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'hit', diffMs }));
            }
            
            // 判定結果の表示
            let judgment = '';
            hitResultEl.className = ''; // クラスをリセット
            
            if (Math.abs(diffMs) <= 30) {
                judgment = 'Perfect!';
                hitResultEl.classList.add('perfect');
            } else if (Math.abs(diffMs) <= 80) {
                judgment = diffMs < 0 ? 'Early' : 'Late';
                hitResultEl.classList.add('good');
            } else {
                judgment = diffMs < 0 ? 'Way Early' : 'Way Late';
                hitResultEl.classList.add('bad');
            }

            const sign = diffMs > 0 ? '+' : '';
            hitResultEl.textContent = `${judgment} (${sign}${diffMs} ms)`;
        }
    }
});
