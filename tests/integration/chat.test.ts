import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createRoom, expectStatus, picture, type Harness, type Room } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.gateway.sessionEvents.length = 0;
  h.gateway.participantEvents.length = 0;
});

const say = (room: Room, from: 'host' | 'a' | 'b' | 'c', text: string, to?: string) =>
  h.c.chat.send(room.session, room[from], { to: to ?? 'public', text });
const thread = async (room: Room, who: 'host' | 'a' | 'b' | 'c', channel = 'public') =>
  (await h.c.chat.messages(room.session, room[who], { channel })).items.map((m) => `${m.senderName}: ${m.text}`);
const chatFrames = (participantId: string) =>
  h.gateway.participantEvents.filter((e) => e.event === 'chat:message' && e.participantId === participantId).map((e) => e.data.text);

describe('public chat', () => {
  it('delivers a message to everyone in the session, in order, and nowhere else', async () => {
    const room = await createRoom(h, {}, false); // chat also works in the waiting room
    const other = await createRoom(h);
    const sent = await say(room, 'a', '  Hello everyone  ');
    await say(room, 'host', 'Welcome!');
    expect(sent).toMatchObject({ senderId: room.a.id, senderName: 'User A', recipientId: null, text: 'Hello everyone' });

    for (const who of ['host', 'a', 'b', 'c'] as const)
      expect(await thread(room, who)).toEqual(['User A: Hello everyone', 'Host: Welcome!']);
    expect(await thread(other, 'a')).toEqual([]);

    const broadcasts = h.gateway.sessionEvents.filter((e) => e.event === 'chat:message');
    expect(broadcasts.map((e) => [e.sessionId, e.data.text])).toEqual([
      [room.session.id, 'Hello everyone'],
      [room.session.id, 'Welcome!'],
    ]);
  });

  it('tracks unread counts per participant and clears them when read', async () => {
    const room = await createRoom(h);
    await say(room, 'a', 'one');
    const last = await say(room, 'a', 'two');
    expect((await h.c.chat.overview(room.session, room.b)).publicUnread).toBe(2);
    expect((await h.c.chat.overview(room.session, room.a)).publicUnread).toBe(0); // own messages are never unread
    const after = await h.c.chat.markRead(room.session, room.b, { channel: 'public', lastId: last.id });
    expect(after.publicUnread).toBe(0);
    await say(room, 'c', 'three');
    expect((await h.c.chat.overview(room.session, room.b)).publicUnread).toBe(1);
    // marking an older message read never moves the marker backwards
    await h.c.chat.markRead(room.session, room.b, { channel: 'public', lastId: '1' });
    expect((await h.c.chat.overview(room.session, room.b)).publicUnread).toBe(1);
  });

  it('pages backwards through history', async () => {
    const room = await createRoom(h);
    for (let i = 1; i <= 7; i++) await say(room, 'a', `m${i}`);
    const latest = await h.c.chat.messages(room.session, room.b, { limit: 3 });
    expect(latest.items.map((m) => m.text)).toEqual(['m5', 'm6', 'm7']);
    expect(latest.hasMore).toBe(true);
    const older = await h.c.chat.messages(room.session, room.b, { limit: 5, before: latest.items[0].id });
    expect(older.items.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(older.hasMore).toBe(false);
  });

  it('validates messages', async () => {
    const room = await createRoom(h);
    await expectStatus(say(room, 'a', '   '), 400, 'MESSAGE_REQUIRED');
    await expectStatus(say(room, 'a', 'x'.repeat(1001)), 400, 'MESSAGE_TOO_LONG');
    await expectStatus(h.c.chat.send(room.session, room.a, { text: { $ne: 1 } }), 400, 'MESSAGE_REQUIRED');
    const html = await say(room, 'a', '<script>alert(1)</script>');
    expect(html.text).toBe('<script>alert(1)</script>'); // stored verbatim; the UI renders it as text
  });
});

describe('private chat', () => {
  it('is delivered to and readable by exactly the two participants', async () => {
    const room = await createRoom(h);
    await say(room, 'a', 'psst, B', room.b.id);
    await say(room, 'b', 'yes?', room.a.id);
    await say(room, 'a', 'different chat', room.c.id);

    expect(await thread(room, 'a', room.b.id)).toEqual(['User A: psst, B', 'User B: yes?']);
    expect(await thread(room, 'b', room.a.id)).toEqual(['User A: psst, B', 'User B: yes?']);
    // C asking for "my conversation with A" or "with B" sees only what C is part of
    expect(await thread(room, 'c', room.a.id)).toEqual(['User A: different chat']);
    expect(await thread(room, 'c', room.b.id)).toEqual([]);
    // the host cannot read private conversations either, and nothing leaks into public
    expect(await thread(room, 'host', room.a.id)).toEqual([]);
    expect(await thread(room, 'host', room.b.id)).toEqual([]);
    for (const who of ['host', 'a', 'b', 'c'] as const) expect(await thread(room, who)).toEqual([]);

    // realtime: only sender and recipient get the frame; nothing goes to the session room
    expect(h.gateway.sessionEvents.filter((e) => e.event === 'chat:message')).toHaveLength(0);
    expect(chatFrames(room.b.id)).toEqual(['psst, B', 'yes?']);
    expect(chatFrames(room.a.id)).toEqual(['psst, B', 'yes?', 'different chat']);
    expect(chatFrames(room.c.id)).toEqual(['different chat']);
    expect(chatFrames(room.host.id)).toEqual([]);
  });

  it('never appears in the host dashboard, question history or event log', async () => {
    const room = await createRoom(h);
    const q = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Dog' });
    await say(room, 'a', 'top-secret-private-text', room.b.id);
    await say(room, 'a', 'public-text');
    const dash = JSON.stringify(await h.c.sessions.dashboard(room.session, room.host));
    expect(dash).not.toContain('top-secret-private-text');
    expect(dash).not.toContain('public-text');
    if (q.outcome === 'NEW_QUESTION')
      expect(JSON.stringify(await h.c.questions.detail(room.session, room.host, q.question.id))).not.toContain('top-secret');
    const logged = await h.c.db.query('SELECT payload::text AS p FROM session_events WHERE session_id = $1', [room.session.id]);
    expect(JSON.stringify(logged)).not.toContain('top-secret');
    expect(JSON.stringify(await h.c.sessions.state(room.session, room.host))).not.toContain('top-secret');
  });

  it('shows unread private conversations only to their recipient', async () => {
    const room = await createRoom(h);
    await say(room, 'a', 'hi B', room.b.id);
    const last = await say(room, 'a', 'you there?', room.b.id);
    expect((await h.c.chat.overview(room.session, room.b)).direct).toEqual([{ participantId: room.a.id, unread: 2 }]);
    expect((await h.c.chat.overview(room.session, room.a)).direct).toEqual([{ participantId: room.b.id, unread: 0 }]);
    expect((await h.c.chat.overview(room.session, room.c)).direct).toEqual([]);
    expect((await h.c.chat.overview(room.session, room.host)).direct).toEqual([]);
    const read = await h.c.chat.markRead(room.session, room.b, { channel: room.a.id, lastId: last.id });
    expect(read.direct).toEqual([{ participantId: room.a.id, unread: 0 }]);
  });

  it('rejects messaging yourself, strangers and people in other sessions', async () => {
    const room = await createRoom(h);
    const other = await createRoom(h);
    await say(other, 'a', 'their secret', other.b.id);
    await expectStatus(say(room, 'a', 'me', room.a.id), 400);
    await expectStatus(say(room, 'a', 'x', other.a.id), 404);
    await expectStatus(say(room, 'a', 'x', '00000000-0000-4000-8000-000000000000'), 404);
    await expectStatus(say(room, 'a', 'x', "public' OR '1'='1"), 400);
    // reading another session's conversation by guessing ids
    await expectStatus(h.c.chat.messages(room.session, room.a, { channel: other.b.id }), 404);
    await expectStatus(h.c.chat.markRead(room.session, room.a, { channel: other.b.id, lastId: '1' }), 404);
  });
});

describe('chat settings and lifecycle', () => {
  it('can be turned off entirely', async () => {
    const room = await createRoom(h, { chatEnabled: false });
    expect(await h.c.chat.overview(room.session, room.a)).toMatchObject({ enabled: false, privateEnabled: false, canSend: false });
    await expectStatus(say(room, 'a', 'hi'), 403);
    await expectStatus(say(room, 'host', 'hi'), 403);
    await expectStatus(h.c.chat.messages(room.session, room.a, {}), 403);
  });

  it('can allow public chat while turning private messages off', async () => {
    const room = await createRoom(h, { privateChatEnabled: false });
    await say(room, 'a', 'public is fine');
    expect(await h.c.chat.overview(room.session, room.a)).toMatchObject({ enabled: true, privateEnabled: false });
    await expectStatus(say(room, 'a', 'psst', room.b.id), 403, 'PRIVATE_CHAT_DISABLED');
    await expectStatus(h.c.chat.messages(room.session, room.a, { channel: room.b.id }), 403, 'PRIVATE_CHAT_DISABLED');
  });

  it('becomes read-only when the session ends', async () => {
    const room = await createRoom(h);
    await say(room, 'a', 'before the end');
    const ended = await h.c.sessions.end(room.session, room.host);
    await expectStatus(h.c.chat.send(ended, room.a, { to: 'public', text: 'too late' }), 409, 'SESSION_ENDED');
    expect((await h.c.chat.messages(ended, room.b, {})).items.map((m) => m.text)).toEqual(['before the end']);
    expect((await h.c.chat.overview(ended, room.b)).canSend).toBe(false);
  });

  it('treats sessions created before chat existed as chat-enabled', async () => {
    const room = await createRoom(h);
    await h.c.db.query(`UPDATE sessions SET settings = settings - 'chatEnabled' - 'privateChatEnabled' WHERE id = $1`, [room.session.id]);
    const legacy = (await h.c.repos.sessions.findById(room.session.id))!;
    expect('chatEnabled' in legacy.settings).toBe(false);
    await h.c.chat.send(legacy, room.a, { to: room.b.id, text: 'still works' });
    expect(h.c.sessions.toSessionView(legacy).settings).toMatchObject({ chatEnabled: true, privateChatEnabled: true });
  });
});
