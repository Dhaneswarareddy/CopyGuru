import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createRoom, expectStatus, picture, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.gateway.online = [];
  h.gateway.disconnected = [];
  h.gateway.sessionEvents.length = 0;
  h.gateway.participantEvents.length = 0;
});

describe('removing a participant', () => {
  it('cuts their access immediately and keeps what they contributed', async () => {
    const room = await createRoom(h);
    const q = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Golden Retriever' });
    const b = await h.c.submissions.submit(room.session, room.b, { image: await picture(1, 'high'), answer: 'Labrador' });
    await h.c.submissions.decide(room.session, room.b, b.submissionId, 'CHALLENGE');
    if (q.outcome !== 'NEW_QUESTION') throw new Error('setup');

    const remaining = await h.c.sessions.removeParticipant(room.session, room.host, room.b.id);
    expect(remaining.map((p) => p.displayName)).toEqual(['Host', 'User A', 'User C']);
    expect(h.gateway.disconnected).toEqual([room.b.id]); // live connection closed

    // their token no longer opens anything
    await expectStatus(h.c.sessions.authenticate(room.tokens.b), 403, 'REMOVED');
    // …but nothing they did is erased or altered
    const d = await h.c.questions.detail(room.session, room.host, q.question.id);
    expect(d.answers!.find((a) => a.by === 'User B')).toMatchObject({ raw: 'Labrador', relationship: 'CHALLENGES' });
    expect(d.images.map((i) => i.by).sort()).toEqual(['User A', 'User B']);
    expect(d.challenges[0].challenge).toMatchObject({ raw: 'Labrador', by: 'User B' });
    expect(d.answerCount).toBe(2);

    const dash = await h.c.sessions.dashboard(room.session, room.host);
    expect(dash.stats.participants).toBe(3);
    expect(dash.events.map((e) => e.summary)).toContain('Host removed User B from the session');
    expect(h.gateway.sessionEvents.map((e) => e.data.type)).toContain('PARTICIPANT_REMOVED');
  });

  it('stops notifications and private messages to the removed person, and frees no name', async () => {
    const room = await createRoom(h);
    await h.c.sessions.removeParticipant(room.session, room.host, room.c.id);
    h.gateway.participantEvents.length = 0;
    const q = await h.c.submissions.submit(room.session, room.a, { image: await picture(2), answer: 'One' });
    const b = await h.c.submissions.submit(room.session, room.b, { image: await picture(2), answer: 'Two' });
    await h.c.submissions.decide(room.session, room.b, b.submissionId, 'CHALLENGE');
    expect(q.outcome).toBe('NEW_QUESTION');
    expect(h.gateway.notificationsFor(room.c.id)).toHaveLength(0);
    expect(h.gateway.notificationsFor(room.a.id).length).toBeGreaterThan(0);
    await expectStatus(h.c.chat.send(room.session, room.a, { to: room.c.id, text: 'still there?' }), 404);
    // the same name cannot be reused to slip back in unnoticed
    await expectStatus(h.c.sessions.join(room.session.code, { displayName: 'User C' }), 409, 'NAME_TAKEN');
  });

  it('is restricted to hosts, and never applies to the host, yourself or other sessions', async () => {
    const room = await createRoom(h);
    const other = await createRoom(h);
    await expectStatus(h.c.sessions.removeParticipant(room.session, room.a, room.b.id), 403);
    await expectStatus(h.c.sessions.removeParticipant(room.session, room.host, room.host.id), 400, 'CANNOT_REMOVE_SELF');
    await expectStatus(h.c.sessions.removeParticipant(room.session, room.host, other.a.id), 404);
    await expectStatus(h.c.sessions.removeParticipant(room.session, room.host, 'nope'), 404);
    await h.c.sessions.removeParticipant(room.session, room.host, room.a.id);
    await expectStatus(h.c.sessions.removeParticipant(room.session, room.host, room.a.id), 409, 'ALREADY_REMOVED');
    // nobody can remove the host
    const mod = await h.c.sessions.join(room.session.code, { displayName: 'Mod', role: 'MODERATOR' });
    await expectStatus(h.c.sessions.removeParticipant(room.session, mod.participant, room.host.id), 403, 'CANNOT_REMOVE_HOST');
    expect((await h.c.sessions.state(room.session, room.b)).caps.canRemoveParticipants).toBe(false);
    expect((await h.c.sessions.state(room.session, room.host)).caps.canRemoveParticipants).toBe(true);
  });
});

