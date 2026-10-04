/**
 * API response shapes (what the browser receives). Views are computed per
 * viewer: answers, names and consensus are redacted server-side according to
 * the session settings and the viewer's role.
 */
import type {
  AnswerRelationship,
  AnswerSource,
  ChallengeResolution,
  ChallengeStance,
  ChallengeStatus,
  ConsensusLevel,
  MatchDecision,
  QuestionStatus,
  Role,
  SessionStatus,
} from './types';
import type { SessionSettings } from './settings';

export interface ParticipantView {
  id: string;
  displayName: string;
  role: Role;
  online: boolean;
  isMe: boolean;
}

export interface SessionView {
  id: string;
  code: string;
  name: string;
  status: SessionStatus;
  settings: SessionSettings;
  isDemo: boolean;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ViewerCaps {
  canStart: boolean;
  canEnd: boolean;
  canPost: boolean;
  canChallenge: boolean;
  canResolve: boolean;
  canViewDashboard: boolean;
  /** May admit or decline people asking to join from the home page. */
  canAdmit: boolean;
  canRemoveParticipants: boolean;
  canManageSettings: boolean;
  canSeeConsensus: boolean;
}

export interface SessionStateView {
  session: SessionView;
  me: ParticipantView;
  participants: ParticipantView[];
  caps: ViewerCaps;
  unreadNotifications: number;
  /** A submission that still needs the viewer's decision (restored after refresh). */
  pending: SubmissionResult | null;
  limits: { maxImageBytes: number; maxAnswerLength: number };
}

export interface ConsensusView {
  pct: number | null;
  level: ConsensusLevel;
}

export interface AnswerTallyView {
  label: string;
  count: number;
  pct: number;
}

export interface QuestionSummaryView {
  id: string;
  number: number;
  thumbUrl: string | null;
  answerCount: number;
  imageCount: number;
  status: QuestionStatus;
  challengeCount: number;
  openChallengeCount: number;
  /** null when the viewer may not see consensus. */
  consensus: ConsensusView | null;
  /** null when the viewer may not (yet) see other answers. */
  tally: AnswerTallyView[] | null;
  answeredByMe: boolean;
  myAnswer: string | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface AnswerView {
  id: string;
  raw: string;
  by: string;
  mine: boolean;
  relationship: AnswerRelationship;
  /** The answer this participant agreed with, when relationship is AGREES. */
  endorsedRaw: string | null;
  source: AnswerSource;
  createdAt: string;
}

export interface ImageView {
  id: string;
  thumbUrl: string;
  displayUrl: string;
  by: string;
  mine: boolean;
  isRepresentative: boolean;
  similarity: number | null;
  matchDecision: MatchDecision | null;
}

export interface ChallengeResponseView {
  by: string;
  mine: boolean;
  stance: ChallengeStance;
  answerRaw: string | null;
  comment: string | null;
  createdAt: string;
}

export interface ChallengeView {
  id: string;
  questionId: string;
  status: ChallengeStatus;
  resolution: ChallengeResolution | null;
  resolutionNote: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  original: { answerId: string; raw: string; by: string };
  challenge: { answerId: string; raw: string; by: string };
  /** Supporters include the original author / the challenger themselves. */
  tally: { original: number; challenge: number; other: number };
  responses: ChallengeResponseView[];
  myStance: ChallengeStance | null;
  /** Viewer is the original author or the challenger (they cannot vote). */
  isParty: boolean;
  canRespond: boolean;
  canResolve: boolean;
}

export interface HistoryEventView {
  id: string;
  type: string;
  actor: string | null;
  summary: string;
  createdAt: string;
}

export interface QuestionDetailView extends QuestionSummaryView {
  displayUrl: string | null;
  images: ImageView[];
  originalAnswer: { id: string; raw: string; by: string } | null;
  answers: AnswerView[] | null;
  challenges: ChallengeView[];
  /** Full audit trail; only for roles with dashboard access. */
  history: HistoryEventView[] | null;
  caps: {
    canSeeAnswers: boolean;
    canAnswer: boolean;
    canChallenge: boolean;
    challengeDeniedReason: string | null;
  };
}

export interface MatchPrompt {
  answerId: string;
  yourAnswer: string;
  /** null when the session hides previous answers. */
  previousAnswer: { raw: string; by: string } | null;
  sameAnswer: boolean;
  needsDecision: boolean;
  canChallenge: boolean;
}

export type SubmissionResult =
  | { outcome: 'NEW_QUESTION'; submissionId: string; question: QuestionSummaryView }
  | {
      outcome: 'MATCHED';
      submissionId: string;
      similarity: number | null;
      confirmedByUser: boolean;
      question: QuestionSummaryView;
      prompt: MatchPrompt;
    }
  | {
      outcome: 'POSSIBLE_MATCH';
      submissionId: string;
      similarity: number;
      yourAnswer: string;
      yourImageUrl: string;
      candidate: { id: string; number: number; imageUrl: string | null };
    }
  | { outcome: 'ALREADY_ANSWERED'; submissionId: string; question: QuestionSummaryView; yourAnswer: string }
  | { outcome: 'SIMILARITY_UNAVAILABLE'; submissionId: string; yourAnswer: string; yourImageUrl: string };

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  questionId: string | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface DashboardView {
  stats: {
    participants: number;
    online: number;
    questions: number;
    answers: number;
    images: number;
    challenges: number;
    openChallenges: number;
    resolvedChallenges: number;
  };
  questions: QuestionSummaryView[];
  events: HistoryEventView[];
}

/** A session shown in the public list on the home page. Never includes the code. */
export interface PublicSessionView {
  id: string;
  name: string;
  hostName: string;
  status: SessionStatus;
  participantCount: number;
  onlineCount: number;
  createdAt: string;
}

/** What a host sees for someone waiting to be let in. */
export interface JoinRequestView {
  id: string;
  displayName: string;
  createdAt: string;
}

/** What the person waiting sees. `code` is only revealed once they are approved. */
export interface JoinRequestStatusView {
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'CLOSED';
  sessionName: string;
  code: string | null;
}

export interface ChatMessageView {
  id: string;
  senderId: string;
  senderName: string;
  /** null = sent to everyone; otherwise a private message to this participant. */
  recipientId: string | null;
  text: string;
  createdAt: string;
}

export interface ChatOverviewView {
  enabled: boolean;
  privateEnabled: boolean;
  canSend: boolean;
  publicUnread: number;
  /** Private conversations the viewer is part of. */
  direct: { participantId: string; unread: number }[];
}

export interface ChatThreadView {
  items: ChatMessageView[];
  hasMore: boolean;
}

export interface QuestionListView {
  items: QuestionSummaryView[];
  total: number;
  offset: number;
  limit: number;
  filter: string;
  sort: string;
  /** Filters / sorts this viewer may use; the UI renders whatever the server offers. */
  filters: { key: string; label: string }[];
  sorts: { key: string; label: string }[];
}
