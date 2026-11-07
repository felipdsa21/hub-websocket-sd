import { Conversation, directConversationId } from '@/core/model/conversation';
import { Message, messageSk } from '@/core/model/message';
import { MemberNotice } from '@/core/model/notice';
import { UserState } from '@/core/model/user';
import { TimeContext } from '@/core/time/time-format';

/** What the backend would know, seen by the user who entered, who takes Marina's place. */
export interface Fixtures {
  /** Every user, for the search. */
  readonly directory: readonly UserState[];
  readonly conversations: readonly Conversation[];
  /** All messages of every conversation; the client loads them page by page. */
  readonly messages: readonly Message[];
  /** `sentAt` of the last message seen in each conversation (RF10). */
  readonly seen: ReadonlyMap<string, number>;
  readonly notices: readonly MemberNotice[];
}

export interface FixtureUser {
  readonly username: string;
  readonly displayName: string;
}

type Line = readonly [sender: string, text: string, sentAt: number];

const FILLER = [
  'Atualizei o diagrama da arquitetura com o presenceSweeper.',
  'Alguém já testou o $disconnect com a aba fechada?',
  'Subi a tabela Memberships no stack dev.',
  'O fan-out com 410 está removendo a conexão certinho.',
  'Revisei a seção 4.3; ficou bem mais clara.',
  'Vou rodar o T3 de novo depois do almoço.',
  'O painel do CloudWatch já mostra o IntegrationLatency.',
  'Quem fica com os logs anonimizados?',
  'Pode deixar comigo.',
  'Abri o PR com o heartbeat de 30 s.',
  'Aprovei, só deixei um comentário sobre o backoff.',
  'A reconexão está voltando em menos de 2 s aqui.',
  'Testei com 10 usuários e ficou abaixo de 500 ms.',
  'Faltam só as capturas de tela do T6.',
  'Amanhã eu faço as do T6.',
  'Combinado, obrigado!',
] as const;

