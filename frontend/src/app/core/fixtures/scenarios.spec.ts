import { TestBed } from '@angular/core/testing';
import { Scenarios } from './scenarios';

describe('Scenarios', () => {
  let service: Scenarios;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Scenarios);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
