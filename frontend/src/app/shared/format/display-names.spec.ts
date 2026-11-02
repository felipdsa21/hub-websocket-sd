import { UserState } from '@/core/model/user';
import { initials, membersLabel, repeatedDisplayNames } from './display-names';

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
});
