import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createRoom, picture, type Harness, type Room } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const post = (room: Room, who: 'host' | 'a' | 'b' | 'c', image: Buffer, answer: string) =>
  h.c.submissions.submit(room.session, room[who], { image, answer });

describe('question grouping', () => {
  it('creates a new question when nothing in the session is similar', async () => {
    const room = await createRoom(h);
    const r = await post(room, 'a', await picture(1), 'Golden Retriever');
    expect(r.outcome).toBe('NEW_QUESTION');
    if (r.outcome !== 'NEW_QUESTION') return;
    expect(r.question.number).toBe(1);
    expect(r.question.answerCount).toBe(1);
    expect(r.question.imageCount).toBe(1);
    const other = await post(room, 'b', await picture(5), 'Paris');
    expect(other.outcome).toBe('NEW_QUESTION');
    if (other.outcome === 'NEW_QUESTION') expect(other.question.number).toBe(2);
  });

  it('joins the existing question on a high-confidence match and keeps every image', async () => {
    const room = await createRoom(h);
    const first = await post(room, 'a', await picture(1), 'Golden Retriever');
    const second = await post(room, 'b', await picture(1, 'high'), 'Labrador');
    expect(second.outcome).toBe('MATCHED');
    if (second.outcome !== 'MATCHED' || first.outcome !== 'NEW_QUESTION') return;
    expect(second.question.id).toBe(first.question.id);
    expect(second.similarity).toBeGreaterThan(0.86);
    expect(second.question.imageCount).toBe(2);
    expect(second.question.answerCount).toBe(2);
    expect(second.prompt).toMatchObject({
      yourAnswer: 'Labrador',
      previousAnswer: { raw: 'Golden Retriever', by: 'User A' },
      sameAnswer: false,
      needsDecision: true,
      canChallenge: true,
    });

    const detail = await h.c.questions.detail(room.session, room.host, first.question.id);
    expect(detail.images).toHaveLength(2);
    expect(detail.images.map((i) => i.by).sort()).toEqual(['User A', 'User B']);
    expect(detail.images.filter((i) => i.isRepresentative)).toHaveLength(1);
    expect(detail.images.find((i) => i.isRepresentative)!.by).toBe('User A'); // first submitted
    const list = await h.c.questions.list(room.session, room.c, {});
    expect(list.total).toBe(1);
  });

  it('asks the participant when the match is uncertain, and honours "use existing"', async () => {
    const room = await createRoom(h);
    const first = await post(room, 'a', await picture(2), 'Apple');
    const maybe = await post(room, 'b', await picture(2, 'possible'), 'Tomato');
    expect(maybe.outcome).toBe('POSSIBLE_MATCH');
    if (maybe.outcome !== 'POSSIBLE_MATCH' || first.outcome !== 'NEW_QUESTION') return;
    expect(maybe.similarity).toBeGreaterThan(0.66);
    expect(maybe.similarity).toBeLessThan(0.86);
    expect(maybe.candidate.id).toBe(first.question.id);
    // nothing is grouped or counted until the participant decides
    expect((await h.c.questions.list(room.session, room.host, {})).items[0]).toMatchObject({ answerCount: 1, imageCount: 1 });
    // and the pending prompt survives a page refresh
    expect((await h.c.sessions.state(room.session, room.b)).pending?.outcome).toBe('POSSIBLE_MATCH');

    const used = await h.c.submissions.resolveMatch(room.session, room.b, maybe.submissionId, 'USE_EXISTING');
    expect(used.outcome).toBe('MATCHED');
    if (used.outcome !== 'MATCHED') return;
    expect(used.confirmedByUser).toBe(true);
    expect(used.question.id).toBe(first.question.id);
    expect(used.question.answerCount).toBe(2);
    await expect(h.c.submissions.resolveMatch(room.session, room.b, maybe.submissionId, 'CREATE_NEW')).rejects.toMatchObject({ status: 409 });
  });

  it('creates a separate question when the participant says it is not the same', async () => {
    const room = await createRoom(h);
    await post(room, 'a', await picture(2), 'Apple');
    const maybe = await post(room, 'b', await picture(2, 'possible'), 'Tomato');
    const created = await h.c.submissions.resolveMatch(room.session, room.b, maybe.submissionId, 'CREATE_NEW');
    expect(created.outcome).toBe('NEW_QUESTION');
    if (created.outcome === 'NEW_QUESTION') expect(created.question.number).toBe(2);
    expect((await h.c.questions.list(room.session, room.host, {})).total).toBe(2);
  });

  it('does not match a dissimilar picture of a known concept', async () => {
    const room = await createRoom(h);
    await post(room, 'a', await picture(3), 'Cat');
    expect((await post(room, 'b', await picture(3, 'far'), 'Dog')).outcome).toBe('NEW_QUESTION');
  });

  it('scopes similarity search to the current session', async () => {
    const one = await createRoom(h);
    const two = await createRoom(h);
    await post(one, 'a', await picture(4), 'Bridge');
    const elsewhere = await post(two, 'a', await picture(4), 'Bridge');
    expect(elsewhere.outcome).toBe('NEW_QUESTION');
    if (elsewhere.outcome === 'NEW_QUESTION') expect(elsewhere.question.number).toBe(1);
  });

  it('matches against any image in a group, not only the representative', async () => {
    const room = await createRoom(h);
    await post(room, 'a', await picture(6), 'X');
    const maybe = await post(room, 'b', await picture(6, 'possible'), 'X');
    await h.c.submissions.resolveMatch(room.session, room.b, maybe.submissionId, 'USE_EXISTING');
    // identical to B's picture → high match through B's image
    const third = await post(room, 'c', await picture(6, 'possible'), 'X');
    expect(third.outcome).toBe('MATCHED');
    if (third.outcome === 'MATCHED') expect(third.similarity).toBeGreaterThan(0.99);
  });

  it('does not create duplicate questions when the same content is posted simultaneously', async () => {
    const room = await createRoom(h);
    const img = await picture(7);
    const results = await Promise.all([post(room, 'a', img, 'One'), post(room, 'b', img, 'Two'), post(room, 'c', img, 'Three')]);
    expect(results.filter((r) => r.outcome === 'NEW_QUESTION')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'MATCHED')).toHaveLength(2);
    const list = await h.c.questions.list(room.session, room.host, {});
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ answerCount: 3, imageCount: 3 });
  });
});

