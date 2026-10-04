import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import type { ActivityRepo } from '@/lib/database/repositories/activity';
import type { QuestionsRepo } from '@/lib/database/repositories/questions';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type { NotificationRow, ParticipantRow, SessionRow } from '@/lib/domain/types';
import type { NotificationView } from '@/lib/domain/views';
import type { DomainEvent } from '@/lib/events/types';
import { Permission, roleHas } from '@/lib/permissions/permissions';
import { RT, type RealtimeGateway } from '@/lib/realtime/gateway';
import { visibilityFor } from '@/services/questions/visibility';

export interface NotificationDeps {
  config: AppConfig;
  sessions: SessionsRepo;
  questions: QuestionsRepo;
  activity: ActivityRepo;
  realtime: () => RealtimeGateway;
}

type Draft = { type: string; title: string; body: string; data?: Record<string, unknown> };

/**
 * Turns domain events into per-recipient notifications. Each notification is
 * composed for its recipient, so hidden answers and anonymous names are never
 * leaked through the notification channel.
 */
export class NotificationService {
  constructor(private d: NotificationDeps) {}

  toView(n: NotificationRow): NotificationView {
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      questionId: n.questionId,
      data: n.data ?? {},
      read: !!n.readAt,
      createdAt: new Date(n.createdAt).toISOString(),
    };
  }

  async list(viewer: ParticipantRow) {
    const [rows, unread] = await Promise.all([
      this.d.activity.listNotifications(viewer.id, 50),
      this.d.activity.unreadCount(viewer.id),
    ]);
    return { items: rows.map((r) => this.toView(r)), unread };
  }

  async markRead(viewer: ParticipantRow, ids: unknown) {
    const list = Array.isArray(ids)
      ? ids.filter((i): i is string => typeof i === 'string' && /^[0-9a-f-]{36}$/i.test(i)).slice(0, 200)
      : null;
    await this.d.activity.markRead(viewer.id, list);
    return { unread: await this.d.activity.unreadCount(viewer.id) };
  }

  /** Event-bus subscriber. */
  handle = async (event: DomainEvent): Promise<void> => {
    const builder = this.builders[event.type];
    if (!builder) return;
    const session = await this.d.sessions.findById(event.sessionId);
    if (!session) return;
    const participants = await this.d.sessions.listParticipants(session.id);
    const answerers = new Set(event.questionId ? await this.d.questions.answererIds(event.questionId) : []);
    const actor = participants.find((p) => p.id === event.actorId) ?? null;

    for (const recipient of participants) {
      if (recipient.removedAt) continue;
      const answered = answerers.has(recipient.id);
      const vis = visibilityFor(session, recipient, answered);
      const draft = builder({
        event,
        p: event.payload as Record<string, any>,
        session,
        recipient,
        answered,
        isStaff: roleHas(recipient.role, Permission.VIEW_DASHBOARD),
        seesAnswers: vis.answers,
        seesConsensus: vis.consensus,
        actorName: actor && vis.identities ? actor.displayName : 'A participant',
      });
      if (!draft) continue;
      const row = await this.d.activity.insertNotification({
        id: crypto.randomUUID(),
        sessionId: session.id,
        recipientId: recipient.id,
        type: draft.type,
        title: draft.title,
        body: draft.body,
        questionId: event.questionId ?? null,
        data: draft.data ?? {},
      });
      this.d.realtime().emitToParticipant(recipient.id, RT.NOTIFICATION, this.toView(row));
    }
  };

  /** One builder per notifying event; return null to skip a recipient. */
  private builders: Partial<
    Record<
      DomainEvent['type'],
      (c: {
        event: DomainEvent;
        p: Record<string, any>;
        session: SessionRow;
        recipient: ParticipantRow;
        answered: boolean;
        isStaff: boolean;
        seesAnswers: boolean;
        seesConsensus: boolean;
        actorName: string;
      }) => Draft | null
    >
  > = {
    ANSWER_CHALLENGED: ({ event, p, recipient, seesAnswers, actorName }) => {
      if (recipient.id === event.actorId) return null;
      return {
        type: 'CHALLENGE',
        title: `New challenge on Question #${p.questionNumber}`,
        body: `${actorName} challenged the answer for Question #${p.questionNumber}.`,
        data: {
          questionNumber: p.questionNumber,
          challengeId: p.challengeId,
          // only included when this recipient is allowed to see the answers
          ...(seesAnswers
            ? { originalAnswer: p.originalAnswer, challengerAnswer: p.challengerAnswer, reason: p.reason ?? null }
            : { hidden: true }),
        },
      };
    },

    ANSWER_SUBMITTED: ({ event, p, recipient, answered, isStaff }) => {
      // the first answer creates the question; that shows up on the board instead
      if (p.isFirstAnswer || recipient.id === event.actorId) return null;
      if (!answered && !isStaff) return null;
      return {
        type: 'NEW_ANSWER',
        title: `Question #${p.questionNumber} received a new answer`,
        body: '',
        data: { questionNumber: p.questionNumber },
      };
    },

    CONSENSUS_UPDATED: ({ p, answered, isStaff, seesConsensus }) => {
      const high = this.d.config.consensus.high;
      const after = p.after ?? {};
      const before = p.before ?? {};
      const crossed =
        after.total >= this.d.config.consensus.notifyMinAnswers &&
        after.pct >= high &&
        !(before.total >= this.d.config.consensus.notifyMinAnswers && before.pct >= high);
      if (!crossed || !seesConsensus || !(answered || isStaff)) return null;
      return {
        type: 'CONSENSUS',
        title: `Question #${p.questionNumber} reached ${after.pct}% consensus`,
        body: `${after.total} answers so far.`,
        data: { questionNumber: p.questionNumber, pct: after.pct },
      };
    },

    JOIN_REQUESTED: ({ p, recipient }) => {
      // only people who can actually let them in
      if (!roleHas(recipient.role, Permission.ADMIT_PARTICIPANTS)) return null;
      return {
        type: 'JOIN_REQUEST',
        title: `${p.displayName} wants to join`,
        body: 'Admit or decline them at the top of the session.',
        data: { requestId: p.requestId },
      };
    },

    CHALLENGE_RESOLVED: ({ event, p, recipient }) => {
      if (recipient.id === event.actorId) return null;
      const dismissed = p.status === 'DISMISSED';
      return {
        type: 'CHALLENGE_RESOLVED',
        title: dismissed
          ? `The challenge on Question #${p.questionNumber} was dismissed`
          : `Question #${p.questionNumber} was resolved`,
        body: dismissed ? '' : `Outcome: ${String(p.resolution).replace(/_/g, ' ').toLowerCase()}.`,
        data: { questionNumber: p.questionNumber, challengeId: p.challengeId, resolution: p.resolution ?? null },
      };
    },
  };
}