describe('changing settings during the session', () => {
  it('applies valid changes at once and ignores unknown or invalid ones', async () => {
    const room = await createRoom(h);
    await h.c.chat.send(room.session, room.a, { to: 'public', text: 'hi' });
    const updated = await h.c.sessions.updateSettings(room.session, room.host, {
      chatEnabled: false,
      previousAnswerVisibility: 'NEVER',
      challengeMode: 'nope',
      isAdmin: true,
    });
    expect(updated.settings).toMatchObject({ chatEnabled: false, previousAnswerVisibility: 'NEVER', challengeMode: true });
    expect('isAdmin' in updated.settings).toBe(false);
    await expectStatus(h.c.chat.send(updated, room.a, { to: 'public', text: 'hi again' }), 403);
    expect(h.gateway.sessionEvents.map((e) => e.data.type)).toContain('SESSION_SETTINGS_UPDATED');
    // unchanged input publishes nothing
    h.gateway.sessionEvents.length = 0;
    await h.c.sessions.updateSettings(updated, room.host, { chatEnabled: false });
    expect(h.gateway.sessionEvents).toHaveLength(0);
  });

  it('is host-only and closed once the session has ended', async () => {
    const room = await createRoom(h);
    await expectStatus(h.c.sessions.updateSettings(room.session, room.a, { chatEnabled: false }), 403);
    await expectStatus(h.c.sessions.updateSettings(room.session, room.host, 'chatEnabled=false'), 400);
    const ended = await h.c.sessions.end(room.session, room.host);
    await expectStatus(h.c.sessions.updateSettings(ended, room.host, { chatEnabled: false }), 409);
  });

  it('can take a session off the home page', async () => {
    const room = await createRoom(h);
    h.gateway.online = [room.host.id];
    expect((await h.c.joinRequests.listPublic()).map((s) => s.id)).toContain(room.session.id);
    await h.c.sessions.updateSettings(room.session, room.host, { listedPublicly: false });
    expect((await h.c.joinRequests.listPublic()).map((s) => s.id)).not.toContain(room.session.id);
  });
});

describe('approving everyone who joins', () => {
  it('sends code-holders through the host too, so a removed person cannot walk back in', async () => {
    const room = await createRoom(h, { listedPublicly: false });
    await h.c.sessions.removeParticipant(room.session, room.host, room.c.id);
    // without the setting, the code still lets anyone in under a new name
    expect((await h.c.sessions.join(room.session.code, { displayName: 'New name' })).participant.displayName).toBe('New name');

    const locked = await h.c.sessions.updateSettings(room.session, room.host, { approveAllJoins: true });
    await expectStatus(h.c.sessions.join(locked.code, { displayName: 'Sneaky' }), 409, 'APPROVAL_REQUIRED');
    // the code now starts a request instead (works although the session is unlisted)
    const req = await h.c.joinRequests.request(locked.code.toLowerCase(), { displayName: 'Sneaky' });
    await expectStatus(h.c.sessions.authenticate(req.token), 401);
    const [pending] = await h.c.joinRequests.listPending(locked, room.host);
    expect(pending.displayName).toBe('Sneaky');
    await h.c.joinRequests.decide(locked, room.host, pending.id, 'DECLINE');
    await expectStatus(h.c.sessions.authenticate(req.token), 401);

    const welcome = await h.c.joinRequests.request(locked.code, { displayName: 'Welcome' });
    const [next] = await h.c.joinRequests.listPending(locked, room.host);
    await h.c.joinRequests.decide(locked, room.host, next.id, 'APPROVE');
    expect((await h.c.sessions.authenticate(welcome.token)).participant.displayName).toBe('Welcome');
  });
});

describe('results export', () => {
  it('gives the host every answer as CSV, safely escaped', async () => {
    const room = await createRoom(h);
    await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Paris, "the" city' });
    const b = await h.c.submissions.submit(room.session, room.b, { image: await picture(1), answer: '=HYPERLINK("http://evil","x")' });
    await h.c.submissions.decide(room.session, room.b, b.submissionId, 'AGREE');
    await h.c.submissions.submit(room.session, room.c, { image: await picture(5), answer: 'Line one\nline two' });

    const csv = await h.c.sessions.exportCsv(room.session, room.host);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Question,Question status,Consensus %,Answers on question,Participant,Answer,Normalized answer,Relationship,Agreed with,Source,Answered at');
    expect(lines[1]).toContain('1,OPEN,100,2,User A,"Paris, ""the"" city",paris the city,ORIGINAL,,IMAGE_SUBMISSION,');
    // a formula-looking answer is neutralised but still recognisable, and shows what it agreed with
    expect(lines[2]).toContain(`User B,"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(lines[2]).toContain('AGREES,"Paris, ""the"" city"');
    expect(csv).toContain('"Line one\nline two"');
    await expectStatus(h.c.sessions.exportCsv(room.session, room.a), 403);
  });
});
