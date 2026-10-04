import type { Db } from '../client';
import type { ParticipantRow, Role, SessionRow, SessionStatus } from '@/lib/domain/types';
import type { SessionSettings } from '@/lib/domain/settings';

const PARTICIPANT_COLS = 'id, session_id, user_id, display_name, role, joined_at, last_seen_at, removed_at';

export function sessionsRepo(db: Db) {
  return {
    async insertUser(id: string, displayName: string) {
      await db.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [id, displayName]);
    },

    async insertSession(s: {
      id: string;
      code: string;
      name: string;
      settings: SessionSettings;
      hostUserId: string;
      isDemo: boolean;
    }) {
      return (await db.one<SessionRow>(
        `INSERT INTO sessions (id, code, name, settings, host_user_id, is_demo)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
        [s.id, s.code, s.name, JSON.stringify(s.settings), s.hostUserId, s.isDemo],
      ))!;
    },

    findByCode: (code: string) => db.one<SessionRow>('SELECT * FROM sessions WHERE code = $1', [code]),
    findById: (id: string) => db.one<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]),

    async setStatus(id: string, status: SessionStatus) {
      const stamp = status === 'ACTIVE' ? ', started_at = now()' : status === 'ENDED' ? ', ended_at = now()' : '';
      return (await db.one<SessionRow>(`UPDATE sessions SET status = $2${stamp} WHERE id = $1 RETURNING *`, [
        id,
        status,
      ]))!;
    },

    /** Atomically allocates the next per-session question number. */
    async nextQuestionNumber(sessionId: string): Promise<number> {
      const row = await db.one<{ questionSeq: number }>(
        'UPDATE sessions SET question_seq = question_seq + 1 WHERE id = $1 RETURNING question_seq',
        [sessionId],
      );
      return row!.questionSeq;
    },

    /** Serialises matching within one session so two simultaneous uploads of
     *  the same content cannot both create a new question group. */
    async lockSession(sessionId: string) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionId]);
    },

    async insertParticipant(p: {
      id: string;
      sessionId: string;
      userId: string;
      displayName: string;
      role: Role;
      tokenHash: string;
    }) {
      return (await db.one<ParticipantRow>(
        `INSERT INTO session_participants (id, session_id, user_id, display_name, role, token_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PARTICIPANT_COLS}`,
        [p.id, p.sessionId, p.userId, p.displayName, p.role, p.tokenHash],
      ))!;
    },

    findParticipantByTokenHash: (tokenHash: string) =>
      db.one<ParticipantRow>(`SELECT ${PARTICIPANT_COLS} FROM session_participants WHERE token_hash = $1`, [
        tokenHash,
      ]),

    findParticipant: (id: string) =>
      db.one<ParticipantRow>(`SELECT ${PARTICIPANT_COLS} FROM session_participants WHERE id = $1`, [id]),

    listParticipants: (sessionId: string) =>
      db.query<ParticipantRow>(
        `SELECT ${PARTICIPANT_COLS} FROM session_participants WHERE session_id = $1 ORDER BY joined_at, id`,
        [sessionId],
      ),

    async nameTaken(sessionId: string, displayName: string) {
      return !!(await db.one(
        'SELECT 1 AS x FROM session_participants WHERE session_id = $1 AND lower(display_name) = lower($2)',
        [sessionId, displayName],
      ));
    },

    async countParticipants(sessionId: string) {
      const r = await db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM session_participants WHERE session_id = $1 AND removed_at IS NULL',
        [sessionId],
      );
      return r!.n;
    },

    async markRemoved(id: string, removedBy: string) {
      return (await db.one<ParticipantRow>(
        `UPDATE session_participants SET removed_at = now(), removed_by = $2 WHERE id = $1 RETURNING ${PARTICIPANT_COLS}`,
        [id, removedBy],
      ))!;
    },

    async updateSettings(id: string, settings: SessionSettings) {
      return (await db.one<SessionRow>('UPDATE sessions SET settings = $2::jsonb WHERE id = $1 RETURNING *', [
        id,
        JSON.stringify(settings),
      ]))!;
    },

    async touchParticipant(id: string) {
      await db.query('UPDATE session_participants SET last_seen_at = now() WHERE id = $1', [id]);
    },

    async stats(sessionId: string) {
      return (await db.one<{
        participants: number;
        questions: number;
        answers: number;
        images: number;
        challenges: number;
        openChallenges: number;
        resolvedChallenges: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM session_participants WHERE session_id = $1 AND removed_at IS NULL) AS participants,
           (SELECT count(*)::int FROM session_questions WHERE session_id = $1) AS questions,
           (SELECT count(*)::int FROM answers WHERE session_id = $1) AS answers,
           (SELECT count(*)::int FROM question_images WHERE session_id = $1 AND question_id IS NOT NULL) AS images,
           (SELECT count(*)::int FROM challenges WHERE session_id = $1) AS challenges,
           (SELECT count(*)::int FROM challenges WHERE session_id = $1 AND status IN ('OPEN','DISCUSSION')) AS open_challenges,
           (SELECT count(*)::int FROM challenges WHERE session_id = $1 AND status IN ('RESOLVED','DISMISSED')) AS resolved_challenges`,
        [sessionId],
      ))!;
    },
  };
}
export type SessionsRepo = ReturnType<typeof sessionsRepo>;
