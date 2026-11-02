import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MembersPanel } from './members-panel';

describe('MembersPanel', () => {
  let component: MembersPanel;
  let fixture: ComponentFixture<MembersPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MembersPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(MembersPanel);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
