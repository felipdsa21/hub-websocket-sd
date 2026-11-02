import { TestBed } from '@angular/core/testing';
import { ConnectionStore } from './connection-store';

describe('ConnectionStore', () => {
  let service: ConnectionStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConnectionStore);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
