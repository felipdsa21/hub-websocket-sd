import { TestBed } from '@angular/core/testing';
import { Breakpoints } from './breakpoints';

describe('Breakpoints', () => {
  let service: Breakpoints;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Breakpoints);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
