import { Component, computed, effect, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GeminiLiveService, GeminiMessage, FunctionCall, ToolDefinition } from './services/gemini-live.service';
import { AudioService } from './services/audio.service';
import { AppointmentService } from './services/appointment.service';
import { AppConfigService, AppConfig } from './services/app-config.service';
import { CalendarComponent } from './calendar/calendar.component';

type TranscriptEntry = { role: 'user' | 'assistant'; text: string };

const TOOLS: ToolDefinition[] = [
  {
    name: 'check_availability',
    description: 'Verifica los horarios disponibles para una fecha y duración específica',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        duration_minutes: { type: 'integer', description: 'Duración en minutos (30, 60 o 90)' },
      },
      required: ['date', 'duration_minutes'],
    },
  },
  {
    name: 'create_appointment',
    description: 'Crea una cita en el sistema después de confirmar con el cliente',
    parameters: {
      type: 'object',
      properties: {
        client_name:      { type: 'string',  description: 'Nombre completo del cliente' },
        phone:            { type: 'string',  description: 'Número de teléfono' },
        date:             { type: 'string',  description: 'Fecha en formato YYYY-MM-DD' },
        time:             { type: 'string',  description: 'Hora en formato HH:MM (24h)' },
        duration_minutes: { type: 'integer', description: 'Duración en minutos' },
        notes:            { type: 'string',  description: 'Notas adicionales (opcional)' },
      },
      required: ['client_name', 'phone', 'date', 'time', 'duration_minutes'],
    },
  },
  {
    name: 'update_appointment',
    description: 'Corrige o actualiza datos de una cita existente (nombre, teléfono, fecha, hora, notas)',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'integer', description: 'ID de la cita a corregir' },
        client_name:    { type: 'string',  description: 'Nombre corregido' },
        phone:          { type: 'string',  description: 'Teléfono corregido' },
        date:           { type: 'string',  description: 'Nueva fecha YYYY-MM-DD' },
        time:           { type: 'string',  description: 'Nueva hora HH:MM' },
        duration_minutes: { type: 'integer', description: 'Nueva duración en minutos' },
        notes:          { type: 'string',  description: 'Notas' },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela una cita existente por su ID',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'integer', description: 'ID de la cita a cancelar' },
      },
      required: ['appointment_id'],
    },
  },
];

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  imports: [CalendarComponent, FormsModule],
})
export class App implements OnDestroy {
  private gemini        = inject(GeminiLiveService);
  private audio         = inject(AudioService);
  private apptService   = inject(AppointmentService);
  private configService = inject(AppConfigService);

  readonly status      = this.gemini.status;
  readonly config      = this.configService.config;
  readonly transcript   = signal<TranscriptEntry[]>([]);
  readonly micGranted  = signal<boolean | null>(null);
  readonly errorMsg    = signal<string>('');
  readonly showConfig  = signal(false);
  readonly editConfig  = signal<AppConfig | null>(null);

  readonly isConnected  = computed(() => this.status() === 'connected');
  readonly isConnecting = computed(() => this.status() === 'connecting');
  readonly isDisconnected = computed(() =>
    this.status() === 'disconnected' || this.status() === 'error'
  );
  readonly buttonLabel = computed(() => {
    switch (this.status()) {
      case 'connecting': return 'Conectando...';
      case 'connected':  return 'Terminar';
      default:           return 'Iniciar';
    }
  });

  readonly slotOptions = [30, 60, 90];
  readonly dayNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  constructor() {
    this.configService.load();
  }

  async toggle(): Promise<void> {
    if (this.isConnected() || this.isConnecting()) {
      this.end();
    } else {
      await this.start();
    }
  }

  private async start(): Promise<void> {
    this.errorMsg.set('');
    this.transcript.set([]);

    const granted = await this.audio.requestMicPermission();
    this.micGranted.set(granted);
    if (!granted) { this.errorMsg.set('Permiso de micrófono denegado.'); return; }

    try {
      const cfg = await this.configService.load();
      const sysInstruction = `${cfg.systemInstruction}

REGLAS OBLIGATORIAS (nunca preguntar al usuario):
- Duración de cita: SIEMPRE usa ${cfg.slotDurationMinutes} minutos.
- Fechas: SIEMPRE en formato YYYY-MM-DD (ejemplo: 2026-06-02).
- Horas: SIEMPRE en formato HH:MM 24h (ejemplo: 11:00, 14:30).
- En check_availability y create_appointment usa duration_minutes: ${cfg.slotDurationMinutes}.`;
      await this.gemini.connect(sysInstruction, cfg.voiceName, TOOLS, (msg) => this.handleMessage(msg));
      await this.audio.initPlayback();
      await this.audio.startCapture((b64) => this.gemini.sendAudio(b64));
    } catch (err: unknown) {
      const msg = (err && typeof err === 'object' && 'message' in err)
        ? String((err as { message: unknown }).message)
        : JSON.stringify(err);
      this.errorMsg.set(`Error: ${msg}`);
      this.end();
    }
  }

