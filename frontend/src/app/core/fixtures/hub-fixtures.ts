import { Service, signal } from '@angular/core';
import { Fixtures } from './fixtures';

/** The fixed data of the session, standing in for what the backend would send on request. */
@Service()
export class HubFixtures {
  public readonly data = signal<Fixtures | null>(null);
}
