const { app, BrowserWindow, ipcMain, clipboard, screen, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const koffi = require('koffi');

// --- NATIVE INTEROP (Windows) ---
const lib = koffi.load('user32.dll');
const GetAsyncKeyState = lib.func('short __stdcall GetAsyncKeyState(int)');
const SendInput = lib.func('uint __stdcall SendInput(uint, void *, int)');

// Virtual Key Codes
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;
const KEYEVENTF_KEYUP = 0x0002;
const INPUT_KEYBOARD = 1;
const INPUT_SIZE = 40;

// Build keyboard input buffer
function buildKeyboardInput(wVk, dwFlags) {
    const buf = Buffer.alloc(INPUT_SIZE);
    buf.writeUInt32LE(INPUT_KEYBOARD, 0);
    buf.writeUInt16LE(wVk, 8);
    buf.writeUInt16LE(0, 10);
    buf.writeUInt32LE(dwFlags, 12);
    buf.writeUInt32LE(0, 16);
    buf.writeBigUInt64LE(0n, 24);
    return buf;
}

// PRE-COMPILED paste buffer (zero allocation during paste)
const PASTE_BUFFER = Buffer.concat([
    buildKeyboardInput(VK_CONTROL, 0),
    buildKeyboardInput(VK_V, 0),
    buildKeyboardInput(VK_V, KEYEVENTF_KEYUP),
    buildKeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP)
]);

// --- CONFIGURATION ---
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const INPUT_SMOOTHING_MS = 30;
const MIN_DURATION_MS = 200;

// --- STATE ---
const STATE = { IDLE: 'IDLE', RECORDING: 'RECORDING', STOPPING: 'STOPPING', FINALIZING: 'FINALIZING' };
let currentState = STATE.IDLE;
let pcmBuffers = [];
let recordingStartTime = null;
let recorderWindow = null;
let ctrlDown = false;
let winDown = false;
let keyListenerInterval = null;
let stopTimer = null;
let indicatorWindow = null;
let firstRunShown = false;
let isPaused = false;
let tray = null;
let settingsWindow = null;
let asrProcess = null;
let lastReleaseTime = 0;
// --- SETTINGS ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
let settings = {
    hotkey: 'Ctrl+Win',
    paused: false,
    launchOnStartup: false,
    microphoneId: 'default'
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
            settings = { ...settings, ...data };
            isPaused = settings.paused;
        }
    } catch (e) { /* silent */ }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (e) { /* silent */ }
}

// --- STATE TRANSITIONS ---
function transition(newState) {
    if (currentState === newState) return;
    const allowed = {
        [STATE.IDLE]: [STATE.RECORDING],
        [STATE.RECORDING]: [STATE.STOPPING],
        [STATE.STOPPING]: [STATE.FINALIZING],
        [STATE.FINALIZING]: [STATE.IDLE]
    };
    if (!allowed[currentState]?.includes(newState)) return;
    currentState = newState;
}

// --- UTILITIES ---
function float32ToInt16(floatArray) {
    const buf = Buffer.allocUnsafe(floatArray.length * 2);
    for (let i = 0; i < floatArray.length; i++) {
        const s = Math.max(-1, Math.min(1, floatArray[i]));
        buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, i * 2);
    }
    return buf;
}

function generateWavHeader(dataLength) {
    const buffer = Buffer.alloc(44);
    const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
    const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(CHANNELS, 22);
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
}

// --- PASTE INJECTION (INSTANT) ---
function injectText(text) {
    if (isPaused) return;
    if (!text || !text.trim()) return;

    // FORCE UI CLEARANCE on paste to avoid overlapping
    hideIndicator(true);

    clipboard.writeText(text.trim());
    BrowserWindow.getAllWindows().forEach(w => { if (w.isFocused()) w.blur(); });
    if (process.platform === 'win32') {
        try { SendInput(4, PASTE_BUFFER, INPUT_SIZE); } catch (e) { /* silent */ }
    }
}

