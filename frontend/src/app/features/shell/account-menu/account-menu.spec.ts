import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of } from 'rxjs';
import { SessionStore } from '@/core/state/session-store';
import { AccountMenu } from './account-menu';

describe('AccountMenu', () => {
  let component: AccountMenu;
  let fixture: ComponentFixture<AccountMenu>;

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AccountMenu],
    }).compileComponents();

    fixture = TestBed.createComponent(AccountMenu);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('chooses the theme from the "Tema" submenu', async () => {
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.trigger')!.click();
    await fixture.whenStable();
    const submenu = [...document.querySelectorAll<HTMLElement>('[mat-menu-item]')].find(
      (item) => item.textContent?.trim() === 'Tema',
    )!;
    submenu.click();
    await fixture.whenStable();
    const dark = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((o) =>
      o.textContent?.includes('Escuro'),
    )!;
    dark.click();
    await fixture.whenStable();

    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });

  it('reports failure via snackbar when changing displayName fails (RF01)', async () => {
    const dialog = TestBed.inject(MatDialog);
    const snackBar = TestBed.inject(MatSnackBar);
    const session = TestBed.inject(SessionStore);
    vi.spyOn(dialog, 'open').mockReturnValue({
      afterClosed: () => of('Novo Nome'),
    } as MatDialogRef<unknown>);
    vi.spyOn(session, 'changeDisplayName').mockResolvedValue(false);
    const openSnack = vi.spyOn(snackBar, 'open').mockImplementation(() => ({}) as never);

    (component as unknown as { changeDisplayName(): void }).changeDisplayName();
    await Promise.resolve();

    expect(openSnack).toHaveBeenCalledWith(
      'Não foi possível alterar o nome de exibição. Tente de novo.',
      undefined,
      { duration: 6000 },
    );
  });
});
