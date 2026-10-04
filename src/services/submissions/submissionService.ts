import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import type { Db } from '@/lib/database/client';
import type { QuestionsRepo } from '@/lib/database/repositories/questions';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type {
  AnswerRow,
  MatchDecision,
  ParticipantRow,
  QuestionRow,
  SessionRow,
  SubmissionRow,
  SubmissionSource,
} from '@/lib/domain/types';
import type { MatchPrompt, SubmissionResult } from '@/lib/domain/views';
import type { EventBus } from '@/lib/events/bus';
import type { DomainEvent } from '@/lib/events/types';
import { badRequest, conflict, notFound } from '@/lib/http/errors';
import { Permission, authorize, can } from '@/lib/permissions/permissions';
import type { AnswerMatchingService } from '@/services/answerMatching';
import type { ChallengeService } from '@/services/challenges/challengeService';
import type { ImageProcessor } from '@/services/imageProcessing/imageProcessor';
import { classifyMatch, type ImageSimilarityService } from '@/services/imageSimilarity';
import type { QuestionService } from '@/services/questions/questionService';
import { nameResolver, visibilityFor } from '@/services/questions/visibility';
import type { StorageService } from '@/services/storage';

export interface SubmissionDeps {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionsRepo;
  questions: QuestionsRepo;
  matcher: AnswerMatchingService;
  similarity: ImageSimilarityService;
  images: ImageProcessor;
  storage: StorageService;
  questionService: QuestionService;
  challengeService: ChallengeService;
}

/** What the matching step decided to do with a submission. */
interface Placement {
  submission: SubmissionRow;
  events: DomainEvent[];
}

type Draft = {
  id: string;
  imageId: string;
  rawAnswer: string;
  source: SubmissionSource;
  /** set when re-processing a submission that already has a row */
  existing: boolean;
};

export type MatchAction = 'USE_EXISTING' | 'CREATE_NEW' | 'RETRY';
export type AnswerDecision = 'AGREE' | 'CHALLENGE' | 'KEEP';

/**
 * The core workflow: image + answer in → embedding → session-scoped similarity
 * search → join an existing question group, ask the participant, or create a
 * new group. Publishes domain events; knows nothing about sockets or UI.
 */
export class SubmissionService {
  constructor(private d: SubmissionDeps) {}

