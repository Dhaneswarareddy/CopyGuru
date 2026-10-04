import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import type { Db } from '@/lib/database/client';
import type { ChallengesRepo } from '@/lib/database/repositories/challenges';
import type { QuestionsRepo } from '@/lib/database/repositories/questions';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type {
  ChallengeResolution,
  ChallengeRow,
  ChallengeStance,
  ParticipantRow,
  SessionRow,
} from '@/lib/domain/types';
import type { EventBus } from '@/lib/events/bus';
import type { DomainEvent } from '@/lib/events/types';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http/errors';
import { Permission, authorize } from '@/lib/permissions/permissions';
import type { AnswerMatchingService } from '@/services/answerMatching';
import type { QuestionService } from '@/services/questions/questionService';
import { visibilityFor } from '@/services/questions/visibility';
import { RESOLUTIONS, assertTransition, isActive } from './stateMachine';

export interface ChallengeDeps {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionsRepo;
  questions: QuestionsRepo;
  challenges: ChallengesRepo;
  matcher: AnswerMatchingService;
  questionService: QuestionService;
}

const MAX_TEXT = 500;
const cleanText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);

export class ChallengeService {
  constructor(private d: ChallengeDeps) {}

  /**
   * Opens a challenge against a question's original answer. The original
   * answer and the challenger's answer both stay intact, side by side.
   */
  async create(
    session: SessionRow,
    challenger: ParticipantRow,
    questionId: string,
    input: { reason?: unknown; answer?: unknown },
  ): Promise<ChallengeRow> {
    authorize(challenger, session, Permission.CHALLENGE_ANSWER);
    this.assertActive(session);
    const reason = cleanText(input.reason);

    const { challenge, events } = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const question = await this.d.questionService.requireQuestion(session, questionId);
      const original = question.originalAnswerId ? await this.d.questions.findAnswer(question.originalAnswerId) : null;
      if (!original) throw conflict('There is no answer to challenge yet', 'NOTHING_TO_CHALLENGE');
      if (original.participantId === challenger.id)
        throw conflict('You cannot challenge your own answer', 'OWN_ANSWER');
      if (await this.d.challenges.findByChallenger(question.id, challenger.id))
        throw conflict('You have already challenged this question', 'ALREADY_CHALLENGED');

      const events: DomainEvent[] = [];
      let mine = await this.d.questions.findAnswerFor(question.id, challenger.id);
      if (!visibilityFor(session, challenger, !!mine || input.answer !== undefined).answers)
        throw forbidden('You cannot challenge an answer you are not allowed to see');
      if (!mine) {
        // challenging from the question page without having answered yet
        const raw = this.d.questionService.validateAnswerText(input.answer);
        mine = await this.d.questionService.recordAnswer({
          session,
          question,
          participant: challenger,
          rawAnswer: raw,
          submissionId: null,
          source: 'DIRECT',
          relationship: 'INDEPENDENT',
        });
        events.push(this.d.questionService.answerSubmittedEvent(question, mine));
      }
      if (this.d.matcher.compare(mine.rawAnswer, original.rawAnswer).equivalent)
        throw conflict('Your answer is the same as the original answer', 'SAME_ANSWER');

      // record the relationship; the raw answer itself is untouched
      mine = await this.d.questions.setAnswerRelationship(mine.id, 'CHALLENGES', null, mine.normalizedAnswer);
      const challenge = await this.d.challenges.insert({
        id: crypto.randomUUID(),
        sessionId: session.id,
        questionId: question.id,
        originalAnswerId: original.id,
        challengerAnswerId: mine.id,
        challengerId: challenger.id,
        reason,
      });
      const detail = {
        questionNumber: question.number,
        challengeId: challenge.id,
        originalAnswerId: original.id,
        originalAnswer: original.rawAnswer,
        originalAuthorId: original.participantId,
        challengerAnswerId: mine.id,
        challengerAnswer: mine.rawAnswer,
        reason,
      };
      const pub = { questionNumber: question.number, challengeId: challenge.id };
      events.push(
        { type: 'ANSWER_CHALLENGED', sessionId: session.id, actorId: challenger.id, questionId: question.id, payload: detail, publicPayload: pub },
        { type: 'CHALLENGE_CREATED', sessionId: session.id, actorId: challenger.id, questionId: question.id, payload: { ...detail, status: challenge.status }, publicPayload: pub },
        ...(await this.d.questionService.recompute(question.id, challenger.id)),
      );
      return { challenge, events };
    });
    await this.d.bus.publishAll(events);
    return challenge;
  }

  /**
   * A participant takes a side. One response per participant per challenge
   * (enforced here and by a unique constraint).
   */
  async respond(
    session: SessionRow,
    participant: ParticipantRow,
    challengeId: string,
    input: { stance: unknown; answer?: unknown; comment?: unknown },
  ) {
    authorize(participant, session, Permission.RESPOND_TO_CHALLENGE);
    this.assertActive(session);
    const stance = input.stance as ChallengeStance;
    if (!['ORIGINAL', 'CHALLENGE', 'OTHER'].includes(stance)) throw badRequest('Unknown stance');

    const { questionId, events } = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const challenge = await this.requireChallenge(session, challengeId, true);
      if (!isActive(challenge.status)) throw conflict('This challenge is closed', 'CHALLENGE_CLOSED');
      const question = (await this.d.questions.findQuestion(challenge.questionId))!;
      const original = (await this.d.questions.findAnswer(challenge.originalAnswerId))!;
      const challengerAnswer = (await this.d.questions.findAnswer(challenge.challengerAnswerId))!;
      if (participant.id === challenge.challengerId || participant.id === original.participantId)
        throw conflict('You are a party to this challenge and already count for your side', 'CHALLENGE_PARTY');
      if (await this.d.challenges.findResponse(challenge.id, participant.id))
        throw conflict('You have already responded to this challenge', 'ALREADY_RESPONDED');

      const events: DomainEvent[] = [];
      // If the participant has no answer on this question yet, their response
      // becomes their answer. An existing answer is never changed.
      let mine = await this.d.questions.findAnswerFor(question.id, participant.id);
      let answerId: string | null = null;
      if (!mine) {
        const endorsed = stance === 'ORIGINAL' ? original : stance === 'CHALLENGE' ? challengerAnswer : null;
        const raw = endorsed ? endorsed.rawAnswer : this.d.questionService.validateAnswerText(input.answer);
        mine = await this.d.questionService.recordAnswer({
          session,
          question,
          participant,
          rawAnswer: raw,
          submissionId: null,
          source: 'CHALLENGE_RESPONSE',
          relationship: endorsed ? 'AGREES' : 'INDEPENDENT',
          endorsed,
        });
        answerId = mine.id;
        events.push(this.d.questionService.answerSubmittedEvent(question, mine));
      }
      const response = await this.d.challenges.insertResponse({
        id: crypto.randomUUID(),
        challengeId: challenge.id,
        participantId: participant.id,
        stance,
        answerId,
        comment: cleanText(input.comment),
      });
      let status: ChallengeRow['status'] = challenge.status;
      if (status === 'OPEN') {
        assertTransition('OPEN', 'DISCUSSION');
        status = (await this.d.challenges.setStatus(challenge.id, 'DISCUSSION')).status;
      }
      events.push(
        {
          type: 'CHALLENGE_RESPONSE_ADDED',
          sessionId: session.id,
          actorId: participant.id,
          questionId: question.id,
          payload: {
            questionNumber: question.number,
            challengeId: challenge.id,
            responseId: response.id,
            stance,
            rawAnswer: stance === 'OTHER' ? mine.rawAnswer : null,
            status,
          },
          publicPayload: { questionNumber: question.number, challengeId: challenge.id },
        },
        ...(await this.d.questionService.recompute(question.id, participant.id)),
      );
      return { questionId: question.id, events };
    });
    await this.d.bus.publishAll(events);
    return this.d.questionService.detail(session, participant, questionId);
  }

  /** Host (or any role with RESOLVE_CHALLENGE) closes a challenge. */
  async resolve(
    session: SessionRow,
    actor: ParticipantRow,
    challengeId: string,
    input: { outcome: unknown; note?: unknown },
  ) {
    authorize(actor, session, Permission.RESOLVE_CHALLENGE);
    const outcome = input.outcome as ChallengeResolution | 'DISMISSED';
    const dismiss = outcome === 'DISMISSED';
    if (!dismiss && !RESOLUTIONS.includes(outcome as ChallengeResolution)) throw badRequest('Unknown outcome');

    const { questionId, events } = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const challenge = await this.requireChallenge(session, challengeId, true);
      const target = dismiss ? 'DISMISSED' : 'RESOLVED';
      assertTransition(challenge.status, target);
      const updated = await this.d.challenges.setStatus(challenge.id, target, {
        resolution: dismiss ? null : (outcome as ChallengeResolution),
        note: cleanText(input.note),
        resolvedBy: actor.id,
      });
      const question = (await this.d.questions.findQuestion(challenge.questionId))!;
      const events: DomainEvent[] = [
        {
          type: 'CHALLENGE_RESOLVED',
          sessionId: session.id,
          actorId: actor.id,
          questionId: question.id,
          payload: {
            questionNumber: question.number,
            challengeId: challenge.id,
            status: updated.status,
            resolution: updated.resolution,
            note: updated.resolutionNote,
          },
          publicPayload: { questionNumber: question.number, challengeId: challenge.id, status: updated.status },
        },
        ...(await this.d.questionService.recompute(question.id, actor.id)),
      ];
      return { questionId: question.id, events };
    });
    await this.d.bus.publishAll(events);
    return this.d.questionService.detail(session, actor, questionId);
  }

  private assertActive(session: SessionRow) {
    if (session.status !== 'ACTIVE') throw conflict('The session is not active', 'SESSION_NOT_ACTIVE');
  }

  private async requireChallenge(session: SessionRow, id: string, lock = false): Promise<ChallengeRow> {
    const valid = /^[0-9a-f-]{36}$/i.test(id);
    const c = valid ? await (lock ? this.d.challenges.findForUpdate(id) : this.d.challenges.find(id)) : null;
    if (!c || c.sessionId !== session.id) throw notFound('Challenge');
    return c;
  }
}
