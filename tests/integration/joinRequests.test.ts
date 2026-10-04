import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createRoom, expectStatus, type Harness, type Room } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.gateway.online = [];
  h.gateway.participantEvents.length = 0;
  h.gateway.sessionEvents.length = 0;
});

/** A listed session whose host is connected (so it shows on the home page). */
async function listedRoom(settings: Record<string, unknown> = {}, start = true): Promise<Room> {
  const room = await createRoom(h, settings, start);
  h.gateway.online.push(room.host.id);
  return room;
}
const listedIds = async () => (await h.c.joinRequests.listPublic()).map((s) => s.id);
const ask = (room: Room, displayName: string) => h.c.joinRequests.request(room.session.id, { displayName });

describe('public session list', () => {
  it('shows ongoing listed sessions without revealing their codes', async () => {
    const room = await listedRoom();
    h.gateway.online.push(room.a.id);
    const entry = (await h.c.joinRequests.listPublic()).find((s) => s.id === room.session.id)!;
    expect(entry).toMatchObject({ name: 'Test session', hostName: 'Host', status: 'ACTIVE', participantCount: 4, onlineCount: 2 });
    expect(JSON.stringify(await h.c.joinRequests.listPublic())).not.toContain(room.session.code);
  });

  it('includes sessions still in the waiting room', async () => {
    const room = await listedRoom({}, false);
    expect((await h.c.joinRequests.listPublic()).find((s) => s.id === room.session.id)?.status).toBe('WAITING');
  });

  it('leaves out unlisted, ended, demo, host-less and pre-existing sessions', async () => {
    const unlisted = await listedRoom({ listedPublicly: false });
    const ended = await listedRoom();
    await h.c.sessions.end(ended.session, ended.host);
    const hostAway = await createRoom(h); // nobody online who could admit
    h.gateway.online.push(hostAway.a.id);
    const legacy = await listedRoom();
    await h.c.db.query(`UPDATE sessions SET settings = settings - 'listedPublicly' WHERE id = $1`, [legacy.session.id]);
    const demo = await listedRoom();
    await h.c.db.query('UPDATE sessions SET is_demo = true WHERE id = $1', [demo.session.id]);
    const shown = await listedRoom();

    const ids = await listedIds();
    expect(ids).toContain(shown.session.id);
    for (const hidden of [unlisted, ended, hostAway, legacy, demo]) expect(ids).not.toContain(hidden.session.id);
    // and none of them accepts requests either
    for (const hidden of [unlisted, ended, legacy, demo]) await expectStatus(ask(hidden, 'Visitor'), 404);
  });
});

