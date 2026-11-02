import { UserState } from '@/core/model/user';
import {
  initials,
  joinParts,
  membersLabel,
  nameWithUsername,
  partnerOf,
  presenceOf,
  presenceText,
  repeatedDisplayNames,
} from './display-names';

const user = (username: string, displayName: string): UserState => ({
  username,
  displayName,
  online: true,
  version: 1,
});

describe('display names', () => {
  it('takes the initials of the first and last words', () => {
    expect(initials('Marina Alves')).toBe('MA');
    expect(initials('Ana Paula de Souza')).toBe('AS');
    expect(initials('  bruno ')).toBe('B');
    expect(initials('édson lima')).toBe('ÉL');
  });

  it('finds display names used by more than one user', () => {
    const names = repeatedDisplayNames([
      user('ana.lima', 'Ana Lima'),
      user('analima', 'Ana Lima'),
      user('bruno', 'Bruno Lima'),
      user('bruno', 'Bruno Lima'),
    ]);
    expect([...names]).toEqual(['Ana Lima']);
  });

  it('labels the member count', () => {
    expect(membersLabel(1)).toBe('1 membro');
    expect(membersLabel(5)).toBe('5 membros');
  });

  it('shows the username next to a repeated display name only', () => {
    const repeated = new Set(['Ana Lima']);
    expect(nameWithUsername(user('ana.lima', 'Ana Lima'), repeated)).toBe('Ana Lima · @ana.lima');
    expect(nameWithUsername(user('bruno', 'Bruno Lima'), repeated)).toBe('Bruno Lima');
  });

  it('hides presence while offline and joins only the parts that exist', () => {
    const ana = user('ana.lima', 'Ana Lima');
    expect(presenceText(presenceOf(ana, true))).toBe('Online');
    expect(presenceOf(ana, false)).toBeNull();
    expect(joinParts('@ana.lima', false, presenceText(null), 'Chat privado')).toBe(
      '@ana.lima · Chat privado',
    );
  });

  it('finds the partner of a direct chat', () => {
    const chat = {
      conversationId: 'd:bruno:marina',
      type: 'direct' as const,
      members: ['marina', 'bruno'],
      joinedAt: 0,
    };
    expect(partnerOf(chat, 'marina')).toBe('bruno');
  });
});
