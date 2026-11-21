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
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('42 ms');
    expect(text).toContain('Tentativa de reconexão #1');

    expect(telemetry.showLatency()).toBe(false);
    const toggle = (fixture.nativeElement as HTMLElement).querySelector(
      'button[role="switch"]',
    ) as HTMLButtonElement | null;
    toggle?.click();
    await fixture.whenStable();
    expect(telemetry.showLatency()).toBe(true);
  });
});
