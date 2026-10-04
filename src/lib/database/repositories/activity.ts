import type { Db } from '../client';
import type { NotificationRow, SessionEventRow } from '@/lib/domain/types';

/** Notifications and the session event log. */
export function activityRepo(db: Db) {
  return {
    async insertNotification(n: {
      id: string;
      sessionId: string;
      recipientId: string;
      type: string;
      title: string;
      body: string;
      questionId: string | null;
      data: Record<string, unknown>;
    }) {
      return (await db.one<NotificationRow>(
        `INSERT INTO notifications (id, session_id, recipient_id, type, title, body, question_id, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [n.id, n.sessionId, n.recipientId, n.type, n.title, n.body, n.questionId, JSON.stringify(n.data)],
      ))!;
    },

    listNotifications: (recipientId: string, limit: number) =>
      db.query<NotificationRow>(
        'SELECT * FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC, id LIMIT $2',
        [recipientId, limit],
      ),

    async unreadCount(recipientId: string) {
      const r = await db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
        [recipientId],
      );
      return r!.n;
    },

    async markRead(recipientId: string, ids: string[] | null) {
      if (ids === null) {
        await db.query('UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL', [
          recipientId,
        ]);
      } else if (ids.length) {
        await db.query(
          'UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
          [recipientId, ids],
        );
      }
    },

    async insertEvent(e: {
      sessionId: string;
      type: string;
      actorId: string | null;
      questionId: string | null;
      payload: Record<string, unknown>;
    }) {
      await db.query(
        'INSERT INTO session_events (session_id, type, actor_id, question_id, payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [e.sessionId, e.type, e.actorId, e.questionId, JSON.stringify(e.payload)],
      );
    },

    listSessionEvents: (sessionId: string, limit: number) =>
      db.query<SessionEventRow>('SELECT * FROM session_events WHERE session_id = $1 ORDER BY id DESC LIMIT $2', [
        sessionId,
        limit,
      ]),

    listQuestionEvents: (questionId: string, limit: number) =>
      db.query<SessionEventRow>('SELECT * FROM session_events WHERE question_id = $1 ORDER BY id ASC LIMIT $2', [
        questionId,
        limit,
      ]),
  };
}
export type ActivityRepo = ReturnType<typeof activityRepo>;
