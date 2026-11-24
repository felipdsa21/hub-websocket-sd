/** A user's state as the backend sends it (architecture, section 4.2). */
export interface UserState {
  readonly username: string;
  readonly displayName: string;
  readonly online: boolean;
  readonly version: number;
}

/** What others see of a user: online while any connection is open (RF07). */
export type Presence = 'online' | 'offline';
