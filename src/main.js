import './style.css';
import { AudioEngine } from './audio.js';
import { GeminiLiveClient } from './gemini-live.js';

// Safe Tauri API imports with browser fallback
let invoke = null;
let listen = null;
let getCurrentWindow = null;

async function initTauri() {
  try {
    const core = await import('@tauri-apps/api/core');
    const event = await import('@tauri-apps/api/event');
    const windowApi = await import('@tauri-apps/api/window');
    invoke = core.invoke;
    listen = event.listen;
    getCurrentWindow = windowApi.getCurrentWindow;
  } catch (e) {
    console.info('Running in webview/browser mode without full Tauri runtime:', e);
  }
}

// State & LocalStorage
const STORAGE_KEY = 'voicetype_settings_v1';
const HISTORY_KEY = 'voicetype_history_v1';
const DEFAULT_API_KEY = '';

const defaultSettings = {
  apiKey: DEFAULT_API_KEY,
  model: 'gemini-3.5-transcribe-live',
  mode: 'SMART', // 'SMART' or 'VERBATIM'
  typingMethod: 'paste', // 'paste', 'typewriter', 'copy'
  addTrailingSpace: true,
  soundFeedback: true,
  languageCode: 'auto',
  customVocabulary: 'Gemini, Tauri, Rust, TypeScript, API, AI',
  voiceHotkey: 'Ctrl+Alt+V',
  visibilityHotkey: 'Ctrl+Alt+H',
  typeAtMousePointer: true,
  isMiniMode: false,
};

let settings = { ...defaultSettings };
let history = [];
let totalWordsTyped = 0;
let isListening = false;
let isDrawerOpen = false;
let isInterimVisible = false;
let currentAppTitle = 'Active Window';

// Audio and Gemini instances
const audio = new AudioEngine();
const gemini = new GeminiLiveClient({ apiKey: DEFAULT_API_KEY });

// Load stored settings and history
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      settings = { ...defaultSettings, ...JSON.parse(saved) };
      if (!settings.apiKey) {
        settings.apiKey = DEFAULT_API_KEY;
      }
      if (!settings.voiceHotkey) {
        settings.voiceHotkey = settings.hotkey || 'Ctrl+Alt+V';
      }
      if (!settings.visibilityHotkey) {
        settings.visibilityHotkey = 'Ctrl+Alt+H';
      }
      if (settings.typeAtMousePointer === undefined) {
        settings.typeAtMousePointer = true;
      }
    } else {
      settings.apiKey = DEFAULT_API_KEY;
    }
    const savedHistory = localStorage.getItem(HISTORY_KEY);
    if (savedHistory) {
      history = JSON.parse(savedHistory);
    }
  } catch (e) {
    console.warn('Failed to load state:', e);
    settings.apiKey = DEFAULT_API_KEY;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch (e) {
    console.warn('Failed to save history:', e);
  }
}

// Window sizing coordinator
async function updateWindowDimensions() {
  if (!invoke) return;

  try {
    if (settings.isMiniMode) {
      await invoke('resize_overlay', { width: 68, height: 68 });
    } else if (isDrawerOpen) {
      await invoke('resize_overlay', { width: 382, height: 560 });
    } else if (isInterimVisible) {
      await invoke('resize_overlay', { width: 382, height: 168 });
    } else {
      await invoke('resize_overlay', { width: 382, height: 76 });
    }
  } catch (e) {
    console.warn('Failed to resize overlay:', e);
  }
}

// High-performance On-Demand Waveform Visualizer (Zero idle CPU)
let animFrameId = null;
let visualizerCtx = null;
let visualizerCanvas = null;
const visualizerBufferLength = 32;
const visualizerDataArray = new Uint8Array(visualizerBufferLength);

function initWaveformVisualizer() {
  visualizerCanvas = document.getElementById('waveform-canvas');
  if (!visualizerCanvas) return;
  visualizerCtx = visualizerCanvas.getContext('2d', { alpha: true });
  drawIdleWaveform();
}

