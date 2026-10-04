import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createRoom, expectStatus, picture, type Harness, type Room } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

/** A posts "Golden Retriever"; B posts a matching image with "Labrador". */
async function matched(settings: Record<string, unknown> = {}) {
  const room = await createRoom(h, settings);
  const first = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Golden Retriever' });
  const second = await h.c.submissions.submit(room.session, room.b, { image: await picture(1, 'high'), answer: 'Labrador' });
  if (first.outcome !== 'NEW_QUESTION' || second.outcome !== 'MATCHED') throw new Error('unexpected setup');
  return { room, questionId: first.question.id, submissionId: second.submissionId };
}
const detail = (room: Room, who: 'host' | 'a' | 'b' | 'c', questionId: string) =>
  h.c.questions.detail(room.session, room[who], questionId);

describe('answers are never overwritten', () => {
  it('AGREE records the relationship but preserves the raw answer exactly', async () => {
    const { room, questionId, submissionId } = await matched();
    const r = await h.c.submissions.decide(room.session, room.b, submissionId, 'AGREE');
    expect(r.outcome).toBe('MATCHED');
    const d = await detail(room, 'host', questionId);
    const b = d.answers!.find((a) => a.by === 'User B')!;
    expect(b).toMatchObject({ raw: 'Labrador', relationship: 'AGREES', endorsedRaw: 'Golden Retriever' });
    expect(d.answers!.find((a) => a.by === 'User A')).toMatchObject({ raw: 'Golden Retriever', relationship: 'ORIGINAL' });
    // B sided with the original, so the group agrees
    expect(d.consensus).toMatchObject({ pct: 100, level: 'HIGH_AGREEMENT' });
    expect(d.challenges).toHaveLength(0);
    await expectStatus(h.c.submissions.decide(room.session, room.b, submissionId, 'KEEP'), 409, 'ALREADY_DECIDED');
  });

  it('KEEP stores the differing answer without opening a challenge', async () => {
    const { room, questionId, submissionId } = await matched();
    await h.c.submissions.decide(room.session, room.b, submissionId, 'KEEP');
    const d = await detail(room, 'host', questionId);
    expect(d.answers!.find((a) => a.by === 'User B')).toMatchObject({ raw: 'Labrador', relationship: 'INDEPENDENT' });
    expect(d.status).toBe('OPEN');
    expect(d.consensus!.pct).toBe(50);
    expect(d.tally).toEqual([
      { label: 'Golden Retriever', count: 1, pct: 50 },
      { label: 'Labrador', count: 1, pct: 50 },
    ]);
  });

  it('auto-agrees when the new answer is equivalent, storing it as typed', async () => {
    const room = await createRoom(h);
    await h.c.submissions.submit(room.session, room.a, { image: await picture(2), answer: 'Paris' });
    const r = await h.c.submissions.submit(room.session, room.b, { image: await picture(2), answer: '  PARIS! ' });
    expect(r.outcome).toBe('MATCHED');
    if (r.outcome !== 'MATCHED') return;
    expect(r.prompt).toMatchObject({ yourAnswer: '  PARIS! ', sameAnswer: true, needsDecision: false, canChallenge: false });
    expect(r.question.consensus!.pct).toBe(100);
    await expectStatus(h.c.challenges.create(room.session, room.b, r.question.id, {}), 409, 'SAME_ANSWER');
  });

  it('keeps one answer per participant; a second image still joins the group', async () => {
    const { room, questionId } = await matched();
    const again = await h.c.submissions.submit(room.session, room.b, { image: await picture(1), answer: 'Poodle' });
    expect(again.outcome).toBe('ALREADY_ANSWERED');
    if (again.outcome === 'ALREADY_ANSWERED') expect(again.yourAnswer).toBe('Labrador');
    const d = await detail(room, 'host', questionId);
    expect(d.answerCount).toBe(2);
    expect(d.imageCount).toBe(3);
    expect(d.answers!.map((a) => a.raw).sort()).toEqual(['Golden Retriever', 'Labrador']);
    await expectStatus(h.c.questions.answerDirect(room.session, room.b, questionId, 'Poodle'), 409, 'ALREADY_ANSWERED');
  });
});

