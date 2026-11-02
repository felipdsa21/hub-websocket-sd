import { TestBed } from '@angular/core/testing';
import { Temporal } from 'temporal-polyfill';
import { Scenario, Scenarios } from '@/core/fixtures/scenarios';
import { Clock } from '@/core/time/clock';
import { ConversationsStore } from './conversations-store';
import { HISTORY_PAGE_SIZE, MessagesStore } from './messages-store';
import { SessionStore } from './session-store';

const TEAM = 'g:3f2b7c1e-5a4d-4e8f-9b6a-1c2d3e4f5a6b';
const BRUNO = 'd:bruno:marina';

function setUp(scenarios: readonly Scenario[] = []) {
  const timeZone = 'America/Sao_Paulo';
  const now = Temporal.PlainDateTime.from('2026-11-02T09:46').toZonedDateTime(timeZone).toInstant();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Clock,
        useValue: { context: () => ({ now, timeZone }), instant: () => now.add({ minutes: 1 }) },
      },
      {
        provide: Scenarios,
        useValue: { has: (s: Scenario) => scenarios.includes(s), any: () => scenarios.length > 0 },
      },
    ],
  });
  TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
  return TestBed.inject(MessagesStore);
}

describe('MessagesStore', () => {
  it('loads the history page by page until the start', () => {
    const messages = setUp();
    messages.open(TEAM);
    expect(messages.history(TEAM)?.messages.length).toBe(HISTORY_PAGE_SIZE);
    expect(messages.history(TEAM)?.hasOlder).toBe(true);

    messages.loadOlder(TEAM);
    messages.loadOlder(TEAM);

    const history = messages.history(TEAM)!;
    expect(history.hasOlder).toBe(false);
    expect(history.messages.length).toBeGreaterThan(2 * HISTORY_PAGE_SIZE);
    const sks = history.messages.map((m) => m.sk);
    expect(sks).toEqual([...sks].sort());
  });

  it('adds a sent message and moves the conversation up the list', () => {
    const messages = setUp();
    messages.open(BRUNO);
    messages.send(BRUNO, 'Teste');

    expect(messages.history(BRUNO)?.messages.at(-1)?.text).toBe('Teste');
    expect(TestBed.inject(ConversationsStore).sorted()[0]?.conversationId).toBe(BRUNO);
  });

  it('keeps the message pending while offline and rejects it in the "nao-enviada" scenario', () => {
    const offline = setUp(['sem-conexao']);
    offline.send(BRUNO, 'Pendente');
    expect(offline.outgoingIn(BRUNO)).toEqual([expect.objectContaining({ text: 'Pendente' })]);
    expect(offline.pendingCount()).toBe(1);

    TestBed.resetTestingModule();
    const rejecting = setUp(['nao-enviada']);
    rejecting.send(BRUNO, 'Recusada');
    const rejected = rejecting.outgoingIn(BRUNO).find((m) => m.text === 'Recusada')!;
    expect(rejected.error?.code).toBe('invalidRequest');

    rejecting.discard(rejected.messageId);
    expect(rejecting.outgoingIn(BRUNO).some((m) => m.text === 'Recusada')).toBe(false);
  });
});
