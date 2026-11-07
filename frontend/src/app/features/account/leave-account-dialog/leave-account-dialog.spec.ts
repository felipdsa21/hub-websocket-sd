import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LeaveAccountDialog } from './leave-account-dialog';

describe('LeaveAccountDialog', () => {
  let component: LeaveAccountDialog;
  let fixture: ComponentFixture<LeaveAccountDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeaveAccountDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(LeaveAccountDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('pending', 0);
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
