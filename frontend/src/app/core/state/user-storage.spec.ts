import { TestBed } from '@angular/core/testing';
import { UserStorage, userStorageKey } from './user-storage';

describe('UserStorage', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the seen marks of each user apart', () => {
    const storage = TestBed.inject(UserStorage);
    storage.writeSeen('alice', new Map([['g:1', 500]]));
    storage.writeSeen('bruno', new Map([['g:1', 700]]));

    expect(storage.readSeen('alice')).toEqual(new Map([['g:1', 500]]));
    expect(storage.readSeen('bruno')).toEqual(new Map([['g:1', 700]]));
  });

  it('ignores what it cannot read', () => {
    const storage = TestBed.inject(UserStorage);
    localStorage.setItem(userStorageKey('alice'), '{not json');
    expect(storage.readSeen('alice').size).toBe(0);

    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ seen: { 'g:1': 'x', 'g:2': 3 } }),
    );
    expect(storage.readSeen('alice')).toEqual(new Map([['g:2', 3]]));
  });
});
