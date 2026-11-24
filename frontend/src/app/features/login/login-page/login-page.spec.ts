import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FakeWebSocket, answer, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { SessionStore } from '@/core/state/session-store';
import { userStorageKey } from '@/core/state/user-storage';
import { provideTestClock } from '@/core/time/testing';
import { LoginPage } from './login-page';

async function render() {
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [provideRouter([]), ...provideTestClock(), ...provideFakeSockets(sockets)],
  });
  useTestBackend();
  const fixture = TestBed.createComponent(LoginPage);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  const inputs = element.querySelectorAll('input');
  const button = element.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const type = async (index: number, value: string) => {
    const input = inputs[index]!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new FocusEvent('blur'));
    await fixture.whenStable();
  };
  return { element, button, type, fixture, sockets };
}

describe('LoginPage', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  it('shows the spaces error in the field and keeps "Entrar" disabled', async () => {
    const { element, button, type } = await render();
    expect(button.disabled).toBe(true);

    await type(0, 'Marina Alves');

    expect(element.querySelector('mat-error')?.textContent).toContain('Sem espaços');
    expect(button.disabled).toBe(true);
  });

  it('enters with the username in lowercase and goes to the list', async () => {
    const { button, type, fixture, sockets } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    await type(0, 'Marina');
    await type(1, 'Marina Alves');
    button.click();
    expect(new URL(sockets[0]!.url).searchParams.get('username')).toBe('marina');
    sockets[0]!.open();
    await Promise.resolve();
    answer(sockets[0]!, { serverTime: 1000, updated: [], conversations: [] });
    await fixture.whenStable();

    expect(TestBed.inject(SessionStore).user()).toEqual({
      username: 'marina',
      displayName: 'Marina Alves',
    });
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows the connection failure without leaving the entry screen', async () => {
    const { element, button, type, fixture, sockets } = await render();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await type(0, 'marina');
    button.click();
    sockets[0]!.drop();
    await fixture.whenStable();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível conectar. Tente de novo.',
    );
    expect(TestBed.inject(SessionStore).user()).toBeNull();
  });

  it('chooses the theme from a menu on the entry screen', async () => {
    const { element, fixture } = await render();
    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Tema"]')!;
    expect(trigger.textContent?.trim()).toBe('brightness_auto');

    trigger.click();
    await fixture.whenStable();
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map((o) => [o.textContent?.trim(), o.getAttribute('aria-checked')])).toEqual([
      ['checkSistema', 'true'],
      ['Claro', 'false'],
      ['Escuro', 'false'],
    ]);

    options[2]!.click();
    await fixture.whenStable();
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(trigger.textContent?.trim()).toBe('dark_mode');
  });

  it('proposes the saved display name for a username without overwriting manual edits (RF01)', async () => {
    localStorage.clear();
    localStorage.setItem(userStorageKey('alice'), JSON.stringify({ displayName: 'Alice Silva' }));
    localStorage.setItem(userStorageKey('bruno'), JSON.stringify({ displayName: 'Bruno Lima' }));
    const { element, type } = await render();
    const displayInput = element.querySelectorAll('input')[1]!;

    await type(0, 'alice');
    expect(displayInput.value).toBe('Alice Silva');

    await type(0, 'bruno');
    expect(displayInput.value).toBe('Bruno Lima');

    // Switching to an unknown user clears the auto-suggested value.
    await type(0, 'carla');
    expect(displayInput.value).toBe('');

    // Manual edit is preserved even if username changes back to a user with a saved name.
    await type(0, 'alice');
    expect(displayInput.value).toBe('Alice Silva');
    await type(1, 'Meu Nome');
    await type(0, 'bruno');
    expect(displayInput.value).toBe('Meu Nome');
    localStorage.clear();
  });

  it('rejects control and bidi characters in displayName', async () => {
    const { element, button, type } = await render();

    await type(0, 'marina');
    await type(1, 'Marina\u202eAlves');

    expect(button.disabled).toBe(true);
    expect(element.querySelector('mat-error')?.textContent).toContain('caracteres de controle');
  });

  it('explains a displayName made only of invisible characters', async () => {
    const { element, button, type } = await render();

    await type(0, 'marina');
    await type(1, '\u3164');

    expect(button.disabled).toBe(true);
    expect(element.querySelector('mat-error')?.textContent).toContain('invisíveis');
  });
});
