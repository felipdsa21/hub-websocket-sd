import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import {
  FakeWebSocket,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { ConnectionStore } from '@/core/state/connection-store';
import { SessionStore } from '@/core/state/session-store';
import { provideTestClock } from '@/core/time/testing';
import { NewChatDialog } from './new-chat-dialog';

describe('NewChatDialog', () => {
  let component: NewChatDialog;
  let fixture: ComponentFixture<NewChatDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewChatDialog],
      providers: [{ provide: MatDialogRef, useValue: { close: vi.fn() } }],
    }).compileComponents();

    fixture = TestBed.createComponent(NewChatDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('disables picking a person while offline (B1)', async () => {
    const close = vi.fn();
    const sockets: FakeWebSocket[] = [];
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [NewChatDialog],
      providers: [
        ...provideTestClock(),
        ...provideFakeSockets(sockets),
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const session = TestBed.inject(SessionStore);
    const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets);
    socket.drop();
    expect(TestBed.inject(ConnectionStore).connected()).toBe(false);
    const offlineFixture = TestBed.createComponent(NewChatDialog);
    await offlineFixture.whenStable();

    const input = (offlineFixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input',
    )!;
    expect(input.disabled).toBe(true);
    (
      offlineFixture.componentInstance as unknown as {
        pick(u: { username: string; displayName: string; online: boolean; version: number }): void;
      }
    ).pick({ username: 'bruno', displayName: 'Bruno', online: true, version: 1 });
    expect(close).not.toHaveBeenCalled();
  });
});
