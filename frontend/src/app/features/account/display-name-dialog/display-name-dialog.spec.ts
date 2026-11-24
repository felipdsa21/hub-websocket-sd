import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { DisplayNameDialog } from './display-name-dialog';

describe('DisplayNameDialog', () => {
  let component: DisplayNameDialog;
  let fixture: ComponentFixture<DisplayNameDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DisplayNameDialog],
      providers: [{ provide: MatDialogRef, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(DisplayNameDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('displayName', 'Marina Alves');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('disables saving when displayName contains control or bidi characters', async () => {
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input')!;
    const submit = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    input.value = 'Ana\u202eBia';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new FocusEvent('blur'));
    await fixture.whenStable();

    expect(submit.disabled).toBe(true);
  });
});
