import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTestFixtures } from '@/core/fixtures/testing';
import {
  ALICE_BRUNO,
  FakeWebSocket,
  aliceBrunoChat,
  answer,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { Breakpoints } from '@/core/layout/breakpoints';
import { messageSk } from '@/core/model/message';
import { SessionStore } from '@/core/state/session-store';
import { ConversationPage } from './conversation-page';

let lastIntersection: {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[];
} | null = null;

// jsdom has neither observer.
class IntersectionObserverStub {
  public readonly observed: Element[] = [];
  public readonly observe = vi.fn((el: Element) => {
    this.observed.push(el);
  });
  public readonly disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    lastIntersection = { callback, options, observed: this.observed };
  }
}

class ResizeObserverStub {
  public readonly observe = vi.fn();
  public readonly disconnect = vi.fn();
}

describe('ConversationPage', () => {
  let component: ConversationPage;
  let fixture: ComponentFixture<ConversationPage>;

  beforeEach(async () => {
    lastIntersection = null;
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    await TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('observes #olderSentinel with root=scroller and resumes loadOlder after reconnecting (B3)', async () => {
    localStorage.clear();
    lastIntersection = null;
    const sockets: FakeWebSocket[] = [];
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [provideRouter([]), ...provideTestFixtures(), ...provideFakeSockets(sockets)],
    }).compileComponents();
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const session = TestBed.inject(SessionStore);
    const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets, [aliceBrunoChat()]);

    const pageFixture = TestBed.createComponent(ConversationPage);
    pageFixture.componentRef.setInput('conversationId', ALICE_BRUNO);
    await pageFixture.whenStable();

    const latestMsg = {
      conversationId: ALICE_BRUNO,
      sk: messageSk(2000, 'bruno', 'm2'),
      messageId: 'm2',
      sender: 'bruno',
      text: 'oi',
      sentAt: 2000,
    };
    answer(socket, { messages: [latestMsg], hasMore: true });
    await new Promise((r) => setTimeout(r));
    await pageFixture.whenStable();

    const scroller = (pageFixture.nativeElement as HTMLElement).querySelector('.scroller');
    expect(lastIntersection).not.toBeNull();
    expect(lastIntersection!.options?.root).toBe(scroller);

    // Go offline while sentinel intersects -> loadOlder cannot run yet.
    socket.drop();
    await pageFixture.whenStable();
    lastIntersection!.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await pageFixture.whenStable();

    // Reconnect -> sentinel is still intersecting, so loadOlder runs automatically.
    const next = sockets[1]!;
    next.open();
    await Promise.resolve();
    answer(next, { serverTime: 3000, updated: [], conversations: [aliceBrunoChat()] });
    await new Promise((r) => setTimeout(r));
    await pageFixture.whenStable();

    expect(
      next.sent.some(
        (r) =>
          r['action'] === 'getHistory' &&
          r['conversationId'] === ALICE_BRUNO &&
          r['before'] === latestMsg.sk,
      ),
    ).toBe(true);
  });

  it('uses h2 for the conversation header on desktop and h1 in compact mode (B5)', async () => {
    const compact = signal(false);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [
        provideRouter([]),
        ...provideTestFixtures(),
        {
          provide: Breakpoints,
          useValue: {
            compact,
            wideList: signal(true),
            windowSize: signal<'compact' | 'medium' | 'expanded'>('expanded'),
          },
        },
      ],
    }).compileComponents();

    await TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
    const pageFixture = TestBed.createComponent(ConversationPage);
    pageFixture.componentRef.setInput('conversationId', 'd:bruno:marina');
    await pageFixture.whenStable();

    const root = pageFixture.nativeElement as HTMLElement;
    expect(root.querySelector('app-screen-header h1')).toBeNull();
    expect(root.querySelector('app-screen-header h2')?.textContent?.trim()).toBe('Bruno Lima');

    compact.set(true);
    await pageFixture.whenStable();
    expect(root.querySelector('app-screen-header h1')?.textContent?.trim()).toBe('Bruno Lima');
    expect(root.querySelector('app-screen-header h2')).toBeNull();
  });
});
