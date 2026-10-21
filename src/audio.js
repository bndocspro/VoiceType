// High-performance Web Audio engine for Gemini 3.5 Transcribe Live
// Captures mic input, resamples to 16kHz 16-bit PCM mono, calculates volume/waveform for visualizer,
// and synthesizes zero-latency acoustic feedback sounds.

export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.analyserNode = null;
    this.isRecording = false;
    this.sampleRate = 16000;
    this.targetChunkSize = 1600; // 100ms at 16kHz
    this.pcmBuffer = [];
    this.onAudioChunk = null; // callback(base64PcmData)
    this.onVolumeChange = null; // callback(volume0to1)
    this.onSilenceDetected = null; // callback() for Hybrid VAD
    
    // Silence detection parameters
    this.silenceThreshold = 0.015;
    this.silenceTimeoutMs = 850;
    this.lastVoiceTime = 0;
    this.silenceTimer = null;
    this.hasSpoken = false;
  }

  async getAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput');
    } catch (e) {
      console.warn('Failed to enumerate devices:', e);
      return [];
    }
  }

  async start(deviceId = null) {
    if (this.isRecording) return;

    const constraints = {
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {})
      }
    };

    this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
    } catch (e) {
      console.warn('AudioContext at 16kHz not supported by driver, using default hardware rate:', e);
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const inputSampleRate = this.audioContext.sampleRate;
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Setup Analyser for 60fps waveform/volume visualization
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.5;
    this.sourceNode.connect(this.analyserNode);

    // Use ScriptProcessor for low-latency PCM downsampling & chunking
    const bufferSize = 2048;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.pcmBuffer = [];
    this.isRecording = true;
    this.hasSpoken = false;
    this.lastVoiceTime = Date.now();

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isRecording) return;
      const inputChannel = event.inputBuffer.getChannelData(0);

      // Downsample to 16kHz if audioContext runs at 44.1k/48k
      const resampled = this.downsample(inputChannel, inputSampleRate, 16000);

      // Calculate RMS volume
      let sumSquares = 0;
      for (let i = 0; i < resampled.length; i++) {
        sumSquares += resampled[i] * resampled[i];
      }
      const rms = Math.sqrt(sumSquares / resampled.length);

      if (this.onVolumeChange) {
        this.onVolumeChange(Math.min(1, rms * 5));
      }

      // Hybrid VAD silence detection
      const now = Date.now();
      if (rms > this.silenceThreshold) {
        this.hasSpoken = true;
        this.lastVoiceTime = now;
      } else if (this.hasSpoken && (now - this.lastVoiceTime > this.silenceTimeoutMs)) {
        if (this.onSilenceDetected) {
          this.onSilenceDetected();
        }
        this.hasSpoken = false; // Reset until user speaks again
      }

      // Convert to 16-bit PCM and append
      for (let i = 0; i < resampled.length; i++) {
        let s = Math.max(-1, Math.min(1, resampled[i]));
        let pcmSample = s < 0 ? s * 0x8000 : s * 0x7FFF;
        this.pcmBuffer.push(pcmSample);
      }

      // Emit chunk every ~100ms (1600 samples)
      while (this.pcmBuffer.length >= this.targetChunkSize) {
        const chunkSamples = this.pcmBuffer.splice(0, this.targetChunkSize);
        const int16Array = new Int16Array(chunkSamples);
        const base64Data = this.int16ToBase64(int16Array);
        if (this.onAudioChunk) {
          this.onAudioChunk(base64Data);
        }
      }
    };
  }

  stop() {
    this.isRecording = false;

    // Flush any remaining buffered audio
    if (this.pcmBuffer.length > 0 && this.onAudioChunk) {
      const int16Array = new Int16Array(this.pcmBuffer);
      this.pcmBuffer = [];
      const base64Data = this.int16ToBase64(int16Array);
      this.onAudioChunk(base64Data);
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  getWaveformData(outputArray) {
    if (!this.analyserNode) return false;
    this.analyserNode.getByteTimeDomainData(outputArray);
    return true;
  }

  getFrequencyData(outputArray) {
    if (!this.analyserNode) return false;
    this.analyserNode.getByteFrequencyData(outputArray);
    return true;
  }

  downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;
    if (fromRate < toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
        sum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? sum / count : buffer[offsetBuffer];
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    return result;
  }

  int16ToBase64(int16Array) {
    const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Synthesized acoustic feedback chimes (crisp, zero lag, no audio assets required)
  playChime(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === 'start') {
        // Uplifting dual chime: 480Hz -> 720Hz
        osc.type = 'sine';
        osc.frequency.setValueAtTime(480, now);
        osc.frequency.exponentialRampToValueAtTime(720, now + 0.12);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === 'stop') {
        // Soft descending tone: 680Hz -> 420Hz
        osc.type = 'sine';
        osc.frequency.setValueAtTime(680, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.14);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.10, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.18);
      } else if (type === 'typed') {
        // Crisp high-tech tick/confirmation: 880Hz -> 1100Hz
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1100, now + 0.06);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.08, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.1);
      }
    } catch (e) {
      console.warn('Audio chime error:', e);
    }
  }
}
