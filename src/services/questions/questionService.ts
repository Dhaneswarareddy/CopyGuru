import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import { signImage } from '@/lib/auth/tokens';
import type { Db } from '@/lib/database/client';
import type { ActivityRepo } from '@/lib/database/repositories/activity';
import type { ChallengesRepo } from '@/lib/database/repositories/challenges';
import {
  QUESTION_FILTERS,
  QUESTION_SORTS,
  type QuestionFilter,
  type QuestionListRow,
  type QuestionSort,
  type QuestionsRepo,
} from '@/lib/database/repositories/questions';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type {
  AnswerRelationship,
  AnswerRow,
  AnswerSource,
  ChallengeResponseRow,
  ChallengeRow,
  ParticipantRow,
  QuestionRow,
  QuestionStatus,
  SessionEventRow,
  SessionRow,
} from '@/lib/domain/types';
import type {
  AnswerView,
  ChallengeView,
  HistoryEventView,
  QuestionDetailView,
  QuestionListView,
  QuestionSummaryView,
} from '@/lib/domain/views';
import type { EventBus } from '@/lib/events/bus';
import type { DomainEvent } from '@/lib/events/types';
import { badRequest, conflict, notFound } from '@/lib/http/errors';
import { Permission, authorize, can, denialReason } from '@/lib/permissions/permissions';
import type { AnswerMatchingService } from '@/services/answerMatching';
import { isActive } from '@/services/challenges/stateMachine';
import { computeConsensus } from '@/services/consensus/consensus';
import { firstSubmittedStrategy, type RepresentativeImageStrategy } from './representative';
import { nameResolver, visibilityFor } from './visibility';

