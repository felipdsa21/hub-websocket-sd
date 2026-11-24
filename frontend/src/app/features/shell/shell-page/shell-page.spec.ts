import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeWebSocket,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConnectionStore } from '@/core/state/connection-store';
import { SessionStore } from '@/core/state/session-store';
import { TelemetryStore } from '@/core/state/telemetry-store';
import { provideTestClock } from '@/core/time/testing';
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

  it('should create', () => {
    expect(component).toBeTruthy();
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

  it('disables mobile FAB "Novo chat" and "Novo grupo" actions when offline (RF08)', async () => {
    const sockets: FakeWebSocket[] = [];
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ShellPage],
      providers: [
        provideRouter([]),
        ...provideTestClock(),
        ...provideFakeSockets(sockets),
        {
          provide: Breakpoints,
          useValue: {
            compact: signal(true),
            wideList: signal(false),
            windowSize: signal<'compact' | 'medium' | 'expanded'>('compact'),
          },
        },
      ],
    }).compileComponents();
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = TestBed.inject(SessionStore);
    const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets);
    socket.drop();
    expect(TestBed.inject(ConnectionStore).connected()).toBe(false);

    const mobileFixture = TestBed.createComponent(ShellPage);
    (
      mobileFixture.componentInstance as unknown as { newMenuOpen: { set(v: boolean): void } }
    ).newMenuOpen.set(true);
    await mobileFixture.whenStable();

    const items = [
      ...(mobileFixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.fab-item',
      ),
    ];
    expect(items.map((b) => b.textContent?.trim())).toEqual([
      expect.stringContaining('Novo chat'),
      expect.stringContaining('Novo grupo'),
    ]);
    expect(items.every((b) => b.disabled)).toBe(true);
  });
});
