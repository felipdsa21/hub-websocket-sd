import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { MembersSheet } from './members-sheet';

describe('MembersSheet', () => {
  let component: MembersSheet;
  let fixture: ComponentFixture<MembersSheet>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MembersSheet],
      providers: [{ provide: MatDialogRef, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(MembersSheet);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
