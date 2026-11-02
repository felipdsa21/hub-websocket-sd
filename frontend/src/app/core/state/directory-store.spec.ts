import { TestBed } from '@angular/core/testing';
import { DirectoryStore } from './directory-store';

describe('DirectoryStore', () => {
  let service: DirectoryStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DirectoryStore);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
