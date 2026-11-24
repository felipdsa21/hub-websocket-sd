import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  ALICE,
  FakeWebSocket,
  aliceBrunoChat,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { SessionStore } from '@/core/state/session-store';
import { provideTestClock } from '@/core/time/testing';
import { ConversationList } from './conversation-list';

describe('ConversationList', () => {
  let component: ConversationList;
  let fixture: ComponentFixture<ConversationList>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConversationList],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationList);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('prevents keyboard focus and navigation on dimmed offline conversations (M2)', async () => {
    const sockets: FakeWebSocket[] = [];
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ConversationList],
      providers: [provideRouter([]), ...provideTestClock(), ...provideFakeSockets(sockets)],
    }).compileComponents();
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const session = TestBed.inject(SessionStore);
    const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets, [
      aliceBrunoChat({ lastMessageAt: 900, lastMessageBy: 'bruno' }),
      { conversationId: 'g:1', type: 'group', name: 'SD', members: [ALICE], joinedAt: 200 },
    ]);
    const conversations = TestBed.inject(ConversationsStore);
    const [first, second] = conversations.sorted();
    conversations.open(first!.conversationId);
    socket.drop();

    const offlineFixture = TestBed.createComponent(ConversationList);
    await offlineFixture.whenStable();
    const links = [
      ...(offlineFixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(
        'a[mat-list-item]',
      ),
    ];
    const openedLink = links[0]!;
    const dimmedLink = links[1]!;

    expect(openedLink.getAttribute('href')).toBe(`/c/${first!.conversationId}`);
    expect(openedLink.getAttribute('tabindex')).not.toBe('-1');
    expect(openedLink.getAttribute('aria-disabled')).not.toBe('true');

    expect(second).toBeDefined();
    expect(dimmedLink.getAttribute('href')).toBeNull();
    expect(dimmedLink.getAttribute('tabindex')).toBe('-1');
    expect(dimmedLink.getAttribute('aria-disabled')).toBe('true');

    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    dimmedLink.click();
    expect(navigate).not.toHaveBeenCalled();
  });
});
