import { TestBed } from '@angular/core/testing';
import { ConversationActions } from './conversation-actions';

describe('ConversationActions', () => {
  let service: ConversationActions;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConversationActions);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
