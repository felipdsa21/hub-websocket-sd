import { TestBed } from '@angular/core/testing';
import { ConversationsStore } from './conversations-store';

describe('ConversationsStore', () => {
  let service: ConversationsStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConversationsStore);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
