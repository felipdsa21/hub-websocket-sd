import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LeaveGroupDialog } from './leave-group-dialog';

describe('LeaveGroupDialog', () => {
  let component: LeaveGroupDialog;
  let fixture: ComponentFixture<LeaveGroupDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeaveGroupDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(LeaveGroupDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('groupName', 'Equipe SD');
    fixture.componentRef.setInput('lastMember', false);
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
