const startBtn = document.getElementById('start-btn');

let audioContext;
let isPlaying = false;
let currentNote = 0;
let nextNoteTime = 0.0; // 次の音が鳴るべき時間
const lookahead = 25.0; // スケジューリング関数を呼び出す頻度 (ミリ秒)
const scheduleAheadTime = 0.1; // どのくらい先までスケジュールするか (秒)
const bpm = 120.0;
let timerID;

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
        playClick(nextNoteTime);
        nextNote();
    }
    timerID = setTimeout(scheduler, lookahead);
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
        scheduler();
        startBtn.textContent = 'Stop Metronome';
    } else {
        isPlaying = false;
        clearTimeout(timerID);
        startBtn.textContent = 'Start Metronome';
    }
});
