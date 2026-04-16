import { Component, signal, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private http = inject(HttpClient);

  protected readonly title = signal('Cafetería AI');
  protected readonly serverTime = signal<string | null>(null);

  getHora() {
    this.http.get<{ serverTime: string }>('http://localhost:3000/time').subscribe({
      next: (res) => this.serverTime.set(res.serverTime),
      error: (err) => console.error('Error detallado:', err)
    });
  }
}