import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppointmentService, Appointment } from '../services/appointment.service';

interface CalendarDay {
  date: Date;
  dateStr: string;
  inRange: boolean;
  isToday: boolean;
  appointments: Appointment[];
}

interface EditDraft {
  id: number;
  client_name: string;
  phone: string;
  date: string;
  time: string;
  duration_minutes: number;
  notes: string;
}

@Component({
  selector: 'app-calendar',
  templateUrl: './calendar.component.html',
  styleUrl: './calendar.component.scss',
  imports: [FormsModule],
})
export class CalendarComponent {
  private apptService = inject(AppointmentService);

  private readonly todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  private readonly maxDate = new Date(this.todayStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  readonly allAppointments = signal<Appointment[]>([]);
  readonly selectedDay     = signal<CalendarDay | null>(null);
  readonly editing         = signal<EditDraft | null>(null);
  readonly saveError       = signal('');

  readonly rangeLabel = computed(() => {
    const start = this.todayStart;
    const end   = this.maxDate;
    const fmtOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
    return `${start.toLocaleDateString('es', fmtOpts)} — ${end.toLocaleDateString('es', fmtOpts)}`;
  });

  readonly days = computed<CalendarDay[]>(() => {
    const appts = this.allAppointments();

    // Start on Monday of the week containing today
    const startOffset = (this.todayStart.getDay() + 6) % 7;
    const start = new Date(this.todayStart);
    start.setDate(start.getDate() - startOffset);

    const days: CalendarDay[] = [];
    const cursor = new Date(start);

    for (let i = 0; i < 35; i++) {
      const dateStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
      days.push({
        date: new Date(cursor),
        dateStr,
        inRange: cursor >= this.todayStart && cursor <= this.maxDate,
        isToday: cursor.toDateString() === this.todayStart.toDateString(),
        appointments: appts.filter(a => a.date === dateStr),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Drop trailing weeks that are fully out of range
    while (days.slice(-7).every(d => !d.inRange)) days.splice(-7);

    return days;
  });

  constructor() {
    effect(() => {
      this.apptService.version();
      this.loadRange();
    });
  }

  private async loadRange(): Promise<void> {
    const months = new Set<string>();
    let cursor = new Date(this.todayStart);
    while (cursor <= this.maxDate) {
      months.add(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2,'0')}`);
      cursor.setDate(cursor.getDate() + 28);
    }
    const results = await Promise.all([...months].map(m => this.apptService.getByMonth(m)));
    this.allAppointments.set(results.flat());
  }

  selectDay(day: CalendarDay): void {
    if (!day.inRange) return;
    this.selectedDay.set(
      this.selectedDay()?.dateStr === day.dateStr ? null : day
    );
    this.editing.set(null);
    this.saveError.set('');
  }

  startEdit(appt: Appointment): void {
    this.saveError.set('');
    this.editing.set({ ...appt });
  }

  cancelEdit(): void {
    this.editing.set(null);
    this.saveError.set('');
  }

  async saveEdit(): Promise<void> {
    const draft = this.editing();
    if (!draft) return;
    this.saveError.set('');
    try {
      await this.apptService.update(draft.id, draft);
      this.editing.set(null);
    } catch (err: unknown) {
      const e = err as { error?: { error?: string } };
      this.saveError.set(e?.error?.error ?? 'Error al guardar');
    }
  }

  async cancelAppointment(id: number): Promise<void> {
    if (!confirm('¿Cancelar esta cita?')) return;
    await this.apptService.cancel(id);
    if (this.editing()?.id === id) this.editing.set(null);
  }

  formatTime(time: string): string {
    const [h, m] = time.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'pm' : 'am'}`;
  }

  formatDayLabel(date: Date): string {
    return date.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
  }
}
