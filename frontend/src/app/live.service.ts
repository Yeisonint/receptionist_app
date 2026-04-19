import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { GoogleGenAI, Modality } from '@google/genai';
import RecordRTC, { StereoAudioRecorder } from 'recordrtc';

export type LiveChatStatus = 'disconnected' | 'connecting' | 'listening' | 'speaking';

@Injectable({
  providedIn: 'root'
})
export class LiveService {
  private http = inject(HttpClient);
  
  public status = signal<LiveChatStatus>('disconnected');
  public error = signal<string | null>(null);

  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private recorder: RecordRTC | null = null;
  private audioContext: AudioContext | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private isPlaying = false;
  private nextPlayTime = 0;

  async startChat() {
    try {
      this.status.set('connecting');
      this.error.set(null);

      // 1. Obtener el token efimero desde nuestro backend
      const response = await firstValueFrom(
        this.http.get<{ token: string }>('http://localhost:3000/token')
      );
      
      const token = response.token;

      // 2. Inicializar GoogleGenAI SDK usando el token y la API v1alpha
      this.ai = new GoogleGenAI({ 
        apiKey: token,
        httpOptions: { apiVersion: 'v1alpha' }
      });

      // 3. Conectar a Live API
      this.session = await this.ai.live.connect({
        model: 'gemini-2.0-flash-exp', // Modelo recomendado actual para Live
        config: {
          responseModalities: [Modality.AUDIO],
        },
        callbacks: {
          onmessage: (msg: any) => {
             this.handleMessage(msg);
          },
          onclose: () => {
             this.stopChat();
          }
        }
      });

      // 4. Iniciar captura de micrófono usando RecordRTC
      await this.startMicrophone();

      this.status.set('listening');
      
    } catch (err: any) {
      console.error('Error starting chat', err);
      this.error.set(err.message || 'Error al conectar');
      this.stopChat();
    }
  }

  async stopChat() {
    this.status.set('disconnected');
    
    if (this.recorder) {
      this.recorder.stopRecording();
      this.recorder.destroy();
      this.recorder = null;
    }
    
    if (this.session) {
      // Ignorar errores al cerrar para evitar crashes
      try { this.session.close(); } catch(e) {}
      this.session = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.audioQueue = [];
    this.isPlaying = false;
  }

  private async startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    this.recorder = new RecordRTC(stream, {
      type: 'audio',
      mimeType: 'audio/webm',
      recorderType: StereoAudioRecorder,
      timeSlice: 500, // Mandar chunks cada 500ms
      desiredSampRate: 16000,
      numberOfAudioChannels: 1, // Mono como espera Gemini
      ondataavailable: (blob: Blob) => {
        this.processClientAudio(blob);
      }
    });

    this.recorder.startRecording();
  }

  // Convertimos Blob (audio webm o wav/pcm generado por RecordRTC) a Base64 usando FileReader
  private processClientAudio(blob: Blob) {
    if (this.status() !== 'listening' && this.status() !== 'speaking') return;
    if (!this.session) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      // ArrayBuffer -> Base64 string
      const base64Audio = btoa(
        new Uint8Array(arrayBuffer)
          .reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      // Enviamos el stream de audio al modelo
      try {
        this.session.send({
          realtimeInput: {
            mediaChunks: [{
              mimeType: 'audio/pcm;rate=16000',
              data: base64Audio
            }]
          }
        });
      } catch (err) {
        console.warn('Error mandando audio a Gemini', err);
      }
    };
    reader.readAsArrayBuffer(blob);
  }

  // Descomponer y reproducir mensaje del servidor
  private handleMessage(msg: any) {
    if (msg.serverContent && msg.serverContent.modelTurn) {
      const parts = msg.serverContent.modelTurn.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            this.status.set('speaking');
            this.playAudio(part.inlineData.data);
          }
        }
      }
    }
    
    if (msg.serverContent && msg.serverContent.turnComplete) {
      if (this.audioQueue.length === 0 && !this.isPlaying) {
        this.status.set('listening');
      }
    }
  }

  private async playAudio(base64Data: string) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000 // Gemini responde normalmente en 24000Hz para Live API
      });
      this.nextPlayTime = this.audioContext.currentTime;
    }

    // Convert Base64 back to Uint8Array
    const binary = atob(base64Data);
    const audioData = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        audioData[i] = binary.charCodeAt(i);
    }
    
    // Asumiendo PCM 16-bit
    const int16Buffer = new Int16Array(audioData.buffer);
    const float32Buffer = new Float32Array(int16Buffer.length);
    for (let i = 0; i < int16Buffer.length; i++) {
        float32Buffer[i] = int16Buffer[i] / 32768.0;
    }

    const audioBuffer = this.audioContext.createBuffer(1, float32Buffer.length, 24000);
    audioBuffer.getChannelData(0).set(float32Buffer);

    this.audioQueue.push(audioBuffer as any);
    this.scheduleNextPlayback();
  }

  private scheduleNextPlayback() {
    if (this.isPlaying || this.audioQueue.length === 0 || !this.audioContext) return;
    
    this.isPlaying = true;
    const buffer = this.audioQueue.shift() as unknown as AudioBuffer;
    
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    
    const currentTime = this.audioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime;
    }
    
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    
    source.onended = () => {
      this.isPlaying = false;
      
      // Si la cola se vació, regresamos a modo 'listening'
      if (this.audioQueue.length === 0 && this.status() === 'speaking') {
         this.status.set('listening');
      }
      this.scheduleNextPlayback();
    };
  }
}
