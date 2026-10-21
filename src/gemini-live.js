// Gemini 3.5 Transcribe Live WebSocket Client
// Implements real-time bidirectional streaming speech-to-text with interim hypotheses,
// finalized transcripts, smart formatting, custom vocabulary biasing, and Hybrid VAD.

export class GeminiLiveClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'gemini-3.5-transcribe-live';
    this.mode = options.mode || 'SMART'; // 'SMART' or 'VERBATIM'
    this.languageCode = options.languageCode || '';
    this.customVocabulary = options.customVocabulary || [];

    this.ws = null;
    this.isConnected = false;
    this.isSessionReady = false;
    this.connectionStartTime = 0;
    this.latencyMs = 0;

    // Callbacks
    this.onInterim = null; // (text) => {}
    this.onFinal = null;   // (text) => {}
    this.onStateChange = null; // (state: 'disconnected'|'connecting'|'ready'|'error') => {}
    this.onError = null;   // (errMessage) => {}
  }

  updateConfig({ apiKey, model, mode, languageCode, customVocabulary }) {
    if (apiKey !== undefined) this.apiKey = apiKey;
    if (model !== undefined) this.model = model;
    if (mode !== undefined) this.mode = mode;
    if (languageCode !== undefined) this.languageCode = languageCode;
    if (customVocabulary !== undefined) this.customVocabulary = customVocabulary;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) {
        const err = 'Gemini API Key is required. Please set it in Settings.';
        if (this.onError) this.onError(err);
        return reject(new Error(err));
      }

      this.disconnect();
      if (this.onStateChange) this.onStateChange('connecting');
      this.connectionStartTime = Date.now();

      const key = (this.apiKey || '').trim();
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;

      let connectionTimer = null;

      try {
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';
      } catch (err) {
        if (this.onStateChange) this.onStateChange('error');
        if (this.onError) this.onError(err.message || 'Failed to initialize WebSocket');
        return reject(err);
      }

      // 10s connection timeout guard
      connectionTimer = setTimeout(() => {
        if (!this.isSessionReady) {
          const timeoutErr = new Error('Gemini Live WS connection timed out (no setupComplete)');
          this.disconnect();
          if (this.onStateChange) this.onStateChange('error');
          if (this.onError) this.onError('Connection timed out. Check network or API key.');
          reject(timeoutErr);
        }
      }, 10000);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.latencyMs = Date.now() - this.connectionStartTime;

        // Build setup configuration for gemini-3.5-transcribe-live
        const inputTranscriptionConfig = {
          mode: this.mode === 'VERBATIM' ? 'VERBATIM' : 'SMART'
        };

        if (this.languageCode && this.languageCode !== 'auto') {
          inputTranscriptionConfig.languageCodes = [this.languageCode];
        }

        if (Array.isArray(this.customVocabulary) && this.customVocabulary.length > 0) {
          inputTranscriptionConfig.customVocabulary = this.customVocabulary.filter(w => w.trim().length > 0);
        }

        const setupMessage = {
          setup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: ['TEXT']
            },
            inputAudioTranscription: inputTranscriptionConfig
          }
        };

        this.send(setupMessage);
      };

      this.ws.onmessage = async (event) => {
        try {
          let rawText = '';
          if (typeof event.data === 'string') {
            rawText = event.data;
          } else if (event.data instanceof Blob) {
            rawText = await event.data.text();
          } else if (event.data instanceof ArrayBuffer) {
            rawText = new TextDecoder().decode(event.data);
          } else if (event.data && typeof event.data.text === 'function') {
            rawText = await event.data.text();
          } else {
            console.warn('Unhandled WebSocket data type:', typeof event.data);
            return;
          }

          const data = JSON.parse(rawText);
          console.log('[Gemini Live WS]', data);

          // Handle setupComplete confirmation from server
          if (data.setupComplete) {
            console.log('[Gemini Live] Session setupComplete confirmed!');
            if (connectionTimer) clearTimeout(connectionTimer);
            this.isSessionReady = true;
            if (this.onStateChange) this.onStateChange('ready');
            resolve();
            return;
          }

          // Handle server-side errors
          if (data.error) {
            if (connectionTimer) clearTimeout(connectionTimer);
            const errMsg = data.error.message || `API Error (${data.error.code || 'unknown'})`;
            console.error('[Gemini Live Error]:', errMsg);
            if (this.onError) this.onError(errMsg);
            return;
          }

          const serverContent = data.serverContent;
          if (!serverContent) return;

          // 1. Real-time interim hypothesis (streaming partial subtitle)
          if (serverContent.interimInputTranscription && serverContent.interimInputTranscription.text) {
            const interimText = serverContent.interimInputTranscription.text;
            if (this.onInterim) {
              this.onInterim(interimText);
            }
          }

          // 2. Finalized authoritative transcript (ready to type into active window)
          if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
            const finalText = serverContent.inputTranscription.text;
            if (this.onFinal) {
              this.onFinal(finalText);
            }
          }
        } catch (e) {
          console.warn('Error parsing Live API message:', e, event.data);
        }
      };

      this.ws.onerror = (event) => {
        if (connectionTimer) clearTimeout(connectionTimer);
        const errMsg = 'WebSocket error: failed to connect to Gemini Live API. Check your internet connection or API key.';
        console.error('[Gemini Live WS Error]:', event);
        if (this.onStateChange) this.onStateChange('error');
        if (this.onError) this.onError(errMsg);
        reject(new Error(errMsg));
      };

      this.ws.onclose = (event) => {
        if (connectionTimer) clearTimeout(connectionTimer);
        this.isConnected = false;
        this.isSessionReady = false;
        if (this.onStateChange) this.onStateChange('disconnected');
        if (!event.wasClean && event.code !== 1000) {
          const reason = event.reason || `Code ${event.code}`;
          if (this.onError) this.onError(`Live API connection closed: ${reason}`);
        }
      };
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  sendAudioChunk(base64Pcm16k) {
    if (!this.isConnected || !this.isSessionReady) return false;
    return this.send({
      realtimeInput: {
        audio: {
          data: base64Pcm16k,
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    });
  }

  sendAudioStreamEnd() {
    // Hybrid VAD signal for zero-latency turn finalization
    if (!this.isConnected || !this.isSessionReady) return false;
    return this.send({
      realtimeInput: {
        audioStreamEnd: true
      }
    });
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close(1000, 'User disconnect');
      } catch (e) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isSessionReady = false;
  }
}
