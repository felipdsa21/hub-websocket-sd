import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  ALICE,
  BRUNO,
  FakeWebSocket,
  aliceBrunoChat,
  answer,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { SEARCH_DELAY_MS } from '@/core/state/directory-store';
import { SessionStore } from '@/core/state/session-store';
import { provideTestClock } from '@/core/time/testing';
import { SearchBox } from './search-box';

describe('SearchBox', () => {
  let component: SearchBox;
  let fixture: ComponentFixture<SearchBox>;
  let socket: FakeWebSocket;

  beforeEach(async () => {
    const sockets: FakeWebSocket[] = [];
    await TestBed.configureTestingModule({
      imports: [SearchBox],
      providers: [provideRouter([]), ...provideTestClock(), ...provideFakeSockets(sockets)],
    }).compileComponents();
    useTestBackend();
    const session = TestBed.inject(SessionStore);
    socket = await enterAsAlice((u, d) => session.enter(u, d), sockets);

    fixture = TestBed.createComponent(SearchBox);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('stays open when clicking non-focusable panel areas and closes on outside click, Escape or Tab out (M1)', async () => {
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('input')!;

    input.dispatchEvent(new FocusEvent('focus'));
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS));
    expect(socket.last()).toMatchObject({ action: 'search', query: 'a' });
    answer(socket, { conversations: [aliceBrunoChat()], people: [] });
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    expect(host.classList.contains('open')).toBe(true);
    const heading = host.querySelector('h2')!;
    expect(heading).not.toBeNull();

    // Clicking a non-focusable heading inside the panel causes focusout with relatedTarget === null.
    heading.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    heading.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(host.classList.contains('open')).toBe(true);

    // Escape closes even when focus left the input for a non-focusable panel area.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(host.classList.contains('open')).toBe(false);

    // Reopen and close via clicking outside the host.
    input.dispatchEvent(new FocusEvent('focus'));
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(host.classList.contains('open')).toBe(true);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await fixture.whenStable();
      expect(host.classList.contains('open')).toBe(false);

      // Reopen and close via tabbing focus outside the host.
      input.dispatchEvent(new FocusEvent('focus'));
      await fixture.whenStable();
      expect(host.classList.contains('open')).toBe(true);

      host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
      await fixture.whenStable();
      expect(host.classList.contains('open')).toBe(false);
    } finally {
      outside.remove();
    }
  });

  it('opens a found conversation missing from the list', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('input')!;

    input.dispatchEvent(new FocusEvent('focus'));
    input.value = 'sd';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS));
    const group = { conversationId: 'g:9', type: 'group', name: 'SD', members: [ALICE, BRUNO] };
    answer(socket, { conversations: [{ ...group, joinedAt: 500 }], people: [] });
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    host.querySelector<HTMLElement>('app-result-row')!.click();

    expect(TestBed.inject(ConversationsStore).get('g:9')).toBeDefined();
    expect(navigate).toHaveBeenCalledWith(['/c', 'g:9']);
  });
});