// --- PYTHON RESOLVER ---
function getPythonPath() {
    // 1. Check for environment variable override
    if (process.env.WISPR_PYTHON_PATH && fs.existsSync(process.env.WISPR_PYTHON_PATH)) {
        return process.env.WISPR_PYTHON_PATH;
    }

    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
    const commonPaths = [
        path.join(process.env.SystemDrive || 'C:', 'Python313', 'python.exe'),
        path.join(process.env.SystemDrive || 'C:', 'Python312', 'python.exe'),
        path.join(process.env.SystemDrive || 'C:', 'Python311', 'python.exe'),
        path.join(process.env.SystemDrive || 'C:', 'Python310', 'python.exe'),
        path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

// --- PERSISTENT ASR WORKER ---
function startASRWorker() {
    const pythonPath = getPythonPath();
    if (!pythonPath) {
        console.error('[ASR Worker] Python not found. Dictation will be disabled.');
        return;
    }

    const scriptPath = path.resolve(__dirname, 'transcribe_stream.py');
    console.log(`[ASR Worker] Starting with: ${pythonPath}`);

    try {
        asrProcess = spawn(pythonPath, [scriptPath], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        asrProcess.on('error', (err) => {
            console.error('[ASR Worker] Spawn error:', err);
            asrProcess = null;
        });

        asrProcess.stdout.on('data', (d) => {
            const lines = d.toString().split(/\r?\n/);
            for (const line of lines) {
                const text = line.trim();
                if (text === 'TRANSCRIBED_FINISH') {
                    continue;
                }
                if (text) {
                    if (lastReleaseTime > 0) {
                        const latency = performance.now() - lastReleaseTime;
                        console.log(`[LATENCY] Release to First Token: ${latency.toFixed(2)}ms`);
                        lastReleaseTime = 0;
                    }
                    injectText(text);
                }
            }
        });

        asrProcess.stderr.on('data', (d) => {
            console.error(`[ASR Worker stderr] ${d}`);
        });

        asrProcess.on('close', (code) => {
            console.warn(`[ASR Worker] Exited with code ${code}. Respawning in 2s...`);
            asrProcess = null;
            setTimeout(startASRWorker, 2000);
        });
    } catch (e) {
        console.error('[ASR Worker] Unexpected error during spawn:', e);
        asrProcess = null;
    }
}

function sendAudioToWorker(buffer) {
    if (!asrProcess || !asrProcess.stdin || asrProcess.killed) return;
    try {
        const header = Buffer.alloc(5);
        header.writeUInt8(0x02, 0); // Type: AUDIO
        header.writeUInt32LE(buffer.length, 1);
        asrProcess.stdin.write(header);
        asrProcess.stdin.write(buffer);
    } catch (e) {
        console.error('[ASR Worker] Error writing audio data:', e);
    }
}

function signalStartToWorker() {
    if (asrProcess && asrProcess.stdin && !asrProcess.killed) {
        try {
            const header = Buffer.alloc(1);
            header.writeUInt8(0x01, 0); // Type: START
            asrProcess.stdin.write(header);
        } catch (e) {
            console.error('[ASR Worker] Error signaling start:', e);
        }
    }
}

function signalEndToWorker() {
    if (asrProcess && asrProcess.stdin && !asrProcess.killed) {
        try {
            const header = Buffer.alloc(1);
            header.writeUInt8(0x03, 0); // Type: END
            asrProcess.stdin.write(header);
        } catch (e) {
            console.error('[ASR Worker] Error signaling end:', e);
        }
    }
}

// --- INPUT LOGIC ---
function checkInputState() {
    if (isPaused) return;
    const keysHeld = ctrlDown && winDown;
    if (keysHeld) {
        if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
        if (currentState === STATE.IDLE) startRecording();
    } else {
        if (currentState === STATE.RECORDING && !stopTimer) {
            stopTimer = setTimeout(() => { stopRecording(); stopTimer = null; }, INPUT_SMOOTHING_MS);
        }
    }
}

function startRecording() {
    pcmBuffers = [];
    recordingStartTime = Date.now();
    transition(STATE.RECORDING);
    showIndicator();
    signalStartToWorker();
    if (recorderWindow) recorderWindow.webContents.send('start-capture');
}

function stopRecording() {
    lastReleaseTime = performance.now();
    hideIndicator();
    transition(STATE.STOPPING);
    if (recorderWindow) recorderWindow.webContents.send('stop-capture');
    signalEndToWorker();
    finalizeRecording();
}

function finalizeRecording() {
    transition(STATE.FINALIZING);
    // No longer writing WAV or spawning here.
    // Persistent worker handles it.
    resetToIdle();
}

function resetToIdle() {
    pcmBuffers = [];
    recordingStartTime = null;
    transition(STATE.IDLE);
}

// --- IPC ---
ipcMain.on('audio-data', (e, data) => {
    if (currentState === STATE.RECORDING) {
        const pcm = float32ToInt16(data);
        sendAudioToWorker(pcm);
    }
});
ipcMain.on('capture-error', () => {
    if (currentState !== STATE.IDLE) resetToIdle();
});

// --- NATIVE KEY LISTENER ---
function startKeyListener() {
    keyListenerInterval = setInterval(() => {
        ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) !== 0;
        winDown = ((GetAsyncKeyState(VK_LWIN) & 0x8000) !== 0) || ((GetAsyncKeyState(VK_RWIN) & 0x8000) !== 0);
        checkInputState();
    }, 20);
}

// --- INDICATOR WINDOW ---
function createIndicatorWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    indicatorWindow = new BrowserWindow({
        width: 140,
        height: 60,
        x: width - 160,
        y: height - 80,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        movable: false,
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    indicatorWindow.loadFile('indicator.html');
    indicatorWindow.setIgnoreMouseEvents(true);
}

function showIndicator() {
    if (indicatorWindow) {
        indicatorWindow.webContents.send('set-state', 'listening');
        if (!indicatorWindow.isVisible()) indicatorWindow.showInactive();

        if (!firstRunShown) {
            firstRunShown = true;
            indicatorWindow.webContents.send('show-hint');
            try { fs.writeFileSync(path.join(app.getPath('userData'), '.firstrun'), '1'); } catch (e) { }
        }
    }
}

function hideIndicator(immediate = false) {
    if (!indicatorWindow || !indicatorWindow.isVisible()) return;

    if (immediate) {
        indicatorWindow.hide();
        return;
    }

    // LATENCY MASKING:
    // 1. Instantly stop pulsing (intent acknowledgement)
    indicatorWindow.webContents.send('set-state', 'stopping');

    // 2. Start fade-out after a split second (masking STT gap)
    setTimeout(() => {
        if (indicatorWindow && indicatorWindow.isVisible()) {
            indicatorWindow.webContents.send('fade-out');
            // 3. Actually hide after fade completes
            setTimeout(() => {
                if (indicatorWindow) indicatorWindow.hide();
            }, 120);
        }
    }, 150);
}

// --- TRAY ---
function createTray() {
    const iconPath = path.join(__dirname, 'tray_icon.png');
    tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, 'indicator.html'));
    updateTrayMenu();
}

function updateTrayMenu() {
    const contextMenu = Menu.buildFromTemplate([
        { label: `Wispr Flow ${isPaused ? '(Paused)' : ''}`, enabled: false },
        { type: 'separator' },
        {
            label: isPaused ? 'Resume Dictation' : 'Pause Dictation',
            click: () => {
                isPaused = !isPaused;
                settings.paused = isPaused;
                saveSettings();
                updateTrayMenu();
            }
        },
        { label: 'Settings...', click: () => openSettings() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('Wispr Flow');
}

// --- SETTINGS WINDOW ---
function openSettings() {
    if (settingsWindow) {
        settingsWindow.show();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 350,
        height: 450,
        title: 'Wispr Flow Settings',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile('settings.html');
    settingsWindow.on('closed', () => settingsWindow = null);
}

// --- INIT ---
function createRecorderWindow() {
    recorderWindow = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    recorderWindow.loadFile('recorder.html');
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.whenReady().then(() => {
        loadSettings();
        // Check first-run state
        try {
            fs.accessSync(path.join(app.getPath('userData'), '.firstrun'));
            firstRunShown = true;
        } catch (e) { firstRunShown = false; }

        createRecorderWindow();
        createIndicatorWindow();
        createTray();
        startASRWorker();
        startKeyListener();
    });
}

app.on('will-quit', () => {
    if (keyListenerInterval) clearInterval(keyListenerInterval);
    if (tray) tray.destroy();
});