describe('asking to join', () => {
  it('lets the host admit a visitor, whose token only starts working at that moment', async () => {
    const room = await listedRoom();
    const req = await ask(room, 'Visitor Vee');
    expect(req.sessionName).toBe('Test session');

    // before approval: not a participant, token opens nothing, code not revealed
    await expectStatus(h.c.sessions.authenticate(req.token), 401);
    expect(await h.c.joinRequests.status(req.token)).toEqual({ status: 'PENDING', sessionName: 'Test session', code: null });
    expect((await h.c.repos.sessions.listParticipants(room.session.id)).map((p) => p.displayName)).not.toContain('Visitor Vee');

    // the host is told, in real time; ordinary participants are not
    expect(h.gateway.notificationsFor(room.host.id).map((n) => n.title)).toContain('Visitor Vee wants to join');
    expect(h.gateway.notificationsFor(room.a.id).filter((n) => n.type === 'JOIN_REQUEST')).toHaveLength(0);
    expect(JSON.stringify(h.gateway.sessionEvents)).not.toContain('Visitor Vee'); // the room only hears "something changed"

    const pending = await h.c.joinRequests.listPending(room.session, room.host);
    expect(pending.map((p) => p.displayName)).toEqual(['Visitor Vee']);
    const after = await h.c.joinRequests.decide(room.session, room.host, pending[0].id, 'APPROVE');
    expect(after).toEqual([]);

    expect(await h.c.joinRequests.status(req.token)).toEqual({ status: 'APPROVED', sessionName: 'Test session', code: room.session.code });
    const auth = await h.c.sessions.authenticate(req.token);
    expect(auth.participant).toMatchObject({ displayName: 'Visitor Vee', role: 'PARTICIPANT', sessionId: room.session.id });
    expect((await h.c.sessions.state(auth.session, auth.participant)).me.displayName).toBe('Visitor Vee');
    expect(h.gateway.sessionEvents.map((e) => e.data.type)).toEqual(
      expect.arrayContaining(['JOIN_REQUESTED', 'JOIN_REQUEST_APPROVED', 'PARTICIPANT_JOINED']),
    );
    await expectStatus(h.c.joinRequests.decide(room.session, room.host, pending[0].id, 'DECLINE'), 409, 'ALREADY_DECIDED');
  });

  it('lets the host decline; the visitor is told and never gets in', async () => {
    const room = await listedRoom();
    const req = await ask(room, 'Nope');
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    await h.c.joinRequests.decide(room.session, room.host, pending.id, 'DECLINE');
    expect(await h.c.joinRequests.status(req.token)).toMatchObject({ status: 'DECLINED', code: null });
    await expectStatus(h.c.sessions.authenticate(req.token), 401);
    expect(await h.c.repos.sessions.countParticipants(room.session.id)).toBe(4);
    // they may ask again
    expect((await ask(room, 'Nope')).requestId).toBeTruthy();
  });

  it('only lets hosts see and decide requests, and only for their own session', async () => {
    const room = await listedRoom();
    const other = await listedRoom();
    await ask(room, 'Visitor');
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    await expectStatus(h.c.joinRequests.listPending(room.session, room.a), 403);
    await expectStatus(h.c.joinRequests.decide(room.session, room.a, pending.id, 'APPROVE'), 403);
    await expectStatus(h.c.joinRequests.decide(other.session, other.host, pending.id, 'APPROVE'), 404);
    await expectStatus(h.c.joinRequests.decide(room.session, room.host, pending.id, 'MAYBE'), 400);
    await expectStatus(h.c.joinRequests.decide(room.session, room.host, 'not-an-id', 'APPROVE'), 404);
    expect(await h.c.joinRequests.listPending(other.session, other.host)).toEqual([]);
  });

  it('validates names and prevents duplicates', async () => {
    const room = await listedRoom();
    await expectStatus(ask(room, '   '), 400);
    await expectStatus(ask(room, 'x'.repeat(100)), 400);
    await expectStatus(ask(room, 'user a'), 409, 'NAME_TAKEN'); // an existing participant
    await ask(room, 'Twin');
    await expectStatus(ask(room, 'TWIN'), 409, 'NAME_TAKEN'); // someone already waiting
    await expectStatus(h.c.joinRequests.request(room.session.code, { displayName: 'ByCode' }), 404); // the code is not a public id
    await expectStatus(h.c.joinRequests.request('00000000-0000-4000-8000-000000000000', { displayName: 'Ghost' }), 404);
  });

  it('refuses to admit when the name was taken in the meantime', async () => {
    const room = await listedRoom();
    await ask(room, 'Late');
    await h.c.sessions.join(room.session.code, { displayName: 'Late' }); // someone joins by code with that name
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    await expectStatus(h.c.joinRequests.decide(room.session, room.host, pending.id, 'APPROVE'), 409, 'NAME_TAKEN');
    await h.c.joinRequests.decide(room.session, room.host, pending.id, 'DECLINE');
  });

  it('admits each request at most once under a double click', async () => {
    const room = await listedRoom();
    const req = await ask(room, 'Once');
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    const settled = await Promise.allSettled([
      h.c.joinRequests.decide(room.session, room.host, pending.id, 'APPROVE'),
      h.c.joinRequests.decide(room.session, room.host, pending.id, 'APPROVE'),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect((await h.c.repos.sessions.listParticipants(room.session.id)).filter((p) => p.displayName === 'Once')).toHaveLength(1);
    expect((await h.c.sessions.authenticate(req.token)).participant.displayName).toBe('Once');
  });

  it('lets the visitor cancel, and drops visitors who stopped waiting', async () => {
    const room = await listedRoom();
    const quitter = await ask(room, 'Quitter');
    const ghost = await ask(room, 'Ghost');
    expect(await h.c.joinRequests.cancel(quitter.token)).toMatchObject({ status: 'CANCELLED' });
    // the ghost closed their tab a while ago
    await h.c.db.query(`UPDATE join_requests SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [ghost.requestId]);
    expect(await h.c.joinRequests.listPending(room.session, room.host)).toEqual([]);
    // coming back (polling again) puts them back in the queue
    await h.c.joinRequests.status(ghost.token);
    expect((await h.c.joinRequests.listPending(room.session, room.host)).map((p) => p.displayName)).toEqual(['Ghost']);
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    await expectStatus(h.c.joinRequests.decide(room.session, room.host, (await h.c.repos.joinRequests.find(quitter.requestId))!.id, 'APPROVE'), 409);
    await h.c.joinRequests.decide(room.session, room.host, pending.id, 'APPROVE');
  });

  it('tells waiting visitors when the session ends, and rejects bad tokens', async () => {
    const room = await listedRoom();
    const req = await ask(room, 'Too late');
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    const ended = await h.c.sessions.end(room.session, room.host);
    expect(await h.c.joinRequests.status(req.token)).toMatchObject({ status: 'CLOSED', code: null });
    await expectStatus(h.c.joinRequests.decide(ended, room.host, pending.id, 'APPROVE'), 409, 'SESSION_ENDED');
    await expectStatus(h.c.joinRequests.status(null), 401);
    await expectStatus(h.c.joinRequests.status('x'.repeat(43)), 401);
    // a participant token is not a join-request token
    await expectStatus(h.c.joinRequests.status(room.tokens.a), 401);
  });

  it('records requests in the host history', async () => {
    const room = await listedRoom();
    await ask(room, 'Historic');
    const [pending] = await h.c.joinRequests.listPending(room.session, room.host);
    await h.c.joinRequests.decide(room.session, room.host, pending.id, 'APPROVE');
    const summaries = (await h.c.sessions.dashboard(room.session, room.host)).events.map((e) => e.summary);
    expect(summaries).toContain('Historic asked to join from the home page');
    expect(summaries).toContain('Host let Historic in');
  });
});
