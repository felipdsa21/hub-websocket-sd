import { TestBed } from '@angular/core/testing';
import { Clock } from './clock';

describe('Clock', () => {
  let service: Clock;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Clock);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
