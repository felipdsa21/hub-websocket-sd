import { TestBed } from '@angular/core/testing';
import { Scenario } from '@/core/fixtures/scenarios';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { ConversationActions } from './conversation-actions';
import { ConversationsStore } from './conversations-store';
import { SearchStore } from './search-store';
import { SessionStore } from './session-store';

function setUp(scenarios: readonly Scenario[] = []) {
  TestBed.configureTestingModule({ providers: provideTestFixtures({ scenarios }) });
  TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
}

describe('SearchStore', () => {
  it('finds conversations by name and people without a visible direct chat, as in the design', () => {
    setUp();
    const search = TestBed.inject(SearchStore);
    search.search('ANA');

    const conversations = TestBed.inject(ConversationsStore);
    const { conversations: found, people } = search.results();
    expect(found.map((c) => c.name ?? c.conversationId)).toEqual([
      'Semana de provas',
      'd:ana.lima:marina',
      'd:analima:marina',
    ]);
    expect(people.map((p) => p.displayName)).toEqual(['Juliana Ferreira', 'Mariana Costa']);
    expect(conversations.sorted().length).toBe(9);
  });

  it('matches a person with a direct chat by username through that conversation', () => {
    setUp();
    const search = TestBed.inject(SearchStore);
    search.search('ana.lima');
    expect(search.results().conversations.map((c) => c.conversationId)).toEqual([
      'd:ana.lima:marina',
    ]);
    expect(search.results().people).toEqual([]);
  });

  it('fails in the "erro-pesquisa" scenario and can be retried', () => {
    setUp(['erro-pesquisa']);
    const search = TestBed.inject(SearchStore);
    search.search('ana');
    expect(search.status()).toBe('error');
    search.retry();
    expect(search.status()).toBe('error');
  });
});

describe('ConversationActions', () => {
  it('opens the existing direct chat instead of starting another (RF03)', () => {
    setUp();
    const result = TestBed.inject(ConversationActions).openDirect('bruno');
    expect(result).toEqual({ conversationId: 'd:bruno:marina' });
    expect(TestBed.inject(ConversationsStore).sorted().length).toBe(9);
  });

  it('starts a new direct chat and a new group on top of the list', () => {
    setUp();
    const actions = TestBed.inject(ConversationActions);
    const conversations = TestBed.inject(ConversationsStore);

    actions.openDirect('juliana');
    expect(conversations.sorted()[0]?.conversationId).toBe('d:juliana:marina');

    const group = actions.createGroup('  Revisão  ', ['diego']);
    const created = conversations.sorted()[0]!;
    expect(group).toEqual({ conversationId: created.conversationId });
    expect(created).toMatchObject({ type: 'group', name: 'Revisão', members: ['marina', 'diego'] });
  });

  it('reports missing users and unanswered requests in the action scenarios', () => {
    setUp(['erro-acao']);
    expect(TestBed.inject(ConversationActions).createGroup('G', ['diego', 'bruno'])).toEqual(
      expect.objectContaining({ code: 'notFound', details: { usernames: ['diego'] } }),
    );

    TestBed.resetTestingModule();
    setUp(['sem-resposta']);
    expect(TestBed.inject(ConversationActions).openDirect('juliana')).toBe('noResponse');
  });
});
