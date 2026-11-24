import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoConversation } from './no-conversation';

describe('NoConversation', () => {
  let component: NoConversation;
  let fixture: ComponentFixture<NoConversation>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NoConversation],
    }).compileComponents();

    fixture = TestBed.createComponent(NoConversation);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
