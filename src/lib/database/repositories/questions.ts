import { toVectorLiteral, type Db } from '../client';
import type {
  AnswerRelationship,
  AnswerRow,
  AnswerSource,
  AnswerType,
  AnswerValue,
  Consensus,
  ImageRow,
  MatchDecision,
  QuestionRow,
  QuestionStatus,
  SubmissionRow,
  SubmissionSource,
  SubmissionStatus,
} from '@/lib/domain/types';

const imageCols = (t = 'question_images') =>
  ['id', 'session_id', 'question_id', 'participant_id', 'display_key', 'thumb_key', 'original_key', 'width', 'height',
    'bytes', 'sha256', 'embedding_model', 'created_at']
    .map((c) => `${t}.${c}`)
    .join(', ') + `, (${t}.embedding IS NOT NULL) AS has_embedding`;

/**
 * Filters and sorts for the Questions tab are registries: add an entry to
 * support a new one. `a` is the viewer's own answer (LEFT JOIN), `q` the question.
 */
export const QUESTION_FILTERS = {
  ALL: { label: 'All', sql: 'TRUE' },
  UNANSWERED: { label: 'Unanswered', sql: 'a.id IS NULL' },
  ANSWERED: { label: 'Answered', sql: 'a.id IS NOT NULL' },
  CHALLENGED: { label: 'Challenged', sql: 'q.open_challenge_count > 0' },
  RESOLVED: { label: 'Resolved', sql: `q.status = 'RESOLVED'` },
  HIGH_CONSENSUS: { label: 'High consensus', sql: 'q.consensus_pct >= $HIGH', needsConsensus: true },
  LOW_CONSENSUS: { label: 'Low consensus', sql: 'q.consensus_pct < $MODERATE', needsConsensus: true },
} as const satisfies Record<string, { label: string; sql: string; needsConsensus?: boolean }>;
export type QuestionFilter = keyof typeof QUESTION_FILTERS;

export const QUESTION_SORTS = {
  NEWEST: { label: 'Newest', sql: 'q.number DESC' },
  MOST_ANSWERS: { label: 'Most answers', sql: 'q.answer_count DESC, q.number DESC' },
  MOST_CHALLENGED: { label: 'Most challenged', sql: 'q.challenge_count DESC, q.number DESC' },
  HIGHEST_CONSENSUS: {
    label: 'Highest consensus',
    sql: 'q.consensus_pct DESC NULLS LAST, q.number DESC',
    needsConsensus: true,
  },
  LOWEST_CONSENSUS: {
    label: 'Lowest consensus',
    sql: 'q.consensus_pct ASC NULLS LAST, q.number DESC',
    needsConsensus: true,
  },
} as const satisfies Record<string, { label: string; sql: string; needsConsensus?: boolean }>;
export type QuestionSort = keyof typeof QUESTION_SORTS;

export type QuestionListRow = QuestionRow & {
  answeredByMe: boolean;
  myAnswer: string | null;
  repThumbKey: string | null;
};

