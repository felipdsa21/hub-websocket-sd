import { Component } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatProgressBar } from '@angular/material/progress-bar';

/** Band under the top bar while the client reconnects (RF08). */
@Component({
  selector: 'app-connection-banner',
  imports: [MatIcon, MatProgressBar],
  templateUrl: './connection-banner.html',
  styleUrl: './connection-banner.scss',
  host: { role: 'status' },
})
export class ConnectionBanner {}
