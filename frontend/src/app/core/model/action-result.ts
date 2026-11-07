import { HubError } from './error';

/** An action without a response within the deadline may or may not have been done (RF09). */
export type ActionFailure = HubError | 'noResponse';

export type StartResult = { readonly conversationId: string } | ActionFailure;

export interface AddMembersResult {
  readonly added: readonly string[];
  readonly failed: readonly { readonly username: string; readonly reason: ActionFailure }[];
}

export type LeaveResult = 'left' | ActionFailure;