export function questionsRepo(db: Db) {
  return {
    // ------------------------------------------------------------ questions
    async insertQuestion(q: { id: string; sessionId: string; number: number; createdBy: string }) {
      return (await db.one<QuestionRow>(
        `INSERT INTO session_questions (id, session_id, number, content_type, content, created_by)
         VALUES ($1, $2, $3, 'IMAGE', '{}'::jsonb, $4) RETURNING *`,
        [q.id, q.sessionId, q.number, q.createdBy],
      ))!;
    },

    findQuestion: (id: string) => db.one<QuestionRow>('SELECT * FROM session_questions WHERE id = $1', [id]),

    async setQuestionPointers(id: string, p: { representativeImageId?: string; originalAnswerId?: string }) {
      await db.query(
        `UPDATE session_questions SET
           representative_image_id = COALESCE($2, representative_image_id),
           original_answer_id = COALESCE($3, original_answer_id)
         WHERE id = $1`,
        [id, p.representativeImageId ?? null, p.originalAnswerId ?? null],
      );
    },

    async updateQuestionStats(
      id: string,
      s: {
        answerCount: number;
        imageCount: number;
        consensus: Consensus;
        challengeCount: number;
        openChallengeCount: number;
        status: QuestionStatus;
      },
    ) {
      await db.query(
        `UPDATE session_questions SET answer_count = $2, image_count = $3, consensus_pct = $4,
           consensus_level = $5, consensus = $6::jsonb, challenge_count = $7, open_challenge_count = $8,
           status = $9, last_activity_at = now()
         WHERE id = $1`,
        [
          id,
          s.answerCount,
          s.imageCount,
          s.consensus.pct,
          s.consensus.level,
          JSON.stringify(s.consensus),
          s.challengeCount,
          s.openChallengeCount,
          s.status,
        ],
      );
    },

    async questionCounts(questionId: string) {
      return (await db.one<{ images: number; challenges: number; openChallenges: number }>(
        `SELECT
           (SELECT count(*)::int FROM question_images WHERE question_id = $1) AS images,
           (SELECT count(*)::int FROM challenges WHERE question_id = $1) AS challenges,
           (SELECT count(*)::int FROM challenges WHERE question_id = $1 AND status IN ('OPEN','DISCUSSION')) AS open_challenges`,
        [questionId],
      ))!;
    },

    async listQuestions(opts: {
      sessionId: string;
      viewerId: string;
      filter: QuestionFilter;
      sort: QuestionSort;
      search: string | null;
      searchAllAnswers: boolean;
      thresholds: { high: number; moderate: number };
      limit: number;
      offset: number;
    }): Promise<{ rows: QuestionListRow[]; total: number }> {
      const params: unknown[] = [opts.sessionId, opts.viewerId];
      const where = ['q.session_id = $1'];
      // filter fragments come from the registry above, never from user input
      where.push(
        `(${QUESTION_FILTERS[opts.filter].sql
          .replace('$HIGH', String(Number(opts.thresholds.high)))
          .replace('$MODERATE', String(Number(opts.thresholds.moderate)))})`,
      );
      if (opts.search) {
        const numeric = opts.search.replace(/^#/, '');
        params.push(`%${opts.search.replace(/[%_\\]/g, '\\$&')}%`);
        const like = `$${params.length}`;
        const clauses = [`a.raw_answer ILIKE ${like}`];
        if (opts.searchAllAnswers)
          clauses.push(`EXISTS (SELECT 1 FROM answers x WHERE x.question_id = q.id AND x.raw_answer ILIKE ${like})`);
        if (/^\d+$/.test(numeric)) {
          params.push(Number(numeric));
          clauses.push(`q.number = $${params.length}`);
        }
        where.push(`(${clauses.join(' OR ')})`);
      }
      const from = `FROM session_questions q
        LEFT JOIN answers a ON a.question_id = q.id AND a.participant_id = $2
        LEFT JOIN question_images ri ON ri.id = q.representative_image_id
        WHERE ${where.join(' AND ')}`;
      const total = (await db.one<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params))!.n;
      params.push(opts.limit, opts.offset);
      const rows = await db.query<QuestionListRow>(
        `SELECT q.*, (a.id IS NOT NULL) AS answered_by_me, a.raw_answer AS my_answer, ri.thumb_key AS rep_thumb_key
         ${from} ORDER BY ${QUESTION_SORTS[opts.sort].sql}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total };
    },

    // --------------------------------------------------------------- images
    async insertImage(i: {
      id: string;
      sessionId: string;
      participantId: string;
      displayKey: string;
      thumbKey: string;
      originalKey: string | null;
      width: number;
      height: number;
      bytes: number;
      sha256: string;
      embedding: number[] | null;
      embeddingModel: string | null;
    }) {
      await db.query(
        `INSERT INTO question_images (id, session_id, participant_id, display_key, thumb_key, original_key,
           width, height, bytes, sha256, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12)`,
        [
          i.id,
          i.sessionId,
          i.participantId,
          i.displayKey,
          i.thumbKey,
          i.originalKey,
          i.width,
          i.height,
          i.bytes,
          i.sha256,
          i.embedding ? toVectorLiteral(i.embedding) : null,
          i.embeddingModel,
        ],
      );
    },

    findImage: (id: string) => db.one<ImageRow>(`SELECT ${imageCols()} FROM question_images WHERE id = $1`, [id]),

    async attachImage(imageId: string, questionId: string) {
      await db.query('UPDATE question_images SET question_id = $2 WHERE id = $1', [imageId, questionId]);
    },

    async setImageEmbedding(imageId: string, embedding: number[], model: string) {
      await db.query('UPDATE question_images SET embedding = $2::vector, embedding_model = $3 WHERE id = $1', [
        imageId,
        toVectorLiteral(embedding),
        model,
      ]);
    },

    listImages: (questionId: string, limit: number) =>
      db.query<ImageRow & { similarityScore: number | null; matchDecision: MatchDecision | null }>(
        `SELECT ${imageCols('qi')}, s.similarity_score, s.match_decision
         FROM question_images qi LEFT JOIN submissions s ON s.image_id = qi.id
         WHERE qi.question_id = $1 ORDER BY qi.created_at, qi.id LIMIT $2`,
        [questionId, limit],
      ),

    /**
     * Session-scoped nearest-neighbour search (cosine). Only images already
     * attached to a question group, embedded by the same model, are candidates.
     */
    findNearestImages: (sessionId: string, embedding: number[], model: string, topK: number) =>
      db.query<{ imageId: string; questionId: string; similarity: number }>(
        `SELECT id AS image_id, question_id, 1 - (embedding <=> $2::vector) AS similarity
         FROM question_images
         WHERE session_id = $1 AND question_id IS NOT NULL AND embedding IS NOT NULL AND embedding_model = $3
         ORDER BY embedding <=> $2::vector
         LIMIT $4`,
        [sessionId, toVectorLiteral(embedding), model, topK],
      ),

    // ---------------------------------------------------------- submissions
    async insertSubmission(s: {
      id: string;
      sessionId: string;
      participantId: string;
      imageId: string;
      questionId: string | null;
      candidateQuestionId: string | null;
      status: SubmissionStatus;
      matchDecision: MatchDecision;
      similarityScore: number | null;
      rawAnswer: string;
      answerType: AnswerType;
      source: SubmissionSource;
    }) {
      return (await db.one<SubmissionRow>(
        `INSERT INTO submissions (id, session_id, participant_id, image_id, question_id, candidate_question_id,
           status, match_decision, similarity_score, raw_answer, answer_type, source, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $7::text = 'COMPLETED' THEN now() END)
         RETURNING *`,
        [
          s.id,
          s.sessionId,
          s.participantId,
          s.imageId,
          s.questionId,
          s.candidateQuestionId,
          s.status,
          s.matchDecision,
          s.similarityScore,
          s.rawAnswer,
          s.answerType,
          s.source,
        ],
      ))!;
    },

    findSubmission: (id: string) => db.one<SubmissionRow>('SELECT * FROM submissions WHERE id = $1', [id]),

    async updateSubmission(
      id: string,
      u: {
        status: SubmissionStatus;
        matchDecision?: MatchDecision;
        similarityScore?: number | null;
        questionId?: string | null;
        candidateQuestionId?: string | null;
        userConfirmedMatch?: boolean | null;
      },
    ) {
      return (await db.one<SubmissionRow>(
        `UPDATE submissions SET status = $2::text,
           match_decision = COALESCE($3, match_decision),
           similarity_score = COALESCE($4, similarity_score),
           question_id = COALESCE($5, question_id),
           candidate_question_id = COALESCE($6, candidate_question_id),
           user_confirmed_match = COALESCE($7, user_confirmed_match),
           resolved_at = CASE WHEN $2::text = 'COMPLETED' THEN now() ELSE resolved_at END
         WHERE id = $1 RETURNING *`,
        [
          id,
          u.status,
          u.matchDecision ?? null,
          u.similarityScore ?? null,
          u.questionId ?? null,
          u.candidateQuestionId ?? null,
          u.userConfirmedMatch ?? null,
        ],
      ))!;
    },

    /** Most recent submission of a participant that still needs their input. */
    latestOpenSubmission: (participantId: string) =>
      db.one<SubmissionRow>(
        `SELECT s.* FROM submissions s
         LEFT JOIN answers a ON a.submission_id = s.id
         WHERE s.participant_id = $1
           AND (s.status IN ('PENDING_CONFIRMATION','SIMILARITY_FAILED') OR a.relationship = 'UNDECIDED')
         ORDER BY s.created_at DESC LIMIT 1`,
        [participantId],
      ),

    // -------------------------------------------------------------- answers
    async insertAnswer(a: {
      id: string;
      sessionId: string;
      questionId: string;
      participantId: string;
      submissionId: string | null;
      rawAnswer: string;
      normalizedAnswer: string;
      effectiveNormalized: string;
      value: AnswerValue;
      relationship: AnswerRelationship;
      endorsedAnswerId: string | null;
      source: AnswerSource;
    }) {
      return (await db.one<AnswerRow>(
        `INSERT INTO answers (id, session_id, question_id, participant_id, submission_id, answer_type, raw_answer,
           normalized_answer, effective_normalized, value, relationship, endorsed_answer_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING *`,
        [
          a.id,
          a.sessionId,
          a.questionId,
          a.participantId,
          a.submissionId,
          a.value.type,
          a.rawAnswer,
          a.normalizedAnswer,
          a.effectiveNormalized,
          JSON.stringify(a.value),
          a.relationship,
          a.endorsedAnswerId,
          a.source,
        ],
      ))!;
    },

    findAnswer: (id: string) => db.one<AnswerRow>('SELECT * FROM answers WHERE id = $1', [id]),
    findAnswerBySubmission: (submissionId: string) =>
      db.one<AnswerRow>('SELECT * FROM answers WHERE submission_id = $1', [submissionId]),
    findAnswerFor: (questionId: string, participantId: string) =>
      db.one<AnswerRow>('SELECT * FROM answers WHERE question_id = $1 AND participant_id = $2', [
        questionId,
        participantId,
      ]),
    listAnswers: (questionId: string) =>
      db.query<AnswerRow>('SELECT * FROM answers WHERE question_id = $1 ORDER BY created_at, id', [questionId]),

    /** Records how an answer relates to another. The raw answer is never touched. */
    async setAnswerRelationship(
      id: string,
      relationship: AnswerRelationship,
      endorsedAnswerId: string | null,
      effectiveNormalized: string,
    ) {
      return (await db.one<AnswerRow>(
        `UPDATE answers SET relationship = $2, endorsed_answer_id = $3, effective_normalized = $4
         WHERE id = $1 RETURNING *`,
        [id, relationship, endorsedAnswerId, effectiveNormalized],
      ))!;
    },

    /** One row per answer, for the host's results export. */
    exportRows: (sessionId: string) =>
      db.query<{
        number: number;
        status: string;
        consensusPct: number | null;
        answerCount: number;
        participant: string;
        rawAnswer: string;
        normalizedAnswer: string;
        relationship: string;
        endorsedRaw: string | null;
        source: string;
        createdAt: Date;
      }>(
        `SELECT q.number, q.status, q.consensus_pct, q.answer_count, p.display_name AS participant,
                a.raw_answer, a.normalized_answer, a.relationship, e.raw_answer AS endorsed_raw, a.source, a.created_at
         FROM answers a
         JOIN session_questions q ON q.id = a.question_id
         JOIN session_participants p ON p.id = a.participant_id
         LEFT JOIN answers e ON e.id = a.endorsed_answer_id
         WHERE a.session_id = $1
         ORDER BY q.number, a.created_at, a.id`,
        [sessionId],
      ),

    answererIds: async (questionId: string) =>
      (await db.query<{ participantId: string }>('SELECT participant_id FROM answers WHERE question_id = $1', [
        questionId,
      ])).map((r) => r.participantId),
  };
}
export type QuestionsRepo = ReturnType<typeof questionsRepo>;
