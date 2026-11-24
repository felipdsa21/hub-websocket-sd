import { TestBed } from '@angular/core/testing';
import { CURRENT_USER_STORAGE_KEY, UserStorage, userStorageKey } from './user-storage';

describe('UserStorage', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the seen marks of each user apart', () => {
    const storage = TestBed.inject(UserStorage);
    storage.writeSeen('alice', 'g:1', 500);
    storage.writeSeen('bruno', 'g:1', 700);

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

  it("keeps the marks another tab wrote and doesn't move a mark back", () => {
    const storage = TestBed.inject(UserStorage);
    storage.writeSeen('alice', 'g:1', 500);
    // Another tab of alice marks g:2 and a newer message in g:1.
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ seen: { 'g:1': 900, 'g:2': 300 } }),
    );

    storage.writeSeen('alice', 'g:1', 500);
    storage.writeSeen('alice', 'g:3', 100);

    expect(storage.readSeen('alice')).toEqual(
      new Map([
        ['g:1', 900],
        ['g:2', 300],
        ['g:3', 100],
      ]),
    );
  });

  it('persists the current browser user in lowercase and clears invalid values', () => {
    const storage = TestBed.inject(UserStorage);
    storage.writeCurrentUser('Alice.Silva');
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBe('alice.silva');
    expect(storage.readCurrentUser()).toBe('alice.silva');

    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'invalid user!');
    expect(storage.readCurrentUser()).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('persists and clears displayName while staying compatible with seen-only records', () => {
    const storage = TestBed.inject(UserStorage);
    localStorage.setItem(userStorageKey('alice'), JSON.stringify({ seen: { 'g:1': 500 } }));
    expect(storage.readDisplayName('alice')).toBeUndefined();

    storage.writeDisplayName('Alice', '  Alice Silva  ');
    expect(storage.readDisplayName('alice')).toBe('Alice Silva');
    expect(storage.readSeen('alice')).toEqual(new Map([['g:1', 500]]));

    storage.clearDisplayName('alice');
    expect(storage.readDisplayName('alice')).toBeUndefined();
    expect(storage.readSeen('alice')).toEqual(new Map([['g:1', 500]]));

    // Invalid saved displayName (e.g. control char) is erased without losing `seen`.
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ displayName: 'Ana\nBia', seen: { 'g:1': 500 } }),
    );
    expect(storage.readDisplayName('alice')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toEqual({
      seen: { 'g:1': 500 },
    });
  });
});
