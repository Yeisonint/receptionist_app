import { Injectable, NgZone } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AudioService {
  private captureCtx: AudioContext | null = null;
  private captureWorklet: AudioWorkletNode | null = null;
  private captureStream: MediaStream | null = null;

  private playCtx: AudioContext | null = null;
  private playWorklet: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;

  constructor(private zone: NgZone) {}

  async requestMicPermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  async startCapture(onChunk: (base64: string) => void): Promise<void> {
    this.captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.captureCtx = new AudioContext({ sampleRate: 16000 });
    await this.captureCtx.audioWorklet.addModule('/audio-processors/capture.worklet.js');

    this.captureWorklet = new AudioWorkletNode(this.captureCtx, 'audio-capture-processor');
    this.captureWorklet.port.onmessage = (e) => {
      if (e.data.type !== 'audio') return;
      const pcm = this.float32ToPCM16(e.data.data as Float32Array);
      onChunk(this.bufferToBase64(pcm));
    };

    const source = this.captureCtx.createMediaStreamSource(this.captureStream);
    source.connect(this.captureWorklet);
  }

  stopCapture(): void {
    this.captureWorklet?.disconnect();
    this.captureWorklet?.port.close();
    this.captureCtx?.close();
    this.captureStream?.getTracks().forEach((t) => t.stop());
    this.captureCtx = null;
    this.captureWorklet = null;
    this.captureStream = null;
  }

  async initPlayback(): Promise<void> {
    this.playCtx = new AudioContext({ sampleRate: 24000 });
    await this.playCtx.audioWorklet.addModule('/audio-processors/playback.worklet.js');
    this.playWorklet = new AudioWorkletNode(this.playCtx, 'pcm-processor');
    this.gainNode = this.playCtx.createGain();
    this.playWorklet.connect(this.gainNode);
    this.gainNode.connect(this.playCtx.destination);
  }

  playAudio(base64PCM: string): void {
    if (!this.playWorklet) return;
    if (this.playCtx?.state === 'suspended') this.playCtx.resume();
    const bytes = Uint8Array.from(atob(base64PCM), (c) => c.charCodeAt(0));
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    this.playWorklet.port.postMessage(float32);
  }

  interruptPlayback(): void {
    this.playWorklet?.port.postMessage('interrupt');
  }

  destroyPlayback(): void {
    this.playCtx?.close();
    this.playCtx = null;
    this.playWorklet = null;
    this.gainNode = null;
  }

  private float32ToPCM16(f32: Float32Array): ArrayBuffer {
    const int16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
    }
    return int16.buffer;
  }

  private bufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