function drawIdleWaveform() {
  if (!visualizerCanvas || !visualizerCtx) return;
  const width = visualizerCanvas.width;
  const height = visualizerCanvas.height;
  visualizerCtx.clearRect(0, 0, width, height);

  // Single static subtle elegant glowing line (0% CPU cost when idle)
  visualizerCtx.beginPath();
  const gradient = visualizerCtx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
  gradient.addColorStop(0.5, 'rgba(6, 182, 212, 0.45)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.12)');
  visualizerCtx.strokeStyle = gradient;
  visualizerCtx.lineWidth = 1.5;
  visualizerCtx.lineCap = 'round';

  const centerY = height / 2;
  visualizerCtx.moveTo(6, centerY);
  visualizerCtx.bezierCurveTo(width * 0.35, centerY - 2.5, width * 0.65, centerY + 2.5, width - 6, centerY);
  visualizerCtx.stroke();
}

function startVisualizer() {
  if (!visualizerCanvas || !visualizerCtx || animFrameId) return;

  function loop() {
    if (!isListening || document.visibilityState === 'hidden') {
      drawIdleWaveform();
      animFrameId = null;
      return;
    }

    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    visualizerCtx.clearRect(0, 0, width, height);

    if (audio.getFrequencyData(visualizerDataArray)) {
      const barWidth = 4;
      const barGap = 3;
      const totalBars = 7;
      const startX = (width - (totalBars * barWidth + (totalBars - 1) * barGap)) / 2;

      for (let i = 0; i < totalBars; i++) {
        const val = visualizerDataArray[i * 3] || 0;
        const normalized = val / 255;
        const barHeight = Math.max(3, normalized * height * 0.9);
        const x = startX + i * (barWidth + barGap);
        const y = (height - barHeight) / 2;

        const gradient = visualizerCtx.createLinearGradient(0, y, 0, y + barHeight);
        gradient.addColorStop(0, '#10b981');
        gradient.addColorStop(0.6, '#06b6d4');
        gradient.addColorStop(1, '#6366f1');

        visualizerCtx.fillStyle = gradient;
        visualizerCtx.beginPath();
        visualizerCtx.roundRect(x, y, barWidth, barHeight, 2);
        visualizerCtx.fill();
      }
    }

    animFrameId = requestAnimationFrame(loop);
  }

  animFrameId = requestAnimationFrame(loop);
}

function stopVisualizer() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  drawIdleWaveform();
}

// Active target application poller (Adaptive / Zero idle cost)
let pollerIntervalId = null;

async function pollActiveWindow() {
  if (!invoke || document.visibilityState === 'hidden') return;
  try {
    const title = await invoke('get_active_window_info');
    if (title && title !== 'VoiceType') {
      currentAppTitle = title;
      const badgeText = document.querySelector('#target-badge .target-text');
      const badge = document.getElementById('target-badge');
      const diagBadge = document.getElementById('diag-target-app');
      if (badgeText) {
        badgeText.textContent = title;
      }
      if (badge) {
        badge.title = `Current typing target: ${title}`;
      }
      if (diagBadge) {
        diagBadge.textContent = title;
      }
    }
  } catch (e) {
    // Ignore polling errors
  }
}

function startPoller() {
  if (pollerIntervalId) return;
  pollActiveWindow();
  pollerIntervalId = setInterval(pollActiveWindow, 2800);
}

function stopPoller() {
  if (pollerIntervalId) {
    clearInterval(pollerIntervalId);
    pollerIntervalId = null;
  }
}

// Toggle Dictation Listening
async function toggleListening() {
  if (isListening) {
    await stopListening();
  } else {
    await startListening();
  }
}

