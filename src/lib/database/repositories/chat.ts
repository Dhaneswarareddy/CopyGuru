import type { Db } from '../client';

export interface ChatMessageRow {
  /** bigint, carried as text so it survives JSON and both drivers. */
  id: string;
  sessionId: string;
  senderId: string;
  senderName: string;
  recipientId: string | null;
  body: string;
  createdAt: Date;
}

const SELECT = `SELECT m.id::text AS id, m.session_id, m.sender_id, p.display_name AS sender_name,
                       m.recipient_id, m.body, m.created_at
                FROM chat_messages m JOIN session_participants p ON p.id = m.sender_id`;

export function chatRepo(db: Db) {
  return {
    async insert(m: { sessionId: string; senderId: string; recipientId: string | null; body: string }) {
      const row = await db.one<{ id: string }>(
        `INSERT INTO chat_messages (session_id, sender_id, recipient_id, body) VALUES ($1,$2,$3,$4) RETURNING id::text AS id`,
        [m.sessionId, m.senderId, m.recipientId, m.body],
      );
      return (await db.one<ChatMessageRow>(`${SELECT} WHERE m.id = $1::bigint`, [row!.id]))!;
    },

    /** Newest first; `beforeId` pages backwards. */
    listPublic: (sessionId: string, beforeId: string | null, limit: number) =>
      db.query<ChatMessageRow>(
        `${SELECT} WHERE m.session_id = $1 AND m.recipient_id IS NULL
           AND ($2::bigint IS NULL OR m.id < $2::bigint)
         ORDER BY m.id DESC LIMIT $3`,
        [sessionId, beforeId, limit],
      ),

    /** Only messages exchanged between exactly these two participants. */
    listDirect: (sessionId: string, me: string, peer: string, beforeId: string | null, limit: number) =>
      db.query<ChatMessageRow>(
        `${SELECT} WHERE m.session_id = $1
           AND ((m.sender_id = $2 AND m.recipient_id = $3) OR (m.sender_id = $3 AND m.recipient_id = $2))
           AND ($4::bigint IS NULL OR m.id < $4::bigint)
         ORDER BY m.id DESC LIMIT $5`,
        [sessionId, me, peer, beforeId, limit],
      ),

    async publicUnread(sessionId: string, me: string) {
      const r = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_messages m
         WHERE m.session_id = $1 AND m.recipient_id IS NULL AND m.sender_id <> $2
           AND m.id > COALESCE((SELECT last_read_id FROM chat_reads WHERE participant_id = $2 AND channel = 'public'), 0)`,
        [sessionId, me],
      );
      return r!.n;
    },

    /** One row per private conversation the participant is part of. */
    directOverview: (sessionId: string, me: string) =>
      db.query<{ participantId: string; unread: number }>(
        `SELECT m.peer AS participant_id,
                count(*) FILTER (WHERE m.sender_id <> $2 AND m.id > COALESCE(r.last_read_id, 0))::int AS unread
         FROM (
           SELECT id, sender_id, CASE WHEN sender_id = $2 THEN recipient_id ELSE sender_id END AS peer
           FROM chat_messages
           WHERE session_id = $1 AND recipient_id IS NOT NULL AND (sender_id = $2 OR recipient_id = $2)
         ) m
         LEFT JOIN chat_reads r ON r.participant_id = $2 AND r.channel = m.peer::text
         GROUP BY m.peer`,
        [sessionId, me],
      ),

    async markRead(participantId: string, channel: string, lastId: string) {
      await db.query(
        `INSERT INTO chat_reads (participant_id, channel, last_read_id) VALUES ($1, $2, $3::bigint)
         ON CONFLICT (participant_id, channel)
         DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
        [participantId, channel, lastId],
      );
    },
  };
}
export type ChatRepo = ReturnType<typeof chatRepo>;
