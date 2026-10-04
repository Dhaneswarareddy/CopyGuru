import type { Db } from '../client';
import type {
  ChallengeResolution,
  ChallengeResponseRow,
  ChallengeRow,
  ChallengeStance,
  ChallengeStatus,
} from '@/lib/domain/types';

export function challengesRepo(db: Db) {
  return {
    async insert(c: {
      id: string;
      sessionId: string;
      questionId: string;
      originalAnswerId: string;
      challengerAnswerId: string;
      challengerId: string;
      reason: string | null;
    }) {
      return (await db.one<ChallengeRow>(
        `INSERT INTO challenges (id, session_id, question_id, original_answer_id, challenger_answer_id, challenger_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [c.id, c.sessionId, c.questionId, c.originalAnswerId, c.challengerAnswerId, c.challengerId, c.reason],
      ))!;
    },

    find: (id: string) => db.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1', [id]),
    /** Row-locks the challenge so concurrent votes / resolutions serialise. */
    findForUpdate: (id: string) => db.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [id]),
    findByChallenger: (questionId: string, challengerId: string) =>
      db.one<ChallengeRow>('SELECT * FROM challenges WHERE question_id = $1 AND challenger_id = $2', [
        questionId,
        challengerId,
      ]),
    listForQuestion: (questionId: string) =>
      db.query<ChallengeRow>('SELECT * FROM challenges WHERE question_id = $1 ORDER BY created_at, id', [questionId]),

    async setStatus(
      id: string,
      status: ChallengeStatus,
      r?: { resolution: ChallengeResolution | null; note: string | null; resolvedBy: string },
    ) {
      return (await db.one<ChallengeRow>(
        `UPDATE challenges SET status = $2, resolution = $3, resolution_note = $4, resolved_by = $5,
           resolved_at = CASE WHEN $5::uuid IS NULL THEN resolved_at ELSE now() END
         WHERE id = $1 RETURNING *`,
        [id, status, r?.resolution ?? null, r?.note ?? null, r?.resolvedBy ?? null],
      ))!;
    },

    async insertResponse(r: {
      id: string;
      challengeId: string;
      participantId: string;
      stance: ChallengeStance;
      answerId: string | null;
      comment: string | null;
    }) {
      return (await db.one<ChallengeResponseRow>(
        `INSERT INTO challenge_responses (id, challenge_id, participant_id, stance, answer_id, comment)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [r.id, r.challengeId, r.participantId, r.stance, r.answerId, r.comment],
      ))!;
    },

    findResponse: (challengeId: string, participantId: string) =>
      db.one<ChallengeResponseRow>(
        'SELECT * FROM challenge_responses WHERE challenge_id = $1 AND participant_id = $2',
        [challengeId, participantId],
      ),

    listResponses: (challengeIds: string[]) =>
      challengeIds.length
        ? db.query<ChallengeResponseRow>(
            'SELECT * FROM challenge_responses WHERE challenge_id = ANY($1::uuid[]) ORDER BY created_at, id',
            [challengeIds],
          )
        : Promise.resolve([] as ChallengeResponseRow[]),
  };
}
export type ChallengesRepo = ReturnType<typeof challengesRepo>;