  async submit(
    session: SessionRow,
    participant: ParticipantRow,
    input: { image: Buffer; answer: unknown; source?: SubmissionSource },
  ): Promise<SubmissionResult> {
    authorize(participant, session, Permission.POST_ANSWER);
    this.assertActive(session);
    const rawAnswer = this.d.questionService.validateAnswerText(input.answer);
    const processed = await this.d.images.process(input.image);

    const imageId = crypto.randomUUID();
    const base = `${session.id}/${imageId}`;
    const keys = {
      display: `${base}/display.webp`,
      thumb: `${base}/thumb.webp`,
      original: processed.original ? `${base}/original` : null,
    };
    await this.d.storage.put(keys.display, processed.display, 'image/webp');
    await this.d.storage.put(keys.thumb, processed.thumb, 'image/webp');
    if (processed.original && keys.original)
      await this.d.storage.put(keys.original, processed.original, `image/${processed.originalFormat}`);

    // Embedding is generated outside the transaction (it is slow) and may fail.
    const embedding = await this.tryEmbed(processed.display);

    const draft: Draft = {
      id: crypto.randomUUID(),
      imageId,
      rawAnswer,
      source: input.source ?? 'upload',
      existing: false,
    };
    const placement = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      await this.d.questions.insertImage({
        id: imageId,
        sessionId: session.id,
        participantId: participant.id,
        displayKey: keys.display,
        thumbKey: keys.thumb,
        originalKey: keys.original,
        width: processed.width,
        height: processed.height,
        bytes: processed.display.length,
        sha256: processed.sha256,
        embedding,
        embeddingModel: embedding ? this.d.similarity.modelId : null,
      });
      const submitted: DomainEvent = {
        type: 'IMAGE_SUBMITTED',
        sessionId: session.id,
        actorId: participant.id,
        payload: { imageId, source: draft.source, embedded: !!embedding },
      };
      const placed = embedding
        ? await this.matchAndPlace(session, participant, draft, embedding)
        : await this.park(session, participant, draft, 'SIMILARITY_FAILED', 'UNKNOWN', null, null);
      return { ...placed, events: [submitted, ...placed.events] };
    });
    await this.d.bus.publishAll(placement.events);
    return this.toResult(session, participant, placement.submission);
  }

  /**
   * Second step for submissions that could not be placed automatically:
   *  - POSSIBLE match  → USE_EXISTING | CREATE_NEW
   *  - similarity down → RETRY | CREATE_NEW
   */
  async resolveMatch(
    session: SessionRow,
    participant: ParticipantRow,
    submissionId: string,
    action: MatchAction,
  ): Promise<SubmissionResult> {
    authorize(participant, session, Permission.POST_ANSWER);
    this.assertActive(session);
    const sub = await this.requireOwnSubmission(participant, submissionId);
    if (sub.status === 'COMPLETED') throw conflict('This submission has already been placed', 'ALREADY_RESOLVED');
    const draft: Draft = { id: sub.id, imageId: sub.imageId, rawAnswer: sub.rawAnswer, source: sub.source, existing: true };

    let embedding: number[] | null = null;
    if (action === 'RETRY') {
      if (sub.status !== 'SIMILARITY_FAILED') throw badRequest('Nothing to retry for this submission');
      const image = await this.d.questions.findImage(sub.imageId);
      const stored = image ? await this.d.storage.get(image.displayKey) : null;
      embedding = stored ? await this.tryEmbed(stored.data) : null;
      if (!embedding) return this.toResult(session, participant, sub); // still unavailable
    } else if (action === 'USE_EXISTING') {
      if (sub.status !== 'PENDING_CONFIRMATION' || !sub.candidateQuestionId)
        throw badRequest('There is no suggested question for this submission');
    } else if (action !== 'CREATE_NEW') {
      throw badRequest('Unknown action');
    }

    const placement = await this.d.db.tx(async (): Promise<Placement> => {
      await this.d.sessions.lockSession(session.id);
      // re-read under the lock: a double click must not place the submission twice
      const fresh = (await this.d.questions.findSubmission(sub.id))!;
      if (fresh.status === 'COMPLETED') throw conflict('This submission has already been placed', 'ALREADY_RESOLVED');
      if (action === 'RETRY') {
        await this.d.questions.setImageEmbedding(sub.imageId, embedding!, this.d.similarity.modelId);
        return this.matchAndPlace(session, participant, draft, embedding!);
      }
      if (action === 'USE_EXISTING') {
        const question = await this.d.questionService.requireQuestion(session, sub.candidateQuestionId!);
        return this.attach(session, participant, draft, question, 'POSSIBLE_MATCH', sub.similarityScore, true);
      }
      return this.createNew(
        session,
        participant,
        draft,
        sub.status === 'SIMILARITY_FAILED' ? 'UNKNOWN' : 'POSSIBLE_MATCH',
        sub.similarityScore,
        sub.status === 'PENDING_CONFIRMATION' ? false : null,
      );
    });
    await this.d.bus.publishAll(placement.events);
    return this.toResult(session, participant, placement.submission);
  }

  /**
   * After a match the participant chooses how their answer relates to the
   * previous one. Their raw answer is preserved in every case.
   */
  async decide(
    session: SessionRow,
    participant: ParticipantRow,
    submissionId: string,
    decision: AnswerDecision,
    reason?: string | null,
  ): Promise<SubmissionResult> {
    this.assertActive(session);
    const sub = await this.requireOwnSubmission(participant, submissionId);
    if (!sub.questionId) throw conflict('This submission is not attached to a question yet', 'NOT_PLACED');
    if (!['AGREE', 'CHALLENGE', 'KEEP'].includes(decision)) throw badRequest('Unknown decision');

    if (decision === 'CHALLENGE') {
      // the challenge service validates, records the relationship and publishes events
      await this.d.challengeService.create(session, participant, sub.questionId, { reason });
      return this.toResult(session, participant, sub);
    }

    const events = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const answer = await this.d.questions.findAnswerBySubmission(sub.id);
      if (!answer) throw conflict('No answer was recorded for this submission', 'NO_ANSWER');
      if (answer.relationship !== 'UNDECIDED') throw conflict('You have already made this choice', 'ALREADY_DECIDED');
      const question = (await this.d.questions.findQuestion(sub.questionId!))!;
      const original = question.originalAnswerId ? await this.d.questions.findAnswer(question.originalAnswerId) : null;
      const updated =
        decision === 'AGREE' && original
          ? await this.d.questions.setAnswerRelationship(answer.id, 'AGREES', original.id, original.effectiveNormalized)
          : await this.d.questions.setAnswerRelationship(answer.id, 'INDEPENDENT', null, answer.normalizedAnswer);
      const ev: DomainEvent = {
        type: 'ANSWER_RELATIONSHIP_SET',
        sessionId: session.id,
        actorId: participant.id,
        questionId: question.id,
        payload: {
          questionNumber: question.number,
          answerId: answer.id,
          relationship: updated.relationship,
          rawAnswer: answer.rawAnswer,
          endorsedRaw: updated.relationship === 'AGREES' ? original!.rawAnswer : null,
        },
        publicPayload: { questionNumber: question.number },
      };
      return [ev, ...(await this.d.questionService.recompute(question.id, participant.id))];
    });
    await this.d.bus.publishAll(events);
    return this.toResult(session, participant, sub);
  }

  /** The viewer's most recent submission that is still waiting for them. */
  async pendingFor(session: SessionRow, participant: ParticipantRow): Promise<SubmissionResult | null> {
    const sub = await this.d.questions.latestOpenSubmission(participant.id);
    return sub ? this.toResult(session, participant, sub) : null;
  }

  // ---------------------------------------------------------------- internals

  private assertActive(session: SessionRow) {
    if (session.status !== 'ACTIVE')
      throw conflict(
        session.status === 'WAITING' ? 'The host has not started the session yet' : 'This session has ended',
        'SESSION_NOT_ACTIVE',
      );
  }

  private async requireOwnSubmission(participant: ParticipantRow, id: string) {
    const sub = /^[0-9a-f-]{36}$/i.test(id) ? await this.d.questions.findSubmission(id) : null;
    if (!sub || sub.participantId !== participant.id) throw notFound('Submission');
    return sub;
  }

  /** Never lets a model failure turn into a wrong match: failure → null → ask the user. */
  private async tryEmbed(image: Buffer): Promise<number[] | null> {
    try {
      return await this.d.similarity.generateEmbedding(image);
    } catch (err) {
      console.error('[similarity] embedding failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async matchAndPlace(
    session: SessionRow,
    participant: ParticipantRow,
    draft: Draft,
    embedding: number[],
  ): Promise<Placement> {
    let verdict;
    try {
      const matches = await this.d.similarity.findSimilarImages(embedding, session.id);
      verdict = classifyMatch(matches, this.d.config.similarity);
    } catch (err) {
      console.error('[similarity] search failed:', err);
      return this.park(session, participant, draft, 'SIMILARITY_FAILED', 'UNKNOWN', null, null);
    }
    const score = verdict.best?.similarity ?? null;
    if (verdict.decision === 'HIGH_MATCH') {
      const question = (await this.d.questions.findQuestion(verdict.best!.questionId))!;
      return this.attach(session, participant, draft, question, 'HIGH_MATCH', score, null);
    }
    if (verdict.decision === 'POSSIBLE_MATCH')
      return this.park(session, participant, draft, 'PENDING_CONFIRMATION', 'POSSIBLE_MATCH', score, verdict.best!.questionId);
    return this.createNew(session, participant, draft, 'NO_MATCH', score, null);
  }

  private async save(
    session: SessionRow,
    participant: ParticipantRow,
    draft: Draft,
    fields: {
      status: SubmissionRow['status'];
      matchDecision: MatchDecision;
      similarityScore: number | null;
      questionId: string | null;
      candidateQuestionId: string | null;
      userConfirmedMatch: boolean | null;
    },
  ): Promise<SubmissionRow> {
    if (draft.existing) return this.d.questions.updateSubmission(draft.id, fields);
    return this.d.questions.insertSubmission({
      id: draft.id,
      sessionId: session.id,
      participantId: participant.id,
      imageId: draft.imageId,
      rawAnswer: draft.rawAnswer,
      answerType: 'TEXT',
      source: draft.source,
      ...fields,
    });
  }

  /** Stores the submission without placing it; the participant decides next. */
  private async park(
    session: SessionRow,
    participant: ParticipantRow,
    draft: Draft,
    status: 'PENDING_CONFIRMATION' | 'SIMILARITY_FAILED',
    matchDecision: MatchDecision,
    similarityScore: number | null,
    candidateQuestionId: string | null,
  ): Promise<Placement> {
    const submission = await this.save(session, participant, draft, {
      status,
      matchDecision,
      similarityScore,
      questionId: null,
      candidateQuestionId,
      userConfirmedMatch: null,
    });
    return { submission, events: [] };
  }

  private async createNew(
    session: SessionRow,
    participant: ParticipantRow,
    draft: Draft,
    matchDecision: MatchDecision,
    similarityScore: number | null,
    userConfirmedMatch: boolean | null,
  ): Promise<Placement> {
    const question = await this.d.questionService.createQuestion(session, participant, draft.imageId);
    const submission = await this.save(session, participant, draft, {
      status: 'COMPLETED',
      matchDecision,
      similarityScore,
      questionId: question.id,
      candidateQuestionId: null,
      userConfirmedMatch,
    });
    const answer = await this.d.questionService.recordAnswer({
      session,
      question,
      participant,
      rawAnswer: draft.rawAnswer,
      submissionId: submission.id,
      source: 'IMAGE_SUBMISSION',
      relationship: 'ORIGINAL',
    });
    const created: DomainEvent = {
      type: 'QUESTION_CREATED',
      sessionId: session.id,
      actorId: participant.id,
      questionId: question.id,
      payload: { questionNumber: question.number, imageId: draft.imageId, matchDecision, similarity: similarityScore },
      publicPayload: { questionNumber: question.number },
    };
    return {
      submission,
      events: [
        created,
        this.d.questionService.answerSubmittedEvent(question, answer),
        ...(await this.d.questionService.recompute(question.id, participant.id)),
      ],
    };
  }

  private async attach(
    session: SessionRow,
    participant: ParticipantRow,
    draft: Draft,
    question: QuestionRow,
    matchDecision: MatchDecision,
    similarityScore: number | null,
    userConfirmedMatch: boolean | null,
  ): Promise<Placement> {
    await this.d.questionService.attachImage(question, draft.imageId);
    const submission = await this.save(session, participant, draft, {
      status: 'COMPLETED',
      matchDecision,
      similarityScore,
      questionId: question.id,
      candidateQuestionId: null,
      userConfirmedMatch,
    });
    const events: DomainEvent[] = [
      {
        type: 'QUESTION_MATCHED',
        sessionId: session.id,
        actorId: participant.id,
        questionId: question.id,
        payload: {
          questionNumber: question.number,
          imageId: draft.imageId,
          matchDecision,
          similarity: similarityScore,
          confirmedByUser: userConfirmedMatch === true,
        },
        publicPayload: { questionNumber: question.number },
      },
    ];

    // The image always joins the group. The answer is only recorded if this
    // participant has not answered the question before (answers are immutable).
    const existing = await this.d.questions.findAnswerFor(question.id, participant.id);
    if (!existing) {
      const original = question.originalAnswerId ? await this.d.questions.findAnswer(question.originalAnswerId) : null;
      const same = !!original && this.d.matcher.compare(draft.rawAnswer, original.rawAnswer).equivalent;
      const hidden = session.settings.previousAnswerVisibility === 'NEVER';
      const answer = await this.d.questionService.recordAnswer({
        session,
        question,
        participant,
        rawAnswer: draft.rawAnswer,
        submissionId: submission.id,
        source: 'IMAGE_SUBMISSION',
        // identical answers agree automatically; otherwise the participant is asked
        relationship: !original ? 'ORIGINAL' : same ? 'AGREES' : hidden ? 'INDEPENDENT' : 'UNDECIDED',
        endorsed: same ? original : null,
      });
      events.push(this.d.questionService.answerSubmittedEvent(question, answer));
    }
    events.push(...(await this.d.questionService.recompute(question.id, participant.id)));
    return { submission, events };
  }

  private async toResult(session: SessionRow, viewer: ParticipantRow, stale: SubmissionRow): Promise<SubmissionResult> {
    const sub = (await this.d.questions.findSubmission(stale.id))!;
    const yourImageUrl = this.d.questionService.imageUrl(sub.imageId, 'display');

    if (sub.status === 'SIMILARITY_FAILED')
      return { outcome: 'SIMILARITY_UNAVAILABLE', submissionId: sub.id, yourAnswer: sub.rawAnswer, yourImageUrl };

    if (sub.status === 'PENDING_CONFIRMATION') {
      const candidate = sub.candidateQuestionId ? await this.d.questions.findQuestion(sub.candidateQuestionId) : null;
      if (candidate)
        return {
          outcome: 'POSSIBLE_MATCH',
          submissionId: sub.id,
          similarity: Number(sub.similarityScore ?? 0),
          yourAnswer: sub.rawAnswer,
          yourImageUrl,
          candidate: {
            id: candidate.id,
            number: candidate.number,
            imageUrl: candidate.representativeImageId
              ? this.d.questionService.imageUrl(candidate.representativeImageId, 'display')
              : null,
          },
        };
      return { outcome: 'SIMILARITY_UNAVAILABLE', submissionId: sub.id, yourAnswer: sub.rawAnswer, yourImageUrl };
    }

    const question = await this.d.questionService.summary(session, viewer, sub.questionId!);
    const answer = await this.d.questions.findAnswerBySubmission(sub.id);
    if (!answer) {
      // image joined a question this participant had already answered
      const mine = await this.d.questions.findAnswerFor(sub.questionId!, viewer.id);
      return { outcome: 'ALREADY_ANSWERED', submissionId: sub.id, question, yourAnswer: mine?.rawAnswer ?? sub.rawAnswer };
    }
    if (answer.relationship === 'ORIGINAL' && sub.matchDecision !== 'HIGH_MATCH' && sub.userConfirmedMatch !== true)
      return { outcome: 'NEW_QUESTION', submissionId: sub.id, question };

    return {
      outcome: 'MATCHED',
      submissionId: sub.id,
      similarity: sub.similarityScore === null ? null : Number(sub.similarityScore),
      confirmedByUser: sub.userConfirmedMatch === true,
      question,
      prompt: await this.buildPrompt(session, viewer, sub, answer),
    };
  }

  private async buildPrompt(
    session: SessionRow,
    viewer: ParticipantRow,
    sub: SubmissionRow,
    answer: AnswerRow,
  ): Promise<MatchPrompt> {
    const question = (await this.d.questions.findQuestion(sub.questionId!))!;
    const original =
      question.originalAnswerId && question.originalAnswerId !== answer.id
        ? await this.d.questions.findAnswer(question.originalAnswerId)
        : null;
    const vis = visibilityFor(session, viewer, true);
    const participants = new Map((await this.d.sessions.listParticipants(session.id)).map((p) => [p.id, p]));
    const nameOf = nameResolver(viewer, participants, vis.identities, 'Another participant');
    const sameAnswer = !!original && this.d.matcher.compare(answer.rawAnswer, original.rawAnswer).equivalent;
    return {
      answerId: answer.id,
      yourAnswer: answer.rawAnswer,
      previousAnswer: vis.answers && original ? { raw: original.rawAnswer, by: nameOf(original.participantId) } : null,
      sameAnswer,
      needsDecision: answer.relationship === 'UNDECIDED',
      canChallenge:
        answer.relationship === 'UNDECIDED' &&
        !!original &&
        vis.answers &&
        !sameAnswer &&
        can(viewer, session, Permission.CHALLENGE_ANSWER),
    };
  }
}
