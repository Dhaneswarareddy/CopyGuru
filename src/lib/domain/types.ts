/**
 * Core domain vocabulary. Kept free of server-only imports so the browser can
 * share these types.
 */
import type { SessionSettings } from './settings';

export const ROLES = ['HOST', 'PARTICIPANT', 'MODERATOR', 'JUDGE', 'OBSERVER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export type SessionStatus = 'WAITING' | 'ACTIVE' | 'ENDED';

/** Extensible question content: only IMAGE is implemented today. */
export type QuestionContentType = 'IMAGE' | 'TEXT' | 'AUDIO' | 'VIDEO';
export interface QuestionContent {
  type: QuestionContentType;
  data: unknown;
}

/** Extensible answer payload: only TEXT is implemented today. */
export type AnswerType = 'TEXT' | 'MULTIPLE_CHOICE' | 'NUMERIC' | 'BOOLEAN' | 'IMAGE' | 'AUDIO';
export interface AnswerValue {
  type: AnswerType;
  value: unknown;
}

export type MatchDecision = 'HIGH_MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH' | 'UNKNOWN';
export type SubmissionStatus = 'COMPLETED' | 'PENDING_CONFIRMATION' | 'SIMILARITY_FAILED';
export type SubmissionSource = 'upload' | 'camera' | 'sample' | 'host';

/**
 * How an answer relates to the question's original answer.
 *  ORIGINAL    – the first answer of the question
 *  AGREES      – participant endorsed another answer (raw text is still kept)
 *  CHALLENGES  – participant opened a challenge with this answer
 *  INDEPENDENT – participant kept their own answer without challenging
 *  UNDECIDED   – matched an existing question, decision still pending
 */
export type AnswerRelationship = 'ORIGINAL' | 'AGREES' | 'CHALLENGES' | 'INDEPENDENT' | 'UNDECIDED';
export type AnswerSource = 'IMAGE_SUBMISSION' | 'DIRECT' | 'CHALLENGE_RESPONSE';

export type ChallengeStatus = 'OPEN' | 'DISCUSSION' | 'RESOLVED' | 'DISMISSED';
export type ChallengeResolution = 'ORIGINAL_ACCEPTED' | 'CHALLENGE_ACCEPTED' | 'BOTH_VALID' | 'UNRESOLVED';
export type ChallengeStance = 'ORIGINAL' | 'CHALLENGE' | 'OTHER';

export type QuestionStatus = 'OPEN' | 'CHALLENGED' | 'RESOLVED';
export type ConsensusLevel =
  | 'HIGH_AGREEMENT'
  | 'MODERATE_AGREEMENT'
  | 'LOW_AGREEMENT'
  | 'HIGH_DISAGREEMENT'
  | 'NONE';

export interface ConsensusGroup {
  key: string;
  label: string;
  count: number;
  pct: number;
}
export interface Consensus {
  total: number;
  pct: number | null;
  level: ConsensusLevel;
  groups: ConsensusGroup[];
}

// ---------------------------------------------------------------- DB rows

export interface SessionRow {
  id: string;
  code: string;
  name: string;
  status: SessionStatus;
  settings: SessionSettings;
  hostUserId: string;
  questionSeq: number;
  isDemo: boolean;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface ParticipantRow {
  id: string;
  sessionId: string;
  userId: string;
  displayName: string;
  role: Role;
  joinedAt: Date;
  lastSeenAt: Date | null;
  /** Set when a host removed this participant; they can no longer authenticate. */
  removedAt: Date | null;
}

export interface QuestionRow {
  id: string;
  sessionId: string;
  number: number;
  contentType: QuestionContentType;
  content: Record<string, unknown>;
  representativeImageId: string | null;
  originalAnswerId: string | null;
  createdBy: string | null;
  answerCount: number;
  imageCount: number;
  consensusPct: number | null;
  consensusLevel: ConsensusLevel;
  consensus: Consensus | null;
  challengeCount: number;
  openChallengeCount: number;
  status: QuestionStatus;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface ImageRow {
  id: string;
  sessionId: string;
  questionId: string | null;
  participantId: string;
  displayKey: string;
  thumbKey: string;
  originalKey: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  embeddingModel: string | null;
  hasEmbedding: boolean;
  createdAt: Date;
}

export interface SubmissionRow {
  id: string;
  sessionId: string;
  participantId: string;
  imageId: string;
  questionId: string | null;
  candidateQuestionId: string | null;
  status: SubmissionStatus;
  matchDecision: MatchDecision;
  similarityScore: number | null;
  userConfirmedMatch: boolean | null;
  rawAnswer: string;
  answerType: AnswerType;
  source: SubmissionSource;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface AnswerRow {
  id: string;
  sessionId: string;
  questionId: string;
  participantId: string;
  submissionId: string | null;
  answerType: AnswerType;
  rawAnswer: string;
  normalizedAnswer: string;
  /** Normalized answer counted for consensus (differs from own when AGREES). */
  effectiveNormalized: string;
  value: AnswerValue;
  relationship: AnswerRelationship;
  endorsedAnswerId: string | null;
  source: AnswerSource;
  createdAt: Date;
}

export interface ChallengeRow {
  id: string;
  sessionId: string;
  questionId: string;
  originalAnswerId: string;
  challengerAnswerId: string;
  challengerId: string;
  reason: string | null;
  status: ChallengeStatus;
  resolution: ChallengeResolution | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface ChallengeResponseRow {
  id: string;
  challengeId: string;
  participantId: string;
  stance: ChallengeStance;
  answerId: string | null;
  comment: string | null;
  createdAt: Date;
}

export interface NotificationRow {
  id: string;
  sessionId: string;
  recipientId: string;
  type: string;
  title: string;
  body: string;
  questionId: string | null;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface SessionEventRow {
  id: string;
  sessionId: string;
  type: string;
  actorId: string | null;
  questionId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}
