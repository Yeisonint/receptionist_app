import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AppConfig {
  businessName: string;
  businessHours: { start: number; end: number };
  lunchHour: number;
  slotDurationMinutes: number;
  businessDays: number[];
  voiceName: string;
  systemInstruction: string;
}

@Injectable({ providedIn: 'root' })
export class AppConfigService {
  readonly config = signal<AppConfig | null>(null);

  constructor(private http: HttpClient) {}

  async load(): Promise<AppConfig> {
    const cfg = await firstValueFrom(this.http.get<AppConfig>('/api/config'));
    this.config.set(cfg);
    return cfg;
  }

  async save(data: Partial<AppConfig>): Promise<AppConfig> {
    const cfg = await firstValueFrom(this.http.put<AppConfig>('/api/config', data));
    this.config.set(cfg);
    return cfg;
  }
}
