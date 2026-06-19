import { Injectable, NgZone, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type GeminiMessage =
  | { type: 'audio'; data: string }
  | { type: 'transcript_in'; data: string }
  | { type: 'transcript_out'; data: string }
  | { type: 'setup_complete' }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'tool_call'; data: { functionCalls: FunctionCall[] } };

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

const MODEL = 'gemini-2.5-flash-native-audio-latest';
const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

@Injectable({ providedIn: 'root' })
export class GeminiLiveService {
  private ws: WebSocket | null = null;
  private onMessage: ((msg: GeminiMessage) => void) | null = null;

  readonly status = signal<ConnectionStatus>('disconnected');

  constructor(
    private http: HttpClient,
    private zone: NgZone,
  ) {}

  async connect(
    systemInstruction: string,
    voiceName: string,
    tools: ToolDefinition[],
    onMessage: (msg: GeminiMessage) => void,
  ): Promise<void> {
    this.zone.run(() => this.status.set('connecting'));
    this.onMessage = onMessage;

    const { token } = await firstValueFrom(
      this.http.post<{ token: string }>('/api/token', {}),
    );

    const url = `${WS_BASE}?access_token=${token}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => this.sendSetup(systemInstruction, voiceName, tools);

    this.ws.onmessage = async (event) => {
      const text = event.data instanceof Blob ? await event.data.text() : event.data;
      try {
        const data = JSON.parse(text);
        const msgs = this.parse(data);
        this.zone.run(() => msgs.forEach((m) => this.onMessage?.(m)));
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      this.zone.run(() => this.status.set('error'));
    };

    this.ws.onclose = (e) => {
      console.warn(`WebSocket closed — code: ${e.code}, reason: "${e.reason}", clean: ${e.wasClean}`);
      this.zone.run(() => this.status.set('disconnected'));
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.zone.run(() => this.status.set('disconnected'));
  }

  sendAudio(base64PCM: string): void {
    this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm', data: base64PCM } } });
  }

  sendToolResponse(responses: Array<{ id: string; name: string; response: unknown }>): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  private sendSetup(systemInstruction: string, voiceName: string, tools: ToolDefinition[]): void {
    this.send({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : [],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 2000,
            prefixPaddingMs: 500,
          },
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
        },
      },
    });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private parse(data: Record<string, unknown>): GeminiMessage[] {
    const msgs: GeminiMessage[] = [];
    const sc = data?.['serverContent'] as Record<string, unknown> | undefined;
    const parts = (sc?.['modelTurn'] as Record<string, unknown> | undefined)?.['parts'] as
      | Array<Record<string, unknown>>
      | undefined;

    if (data?.['setupComplete']) {
      this.zone.run(() => this.status.set('connected'));
      msgs.push({ type: 'setup_complete' });
      return msgs;
    }

    if (data?.['toolCall']) {
      const tc = data['toolCall'] as { functionCalls: FunctionCall[] };
      msgs.push({ type: 'tool_call', data: tc });
      return msgs;
    }

    if (parts?.length) {
      for (const part of parts) {
        const inline = part['inlineData'] as Record<string, unknown> | undefined;
        if (inline?.['data']) msgs.push({ type: 'audio', data: inline['data'] as string });
      }
    }

    const inTx = sc?.['inputTranscription'] as Record<string, unknown> | undefined;
    const outTx = sc?.['outputTranscription'] as Record<string, unknown> | undefined;

    if (inTx?.['text']) msgs.push({ type: 'transcript_in', data: inTx['text'] as string });
    if (outTx?.['text']) msgs.push({ type: 'transcript_out', data: outTx['text'] as string });
    if (sc?.['interrupted']) msgs.push({ type: 'interrupted' });
    if (sc?.['turnComplete']) msgs.push({ type: 'turn_complete' });

    return msgs;
  }
}
