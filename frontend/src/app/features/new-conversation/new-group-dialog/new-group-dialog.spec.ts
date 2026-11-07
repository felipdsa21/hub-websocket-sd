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
});
