export type ErrorCode =
  | 'invalidRequest'
  | 'unknownAction'
  | 'forbidden'
  | 'notFound'
  | 'invalidOperation'
  | 'conflict'
  | 'notRegistered'
  | 'lastMember';

/** An `error` event (architecture, section 4.2). The client decides only by `code` and `details`. */
export interface HubError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: {
    readonly field?: string;
    readonly usernames?: readonly string[];
  };
}