async function startListening() {
  if (isListening) return;

  const activeKey = (settings.apiKey && settings.apiKey.trim()) ? settings.apiKey.trim() : DEFAULT_API_KEY;

  const micBoard = document.getElementById('mic-board');
  const interimBubble = document.getElementById('interim-bubble');
  const interimTitle = document.getElementById('interim-status-title');
  const interimText = document.querySelector('#interim-text .text-content');

  if (!activeKey) {
    openDrawer('settings');
    updateDiagStatus('NO API KEY');
    if (interimTitle) interimTitle.textContent = 'API Key Required';
    if (interimText) interimText.textContent = 'Please enter your Gemini API Key in Settings drawer.';
    if (interimBubble) interimBubble.classList.add('visible');
    setTimeout(() => {
      if (!isListening && interimBubble) interimBubble.classList.remove('visible');
    }, 4000);
    return;
  }

  try {
    micBoard.classList.remove('listening', 'typing', 'error');
    micBoard.classList.add('connecting');
    updateDiagStatus('CONNECTING');

    // Configure Gemini Live Client
    const vocabList = settings.customVocabulary
      ? settings.customVocabulary.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    gemini.updateConfig({
      apiKey: activeKey,
      model: settings.model,
      mode: settings.mode,
      languageCode: settings.languageCode,
      customVocabulary: vocabList,
    });

    // 1. Connect WebSocket
    try {
      await gemini.connect();
    } catch (wsErr) {
      throw new Error(`Live WS: ${wsErr.message || wsErr}`);
    }

    // 2. Start Audio Microphone
    try {
      await audio.start();
    } catch (audioErr) {
      throw new Error(`Mic: ${audioErr.message || audioErr}`);
    }

    if (settings.soundFeedback) {
      audio.playChime('start');
    }

    isListening = true;
    micBoard.classList.remove('connecting');
    micBoard.classList.add('listening');
    updateDiagStatus('LISTENING');
    startVisualizer();

    // Wire audio chunks to Gemini WebSocket
    audio.onAudioChunk = (base64Chunk) => {
      gemini.sendAudioChunk(base64Chunk);
    };

    // Wire Hybrid VAD silence notification
    audio.onSilenceDetected = () => {
      gemini.sendAudioStreamEnd();
    };

    // Prepare Interim Bubble
    if (interimBubble && interimText && interimTitle) {
      interimText.textContent = '';
      interimTitle.textContent = 'Listening...';
      interimBubble.classList.remove('finalized');
      interimBubble.classList.add('show');
      isInterimVisible = true;
      updateWindowDimensions();
    }
  } catch (err) {
    console.error('Failed to start dictation:', err);
    micBoard.classList.remove('connecting', 'listening');
    micBoard.classList.add('error');
    const msg = err.message || String(err);
    updateDiagStatus(`ERR: ${msg.substring(0, 24)}`);
    if (interimTitle) {
      interimTitle.textContent = msg;
      if (interimBubble) {
        interimBubble.classList.add('show');
        isInterimVisible = true;
        updateWindowDimensions();
      }
    }
    setTimeout(() => {
      micBoard.classList.remove('error');
      if (!isListening && interimBubble) {
        interimBubble.classList.remove('show');
        isInterimVisible = false;
        updateWindowDimensions();
      }
    }, 4000);
    audio.stop();
    gemini.disconnect();
    isListening = false;
  }
}

async function stopListening() {
  if (!isListening) return;

  const micBoard = document.getElementById('mic-board');
  micBoard.classList.remove('listening', 'connecting');
  updateDiagStatus('FINALIZING');

  if (settings.soundFeedback) {
    audio.playChime('stop');
  }

  // Signal audio stream end for Hybrid VAD
  gemini.sendAudioStreamEnd();
  audio.stop();
  stopVisualizer();

  setTimeout(() => {
    gemini.disconnect();
    isListening = false;
    updateDiagStatus('IDLE');
  }, 400);

  // Auto-hide interim bubble after a moment if not finalized
  setTimeout(() => {
    if (!isListening) {
      const bubble = document.getElementById('interim-bubble');
      if (bubble) bubble.classList.remove('show', 'finalized');
      isInterimVisible = false;
      updateWindowDimensions();
    }
  }, 2200);
}

// Handle Interim Hypothesis (Streaming partial)
function handleInterim(text) {
  const interimText = document.querySelector('#interim-text .text-content');
  const wordCount = document.getElementById('interim-word-count');
  if (interimText) {
    interimText.textContent = text;
  }
  if (wordCount) {
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    wordCount.textContent = `${count} words`;
  }
}

