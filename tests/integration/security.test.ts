import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createRoom, expectStatus, picture, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ env: { IMAGE_MAX_BYTES: String(400 * 1024) } });
});
afterAll(() => h.close());

describe('session access', () => {
  it('rejects invalid session codes and unknown tokens', async () => {
    await expectStatus(h.c.sessions.join('NOPE99', { displayName: 'X' }), 404);
    await expectStatus(h.c.sessions.join("'; DROP TABLE sessions;--", { displayName: 'X' }), 404);
    await expectStatus(h.c.sessions.resolveSession(''), 404);
    await expectStatus(h.c.sessions.authenticate(null), 401);
    await expectStatus(h.c.sessions.authenticate('short'), 401);
    await expectStatus(h.c.sessions.authenticate('x'.repeat(43)), 401);
  });

  it('authenticates a token only for its own session and never stores it in clear text', async () => {
    const room = await createRoom(h);
    const auth = await h.c.sessions.authenticate(room.tokens.a);
    expect(auth.participant.id).toBe(room.a.id);
    expect(auth.session.id).toBe(room.session.id);
    const stored = await h.c.db.query<{ tokenHash: string }>('SELECT token_hash FROM session_participants');
    expect(stored.some((r) => Object.values(room.tokens).includes(r.tokenHash))).toBe(false);
    expect(JSON.stringify(await h.c.sessions.state(room.session, room.a))).not.toContain('tokenHash');
  });

  it("cannot read or act on another session's questions, submissions or challenges", async () => {
    const mine = await createRoom(h);
    const theirs = await createRoom(h);
    const q = await h.c.submissions.submit(theirs.session, theirs.a, { image: await picture(1), answer: 'Secret' });
    const other = await h.c.submissions.submit(theirs.session, theirs.b, { image: await picture(1), answer: 'Other' });
    await h.c.submissions.decide(theirs.session, theirs.b, other.submissionId, 'CHALLENGE');
    if (q.outcome !== 'NEW_QUESTION') throw new Error('setup');
    const challengeId = (await h.c.questions.detail(theirs.session, theirs.host, q.question.id)).challenges[0].id;

    await expectStatus(h.c.questions.detail(mine.session, mine.a, q.question.id), 404);
    await expectStatus(h.c.questions.answerDirect(mine.session, mine.a, q.question.id, 'x'), 404);
    await expectStatus(h.c.challenges.create(mine.session, mine.a, q.question.id, { answer: 'x' }), 404);
    await expectStatus(h.c.challenges.respond(mine.session, mine.a, challengeId, { stance: 'ORIGINAL' }), 404);
    await expectStatus(h.c.challenges.resolve(mine.session, mine.host, challengeId, { outcome: 'DISMISSED' }), 404);
    await expectStatus(h.c.submissions.decide(mine.session, mine.a, other.submissionId, 'AGREE'), 404);
    // even within a session, a submission belongs to its author
    await expectStatus(h.c.submissions.decide(theirs.session, theirs.c, other.submissionId, 'AGREE'), 404);
    expect((await h.c.questions.list(mine.session, mine.a, {})).total).toBe(0);
  });

  it('enforces unique names, non-empty names and closed sessions', async () => {
    const room = await createRoom(h);
    await expectStatus(h.c.sessions.join(room.session.code, { displayName: 'user a' }), 409, 'NAME_TAKEN');
    await expectStatus(h.c.sessions.join(room.session.code, { displayName: '   ' }), 400);
    await expectStatus(h.c.sessions.join(room.session.code, { displayName: 'x'.repeat(200) }), 400);
    expect((await h.c.sessions.join(room.session.code.toLowerCase(), { displayName: 'Late joiner' })).participant.role).toBe('PARTICIPANT');
    await h.c.sessions.end(room.session, room.host);
    await expectStatus(h.c.sessions.join(room.session.code, { displayName: 'Too late' }), 409, 'SESSION_ENDED');
  });
});

