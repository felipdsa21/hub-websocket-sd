import { TestBed } from '@angular/core/testing';
import { Temporal } from 'temporal-polyfill';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { Scenario, Scenarios } from '@/core/fixtures/scenarios';
import { Clock } from '@/core/time/clock';
import { ConversationsStore } from './conversations-store';
import { SessionStore } from './session-store';
import { UsersStore } from './users-store';

function setUp(scenarios: readonly Scenario[] = []) {
  const timeZone = 'America/Sao_Paulo';
  const now = Temporal.PlainDateTime.from('2026-11-02T09:46').toZonedDateTime(timeZone).toInstant();
  TestBed.configureTestingModule({
    providers: [
      { provide: Clock, useValue: { context: () => ({ now, timeZone }) } },
      {
        provide: Scenarios,
        useValue: { has: (s: Scenario) => scenarios.includes(s), any: () => scenarios.length > 0 },
      },
    ],
  });
  return TestBed.inject(SessionStore);
}

describe('SessionStore', () => {
  it('enters in place of Marina, with the conversation list of the design', () => {
    const session = setUp();
    session.enter('Ju.Teste', '  Ju  ');

    expect(session.user()).toEqual({ username: 'ju.teste', displayName: 'Ju' });
    const conversations = TestBed.inject(ConversationsStore);
    const users = TestBed.inject(UsersStore);
    const names = conversations
      .sorted()
      .map((c) =>
        c.type === 'group'
          ? c.name
          : users.get(c.members.find((m) => m !== 'ju.teste')!)?.displayName,
      );
    expect(names).toEqual([
      'Equipe SD',
      'Bruno Lima',
      'Trabalho final',
      'Carla Souza',
      'Semana de provas',
      'Diego Martins',
      'Eduarda Rocha',
      'Ana Lima',
      'Ana Lima',
    ]);
    expect([...conversations.withNewActivity()].map((id) => conversations.get(id)?.name)).toEqual([
      'Trabalho final',
    ]);
  });

  it('uses the username when the display name is empty', () => {
    const session = setUp();
    session.enter('marina', '   ');
    expect(session.user()?.displayName).toBe('marina');
  });

  it('only knows users who share a conversation, so a member who left shows by username', () => {
    setUp().enter('marina', 'Marina Alves');
    const users = TestBed.inject(UsersStore);
    expect(users.get('bruno')?.displayName).toBe('Bruno Lima');
    expect(users.get('gabriel.nunes')).toBeUndefined();
  });

  it('has more than two pages of history in Equipe SD', () => {
    setUp().enter('marina', 'Marina Alves');
    const messages = TestBed.inject(HubFixtures).data()!.messages;
    const team = TestBed.inject(ConversationsStore).sorted()[0]!;
    expect(messages.filter((m) => m.conversationId === team.conversationId).length).toBeGreaterThan(
      100,
    );
    expect(new Set(messages.map((m) => m.messageId)).size).toBe(messages.length);
  });

  it('fails or keeps connecting in the entry scenarios', () => {
    expect(withScenario('entrar-falha')).toBe('failed');
    TestBed.resetTestingModule();
    expect(withScenario('carregando')).toBe('connecting');

    function withScenario(scenario: Scenario) {
      const session = setUp([scenario]);
      session.enter('marina', '');
      expect(session.user()).toBeNull();
      return session.enterStatus();
    }
  });

  it('starts without conversations in the "sem-conversas" scenario', () => {
    setUp(['sem-conversas']).enter('marina', '');
    expect(TestBed.inject(ConversationsStore).sorted()).toEqual([]);
  });

  it('changes the display name with a newer version of the own state', () => {
    const session = setUp();
    session.enter('marina', 'Marina Alves');
    const users = TestBed.inject(UsersStore);
    const before = users.get('marina')!.version;

    session.changeDisplayName('  Marina A.  ');

    expect(session.user()?.displayName).toBe('Marina A.');
    expect(users.get('marina')).toMatchObject({ displayName: 'Marina A.', version: before + 1 });
  });
});
