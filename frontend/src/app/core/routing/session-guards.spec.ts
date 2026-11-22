import { TestBed } from '@angular/core/testing';
import { UrlTree, provideRouter } from '@angular/router';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { FakeWebSocket, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { SessionStore } from '@/core/state/session-store';
import { CURRENT_USER_STORAGE_KEY, userStorageKey } from '@/core/state/user-storage';
import { guestGuard, sessionGuard } from './session-guards';

function setUpLive(scenarios: readonly ('sem-conexao' | 'entrar-falha')[] = []) {
  localStorage.clear();
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ...provideTestFixtures({ scenarios }),
      ...provideFakeSockets(sockets),
    ],
  });
  useTestBackend();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  return { sockets, session: TestBed.inject(SessionStore) };
}

describe('sessionGuard and guestGuard', () => {
  afterEach(() => localStorage.clear());

  it('restores a persisted valid user in sessionGuard without redirecting to /entrar', () => {
    const { sockets, session } = setUpLive();
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'Alice');
    localStorage.setItem(userStorageKey('alice'), JSON.stringify({ displayName: 'Alice Silva' }));

    const result = TestBed.runInInjectionContext(() => sessionGuard({} as never, {} as never));

    expect(result).toBe(true);
    expect(session.user()).toEqual({ username: 'alice', displayName: 'Alice Silva' });
    expect(sockets).toHaveLength(1);
    expect(new URL(sockets[0]!.url).searchParams.get('displayName')).toBe('Alice Silva');
  });

  it('clears an invalid persisted current user and redirects to /entrar', () => {
    const { sockets } = setUpLive();
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'nome invalido');

    const result = TestBed.runInInjectionContext(() => sessionGuard({} as never, {} as never));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/entrar');
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('restores a persisted user in guestGuard and redirects to /', () => {
    const { session } = setUpLive();
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'alice');

    const result = TestBed.runInInjectionContext(() => guestGuard({} as never, {} as never));

    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/');
    expect(session.user()).toEqual({ username: 'alice', displayName: 'alice' });
  });
});
