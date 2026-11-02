import { TestBed } from '@angular/core/testing';
import { Temporal } from 'temporal-polyfill';
import { Scenario, Scenarios } from '@/core/fixtures/scenarios';
import { Clock } from '@/core/time/clock';
import { addMembersNotice } from '@/shared/format/error-messages';
import { ConversationsStore } from './conversations-store';
import { GroupActions } from './group-actions';
import { MessagesStore } from './messages-store';
import { SessionStore } from './session-store';
import { UsersStore } from './users-store';

const TEAM = 'g:3f2b7c1e-5a4d-4e8f-9b6a-1c2d3e4f5a6b';

function setUp(scenarios: readonly Scenario[] = []) {
  const timeZone = 'America/Sao_Paulo';
  const now = Temporal.PlainDateTime.from('2026-11-02T09:46').toZonedDateTime(timeZone).toInstant();
  TestBed.configureTestingModule({
    providers: [
      { provide: Clock, useValue: { context: () => ({ now, timeZone }), instant: () => now } },
      {
        provide: Scenarios,
        useValue: { has: (s: Scenario) => scenarios.includes(s), any: () => scenarios.length > 0 },
      },
    ],
  });
  TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
  return TestBed.inject(GroupActions);
}

describe('GroupActions', () => {
  it('adds people as members, makes them known and records the notices', () => {
    const actions = setUp();
    const result = actions.addMembers(TEAM, ['gabriel.nunes', 'juliana']);

    expect(result).toEqual({ added: ['gabriel.nunes', 'juliana'], failed: [] });
    expect(TestBed.inject(ConversationsStore).get(TEAM)?.members).toContain('juliana');
    expect(TestBed.inject(UsersStore).get('gabriel.nunes')?.displayName).toBe('Gabriel Nunes');
    expect(
      TestBed.inject(MessagesStore)
        .noticesIn(TEAM)
        .map((n) => n.username),
    ).toEqual(['diego', 'gabriel.nunes', 'juliana']);
  });

  it('reports people who already are members or do not exist', () => {
    const result = setUp().addMembers(TEAM, ['bruno', 'ninguem']);
    expect(result.added).toEqual([]);
    expect(
      result.failed.map((f) => (f.reason === 'noResponse' ? f.reason : f.reason.code)),
    ).toEqual(['invalidOperation', 'notFound']);
  });

  it('leaves the group, or keeps it when the scenario rejects the request', () => {
    expect(setUp().leave(TEAM)).toBe('left');
    expect(TestBed.inject(ConversationsStore).get(TEAM)).toBeUndefined();

    TestBed.resetTestingModule();
    expect(setUp(['erro-acao']).leave(TEAM)).toEqual(expect.objectContaining({ code: 'conflict' }));
    expect(TestBed.inject(ConversationsStore).get(TEAM)).toBeDefined();
  });
});

describe('addMembersNotice', () => {
  const nameOf = (u: string) => ({ bruno: 'Bruno Lima', gabriel: 'Gabriel Nunes' })[u] ?? u;

  it('names who went in and why the others failed, as in the design', () => {
    expect(
      addMembersNotice(
        {
          added: ['bruno'],
          failed: [{ username: 'gabriel', reason: { code: 'invalidOperation', message: '' } }],
        },
        nameOf,
      ),
    ).toBe('Bruno Lima foi adicionado. Gabriel Nunes já é membro do grupo.');
  });

  it('says nothing when everyone was added', () => {
    expect(addMembersNotice({ added: ['bruno'], failed: [] }, nameOf)).toBeNull();
  });
});