// Handle Finalized Transcript (Commit to active target window)
async function handleFinal(text) {
  if (!text || !text.trim()) return;

  const micBoard = document.getElementById('mic-board');
  const interimBubble = document.getElementById('interim-bubble');
  const interimTitle = document.getElementById('interim-status-title');
  const interimText = document.querySelector('#interim-text .text-content');

  // Flash UI state
  micBoard.classList.remove('listening');
  micBoard.classList.add('typing');
  if (interimBubble) {
    interimBubble.classList.add('finalized');
  }
  if (interimTitle) {
    interimTitle.textContent = '⚡ Typed into active window!';
  }
  if (interimText) {
    interimText.textContent = text;
  }

  if (settings.soundFeedback) {
    audio.playChime('typed');
  }

  // 1. Inject / Type text into target application anywhere on PC!
  if (invoke) {
    try {
      await invoke('type_text', {
        text: text,
        method: settings.typingMethod,
        addSpace: settings.addTrailingSpace,
        typeAtMouse: settings.typeAtMousePointer !== false,
      });
    } catch (e) {
      console.error('Failed to type text via Tauri:', e);
    }
  } else {
    // Web fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {}
  }

  // 2. Add to History
  const words = text.trim().split(/\s+/).length;
  totalWordsTyped += words;
  const historyEntry = {
    id: Date.now(),
    text,
    words,
    mode: settings.mode,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  history.unshift(historyEntry);
  saveHistory();
  renderHistory();
  updateDiagWordCount();

  // Reset typing state
  setTimeout(() => {
    micBoard.classList.remove('typing');
    if (isListening) {
      micBoard.classList.add('listening');
      if (interimTitle) interimTitle.textContent = 'Listening...';
      if (interimBubble) interimBubble.classList.remove('finalized');
    }
  }, 800);

  // Auto-hide interim bubble after typing confirmation
  setTimeout(() => {
    if (!isListening) {
      if (interimBubble) interimBubble.classList.remove('show', 'finalized');
      isInterimVisible = false;
      updateWindowDimensions();
    }
  }, 1800);
}

// Drawer Management
function toggleDrawer() {
  isDrawerOpen = !isDrawerOpen;
  const drawer = document.getElementById('drawer-panel');
  const toggleBtn = document.getElementById('drawer-toggle-btn');
  if (isDrawerOpen) {
    drawer.classList.add('show');
    toggleBtn.classList.add('active');
  } else {
    drawer.classList.remove('show');
    toggleBtn.classList.remove('active');
  }
  updateWindowDimensions();
}

function openDrawer(tabId = 'tab-settings') {
  isDrawerOpen = true;
  const drawer = document.getElementById('drawer-panel');
  const toggleBtn = document.getElementById('drawer-toggle-btn');
  drawer.classList.add('show');
  toggleBtn.classList.add('active');
  switchTab(tabId);
  updateWindowDimensions();
}

function switchTab(tabId) {
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId);
  });
}

// Mini Mode
function toggleMiniMode() {
  settings.isMiniMode = !settings.isMiniMode;
  document.body.classList.toggle('mini-mode', settings.isMiniMode);
  saveSettings();
  updateWindowDimensions();
}

// Diagnostics updater
function updateDiagStatus(status) {
  const el = document.getElementById('diag-status');
  if (el) {
    el.textContent = status;
    if (status === 'LISTENING') el.style.color = 'var(--emerald)';
    else if (status === 'CONNECTING') el.style.color = 'var(--amber)';
    else if (status === 'ERROR') el.style.color = 'var(--rose)';
    else el.style.color = 'var(--text-muted)';
  }
}

function updateDiagWordCount() {
  const el = document.getElementById('diag-word-count');
  if (el) el.textContent = `${totalWordsTyped} words`;
}

