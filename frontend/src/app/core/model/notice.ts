/** A member joining or leaving a group, kept in memory for the session only (RF04). */
export interface MemberNotice {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: 'joined' | 'left';
  readonly username: string;
  /**
   * Position: right after the messages up to this `sk`, the latest the client knew when the notice
   * arrived, so it doesn't depend on the browser's clock. Absent places it at the start.
   */
  readonly afterSk?: string;
}
