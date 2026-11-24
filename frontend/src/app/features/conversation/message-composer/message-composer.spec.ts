import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageComposer } from './message-composer';

describe('MessageComposer', () => {
  let component: MessageComposer;
  let fixture: ComponentFixture<MessageComposer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageComposer],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageComposer);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  function textarea(): HTMLTextAreaElement {
    return fixture.nativeElement.querySelector('textarea');
  }

  async function type(text: string): Promise<void> {
    textarea().value = text;
    textarea().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('clears the draft when the conversation changes', async () => {
    await type('te ligo depois');

    fixture.componentRef.setInput('conversationId', 'g:2');
    await fixture.whenStable();

    expect(textarea().value).toBe('');
  });
});