// Render History
function renderHistory() {
  const container = document.getElementById('history-container');
  if (!container) return;

  if (history.length === 0) {
    container.innerHTML = `
      <div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 20px 0;">
        No transcriptions yet. Click mic or press hotkey to speak!
      </div>
    `;
    return;
  }

  container.innerHTML = history.map(item => `
    <div class="history-item">
      <div class="history-meta">
        <span>${item.timestamp} • <strong style="color: #a5b4fc;">${item.mode}</strong></span>
        <span>${item.words} words</span>
      </div>
      <div class="history-text">${escapeHtml(item.text)}</div>
      <div class="history-actions">
        <button class="mini-btn btn-copy" data-text="${escapeAttr(item.text)}">Copy</button>
        <button class="mini-btn btn-retype" data-text="${escapeAttr(item.text)}" style="color: var(--primary);">Re-type</button>
      </div>
    </div>
  `).join('');

  // Wire history button clicks
  container.querySelectorAll('.btn-copy').forEach(btn => {
    btn.onclick = async () => {
      const text = btn.dataset.text;
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    };
  });

  container.querySelectorAll('.btn-retype').forEach(btn => {
    btn.onclick = async () => {
      const text = btn.dataset.text;
      if (invoke) {
        await invoke('type_text', {
          text: text,
          method: settings.typingMethod,
          addSpace: settings.addTrailingSpace,
          typeAtMouse: settings.typeAtMousePointer !== false,
        });
      }
      btn.textContent = 'Typed!';
      setTimeout(() => { btn.textContent = 'Re-type'; }, 1200);
    };
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;');
}

// Initialize Application UI
async function initApp() {
  await initTauri();
  loadState();
  // Setup overlay window
  if (invoke) {
    try {
      await invoke('setup_overlay_window');
      // Restore saved window position across desktop
      const savedPos = localStorage.getItem('voicetype_window_pos');
      if (savedPos) {
        const { x, y } = JSON.parse(savedPos);
        await invoke('set_window_pos', { x, y });
      }
    } catch (e) {
      console.warn('setup_overlay_window failed:', e);
    }
  }

  // Explicit window drag handlers on drag grip and board
  const dragGrip = document.querySelector('.drag-grip');
  const micBoard = document.getElementById('mic-board');
  let lastDragTime = 0;

  async function onDragPointerDown(e) {
    if (e.button !== 0) return; // Left click only
    if (Date.now() - lastDragTime < 250) return;
    
    // Do not initiate drag if user clicked an interactive control or inside drawer
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || 
        e.target.closest('.mode-badge') || e.target.closest('#drawer-panel')) {
      return;
    }

    lastDragTime = Date.now();

    if (getCurrentWindow) {
      try {
        const win = getCurrentWindow();
        await win.startDragging();
        setTimeout(async () => {
          try {
            if (invoke) {
              const [x, y] = await invoke('get_window_pos');
              if (x !== undefined && y !== undefined) {
                localStorage.setItem('voicetype_window_pos', JSON.stringify({ x, y }));
              }
            }
          } catch (e) {}
        }, 1200);
        return;
      } catch (err) {
        console.warn('getCurrentWindow startDragging error:', err);
      }
    }

    if (invoke) {
      try {
        await invoke('start_dragging');
        setTimeout(async () => {
          try {
            const [x, y] = await invoke('get_window_pos');
            if (x !== undefined && y !== undefined) {
              localStorage.setItem('voicetype_window_pos', JSON.stringify({ x, y }));
            }
          } catch (e) {}
        }, 1200);
      } catch (err) {
        console.warn('invoke start_dragging error:', err);
      }
    }
  }

  ['mousedown', 'pointerdown'].forEach(evtName => {
    if (dragGrip) dragGrip.addEventListener(evtName, onDragPointerDown);
    if (micBoard) micBoard.addEventListener(evtName, onDragPointerDown);
  });

  // Register Global Hotkey listeners from Tauri
  if (listen) {
    listen('toggle-voice-hotkey', () => {
      toggleListening();
    });
    listen('toggle-visibility-hotkey', () => {
      if (settings.soundFeedback) {
        audio.playChime('start');
      }
    });
  }

  // Wire Gemini Live callbacks
  gemini.onInterim = handleInterim;
  gemini.onFinal = handleFinal;
  gemini.onStateChange = (state) => {
    if (state === 'ready') {
      const el = document.getElementById('diag-latency');
      if (el) el.textContent = `${gemini.latencyMs} ms`;
    }
  };
  gemini.onError = (err) => {
    console.error('Gemini error:', err);
    updateDiagStatus(`ERR: ${err.substring(0, 20)}`);
  };

  // Populate UI inputs from settings
  const inputKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const selectMode = document.getElementById('select-mode');
  const modeBadge = document.getElementById('mode-badge');
  const selectTypingMethod = document.getElementById('select-typing-method');
  const checkTrailingSpace = document.getElementById('check-trailing-space');
  const checkSoundFeedback = document.getElementById('check-sound-feedback');
  const selectLanguage = document.getElementById('select-language');
  const inputVocab = document.getElementById('input-custom-vocab');
  const inputHotkey = document.getElementById('input-hotkey');
  const btnSaveHotkey = document.getElementById('btn-save-hotkey');
  const btnClearHistory = document.getElementById('btn-clear-history');

  if (inputKey) {
    inputKey.value = settings.apiKey;
    inputKey.onchange = () => {
      settings.apiKey = inputKey.value.trim();
      saveSettings();
    };
  }

  if (btnToggleKey && inputKey) {
    btnToggleKey.onclick = () => {
      inputKey.type = inputKey.type === 'password' ? 'text' : 'password';
    };
  }

  function updateModeUI() {
    const modeBadge = document.getElementById('mode-badge');
    const modeText = document.querySelector('#mode-badge .mode-text');
    if (modeText) {
      modeText.textContent = settings.mode;
    } else if (modeBadge) {
      modeBadge.textContent = settings.mode;
    }
    if (modeBadge) {
      modeBadge.classList.toggle('verbatim', settings.mode === 'VERBATIM');
    }
  }

  if (selectMode && modeBadge) {
    selectMode.value = settings.mode;
    updateModeUI();

    selectMode.onchange = () => {
      settings.mode = selectMode.value;
      updateModeUI();
      saveSettings();
    };

    // Clicking mode badge directly on mic board toggles mode
    modeBadge.onclick = () => {
      settings.mode = settings.mode === 'SMART' ? 'VERBATIM' : 'SMART';
      selectMode.value = settings.mode;
      updateModeUI();
      saveSettings();
    };
  }

  if (selectTypingMethod) {
    selectTypingMethod.value = settings.typingMethod;
    selectTypingMethod.onchange = () => {
      settings.typingMethod = selectTypingMethod.value;
      saveSettings();
    };
  }

  if (checkTrailingSpace) {
    checkTrailingSpace.checked = settings.addTrailingSpace;
    checkTrailingSpace.onchange = () => {
      settings.addTrailingSpace = checkTrailingSpace.checked;
      saveSettings();
    };
  }

  if (checkSoundFeedback) {
    checkSoundFeedback.checked = settings.soundFeedback;
    checkSoundFeedback.onchange = () => {
      settings.soundFeedback = checkSoundFeedback.checked;
      saveSettings();
    };
  }

  if (selectLanguage) {
    selectLanguage.value = settings.languageCode;
    selectLanguage.onchange = () => {
      settings.languageCode = selectLanguage.value;
      saveSettings();
    };
  }

  if (inputVocab) {
    inputVocab.value = settings.customVocabulary;
    inputVocab.onchange = () => {
      settings.customVocabulary = inputVocab.value;
      saveSettings();
    };
  }

  // Setup Hotkey Inputs & Type-at-Mouse toggle
  const checkTypeAtMouse = document.getElementById('check-type-at-mouse');
  const inputVoiceHotkey = document.getElementById('input-voice-hotkey');
  const inputVisHotkey = document.getElementById('input-vis-hotkey');
  const btnSaveAllHotkeys = document.getElementById('btn-save-all-hotkeys');
  const hotkeyStatusMsg = document.getElementById('hotkey-status-msg');

  if (checkTypeAtMouse) {
    checkTypeAtMouse.checked = settings.typeAtMousePointer !== false;
    checkTypeAtMouse.onchange = () => {
      settings.typeAtMousePointer = checkTypeAtMouse.checked;
      saveSettings();
    };
  }

  if (inputVoiceHotkey) {
    inputVoiceHotkey.value = settings.voiceHotkey || 'Ctrl+Alt+V';
  }

  if (inputVisHotkey) {
    inputVisHotkey.value = settings.visibilityHotkey || 'Ctrl+Alt+H';
  }

  // Quick preset chips
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.onclick = () => {
      const target = chip.dataset.target;
      const val = chip.dataset.val;
      if (target === 'voice' && inputVoiceHotkey) {
        inputVoiceHotkey.value = val;
      } else if (target === 'vis' && inputVisHotkey) {
        inputVisHotkey.value = val;
      }
    };
  });

  // Interactive keyboard hotkey recorder
  function setupHotkeyRecorder(btnId, inputId) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;

    let isRecording = false;

    function onKeyDown(e) {
      e.preventDefault();
      e.stopPropagation();

      // Skip lone modifier keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        return;
      }

      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Super');

      let key = e.key.toUpperCase();
      if (key === ' ') key = 'Space';
      if (key.length === 1) key = key.toUpperCase();
      parts.push(key);

      const combo = parts.join('+');
      input.value = combo;
      stopRecording();
    }

    function stopRecording() {
      isRecording = false;
      btn.classList.remove('recording-pulse');
      btn.textContent = '🔴 Record';
      window.removeEventListener('keydown', onKeyDown, true);
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      if (isRecording) {
        stopRecording();
      } else {
        isRecording = true;
        btn.classList.add('recording-pulse');
        btn.textContent = '⌨ Press keys...';
        window.addEventListener('keydown', onKeyDown, true);
      }
    };
  }

  setupHotkeyRecorder('btn-record-voice', 'input-voice-hotkey');
  setupHotkeyRecorder('btn-record-vis', 'input-vis-hotkey');

  if (btnSaveAllHotkeys && inputVoiceHotkey && inputVisHotkey && invoke) {
    btnSaveAllHotkeys.onclick = async () => {
      const vHotkey = inputVoiceHotkey.value.trim() || 'Ctrl+Alt+V';
      const visHotkey = inputVisHotkey.value.trim() || 'Ctrl+Alt+H';
      try {
        await invoke('update_hotkeys', {
          voiceHotkeyStr: vHotkey,
          visibilityHotkeyStr: visHotkey,
        });
        settings.voiceHotkey = vHotkey;
        settings.visibilityHotkey = visHotkey;
        saveSettings();

        if (hotkeyStatusMsg) {
          hotkeyStatusMsg.textContent = '✅ Hotkeys successfully applied & active!';
          hotkeyStatusMsg.style.display = 'block';
          hotkeyStatusMsg.style.color = 'var(--emerald)';
          setTimeout(() => { hotkeyStatusMsg.style.display = 'none'; }, 3000);
        }
      } catch (err) {
        if (hotkeyStatusMsg) {
          hotkeyStatusMsg.textContent = `❌ ${err}`;
          hotkeyStatusMsg.style.display = 'block';
          hotkeyStatusMsg.style.color = 'var(--rose)';
        }
      }
    };
  }

  // Close / Hide Overlay Button
  const closeBtn = document.getElementById('close-overlay-btn');
  if (closeBtn && invoke) {
    closeBtn.onclick = async () => {
      await invoke('hide_overlay');
    };
  }

  // Escape key hides overlay to background
  window.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' && !isListening) {
      if (invoke) {
        await invoke('hide_overlay');
      }
    }
  });

  if (btnClearHistory) {
    btnClearHistory.onclick = () => {
      history = [];
      saveHistory();
      renderHistory();
    };
  }

  // Mic Button Click
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) {
    micBtn.onclick = () => {
      toggleListening();
    };
  }

  // Drawer Toggle
  const drawerToggleBtn = document.getElementById('drawer-toggle-btn');
  if (drawerToggleBtn) {
    drawerToggleBtn.onclick = () => {
      toggleDrawer();
    };
  }

  // Mini Mode Toggle
  const miniToggleBtn = document.getElementById('mini-toggle-btn');
  const miniPillBtn = document.getElementById('mini-pill-btn');
  if (miniToggleBtn) {
    miniToggleBtn.onclick = toggleMiniMode;
  }
  if (miniPillBtn) {
    miniPillBtn.onclick = toggleMiniMode;
  }

  // Drawer Tab Switching
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.onclick = () => {
      switchTab(tab.dataset.tab);
    };
  });

  // Restore mini mode class if enabled
  if (settings.isMiniMode) {
    document.body.classList.add('mini-mode');
  }

  // Waveform canvas
  initWaveformVisualizer();

  // Start adaptive polling for active window
  startPoller();

  // Suspend visualizer and poller when window is hidden to save 100% CPU
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPoller();
      stopVisualizer();
    } else {
      startPoller();
      if (isListening) startVisualizer();
    }
  });

  // Initial window resize
  updateWindowDimensions();
}

// Start application
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
