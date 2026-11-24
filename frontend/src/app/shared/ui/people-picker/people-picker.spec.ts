import { TestBed } from '@angular/core/testing';
import {
  BRUNO,
  FakeWebSocket,
  answer,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { SEARCH_DELAY_MS } from '@/core/state/directory-store';
import { SessionStore } from '@/core/state/session-store';
import { provideTestClock } from '@/core/time/testing';
import { PeoplePicker } from './people-picker';

async function setUp() {
  localStorage.clear();
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    providers: [...provideTestClock(), ...provideFakeSockets(sockets)],
  });
  useTestBackend();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const session = TestBed.inject(SessionStore);
  const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets, []);
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(PeoplePicker);
  const element: HTMLElement = fixture.nativeElement;
  const type = async (text: string) => {
    const input = element.querySelector('input')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    TestBed.tick();
  };
  const names = () => [...element.querySelectorAll('li')].map((li) => li.textContent);
  return { socket, element, type, names };
}

describe('PeoplePicker', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a failed search and repeats it on request (RF09)', async () => {
    const { socket, element, type } = await setUp();
    await type('bru');
    expect(element.querySelector('mat-progress-spinner')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    socket.receive({
      type: 'error',
      requestId: socket.last().requestId,
      code: 'invalidRequest',
      message: 'x',
    });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    const alert = element.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Não foi possível pesquisar.');

    alert!.querySelector('button')!.click();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    const searches = socket.sent.filter((r) => r['action'] === 'search');
    expect(searches.map((r) => r['query'])).toEqual(['bru', 'bru']);
  });

  it('hides the people of the previous query while the next one loads', async () => {
    const { socket, type, names } = await setUp();
    await type('bru');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    answer(socket, { conversations: [], people: [BRUNO] });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    expect(names().join()).toContain('Bruno');

    await type('brux');
    expect(names()).toEqual([]);
  });

  it('shows empty state with role=status when search finishes without results (UX)', async () => {
    const { socket, element, type } = await setUp();
    await type('zzzz');
    expect(element.querySelector('[role="status"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    answer(socket, { conversations: [], people: [] });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    const status = element.querySelector('[role="status"]');
    expect(status?.textContent?.trim()).toBe('Nenhuma pessoa encontrada.');
  });

  it('disables search input and person selection while disconnected (B1)', async () => {
    const { socket, element, type } = await setUp();
    await type('bru');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS);
    answer(socket, { conversations: [], people: [BRUNO] });
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    const input = element.querySelector<HTMLInputElement>('input')!;
    const rowButton = element.querySelector<HTMLButtonElement>('app-result-row button')!;
    expect(input.disabled).toBe(false);
    expect(rowButton.disabled).toBe(false);

    socket.drop();
    TestBed.tick();

    expect(input.disabled).toBe(true);
    expect(rowButton.disabled).toBe(true);
  });
});