export interface QuestionDeps {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionsRepo;
  questions: QuestionsRepo;
  challenges: ChallengesRepo;
  activity: ActivityRepo;
  matcher: AnswerMatchingService;
  representative?: RepresentativeImageStrategy;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export class QuestionService {
  private representative: RepresentativeImageStrategy;
  constructor(private d: QuestionDeps) {
    this.representative = d.representative ?? firstSubmittedStrategy;
  }

  // ------------------------------------------------------------------ writes

  validateAnswerText(input: unknown): string {
    if (typeof input !== 'string') throw badRequest('An answer is required', 'ANSWER_REQUIRED');
    const raw = input.replace(/\u0000/g, '');
    if (!raw.trim()) throw badRequest('An answer is required', 'ANSWER_REQUIRED');
    if (raw.length > this.d.config.limits.maxAnswerLength)
      throw badRequest(`Answer is too long (max ${this.d.config.limits.maxAnswerLength} characters)`, 'ANSWER_TOO_LONG');
    return raw; // stored exactly as typed
  }

  /** Creates a new question group around an already-stored image. Call inside a transaction. */
  async createQuestion(session: SessionRow, participant: ParticipantRow, imageId: string): Promise<QuestionRow> {
    const number = await this.d.sessions.nextQuestionNumber(session.id);
    const question = await this.d.questions.insertQuestion({
      id: crypto.randomUUID(),
      sessionId: session.id,
      number,
      createdBy: participant.id,
    });
    await this.attachImage(question, imageId);
    return (await this.d.questions.findQuestion(question.id))!;
  }

  async attachImage(question: QuestionRow, imageId: string) {
    await this.d.questions.attachImage(imageId, question.id);
    const representativeImageId = this.representative.select(question, { id: imageId });
    if (representativeImageId) await this.d.questions.setQuestionPointers(question.id, { representativeImageId });
  }

  /**
   * Inserts an answer. One answer per participant per question; existing
   * answers are never modified here.
   */
  async recordAnswer(a: {
    session: SessionRow;
    question: QuestionRow;
    participant: ParticipantRow;
    rawAnswer: string;
    submissionId: string | null;
    source: AnswerSource;
    relationship: AnswerRelationship;
    endorsed?: AnswerRow | null;
  }): Promise<AnswerRow> {
    const normalized = this.d.matcher.normalize(a.rawAnswer);
    const endorsed = a.relationship === 'AGREES' ? (a.endorsed ?? null) : null;
    const answer = await this.d.questions.insertAnswer({
      id: crypto.randomUUID(),
      sessionId: a.session.id,
      questionId: a.question.id,
      participantId: a.participant.id,
      submissionId: a.submissionId,
      rawAnswer: a.rawAnswer,
      normalizedAnswer: normalized,
      effectiveNormalized: endorsed ? endorsed.effectiveNormalized : normalized,
      value: { type: 'TEXT', value: a.rawAnswer },
      relationship: a.relationship,
      endorsedAnswerId: endorsed?.id ?? null,
      source: a.source,
    });
    if (!a.question.originalAnswerId)
      await this.d.questions.setQuestionPointers(a.question.id, { originalAnswerId: answer.id });
    return answer;
  }

  /** Refreshes the denormalised read model of a question; returns events to publish. */
  async recompute(questionId: string, actorId: string | null): Promise<DomainEvent[]> {
    const before = await this.d.questions.findQuestion(questionId);
    if (!before) return [];
    const answers = await this.d.questions.listAnswers(questionId);
    const consensus = computeConsensus(answers, this.d.matcher, this.d.config.consensus);
    const counts = await this.d.questions.questionCounts(questionId);
    const status: QuestionStatus = counts.openChallenges > 0 ? 'CHALLENGED' : counts.challenges > 0 ? 'RESOLVED' : 'OPEN';
    await this.d.questions.updateQuestionStats(questionId, {
      answerCount: answers.length,
      imageCount: counts.images,
      consensus,
      challengeCount: counts.challenges,
      openChallengeCount: counts.openChallenges,
      status,
    });
    // (stored jsonb does not preserve key order, so compare a canonical form)
    const shape = (c: typeof consensus | null) => (c?.groups ?? []).map((g) => `${g.key}=${g.count}`).join('|');
    const changed =
      before.answerCount !== answers.length ||
      before.consensusPct !== consensus.pct ||
      shape(before.consensus) !== shape(consensus);
    if (!changed) return [];
    return [
      {
        type: 'CONSENSUS_UPDATED',
        sessionId: before.sessionId,
        actorId,
        questionId,
        payload: {
          questionNumber: before.number,
          before: { pct: before.consensusPct, level: before.consensusLevel, total: before.answerCount },
          after: { pct: consensus.pct, level: consensus.level, total: consensus.total, groups: consensus.groups },
        },
        publicPayload: { questionNumber: before.number },
      },
    ];
  }

  /** "Submit my answer" on an existing question, without uploading an image. */
  async answerDirect(session: SessionRow, viewer: ParticipantRow, questionId: string, input: unknown) {
    authorize(viewer, session, Permission.POST_ANSWER);
    if (session.status !== 'ACTIVE') throw conflict('The session is not active', 'SESSION_NOT_ACTIVE');
    const raw = this.validateAnswerText(input);
    const events = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const question = await this.requireQuestion(session, questionId);
      if (await this.d.questions.findAnswerFor(question.id, viewer.id))
        throw conflict('You have already answered this question', 'ALREADY_ANSWERED');
      const original = question.originalAnswerId ? await this.d.questions.findAnswer(question.originalAnswerId) : null;
      const same = !!original && this.d.matcher.compare(raw, original.rawAnswer).equivalent;
      const answer = await this.recordAnswer({
        session,
        question,
        participant: viewer,
        rawAnswer: raw,
        submissionId: null,
        source: 'DIRECT',
        relationship: !original ? 'ORIGINAL' : same ? 'AGREES' : 'INDEPENDENT',
        endorsed: same ? original : null,
      });
      return [this.answerSubmittedEvent(question, answer), ...(await this.recompute(question.id, viewer.id))];
    });
    await this.d.bus.publishAll(events);
    return this.detail(session, viewer, questionId);
  }

  exportRows(sessionId: string) {
    return this.d.questions.exportRows(sessionId);
  }

  answerSubmittedEvent(question: QuestionRow, answer: AnswerRow): DomainEvent {
    return {
      type: 'ANSWER_SUBMITTED',
      sessionId: question.sessionId,
      actorId: answer.participantId,
      questionId: question.id,
      payload: {
        questionNumber: question.number,
        answerId: answer.id,
        rawAnswer: answer.rawAnswer,
        normalizedAnswer: answer.normalizedAnswer,
        relationship: answer.relationship,
        source: answer.source,
        isFirstAnswer: !question.originalAnswerId,
      },
      publicPayload: { questionNumber: question.number },
    };
  }

  // ------------------------------------------------------------------- reads

  async requireQuestion(session: SessionRow, questionId: string): Promise<QuestionRow> {
    const q = /^[0-9a-f-]{36}$/i.test(questionId) ? await this.d.questions.findQuestion(questionId) : null;
    // a question from another session is indistinguishable from a missing one
    if (!q || q.sessionId !== session.id) throw notFound('Question');
    return q;
  }

  imageUrl(imageId: string, variant: 'thumb' | 'display') {
    return `/api/images/${imageId}?v=${variant}&sig=${signImage(this.d.config.appSecret, imageId)}`;
  }

  toSummary(session: SessionRow, viewer: ParticipantRow, q: QuestionListRow | (QuestionRow & { answeredByMe: boolean; myAnswer: string | null })): QuestionSummaryView {
    const vis = visibilityFor(session, viewer, q.answeredByMe);
    return {
      id: q.id,
      number: q.number,
      thumbUrl: q.representativeImageId ? this.imageUrl(q.representativeImageId, 'thumb') : null,
      answerCount: q.answerCount,
      imageCount: q.imageCount,
      status: q.status,
      challengeCount: q.challengeCount,
      openChallengeCount: q.openChallengeCount,
      consensus: vis.consensus ? { pct: q.consensusPct, level: q.consensusLevel } : null,
      tally:
        vis.answers && vis.consensus && q.consensus
          ? q.consensus.groups.map((g) => ({ label: g.label, count: g.count, pct: g.pct }))
          : null,
      answeredByMe: q.answeredByMe,
      myAnswer: q.myAnswer,
      createdAt: iso(q.createdAt),
      lastActivityAt: iso(q.lastActivityAt),
    };
  }

  async summary(session: SessionRow, viewer: ParticipantRow, questionId: string): Promise<QuestionSummaryView> {
    const q = await this.requireQuestion(session, questionId);
    const mine = await this.d.questions.findAnswerFor(q.id, viewer.id);
    return this.toSummary(session, viewer, { ...q, answeredByMe: !!mine, myAnswer: mine?.rawAnswer ?? null });
  }

  async list(
    session: SessionRow,
    viewer: ParticipantRow,
    opts: { filter?: string; sort?: string; search?: string; limit?: number; offset?: number },
  ): Promise<QuestionListView> {
    authorize(viewer, session, Permission.VIEW_RESULTS);
    const seesConsensus = visibilityFor(session, viewer, false).consensus;
    let filter = (opts.filter && opts.filter in QUESTION_FILTERS ? opts.filter : 'ALL') as QuestionFilter;
    let sort = (opts.sort && opts.sort in QUESTION_SORTS ? opts.sort : 'NEWEST') as QuestionSort;
    // consensus-based filters/sorts would leak consensus to viewers who may not see it
    if (!seesConsensus && 'needsConsensus' in QUESTION_FILTERS[filter]) filter = 'ALL';
    if (!seesConsensus && 'needsConsensus' in QUESTION_SORTS[sort]) sort = 'NEWEST';
    const limit = Math.min(Math.max(Number(opts.limit) || this.d.config.limits.pageSize, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const search = opts.search?.trim().slice(0, 100) || null;
    const { rows, total } = await this.d.questions.listQuestions({
      sessionId: session.id,
      viewerId: viewer.id,
      filter,
      sort,
      search,
      // searching other people's answers is only allowed when they are visible up-front
      searchAllAnswers: visibilityFor(session, viewer, false).answers,
      thresholds: this.d.config.consensus,
      limit,
      offset,
    });
    const offered = (registry: Record<string, { label: string; needsConsensus?: boolean }>) =>
      Object.entries(registry)
        .filter(([, v]) => seesConsensus || !v.needsConsensus)
        .map(([key, v]) => ({ key, label: v.label }));
    return {
      items: rows.map((r) => this.toSummary(session, viewer, r)),
      total,
      offset,
      limit,
      filter,
      sort,
      filters: offered(QUESTION_FILTERS),
      sorts: offered(QUESTION_SORTS),
    };
  }

  async detail(session: SessionRow, viewer: ParticipantRow, questionId: string): Promise<QuestionDetailView> {
    authorize(viewer, session, Permission.VIEW_RESULTS);
    const q = await this.requireQuestion(session, questionId);
    const [answers, images, challenges, participantRows] = await Promise.all([
      this.d.questions.listAnswers(q.id),
      this.d.questions.listImages(q.id, 60),
      this.d.challenges.listForQuestion(q.id),
      this.d.sessions.listParticipants(session.id),
    ]);
    const mine = answers.find((a) => a.participantId === viewer.id) ?? null;
    const vis = visibilityFor(session, viewer, !!mine);
    const participants = new Map(participantRows.map((p) => [p.id, p]));
    const nameOf = nameResolver(viewer, participants, vis.identities);
    const answerById = new Map(answers.map((a) => [a.id, a]));
    const original = q.originalAnswerId ? (answerById.get(q.originalAnswerId) ?? null) : null;

    const answerViews: AnswerView[] = answers.map((a) => ({
      id: a.id,
      raw: a.rawAnswer,
      by: nameOf(a.participantId),
      mine: a.participantId === viewer.id,
      relationship: a.relationship,
      endorsedRaw: a.endorsedAnswerId ? (answerById.get(a.endorsedAnswerId)?.rawAnswer ?? null) : null,
      source: a.source,
      createdAt: iso(a.createdAt),
    }));

    const responses = await this.d.challenges.listResponses(challenges.map((c) => c.id));
    const challengeViews = vis.answers
      ? challenges.map((c) => this.toChallengeView(session, viewer, c, responses, answerById, nameOf))
      : [];

    const canStaff = can(viewer, session, Permission.VIEW_DASHBOARD);
    const history = canStaff
      ? (await this.d.activity.listQuestionEvents(q.id, 300)).map((e) => this.toHistory(e, participants))
      : null;

    const alreadyChallenged = challenges.some((c) => c.challengerId === viewer.id);
    const challengeDeniedReason =
      denialReason(viewer, session, Permission.CHALLENGE_ANSWER) ??
      (session.status !== 'ACTIVE' ? 'The session is not active' : null) ??
      (!vis.answers ? 'Answer this question to see and challenge the previous answer' : null) ??
      (!original ? 'There is no answer to challenge yet' : null) ??
      (original!.participantId === viewer.id ? 'You gave the original answer' : null) ??
      (alreadyChallenged ? 'You have already challenged this question' : null) ??
      (mine && mine.effectiveNormalized === original!.effectiveNormalized && mine.relationship !== 'UNDECIDED'
        ? 'Your answer matches the original answer'
        : null);

    return {
      ...this.toSummary(session, viewer, { ...q, answeredByMe: !!mine, myAnswer: mine?.rawAnswer ?? null }),
      displayUrl: q.representativeImageId ? this.imageUrl(q.representativeImageId, 'display') : null,
      images: images.map((i) => ({
        id: i.id,
        thumbUrl: this.imageUrl(i.id, 'thumb'),
        displayUrl: this.imageUrl(i.id, 'display'),
        by: nameOf(i.participantId),
        mine: i.participantId === viewer.id,
        isRepresentative: i.id === q.representativeImageId,
        similarity: i.similarityScore === null ? null : Number(i.similarityScore),
        matchDecision: i.matchDecision,
      })),
      originalAnswer:
        vis.answers && original ? { id: original.id, raw: original.rawAnswer, by: nameOf(original.participantId) } : null,
      answers: vis.answers ? answerViews : answerViews.filter((a) => a.mine),
      challenges: challengeViews,
      history,
      caps: {
        canSeeAnswers: vis.answers,
        canAnswer: !mine && session.status === 'ACTIVE' && can(viewer, session, Permission.POST_ANSWER),
        canChallenge: challengeDeniedReason === null,
        challengeDeniedReason,
      },
    };
  }

  toChallengeView(
    session: SessionRow,
    viewer: ParticipantRow,
    c: ChallengeRow,
    allResponses: ChallengeResponseRow[],
    answerById: Map<string, AnswerRow>,
    nameOf: (id: string | null) => string,
  ): ChallengeView {
    const responses = allResponses.filter((r) => r.challengeId === c.id);
    const original = answerById.get(c.originalAnswerId);
    const challenger = answerById.get(c.challengerAnswerId);
    const count = (s: string) => responses.filter((r) => r.stance === s).length;
    const mine = responses.find((r) => r.participantId === viewer.id) ?? null;
    const isParty = viewer.id === c.challengerId || viewer.id === original?.participantId;
    const active = isActive(c.status);
    return {
      id: c.id,
      questionId: c.questionId,
      status: c.status,
      resolution: c.resolution,
      resolutionNote: c.resolutionNote,
      reason: c.reason,
      createdAt: iso(c.createdAt),
      resolvedAt: c.resolvedAt ? iso(c.resolvedAt) : null,
      original: { answerId: c.originalAnswerId, raw: original?.rawAnswer ?? '', by: nameOf(original?.participantId ?? null) },
      challenge: { answerId: c.challengerAnswerId, raw: challenger?.rawAnswer ?? '', by: nameOf(c.challengerId) },
      // the two parties implicitly support their own side
      tally: { original: 1 + count('ORIGINAL'), challenge: 1 + count('CHALLENGE'), other: count('OTHER') },
      responses: responses.map((r) => ({
        by: nameOf(r.participantId),
        mine: r.participantId === viewer.id,
        stance: r.stance,
        answerRaw: r.answerId ? (answerById.get(r.answerId)?.rawAnswer ?? null) : null,
        comment: r.comment,
        createdAt: iso(r.createdAt),
      })),
      myStance: mine?.stance ?? null,
      isParty,
      canRespond:
        active && !mine && !isParty && session.status === 'ACTIVE' && can(viewer, session, Permission.RESPOND_TO_CHALLENGE),
      canResolve: active && can(viewer, session, Permission.RESOLVE_CHALLENGE),
    };
  }

  toHistory(e: SessionEventRow, participants: Map<string, ParticipantRow>): HistoryEventView {
    const actor = e.actorId ? (participants.get(e.actorId)?.displayName ?? null) : null;
    const p = e.payload as Record<string, any>;
    const n = p.questionNumber ? `Question #${p.questionNumber}` : 'the question';
    const who = actor ?? 'Someone';
    const summaries: Record<string, () => string> = {
      SESSION_CREATED: () => `${who} created the session`,
      PARTICIPANT_JOINED: () => `${who} joined`,
      SESSION_STARTED: () => `${who} started the session`,
      SESSION_ENDED: () => `${who} ended the session`,
      PARTICIPANT_REMOVED: () => `${who} removed ${p.displayName} from the session`,
      SESSION_SETTINGS_UPDATED: () => `${who} changed the session settings`,
      JOIN_REQUESTED: () => `${p.displayName} asked to join from the home page`,
      JOIN_REQUEST_APPROVED: () => `${who} let ${p.displayName} in`,
      JOIN_REQUEST_DECLINED: () => `${who} declined ${p.displayName}’s request to join`,
      JOIN_REQUEST_CANCELLED: () => `${p.displayName} stopped waiting to join`,
      IMAGE_SUBMITTED: () => `${who} submitted an image`,
      QUESTION_CREATED: () => `${who} created ${n}`,
      QUESTION_MATCHED: () =>
        `${who}'s image matched ${n}` +
        (typeof p.similarity === 'number' ? ` (similarity ${p.similarity.toFixed(2)}${p.confirmedByUser ? ', confirmed by participant' : ''})` : ''),
      ANSWER_SUBMITTED: () => `${who} answered “${p.rawAnswer}”`,
      ANSWER_RELATIONSHIP_SET: () =>
        p.relationship === 'AGREES'
          ? `${who} agreed with “${p.endorsedRaw}” (their own answer “${p.rawAnswer}” is kept)`
          : `${who} kept their answer “${p.rawAnswer}” without challenging`,
      ANSWER_CHALLENGED: () => `${who} challenged “${p.originalAnswer}” with “${p.challengerAnswer}”`,
      CHALLENGE_CREATED: () => `Challenge opened${p.reason ? `: “${p.reason}”` : ''}`,
      CHALLENGE_RESPONSE_ADDED: () =>
        `${who} ${p.stance === 'ORIGINAL' ? 'supported the original answer' : p.stance === 'CHALLENGE' ? 'supported the challenge' : `responded with a different answer${p.rawAnswer ? ` “${p.rawAnswer}”` : ''}`}`,
      CONSENSUS_UPDATED: () => `Consensus is now ${p.after?.pct ?? '–'}% across ${p.after?.total ?? 0} answer(s)`,
      CHALLENGE_RESOLVED: () =>
        `${who} ${p.status === 'DISMISSED' ? 'dismissed the challenge' : `resolved the challenge: ${String(p.resolution ?? '').replace(/_/g, ' ').toLowerCase()}`}`,
    };
    return {
      id: String(e.id),
      type: e.type,
      actor,
      summary: summaries[e.type]?.() ?? e.type,
      createdAt: iso(e.createdAt),
    };
  }
}
