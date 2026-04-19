import { Component, signal, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { LiveService } from './live.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  public liveService = inject(LiveService);

  toggleChat() {
    if (this.liveService.status() === 'disconnected') {
      this.liveService.startChat();
    } else {
      this.liveService.stopChat();
    }
  }
}