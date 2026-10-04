import type { ActivityRepo } from '@/lib/database/repositories/activity';
import { RT, type RealtimeGateway, type RealtimeSessionEvent } from '@/lib/realtime/gateway';
import type { EventBus } from '../bus';
import type { DomainEvent } from '../types';

/**
 * Wires the built-in subscribers. Order matters: the audit log is written
 * first, then notifications are created, then clients are told to refresh.
 * New features (leaderboards, analytics, webhooks…) register here.
 */
export function registerCoreSubscribers(
  bus: EventBus,
  deps: {
    activity: ActivityRepo;
    realtime: () => RealtimeGateway;
    notify: (event: DomainEvent) => Promise<void>;
  },
) {
  // 1. durable event log (also the per-question history shown to the host)
  bus.subscribe('*', async (e) => {
    await deps.activity.insertEvent({
      sessionId: e.sessionId,
      type: e.type,
      actorId: e.actorId ?? null,
      questionId: e.questionId ?? null,
      payload: e.payload,
    });
  });

  // 2. per-recipient notifications
  bus.subscribe('*', deps.notify);

  // 3. realtime fan-out: a small, non-sensitive signal; clients re-fetch
  //    through the API where per-viewer visibility rules are applied
  bus.subscribe('*', (e) => {
    const message: RealtimeSessionEvent = {
      type: e.type,
      questionId: e.questionId ?? null,
      data: e.publicPayload ?? {},
      at: (e.at ?? new Date()).toISOString(),
    };
    deps.realtime().emitToSession(e.sessionId, RT.SESSION_EVENT, message);
  });
}
