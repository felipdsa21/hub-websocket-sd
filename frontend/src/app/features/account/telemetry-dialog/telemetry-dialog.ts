import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { ConnectionStore } from '@/core/state/connection-store';
import { MessagesStore } from '@/core/state/messages-store';
import { TelemetryKind, TelemetryStore } from '@/core/state/telemetry-store';

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const KIND_LABELS: Readonly<Record<TelemetryKind, string>> = {
  connection: 'Conexão',
  presence: 'Presença',
  retry: 'Fila',
  latency: 'Latência',
};

/** Panel showing recent WebSocket events, queue status and Round-Trip Time metrics. */
@Component({
  selector: 'app-telemetry-dialog',
  imports: [
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatDialogTitle,
    MatSlideToggle,
  ],
  templateUrl: './telemetry-dialog.html',
  styleUrl: './telemetry-dialog.scss',
})
export class TelemetryDialog {
  protected readonly telemetry = inject(TelemetryStore);
  protected readonly connected = inject(ConnectionStore).connected;
  private readonly messages = inject(MessagesStore);

  protected readonly pendingCount = computed(() => this.messages.pendingCount());

  protected formatTime(timestamp: number): string {
    return TIME_FORMAT.format(timestamp);
  }

  protected kindLabel(kind: TelemetryKind): string {
    return KIND_LABELS[kind];
  }

  protected toggleLatency(checked: boolean): void {
    this.telemetry.showLatency.set(checked);
  }

  protected clear(): void {
    this.telemetry.clear();
  }
}
