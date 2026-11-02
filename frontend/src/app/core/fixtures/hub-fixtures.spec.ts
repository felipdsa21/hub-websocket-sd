import { TestBed } from '@angular/core/testing';
import { HubFixtures } from './hub-fixtures';

describe('HubFixtures', () => {
  let service: HubFixtures;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(HubFixtures);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
