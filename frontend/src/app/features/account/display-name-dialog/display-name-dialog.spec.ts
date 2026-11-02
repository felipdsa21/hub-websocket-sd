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
});
