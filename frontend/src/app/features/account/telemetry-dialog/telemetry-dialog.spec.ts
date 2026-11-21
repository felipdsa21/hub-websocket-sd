import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { TelemetryStore } from '@/core/state/telemetry-store';
import { TelemetryDialog } from './telemetry-dialog';

describe('TelemetryDialog', () => {
  it('renders metrics, events and toggles the optional latency badge', async () => {
    TestBed.configureTestingModule({
      imports: [TelemetryDialog],
      providers: provideTestFixtures(),
    });
    const telemetry = TestBed.inject(TelemetryStore);
    telemetry.recordRtt(42, 'heartbeat');
    telemetry.record('connection', 'Tentativa de reconexão #1 (espera 0 ms)');

    const fixture = TestBed.createComponent(TelemetryDialog);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? '';
    expect(text).toContain('42 ms');
    expect(text).toContain('Tentativa de reconexão #1');

    const log = root.querySelector('[role="log"]');
    expect(log?.getAttribute('tabindex')).toBe('0');

    expect(telemetry.showLatency()).toBe(false);
    const toggle = root.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    toggle?.click();
    await fixture.whenStable();
    expect(telemetry.showLatency()).toBe(true);

    const clearBtn = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Limpar',
    );
    clearBtn?.click();
    await fixture.whenStable();
    expect(telemetry.events()).toEqual([]);
    expect(clearBtn?.disabled).toBe(true);
  });
});