describe('similarity service failure', () => {
  it('never guesses: parks the submission and offers retry / create new', async () => {
    const room = await createRoom(h);
    await post(room, 'a', await picture(8), 'Moon');
    h.embedder.fail = true;
    const failed = await post(room, 'b', await picture(8), 'Sun');
    expect(failed.outcome).toBe('SIMILARITY_UNAVAILABLE');
    expect((await h.c.questions.list(room.session, room.host, {})).items[0].answerCount).toBe(1);

    const again = await h.c.submissions.resolveMatch(room.session, room.b, failed.submissionId, 'RETRY');
    expect(again.outcome).toBe('SIMILARITY_UNAVAILABLE'); // still down
    h.embedder.fail = false;
    const ok = await h.c.submissions.resolveMatch(room.session, room.b, failed.submissionId, 'RETRY');
    expect(ok.outcome).toBe('MATCHED');
    if (ok.outcome === 'MATCHED') expect(ok.prompt.yourAnswer).toBe('Sun');
  });

  it('lets the participant create a new question while similarity is down', async () => {
    const room = await createRoom(h);
    h.embedder.fail = true;
    const failed = await post(room, 'a', await picture(9), 'Star');
    h.embedder.fail = false;
    const created = await h.c.submissions.resolveMatch(room.session, room.a, failed.submissionId, 'CREATE_NEW');
    expect(created.outcome).toBe('NEW_QUESTION');
    if (created.outcome === 'NEW_QUESTION') expect(created.question.myAnswer).toBe('Star');
  });
});

describe('questions tab queries', () => {
  it('filters, sorts, searches and paginates', async () => {
    const room = await createRoom(h, { previousAnswerVisibility: 'BEFORE_ANSWER' });
    await post(room, 'a', await picture(1), 'Golden Retriever');
    await post(room, 'b', await picture(1), 'Golden Retriever');
    await post(room, 'c', await picture(1), 'golden retriever!');
    await post(room, 'a', await picture(5), 'Paris');
    const lab = await post(room, 'b', await picture(5), 'London');
    await h.c.submissions.decide(room.session, room.b, lab.submissionId, 'CHALLENGE', 'Looks like London');
    await post(room, 'c', await picture(9), 'Apple');

    const numbers = async (viewer: 'a' | 'b' | 'c', opts: Record<string, unknown>) =>
      (await h.c.questions.list(room.session, room[viewer], opts)).items.map((q) => q.number);

    expect(await numbers('a', {})).toEqual([3, 2, 1]);
    expect(await numbers('a', { sort: 'MOST_ANSWERS' })).toEqual([1, 2, 3]);
    expect(await numbers('a', { sort: 'HIGHEST_CONSENSUS' })).toEqual([3, 1, 2]);
    expect(await numbers('a', { sort: 'LOWEST_CONSENSUS' })).toEqual([2, 3, 1]);
    expect(await numbers('a', { sort: 'MOST_CHALLENGED' })).toEqual([2, 3, 1]);
    expect(await numbers('a', { filter: 'CHALLENGED' })).toEqual([2]);
    expect(await numbers('a', { filter: 'UNANSWERED' })).toEqual([3]);
    expect(await numbers('c', { filter: 'ANSWERED' })).toEqual([3, 1]);
    expect(await numbers('a', { filter: 'HIGH_CONSENSUS' })).toEqual([3, 1]);
    expect(await numbers('a', { filter: 'RESOLVED' })).toEqual([]);
    expect(await numbers('a', { search: 'london' })).toEqual([2]);
    expect(await numbers('a', { search: '#3' })).toEqual([3]);
    expect(await numbers('a', { search: '100%_' })).toEqual([]); // LIKE wildcards are escaped
    expect(await numbers('a', { filter: "ALL'; DROP TABLE answers; --" })).toEqual([3, 2, 1]);
    const page = await h.c.questions.list(room.session, room.a, { limit: 2, offset: 2 });
    expect(page.items.map((q) => q.number)).toEqual([1]);
    expect(page.total).toBe(3);
  });
});
