import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Scenario, Scenarios } from '@/core/fixtures/scenarios';
import { SessionStore } from '@/core/state/session-store';
import { LoginPage } from './login-page';

async function render(scenarios: readonly Scenario[] = []) {
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [
      provideRouter([]),
      {
        provide: Scenarios,
        useValue: { has: (s: Scenario) => scenarios.includes(s), any: () => scenarios.length > 0 },
      },
    ],
  });
  const fixture = TestBed.createComponent(LoginPage);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  const inputs = element.querySelectorAll('input');
  const button = element.querySelector('button')!;
  const type = async (index: number, value: string) => {
    const input = inputs[index]!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new FocusEvent('blur'));
    await fixture.whenStable();
  };
  return { element, button, type, fixture };
}

describe('LoginPage', () => {
  it('shows the spaces error in the field and keeps "Entrar" disabled', async () => {
    const { element, button, type } = await render();
    expect(button.disabled).toBe(true);

    await type(0, 'Marina Alves');

    expect(element.querySelector('mat-error')?.textContent).toContain('Sem espaços');
    expect(button.disabled).toBe(true);
  });

  it('enters with the username in lowercase and goes to the list', async () => {
    const { button, type } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    await type(0, 'Marina');
    await type(1, 'Marina Alves');
    button.click();

    expect(TestBed.inject(SessionStore).user()).toEqual({
      username: 'marina',
      displayName: 'Marina Alves',
    });
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows the connection failure without leaving the entry screen', async () => {
    const { element, button, type, fixture } = await render(['entrar-falha']);

    await type(0, 'marina');
    button.click();
    await fixture.whenStable();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível conectar. Tente de novo.',
    );
    expect(TestBed.inject(SessionStore).user()).toBeNull();
  });
});
