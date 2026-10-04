import type { Db } from '../client';
import type { Role, SessionRow } from '@/lib/domain/types';

export type JoinRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED';

export interface JoinRequestRow {
  id: string;
  sessionId: string;
  displayName: string;
  status: JoinRequestStatus;
  participantId: string | null;
  decidedBy: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  lastSeenAt: Date;
}

const COLS = 'id, session_id, display_name, status, participant_id, decided_by, created_at, decided_at, last_seen_at';

export function joinRequestsRepo(db: Db) {
  return {
    /** Sessions that opted into the public list and are not over. */
    listListedSessions: (limit: number) =>
      db.query<SessionRow>(
        `SELECT * FROM sessions
         WHERE status IN ('WAITING','ACTIVE') AND is_demo = false
           AND settings->>'listedPublicly' = 'true'
           AND created_at > now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT $1`,
        [limit],
      ),

    participantsOf: (sessionIds: string[]) =>
      sessionIds.length
        ? db.query<{ id: string; sessionId: string; displayName: string; role: Role }>(
            'SELECT id, session_id, display_name, role FROM session_participants WHERE session_id = ANY($1::uuid[]) AND removed_at IS NULL',
            [sessionIds],
          )
        : Promise.resolve([]),

    async insert(r: { id: string; sessionId: string; displayName: string; tokenHash: string }) {
      return (await db.one<JoinRequestRow>(
        `INSERT INTO join_requests (id, session_id, display_name, token_hash) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
        [r.id, r.sessionId, r.displayName, r.tokenHash],
      ))!;
    },

    find: (id: string) => db.one<JoinRequestRow>(`SELECT ${COLS} FROM join_requests WHERE id = $1`, [id]),
    findForUpdate: (id: string) =>
      db.one<JoinRequestRow>(`SELECT ${COLS} FROM join_requests WHERE id = $1 FOR UPDATE`, [id]),

    /** Looks the request up by the requester's token and records that they are still waiting. */
    touchByTokenHash: (tokenHash: string) =>
      db.one<JoinRequestRow>(
        `UPDATE join_requests SET last_seen_at = now() WHERE token_hash = $1 RETURNING ${COLS}`,
        [tokenHash],
      ),

    /** Pending requests whose requester was seen within the last `freshSeconds`. */
    listPending: (sessionId: string, freshSeconds: number) =>
      db.query<JoinRequestRow>(
        `SELECT ${COLS} FROM join_requests
         WHERE session_id = $1 AND status = 'PENDING' AND last_seen_at > now() - make_interval(secs => $2)
         ORDER BY created_at, id`,
        [sessionId, freshSeconds],
      ),

    async pendingNameTaken(sessionId: string, displayName: string, freshSeconds: number) {
      return !!(await db.one(
        `SELECT 1 AS x FROM join_requests
         WHERE session_id = $1 AND status = 'PENDING' AND lower(display_name) = lower($2)
           AND last_seen_at > now() - make_interval(secs => $3)`,
        [sessionId, displayName, freshSeconds],
      ));
    },

    async setStatus(id: string, status: JoinRequestStatus, decidedBy: string | null, participantId: string | null) {
      return (await db.one<JoinRequestRow>(
        `UPDATE join_requests SET status = $2, decided_by = $3, participant_id = $4, decided_at = now()
         WHERE id = $1 RETURNING ${COLS}`,
        [id, status, decidedBy, participantId],
      ))!;
    },
  };
}
export type JoinRequestsRepo = ReturnType<typeof joinRequestsRepo>;
