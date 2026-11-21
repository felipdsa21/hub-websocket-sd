import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TelemetryStore } from '@/core/state/telemetry-store';
import { ShellPage } from './shell-page';

describe('ShellPage', () => {
  let component: ShellPage;
  let fixture: ComponentFixture<ShellPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ShellPage],
    }).compileComponents();

    fixture = TestBed.createComponent(ShellPage);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('toggles dark mode from the header with constant aria-label', async () => {
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

    expect(toggle.getAttribute('aria-label')).toBe('Modo escuro');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();
    await fixture.whenStable();

    expect(toggle.getAttribute('aria-label')).toBe('Modo escuro');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });

  it('shows the RTT badge only when showLatency is enabled and a sample exists', async () => {
    const telemetry = TestBed.inject(TelemetryStore);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.rtt-badge')).toBeNull();

    telemetry.recordRtt(48, 'heartbeat');
    await fixture.whenStable();
    expect(root.querySelector('.rtt-badge')).toBeNull();

    telemetry.showLatency.set(true);
    await fixture.whenStable();
    const badge = root.querySelector('.rtt-badge');
    expect(badge?.textContent?.trim()).toBe('Latência da conexão: RTT 48 ms');
  });
});