  private end(): void {
    this.gemini.disconnect();
    this.audio.stopCapture();
    this.audio.destroyPlayback();
  }

  private handleMessage(msg: GeminiMessage): void {
    switch (msg.type) {
      case 'audio':          this.audio.playAudio(msg.data); break;
      case 'transcript_in':  this.appendTranscript('user', msg.data); break;
      case 'transcript_out': this.appendTranscript('assistant', msg.data); break;
      case 'interrupted':    this.audio.interruptPlayback(); break;
      case 'tool_call':      this.handleToolCall(msg.data.functionCalls); break;
    }
  }

  private async handleToolCall(calls: FunctionCall[]): Promise<void> {
    const responses = await Promise.all(calls.map(async (call) => {
      console.log('Tool call:', call.name, call.args);
      try {
        const result = await this.executeTool(call.name, call.args);
        console.log('Tool result:', call.name, result);
        return { id: call.id, name: call.name, response: { result } };
      } catch (err: unknown) {
        let error: string;
        if (err && typeof err === 'object' && 'error' in err) {
          const e = (err as { error: unknown }).error;
          error = (e && typeof e === 'object' && 'error' in e)
            ? String((e as { error: unknown }).error)
            : JSON.stringify(e);
        } else {
          error = err instanceof Error ? err.message : String(err);
        }
        console.error('Tool error:', call.name, error);
        return { id: call.id, name: call.name, response: { error } };
      }
    }));
    this.gemini.sendToolResponse(responses);
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'check_availability': {
        const slots = await this.apptService.getAvailability(
          args['date'] as string,
          args['duration_minutes'] as number,
        );
        return slots.length > 0
          ? `Horarios disponibles: ${slots.join(', ')}`
          : 'No hay horarios disponibles para esa fecha y duración.';
      }

      case 'create_appointment': {
        const appt = await this.apptService.create({
          client_name:      args['client_name'] as string,
          phone:            args['phone'] as string,
          date:             args['date'] as string,
          time:             args['time'] as string,
          duration_minutes: args['duration_minutes'] as number,
          notes:            (args['notes'] as string) ?? '',
        });
        return `Cita creada exitosamente. ID: ${appt.id}. ${appt.client_name} el ${appt.date} a las ${appt.time}.`;
      }

      case 'update_appointment': {
        const { appointment_id, ...fields } = args as { appointment_id: number; [k: string]: unknown };
        const updated = await this.apptService.update(appointment_id, fields as Parameters<typeof this.apptService.update>[1]);
        return `Cita actualizada: ${updated.client_name}, ${updated.date} a las ${updated.time}.`;
      }

      case 'cancel_appointment': {
        await this.apptService.cancel(args['appointment_id'] as number);
        return `Cita ${args['appointment_id']} cancelada exitosamente.`;
      }

      default:
        throw new Error(`Herramienta desconocida: ${name}`);
    }
  }

  private appendTranscript(role: 'user' | 'assistant', text: string): void {
    if (!text?.trim()) return;
    this.transcript.update((entries) => {
      const last = entries[entries.length - 1];
      if (last?.role === role) {
        return [...entries.slice(0, -1), { role, text: last.text + text }];
      }
      return [...entries, { role, text }];
    });
  }

  // ── Config panel ────────────────────────────────────────────────────────────

  openConfig(): void {
    const cfg = this.config();
    if (cfg) this.editConfig.set({ ...cfg, businessDays: [...cfg.businessDays] });
    this.showConfig.set(true);
  }

  closeConfig(): void {
    this.showConfig.set(false);
    this.editConfig.set(null);
  }

  toggleDay(day: number): void {
    const cfg = this.editConfig();
    if (!cfg) return;
    const days = cfg.businessDays.includes(day)
      ? cfg.businessDays.filter(d => d !== day)
      : [...cfg.businessDays, day].sort();
    this.editConfig.set({ ...cfg, businessDays: days });
  }

  async saveConfig(): Promise<void> {
    const cfg = this.editConfig();
    if (!cfg) return;
    await this.configService.save(cfg);
    this.closeConfig();
  }

  ngOnDestroy(): void {
    this.end();
  }
}
