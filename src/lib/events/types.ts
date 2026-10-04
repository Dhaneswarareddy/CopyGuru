/**
 * Domain events. Core services publish these; everything else (realtime
 * fan-out, notifications, the audit log, and future features such as
 * leaderboards or analytics) subscribes without touching submission logic.
 */
export const EVENT_TYPES = [
  'SESSION_CREATED',
  'PARTICIPANT_JOINED',
  'SESSION_STARTED',
  'IMAGE_SUBMITTED',
  'QUESTION_MATCHED',
  'QUESTION_CREATED',
  'ANSWER_SUBMITTED',
  'ANSWER_RELATIONSHIP_SET',
  'ANSWER_CHALLENGED',
  'CHALLENGE_CREATED',
  'CHALLENGE_RESPONSE_ADDED',
  'CONSENSUS_UPDATED',
  'CHALLENGE_RESOLVED',
  'SESSION_ENDED',
  'PARTICIPANT_REMOVED',
  'SESSION_SETTINGS_UPDATED',
  'JOIN_REQUESTED',
  'JOIN_REQUEST_APPROVED',
  'JOIN_REQUEST_DECLINED',
  'JOIN_REQUEST_CANCELLED',
] as const;
export type DomainEventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent {
  type: DomainEventType;
  sessionId: string;
  actorId?: string | null;
  questionId?: string | null;
  /** Full detail. Persisted to the audit log; never broadcast as-is because it
   *  may contain answers the recipient is not yet allowed to see. */
  payload: Record<string, unknown>;
  /** Safe-for-everyone subset that is broadcast to the session room. */
  publicPayload?: Record<string, unknown>;
  at?: Date;
}

export type EventHandler = (event: DomainEvent) => Promise<void> | void;
