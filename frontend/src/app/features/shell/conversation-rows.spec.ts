import { Temporal } from 'temporal-polyfill';
import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { ConversationRowsInput, conversationRows } from './conversation-rows';

const timeZone = 'America/Sao_Paulo';
const now = Temporal.PlainDateTime.from('2026-11-02T10:00').toZonedDateTime(timeZone);

const user = (username: string, displayName: string, online: boolean): UserState => ({
  username,
  displayName,
  online,
  version: 1,
});

const direct = (other: string, fields: Partial<Conversation> = {}): Conversation => ({
  conversationId: `d:${other}:marina`,
  type: 'direct',
  members: ['marina', other],
  joinedAt: 0,
  ...fields,
});

function rows(fields: Partial<ConversationRowsInput>) {
  return conversationRows({
    conversations: [],
    me: 'marina',
    users: new Map(
      [
        user('marina', 'Marina Alves', true),
        user('ana.lima', 'Ana Lima', true),
        user('analima', 'Ana Lima', false),
        user('bruno', 'Bruno Lima', true),
      ].map((u) => [u.username, u]),
    ),
    withNewActivity: new Set(),
    opened: new Set(),
    connected: true,
    time: { now: now.toInstant(), timeZone },
    ...fields,
  });
}

describe('conversationRows', () => {
  it('shows presence, and the username next to repeated display names', () => {
    const result = rows({
      conversations: [direct('ana.lima'), direct('analima'), direct('bruno')],
    });
    expect(result.map((r) => [r.title, r.subtitle, r.presence])).toEqual([
      ['Ana Lima', '@ana.lima · Online', 'online'],
      ['Ana Lima', '@analima · Offline', 'offline'],
      ['Bruno Lima', 'Online', 'online'],
    ]);
  });

  it('hides presence and dims unopened conversations while offline', () => {
    const result = rows({
      conversations: [direct('ana.lima'), direct('analima'), direct('bruno')],
      opened: new Set(['d:bruno:marina']),
      connected: false,
    });
    expect(result.map((r) => [r.subtitle, r.presence, r.dimmed])).toEqual([
      ['@ana.lima', null, true],
      ['@analima', null, true],
      ['', null, false],
    ]);
  });

  it('shows a partner the client knows nothing about by username, with the neutral avatar', () => {
    const [row] = rows({ conversations: [direct('gabriel.nunes')] });
    expect(row).toMatchObject({ title: '@gabriel.nunes', avatarKind: 'unknown', presence: null });
  });

  it('shows groups with the member count and the time of the last message', () => {
    const [row] = rows({
      conversations: [
        {
          conversationId: 'g:1',
          type: 'group',
          name: 'Equipe SD',
          members: ['marina', 'bruno', 'ana.lima'],
          joinedAt: 0,
          lastMessageAt: now.subtract({ days: 1 }).epochMilliseconds,
          lastMessageBy: 'bruno',
        },
      ],
      withNewActivity: new Set(['g:1']),
    });
    expect(row).toMatchObject({
      title: 'Equipe SD',
      subtitle: '3 membros',
      avatarKind: 'group',
      time: 'Ontem',
      newActivity: true,
    });
  });
});