export function createFixtures(me: FixtureUser, context: TimeContext): Fixtures {
  const timeZone = context.timeZone;
  const now = context.now.toZonedDateTimeISO(timeZone);
  const today = now.toPlainDate();
  const minutesAgo = (minutes: number) => now.subtract({ minutes }).epochMilliseconds;
  const daysAgo = (days: number, time: string) =>
    today.subtract({ days }).toZonedDateTime({ timeZone, plainTime: time }).epochMilliseconds;

  const user = (username: string, displayName: string, online: boolean): UserState => ({
    username,
    displayName,
    online,
    version: 1,
  });
  const directory = [
    user(me.username, me.displayName, true),
    user('bruno', 'Bruno Lima', true),
    user('carla', 'Carla Souza', false),
    user('diego', 'Diego Martins', true),
    user('eduarda', 'Eduarda Rocha', false),
    user('ana.lima', 'Ana Lima', true),
    user('analima', 'Ana Lima', false),
    user('juliana', 'Juliana Ferreira', true),
    user('gabriel.nunes', 'Gabriel Nunes', true),
    user('gabriela', 'Gabriela Prado', false),
    user('mariana', 'Mariana Costa', false),
  ];

  let nextId = 1;
  const messageId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  const conversations: Conversation[] = [];
  const messages: Message[] = [];

  const add = (
    conversation: Omit<Conversation, 'lastMessageAt' | 'lastMessageBy'>,
    lines: readonly Line[],
  ) => {
    for (const [sender, text, sentAt] of lines) {
      const id = messageId();
      messages.push({
        conversationId: conversation.conversationId,
        sk: messageSk(sentAt, sender, id),
        messageId: id,
        sender,
        text,
        sentAt,
      });
    }
    const last = lines.at(-1);
    conversations.push({ ...conversation, lastMessageAt: last?.[2], lastMessageBy: last?.[0] });
    return conversation.conversationId;
  };
  const direct = (other: string, lines: readonly Line[]) =>
    add(
      {
        conversationId: directConversationId(me.username, other),
        type: 'direct',
        members: [me.username, other],
        joinedAt: daysAgo(40, '10:00'),
      },
      lines,
    );
  const group = (id: string, name: string, members: readonly string[], lines: readonly Line[]) =>
    add(
      {
        conversationId: `g:${id}`,
        type: 'group',
        name,
        members: [me.username, ...members],
        joinedAt: daysAgo(30, '10:00'),
      },
      lines,
    );

  // Enough history for more than two pages of 50 (architecture, section 4.4). Diego only joins
  // the group today, so he isn't among the senders.
  const teamSenders = ['carla', 'bruno', me.username, 'eduarda'];
  const teamHistory: Line[] = [];
  for (let i = 0; i < 120; i++) {
    const day = 9 - Math.floor(i / 15);
    const minute = 9 * 60 + (i % 15) * 20;
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    teamHistory.push([
      teamSenders[i % teamSenders.length]!,
      FILLER[i % FILLER.length]!,
      daysAgo(day, time),
    ]);
  }
  const brunoReportAt = minutesAgo(16);
  const teamId = group(
    '3f2b7c1e-5a4d-4e8f-9b6a-1c2d3e4f5a6b',
    'Equipe SD',
    ['bruno', 'diego', 'carla', 'eduarda'],
    [
      ...teamHistory,
      ['carla', 'Subi o stack dev com o presenceSweeper novo.', daysAgo(1, '18:20')],
      ['carla', 'Quem puder, roda o T7 amanhã cedo.', daysAgo(1, '18:21')],
      [
        'bruno',
        'Rodei o T7 agora: a reconexão voltou sozinha e as duas mensagens pendentes chegaram uma vez só.',
        brunoReportAt,
      ],
      ['diego', 'Boa! Vou medir a latência com os 10 usuários.', minutesAgo(4)],
      [me.username, 'Ótimo. Eu fecho o painel do CloudWatch depois do almoço.', minutesAgo(1)],
      [me.username, 'Alguém já conferiu os logs anonimizados?', minutesAgo(0)],
    ],
  );
  const diegoJoinedAfter = messages.find(
    (m) => m.conversationId === teamId && m.sentAt === brunoReportAt,
  )?.sk;

  direct('bruno', [
    ['bruno', 'Oi! Conseguiu ver o erro do T2, passo 4?', minutesAgo(33)],
    ['bruno', 'O identificador da mensagem voltou no erro, como pede o RF09.', minutesAgo(32)],
    [me.username, 'Vi sim, está certo. Vou colocar o log no relatório.', minutesAgo(30)],
    ['bruno', 'Fechado. Te mando o resto quando terminar o teste de carga.', minutesAgo(17)],
    [me.username, 'Combinado!', minutesAgo(15)],
  ]);

  // Gabriel left the group, so the client only knows his username (RF04, RF06).
  const projectId = group(
    '8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a',
    'Trabalho final',
    ['carla', 'diego'],
    [
      ['carla', 'Criei o grupo para o trabalho de SD.', daysAgo(12, '14:00')],
      [me.username, 'Boa, obrigada!', daysAgo(12, '14:03')],
      ['gabriel.nunes', 'Deixei o roteiro da apresentação no repositório.', daysAgo(12, '15:20')],
      ['carla', 'Obrigada! Vou revisar hoje.', daysAgo(12, '15:31')],
      ['diego', 'Separei os slides por requisito.', daysAgo(2, '10:15')],
      ['carla', 'Alguém revisa a seção de testes até amanhã?', daysAgo(1, '21:10')],
    ],
  );

  direct('carla', [
    ['carla', 'Fechei a revisão da arquitetura.', daysAgo(1, '16:02')],
    [me.username, 'Valeu! Vou ler hoje à noite.', daysAgo(1, '16:10')],
  ]);

  group(
    '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f',
    'Semana de provas',
    ['bruno', 'eduarda', 'ana.lima'],
    [
      ['eduarda', 'Alguém tem o resumo de redes?', daysAgo(3, '19:00')],
      ['ana.lima', 'Tenho, mando aqui à noite.', daysAgo(3, '19:12')],
      ['bruno', 'A prova de SD é na quinta.', daysAgo(3, '20:05')],
    ],
  );

  direct('diego', [
    ['diego', 'Você consegue revisar meu PR hoje?', daysAgo(6, '11:20')],
    [me.username, 'Consigo, olho depois da aula.', daysAgo(6, '11:42')],
  ]);

  direct('eduarda', [
    [me.username, 'Você vai na monitoria amanhã?', daysAgo(10, '17:30')],
    ['eduarda', 'Vou sim!', daysAgo(10, '17:45')],
  ]);

  direct('ana.lima', [
    ['ana.lima', 'Também entrei no grupo da semana de provas.', daysAgo(12, '11:02')],
  ]);

  direct('analima', [
    [me.username, 'Oi, Ana! Você está na turma de terça?', daysAgo(14, '09:10')],
    ['analima', 'Estou, sim.', daysAgo(14, '09:31')],
  ]);

  const seen = new Map(
    conversations
      .filter((c) => c.conversationId !== projectId && c.lastMessageAt !== undefined)
      .map((c) => [c.conversationId, c.lastMessageAt!] as const),
  );

  const notices: MemberNotice[] = [
    {
      id: 'fixture-diego-joined',
      conversationId: teamId,
      kind: 'joined',
      username: 'diego',
      afterSk: diegoJoinedAfter,
    },
  ];

  return { directory, conversations, messages, seen, notices };
}
