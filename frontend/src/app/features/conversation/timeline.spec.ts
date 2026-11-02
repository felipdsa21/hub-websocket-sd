import { Temporal } from 'temporal-polyfill';
import { Message, messageSk } from '@/core/model/message';
import { UserState } from '@/core/model/user';
import { TimelineInput, TimelineMessage, buildTimeline } from './timeline';

const timeZone = 'America/Sao_Paulo';
const now = Temporal.PlainDateTime.from('2026-11-02T10:00').toZonedDateTime(timeZone);
const at = (iso: string) =>
  Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;

let nextId = 1;
function message(sender: string, iso: string, text = 'oi'): Message {
  const messageId = `id-${nextId++}`;
  const sentAt = at(iso);
  return {
    conversationId: 'g:1',
    sk: messageSk(sentAt, sender, messageId),
    messageId,
    sender,
    text,
    sentAt,
  };
}

const user = (username: string, displayName: string): UserState => ({
  username,
  displayName,
  online: true,
  version: 1,
});

function timeline(fields: Partial<TimelineInput>) {
  return buildTimeline({
    messages: [],
    outgoing: [],
    notices: [],
    atStart: false,
    me: 'marina',
    users: new Map(
      [
        user('marina', 'Marina Alves'),
        user('bruno', 'Bruno Lima'),
        user('ana.lima', 'Ana Lima'),
        user('analima', 'Ana Lima'),
      ].map((u) => [u.username, u]),
    ),
    connected: true,
    time: { now: now.toInstant(), timeZone },
    ...fields,
  });
}

const messagesOf = (items: ReturnType<typeof timeline>) =>
  items.filter((i): i is TimelineMessage => i.kind === 'message');

describe('buildTimeline', () => {
  it('groups messages of the same sender up to 5 minutes apart, inclusive', () => {
    const items = timeline({
      messages: [
        message('bruno', '2026-11-02T09:00'),
        message('bruno', '2026-11-02T09:05'),
        message('bruno', '2026-11-02T09:10:01'),
        message('marina', '2026-11-02T09:11'),
      ],
    });
    expect(messagesOf(items).map((m) => m.first)).toEqual([true, false, true, true]);
    expect(messagesOf(items)[0]?.sender?.label).toBe('Bruno Lima');
    expect(messagesOf(items)[3]?.sender).toBeUndefined();
  });

  it('separates days and starts a new group after the separator', () => {
    const items = timeline({
      atStart: true,
      messages: [message('bruno', '2026-11-01T23:58'), message('bruno', '2026-11-02T00:01')],
    });
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.kind))).toEqual([
      'start',
      'Ontem',
      'message',
      'Hoje',
      'message',
    ]);
    expect(messagesOf(items).map((m) => m.first)).toEqual([true, true]);
  });

  it('places a member notice after the message it followed, breaking the group', () => {
    const first = message('bruno', '2026-11-02T09:00');
    const items = timeline({
      messages: [first, message('bruno', '2026-11-02T09:01')],
      notices: [
        { id: 'n', conversationId: 'g:1', kind: 'left', username: 'bruno', afterSk: first.sk },
      ],
    });
    expect(items.map((i) => (i.kind === 'notice' ? i.text : i.kind))).toEqual([
      'day',
      'message',
      'Bruno Lima saiu do grupo',
      'message',
    ]);
    expect(messagesOf(items).map((m) => m.first)).toEqual([true, true]);
  });

  it('shows unknown senders by username and repeated names with the username', () => {
    const items = messagesOf(
      timeline({
        messages: [
          message('gabriel.nunes', '2026-11-02T09:00'),
          message('ana.lima', '2026-11-02T09:10'),
          message('analima', '2026-11-02T09:20'),
        ],
      }),
    );
    expect(items.map((m) => [m.sender?.label, m.sender?.avatarKind])).toEqual([
      ['@gabriel.nunes', 'unknown'],
      ['Ana Lima · @ana.lima', 'person'],
      ['Ana Lima · @analima', 'person'],
    ]);
  });

  it('puts unconfirmed messages at the end, without a time', () => {
    const items = messagesOf(
      timeline({
        messages: [message('marina', '2026-11-02T09:00')],
        outgoing: [
          { conversationId: 'g:1', messageId: 'p', text: 'pendente' },
          {
            conversationId: 'g:1',
            messageId: 'f',
            text: 'recusada',
            error: { code: 'invalidRequest', message: '' },
          },
        ],
        connected: false,
      }),
    );
    expect(items.map((m) => [m.text, m.time, m.status?.text])).toEqual([
      ['oi', '09:00', undefined],
      ['pendente', undefined, 'Aguardando conexão'],
      ['recusada', undefined, 'Não enviada: requisição fora do formato'],
    ]);
  });
});
