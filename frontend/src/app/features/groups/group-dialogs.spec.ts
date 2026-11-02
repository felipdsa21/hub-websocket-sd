import { TestBed } from '@angular/core/testing';
import { GroupDialogs } from './group-dialogs';

describe('GroupDialogs', () => {
  let service: GroupDialogs;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GroupDialogs);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
