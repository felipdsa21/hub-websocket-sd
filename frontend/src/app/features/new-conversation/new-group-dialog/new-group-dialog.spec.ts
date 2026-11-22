import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { NewGroupDialog } from './new-group-dialog';

describe('NewGroupDialog', () => {
  let component: NewGroupDialog;
  let fixture: ComponentFixture<NewGroupDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewGroupDialog],
      providers: [{ provide: MatDialogRef, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(NewGroupDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('invalidates group names containing control or bidi characters (B6)', async () => {
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input')!;

    for (const invalid of ['Grupo\u202eSD', 'Grupo\tSD']) {
      input.value = invalid;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new FocusEvent('blur'));
      await fixture.whenStable();

      expect(root.querySelector('mat-error')?.textContent).toContain('Dê um nome ao grupo');
    }
  });
});
