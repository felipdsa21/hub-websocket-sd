import { TestBed } from '@angular/core/testing';
import { NewConversationDialogs } from './new-conversation-dialogs';

describe('NewConversationDialogs', () => {
  let service: NewConversationDialogs;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(NewConversationDialogs);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