describe('permissions', () => {
  it('only lets the host start, end and view the dashboard', async () => {
    const room = await createRoom(h, {}, false);
    await expectStatus(h.c.sessions.start(room.session, room.a), 403);
    await expectStatus(h.c.sessions.end(room.session, room.a), 403);
    await expectStatus(h.c.sessions.dashboard(room.session, room.a), 403);
    // nothing can be posted before the host starts
    await expectStatus(h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'x' }), 409, 'SESSION_NOT_ACTIVE');
    const started = await h.c.sessions.start(room.session, room.host);
    await expectStatus(h.c.sessions.start(started, room.host), 409);
    const ended = await h.c.sessions.end(started, room.host);
    await expectStatus(h.c.submissions.submit(ended, room.a, { image: await picture(1), answer: 'x' }), 409, 'SESSION_NOT_ACTIVE');
  });

  it('honours the challenge settings', async () => {
    for (const settings of [{ challengeMode: false }, { allowParticipantChallenges: false }]) {
      const room = await createRoom(h, settings);
      await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'One' });
      const r = await h.c.submissions.submit(room.session, room.b, { image: await picture(1), answer: 'Two' });
      expect(r.outcome === 'MATCHED' && r.prompt.canChallenge).toBe(false);
      await expectStatus(h.c.submissions.decide(room.session, room.b, r.submissionId, 'CHALLENGE'), 403);
      // the answer is still safely recorded and the participant can keep it
      await h.c.submissions.decide(room.session, room.b, r.submissionId, 'KEEP');
    }
  });

  it('hides previous answers until the viewer has answered (AFTER_ANSWER)', async () => {
    const room = await createRoom(h, { previousAnswerVisibility: 'AFTER_ANSWER' });
    const q = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Top secret answer' });
    if (q.outcome !== 'NEW_QUESTION') throw new Error('setup');
    const before = await h.c.questions.detail(room.session, room.c, q.question.id);
    expect(before.caps.canSeeAnswers).toBe(false);
    expect(JSON.stringify(before)).not.toContain('Top secret answer');
    expect(JSON.stringify(await h.c.questions.list(room.session, room.c, {}))).not.toContain('Top secret answer');
    expect((await h.c.questions.list(room.session, room.c, { search: 'secret' })).total).toBe(0);
    await expectStatus(h.c.challenges.create(room.session, room.c, q.question.id, {}), 403); // cannot challenge what you cannot see
    const after = await h.c.questions.answerDirect(room.session, room.c, q.question.id, 'My guess');
    expect(after.originalAnswer?.raw).toBe('Top secret answer');
    // the host always sees everything
    expect((await h.c.questions.detail(room.session, room.host, q.question.id)).answers).toHaveLength(2);
  });

  it('never shows previous answers or allows challenges in NEVER mode', async () => {
    const room = await createRoom(h, { previousAnswerVisibility: 'NEVER' });
    await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Hidden' });
    const r = await h.c.submissions.submit(room.session, room.b, { image: await picture(1), answer: 'Mine' });
    if (r.outcome !== 'MATCHED') throw new Error('setup');
    expect(r.prompt).toMatchObject({ previousAnswer: null, needsDecision: false, canChallenge: false });
    expect(JSON.stringify(r)).not.toContain('Hidden');
    const d = await h.c.questions.detail(room.session, room.b, r.question.id);
    expect(d.answers!.map((a) => a.raw)).toEqual(['Mine']);
    await expectStatus(h.c.challenges.create(room.session, room.b, r.question.id, {}), 403);
  });

  it('hides names from participants in anonymous sessions and consensus when disabled', async () => {
    const room = await createRoom(h, { anonymousAnswers: true, showConsensus: false, previousAnswerVisibility: 'BEFORE_ANSWER' });
    const q = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'One' });
    if (q.outcome !== 'NEW_QUESTION') throw new Error('setup');
    const asB = await h.c.questions.detail(room.session, room.b, q.question.id);
    expect(asB.answers![0].by).toBe('Anonymous');
    expect(asB.images[0].by).toBe('Anonymous');
    expect(asB.consensus).toBeNull();
    expect(asB.tally).toBeNull();
    expect(JSON.stringify(asB)).not.toContain('User A');
    const asHost = await h.c.questions.detail(room.session, room.host, q.question.id);
    expect(asHost.answers![0].by).toBe('User A');
    expect(asHost.consensus).not.toBeNull();
    // consensus-based sorting silently falls back for viewers who cannot see consensus
    expect((await h.c.questions.list(room.session, room.b, { sort: 'HIGHEST_CONSENSUS' })).sort).toBe('NEWEST');
  });
});

describe('uploads', () => {
  const submit = async (image: Buffer, answer: unknown = 'x') => {
    const room = await createRoom(h);
    return h.c.submissions.submit(room.session, room.a, { image, answer });
  };

  it('rejects files that are not real images, whatever they claim to be', async () => {
    await expectStatus(submit(Buffer.from('<?php echo shell_exec($_GET["c"]); ?>')), 415);
    await expectStatus(submit(Buffer.from('MZ\x90\x00 this is an executable')), 415);
    await expectStatus(submit(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), 415);
    await expectStatus(submit(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])), 415); // truncated JPEG header
    await expectStatus(submit(Buffer.alloc(0)), 400, 'IMAGE_REQUIRED');
  });

  it('rejects oversized files and decompression bombs', async () => {
    await expectStatus(submit(Buffer.alloc(500 * 1024, 1)), 413);
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000' } }).png().toBuffer();
    expect(bomb.length).toBeLessThan(400 * 1024); // tiny file, 81 megapixels
    await expectStatus(submit(bomb), 415);
  });

  it('validates the answer text', async () => {
    await expectStatus(submit(await picture(1), ''), 400, 'ANSWER_REQUIRED');
    await expectStatus(submit(await picture(1), '   '), 400, 'ANSWER_REQUIRED');
    await expectStatus(submit(await picture(1), 'x'.repeat(501)), 400, 'ANSWER_TOO_LONG');
    await expectStatus(submit(await picture(1), { $ne: null }), 400, 'ANSWER_REQUIRED');
  });

  it('re-encodes uploads, strips metadata and applies EXIF orientation', async () => {
    const room = await createRoom(h);
    const withExif = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 20, g: 0, b: 128 } } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret-owner', Make: 'SpyCam' } } })
      .toBuffer();
    expect(withExif.includes('secret-owner')).toBe(true);
    const r = await h.c.submissions.submit(room.session, room.a, { image: withExif, answer: 'x' });
    expect(r.outcome).toBe('NEW_QUESTION');
    const stored = [...h.storage.objects.entries()].filter(([k]) => k.startsWith(room.session.id));
    expect(stored).toHaveLength(2); // display + thumbnail; the original is not kept by default
    for (const [, obj] of stored) {
      expect(obj.mime).toBe('image/webp');
      expect(obj.data.includes('secret-owner')).toBe(false);
      const meta = await sharp(obj.data).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.height! > meta.width!).toBe(true); // rotated 90° per EXIF orientation 6
    }
    const thumb = stored.find(([k]) => k.endsWith('thumb.webp'))![1];
    expect((await sharp(thumb.data).metadata()).height).toBeLessThanOrEqual(360);
  });
});
