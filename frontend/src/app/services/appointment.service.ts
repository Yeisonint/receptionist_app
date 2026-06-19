import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Appointment {
  id: number;
  client_name: string;
  phone: string;
  date: string;
  time: string;
  duration_minutes: number;
  notes: string;
  created_at: string;
}

export interface AppointmentCreate {
  client_name: string;
  phone: string;
  date: string;
  time: string;
  duration_minutes: number;
  notes?: string;
}

@Injectable({ providedIn: 'root' })
export class AppointmentService {
  readonly version = signal(0);

  constructor(private http: HttpClient) {}

  async getByMonth(month: string): Promise<Appointment[]> {
    return firstValueFrom(
      this.http.get<Appointment[]>(`/api/appointments?month=${month}`)
    );
  }

  async getAvailability(date: string, durationMinutes: number): Promise<string[]> {
    const res = await firstValueFrom(
      this.http.get<{ slots: string[] }>(`/api/availability?date=${date}&duration=${durationMinutes}`)
    );
    return res.slots;
  }

  async create(data: AppointmentCreate): Promise<Appointment> {
    const appt = await firstValueFrom(
      this.http.post<Appointment>('/api/appointments', data)
    );
    this.version.update(v => v + 1);
    return appt;
  }

  async update(id: number, data: Partial<AppointmentCreate>): Promise<Appointment> {
    const appt = await firstValueFrom(
      this.http.put<Appointment>(`/api/appointments/${id}`, data)
    );
    this.version.update(v => v + 1);
    return appt;
  }

  async cancel(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/appointments/${id}`));
    this.version.update(v => v + 1);
  }
}
