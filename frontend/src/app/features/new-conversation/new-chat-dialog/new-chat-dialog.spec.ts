import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { NewChatDialog } from './new-chat-dialog';

describe('NewChatDialog', () => {
  let component: NewChatDialog;
  let fixture: ComponentFixture<NewChatDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewChatDialog],
      providers: [{ provide: MatDialogRef, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(NewChatDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
