import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ConversationPage } from './conversation-page';

// jsdom has neither observer.
class ObserverStub {
  public readonly observe = vi.fn();
  public readonly disconnect = vi.fn();
}

describe('ConversationPage', () => {
  let component: ConversationPage;
  let fixture: ComponentFixture<ConversationPage>;

  beforeEach(async () => {
    vi.stubGlobal('IntersectionObserver', ObserverStub);
    vi.stubGlobal('ResizeObserver', ObserverStub);
    await TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
