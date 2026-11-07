import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { AddPeopleDialog } from './add-people-dialog';

describe('AddPeopleDialog', () => {
  let component: AddPeopleDialog;
  let fixture: ComponentFixture<AddPeopleDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddPeopleDialog],
      providers: [{ provide: MatDialogRef, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(AddPeopleDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
