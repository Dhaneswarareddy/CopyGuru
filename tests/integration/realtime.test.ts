import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '@/lib/container';
import { RT, getRealtimeGateway } from '@/lib/realtime/gateway';
import { attachRealtime } from '@/lib/realtime/socketServer';
import { createHarness, createRoom, picture, type Harness, type Room } from '../helpers/harness';

/**
 * Real Socket.IO server + real socket clients for several users at once.
 * (The vision model is stubbed here; the HTTP + CLIP path is covered by
 * scripts/e2e-acceptance.ts.)
 */
let h: Harness;
let http: HttpServer;
let url: string;
let room: Room;
const sockets: Socket[] = [];

class Client {
  events: any[] = [];
  notifications: any[] = [];
  socket: Socket;
  constructor(token: string) {
    this.socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    this.socket.on(RT.SESSION_EVENT, (e) => this.events.push(e));
    this.socket.on(RT.NOTIFICATION, (n) => this.notifications.push(n));
    sockets.push(this.socket);
  }
  connected() {
    return new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }
  async waitFor<T>(pick: () => T | undefined, what: string): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const v = pick();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  event(type: string) {
    return this.waitFor(() => this.events.find((e) => e.type === type), `event ${type}`);
  }
}

beforeAll(async () => {
  h = await createHarness();
  // rebuild the container without a gateway override so it uses the Socket.IO one
  const c = await createContainer({ config: h.config, db: h.c.db, embedder: h.embedder, storage: h.storage });
  (globalThis as any).__vqaContainer = Promise.resolve(c);
  h.c = c;
  http = createServer();
  attachRealtime(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  room = await createRoom(h);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => http.close(r));
  await h.close();
});

describe('realtime', () => {
  it('rejects sockets without a valid token', async () => {
    await expect(new Client('not-a-real-token-not-a-real-token').connected()).rejects.toThrow(/unauthorized/);
  });

  it('delivers live updates to every participant and private notifications to the right ones', async () => {
    const [A, B, C, Host] = [new Client(room.tokens.a), new Client(room.tokens.b), new Client(room.tokens.c), new Client(room.tokens.host)];
    await Promise.all([A, B, C, Host].map((c) => c.connected()));
    expect(getRealtimeGateway().onlineParticipantIds(room.session.id).sort()).toEqual([room.a.id, room.b.id, room.c.id, room.host.id].sort());

    // someone from another session must not receive anything
    const otherRoom = await createRoom(h);
    const Outsider = new Client(otherRoom.tokens.a);
    await Outsider.connected();
    Outsider.events.length = 0;

    // User A posts → User B (and everyone) sees the question appear
    const first = await h.c.submissions.submit(room.session, room.a, { image: await picture(1), answer: 'Golden Retriever' });
    if (first.outcome !== 'NEW_QUESTION') throw new Error('setup');
    for (const c of [A, B, C, Host]) {
      const e = await c.event('QUESTION_CREATED');
      expect(e).toMatchObject({ questionId: first.question.id, data: { questionNumber: 1 } });
    }

    // User B challenges → User A, C and the host are notified; B is not
    const second = await h.c.submissions.submit(room.session, room.b, { image: await picture(1, 'high'), answer: 'Labrador' });
    await h.c.submissions.decide(room.session, room.b, second.submissionId, 'CHALLENGE', 'Looks like a lab');
    for (const c of [A, C, Host]) {
      const n = await c.waitFor(() => c.notifications.find((x) => x.type === 'CHALLENGE'), 'challenge notification');
      expect(n).toMatchObject({ title: 'New challenge on Question #1', questionId: first.question.id, read: false });
      await c.event('ANSWER_CHALLENGED');
    }
    expect((await A.waitFor(() => A.notifications.find((x) => x.type === 'CHALLENGE'), 'x')).data).toMatchObject({
      originalAnswer: 'Golden Retriever',
      challengerAnswer: 'Labrador',
      reason: 'Looks like a lab',
    });
    expect(B.notifications.filter((x) => x.type === 'CHALLENGE')).toHaveLength(0);

    // User C submits an answer → everyone sees consensus change
    [A, B, C, Host].forEach((c) => (c.events.length = 0));
    await h.c.questions.answerDirect(room.session, room.c, first.question.id, 'Labrador');
    for (const c of [A, B, C, Host]) await c.event('CONSENSUS_UPDATED');
    expect((await h.c.questions.summary(room.session, room.a, first.question.id)).consensus).toMatchObject({ pct: 67 });

    // broadcast frames carry no answers, and other sessions heard nothing
    expect(JSON.stringify([...A.events, ...B.events, ...C.events])).not.toMatch(/Labrador|Golden/);
    // (the outsider only ever hears about presence in their own session)
    expect(Outsider.events.filter((e) => e.type !== 'PRESENCE_CHANGED')).toHaveLength(0);
    expect(Outsider.notifications).toHaveLength(0);

    // presence updates when someone leaves
    Host.events.length = 0;
    C.socket.close();
    await Host.event('PRESENCE_CHANGED');
    expect(getRealtimeGateway().onlineParticipantIds(room.session.id)).not.toContain(room.c.id);
  });
});
