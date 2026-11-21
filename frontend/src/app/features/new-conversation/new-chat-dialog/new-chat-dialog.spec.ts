import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { SessionStore } from '@/core/state/session-store';
import { NewChatDialog } from './new-chat-dialog';

describe('NewChatDialog', () => {
  let component: NewChatDialog;
  let fixture: ComponentFixture<NewChatDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewChatDialog],
      providers: [{ provide: MatDialogRef, useValue: { close: vi.fn() } }],
    }).compileComponents();

    fixture = TestBed.createComponent(NewChatDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('disables picking a person while offline (B1)', async () => {
    const close = vi.fn();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [NewChatDialog],
      providers: [
        ...provideTestFixtures({ scenarios: ['sem-conexao'] }),
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();

    await TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
    const offlineFixture = TestBed.createComponent(NewChatDialog);
    await offlineFixture.whenStable();

    const input = (offlineFixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input',
    )!;
    expect(input.disabled).toBe(true);
    (
      offlineFixture.componentInstance as unknown as {
        pick(u: { username: string; displayName: string; online: boolean; version: number }): void;
      }
    ).pick({ username: 'bruno', displayName: 'Bruno', online: true, version: 1 });
    expect(close).not.toHaveBeenCalled();
  });
});