describe('challenge lifecycle', () => {
  it('creates an open challenge and notifies every other participant in real time', async () => {
    const { room, questionId, submissionId } = await matched({ previousAnswerVisibility: 'AFTER_ANSWER' });
    h.gateway.participantEvents.length = 0;
    h.gateway.sessionEvents.length = 0;
    await h.c.submissions.decide(room.session, room.b, submissionId, 'CHALLENGE', 'This looks more like a Labrador.');

    const d = await detail(room, 'c', questionId); // C has not answered: AFTER_ANSWER hides the answers from them
    expect(d.status).toBe('CHALLENGED');
    expect(d.openChallengeCount).toBe(1);

    const hostView = await detail(room, 'host', questionId);
    expect(hostView.challenges).toHaveLength(1);
    expect(hostView.challenges[0]).toMatchObject({
      status: 'OPEN',
      reason: 'This looks more like a Labrador.',
      original: { raw: 'Golden Retriever', by: 'User A' },
      challenge: { raw: 'Labrador', by: 'User B' },
      tally: { original: 1, challenge: 1, other: 0 },
    });
    // original and challenged answers stay separate
    expect(hostView.answers!.find((a) => a.by === 'User A')!.raw).toBe('Golden Retriever');
    expect(hostView.answers!.find((a) => a.by === 'User B')).toMatchObject({ raw: 'Labrador', relationship: 'CHALLENGES' });

    for (const who of ['host', 'a', 'c'] as const) {
      const n = h.gateway.notificationsFor(room[who].id).filter((x) => x.type === 'CHALLENGE');
      expect(n, `notification for ${who}`).toHaveLength(1);
      expect(n[0].title).toBe('New challenge on Question #1');
      expect(n[0].questionId).toBe(questionId);
    }
    expect(h.gateway.notificationsFor(room.b.id).filter((x) => x.type === 'CHALLENGE')).toHaveLength(0);
    // A answered → sees the answers; C has not → details withheld
    expect(h.gateway.notificationsFor(room.a.id).find((x) => x.type === 'CHALLENGE').data).toMatchObject({
      originalAnswer: 'Golden Retriever',
      challengerAnswer: 'Labrador',
    });
    expect(h.gateway.notificationsFor(room.c.id).find((x) => x.type === 'CHALLENGE').data).toEqual({
      questionNumber: 1,
      challengeId: hostView.challenges[0].id,
      hidden: true,
    });
    const types = h.gateway.sessionEvents.map((e) => e.data.type);
    expect(types).toContain('ANSWER_CHALLENGED');
    expect(types).toContain('CHALLENGE_CREATED');
    // broadcast frames never carry answer text
    expect(JSON.stringify(h.gateway.sessionEvents)).not.toContain('Labrador');
    // notifications are persisted too
    expect((await h.c.notifications.list(room.a)).unread).toBeGreaterThanOrEqual(1);
  });

  it('collects responses, moves to DISCUSSION and updates consensus', async () => {
    const { room, questionId, submissionId } = await matched();
    await h.c.submissions.decide(room.session, room.b, submissionId, 'CHALLENGE');
    const challengeId = (await detail(room, 'host', questionId)).challenges[0].id;

    const afterC = await h.c.challenges.respond(room.session, room.c, challengeId, { stance: 'CHALLENGE' });
    expect(afterC.challenges[0].status).toBe('DISCUSSION');
    expect(afterC.challenges[0].tally).toEqual({ original: 1, challenge: 2, other: 0 });
    expect(afterC.challenges[0].myStance).toBe('CHALLENGE');
    expect(afterC.answerCount).toBe(3);
    expect(afterC.consensus!.pct).toBe(67); // Labrador 2 / 3
    expect(afterC.tally![0]).toMatchObject({ label: 'Labrador', count: 2 });

    const afterHost = await h.c.challenges.respond(room.session, room.host, challengeId, { stance: 'OTHER', answer: 'Poodle', comment: 'Neither' });
    expect(afterHost.challenges[0].tally).toEqual({ original: 1, challenge: 2, other: 1 });
    expect(afterHost.answerCount).toBe(4);
    expect(afterHost.consensus!.pct).toBe(50);
    expect(afterHost.answers!.find((a) => a.mine)).toMatchObject({ raw: 'Poodle', source: 'CHALLENGE_RESPONSE' });
  });

  it('prevents voting twice and voting by the two parties', async () => {
    const { room, questionId, submissionId } = await matched();
    await h.c.submissions.decide(room.session, room.b, submissionId, 'CHALLENGE');
    const challengeId = (await detail(room, 'host', questionId)).challenges[0].id;
    await h.c.challenges.respond(room.session, room.c, challengeId, { stance: 'ORIGINAL' });
    await expectStatus(h.c.challenges.respond(room.session, room.c, challengeId, { stance: 'CHALLENGE' }), 409, 'ALREADY_RESPONDED');
    await expectStatus(h.c.challenges.respond(room.session, room.a, challengeId, { stance: 'ORIGINAL' }), 409, 'CHALLENGE_PARTY');
    await expectStatus(h.c.challenges.respond(room.session, room.b, challengeId, { stance: 'CHALLENGE' }), 409, 'CHALLENGE_PARTY');
    // simultaneous double-click
    const settled = await Promise.allSettled([
      h.c.challenges.respond(room.session, room.host, challengeId, { stance: 'ORIGINAL' }),
      h.c.challenges.respond(room.session, room.host, challengeId, { stance: 'ORIGINAL' }),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const d = await detail(room, 'host', questionId);
    expect(d.challenges[0].tally).toEqual({ original: 3, challenge: 1, other: 0 });
    expect(d.challenges[0].responses).toHaveLength(2);
    // a participant cannot challenge the same question twice, nor their own answer
    await expectStatus(h.c.challenges.create(room.session, room.b, questionId, {}), 409, 'ALREADY_CHALLENGED');
    await expectStatus(h.c.challenges.create(room.session, room.a, questionId, {}), 409, 'OWN_ANSWER');
  });

  it('lets only the host resolve, records the outcome and closes the challenge', async () => {
    const { room, questionId, submissionId } = await matched();
    await h.c.submissions.decide(room.session, room.b, submissionId, 'CHALLENGE');
    const challengeId = (await detail(room, 'host', questionId)).challenges[0].id;
    await expectStatus(h.c.challenges.resolve(room.session, room.b, challengeId, { outcome: 'CHALLENGE_ACCEPTED' }), 403);
    await expectStatus(h.c.challenges.resolve(room.session, room.host, challengeId, { outcome: 'WHATEVER' }), 400);
    h.gateway.participantEvents.length = 0;

    const d = await h.c.challenges.resolve(room.session, room.host, challengeId, { outcome: 'BOTH_VALID', note: 'Both breeds fit' });
    expect(d.status).toBe('RESOLVED');
    expect(d.openChallengeCount).toBe(0);
    expect(d.challenges[0]).toMatchObject({ status: 'RESOLVED', resolution: 'BOTH_VALID', resolutionNote: 'Both breeds fit' });
    // resolution never rewrites answers
    expect(d.answers!.map((a) => a.raw).sort()).toEqual(['Golden Retriever', 'Labrador']);
    expect(h.gateway.notificationsFor(room.a.id).some((n) => n.title === 'Question #1 was resolved')).toBe(true);

    await expectStatus(h.c.challenges.resolve(room.session, room.host, challengeId, { outcome: 'DISMISSED' }), 409, 'INVALID_CHALLENGE_TRANSITION');
    await expectStatus(h.c.challenges.respond(room.session, room.c, challengeId, { stance: 'ORIGINAL' }), 409, 'CHALLENGE_CLOSED');
    expect((await h.c.questions.list(room.session, room.a, { filter: 'RESOLVED' })).total).toBe(1);
  });

  it('supports dismissing, and challenging from the question page with a new answer', async () => {
    const { room, questionId, submissionId } = await matched({ previousAnswerVisibility: 'BEFORE_ANSWER' });
    await h.c.submissions.decide(room.session, room.b, submissionId, 'KEEP');
    await h.c.challenges.create(room.session, room.c, questionId, { answer: 'Poodle', reason: 'Curly coat' });
    let d = await detail(room, 'host', questionId);
    expect(d.challenges[0]).toMatchObject({ status: 'OPEN', challenge: { raw: 'Poodle', by: 'User C' } });
    expect(d.answerCount).toBe(3);
    d = await h.c.challenges.resolve(room.session, room.host, d.challenges[0].id, { outcome: 'DISMISSED' });
    expect(d.challenges[0]).toMatchObject({ status: 'DISMISSED', resolution: null });
    expect(d.status).toBe('RESOLVED');
    // B kept their answer earlier and may still challenge later
    await h.c.challenges.create(room.session, room.b, questionId, {});
    expect((await detail(room, 'host', questionId)).status).toBe('CHALLENGED');
  });

  it('keeps the full history for the host', async () => {
    const { room, questionId, submissionId } = await matched();
    await h.c.submissions.decide(room.session, room.b, submissionId, 'CHALLENGE', 'Because');
    const challengeId = (await detail(room, 'host', questionId)).challenges[0].id;
    await h.c.questions.answerDirect(room.session, room.c, questionId, 'Golden retriever');
    await h.c.challenges.resolve(room.session, room.host, challengeId, { outcome: 'ORIGINAL_ACCEPTED' });
    const d = await detail(room, 'host', questionId);
    expect(d.history!.map((e) => e.type)).toEqual([
      'QUESTION_CREATED', 'ANSWER_SUBMITTED', 'CONSENSUS_UPDATED',
      'QUESTION_MATCHED', 'ANSWER_SUBMITTED', 'CONSENSUS_UPDATED',
      'ANSWER_CHALLENGED', 'CHALLENGE_CREATED',
      'ANSWER_SUBMITTED', 'CONSENSUS_UPDATED',
      'CHALLENGE_RESOLVED',
    ]);
    expect(d.history!.find((e) => e.type === 'ANSWER_CHALLENGED')!.summary).toBe('User B challenged “Golden Retriever” with “Labrador”');
    expect((await detail(room, 'a', questionId)).history).toBeNull();
    const dash = await h.c.sessions.dashboard(room.session, room.host);
    expect(dash.stats).toMatchObject({ participants: 4, questions: 1, answers: 3, challenges: 1, resolvedChallenges: 1, openChallenges: 0 });
  });

  it('notifies when a question crosses into high consensus', async () => {
    const room = await createRoom(h);
    await h.c.submissions.submit(room.session, room.a, { image: await picture(3), answer: 'Cat' });
    await h.c.submissions.submit(room.session, room.b, { image: await picture(3), answer: 'cat' });
    h.gateway.participantEvents.length = 0;
    await h.c.submissions.submit(room.session, room.c, { image: await picture(3), answer: 'Cat.' });
    const titles = h.gateway.notificationsFor(room.a.id).map((n) => n.title);
    expect(titles).toContain('Question #1 reached 100% consensus');
    expect(titles).toContain('Question #1 received a new answer');
  });
});
