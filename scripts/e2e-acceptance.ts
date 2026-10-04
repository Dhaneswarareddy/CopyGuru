/**
 * End-to-end acceptance run against a RUNNING server (local or deployed):
 *
 *   BASE_URL=http://localhost:3000 npm run test:e2e
 *   BASE_URL=https://your-app.example.com npm run test:e2e
 *
 * Drives the real HTTP API and real WebSocket connections for four users and
 * walks through the acceptance scenario of the product brief. Uses real photos
 * and therefore the real embedding model on the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'tests', 'fixtures', 'images', name));

let step = 0;
function ok(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    throw new Error(`Acceptance check failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}
const section = (title: string) => console.log(`\n${++step}. ${title}`);

async function http<T = any>(method: string, url: string, opts: { token?: string; json?: unknown; form?: FormData } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

class User {
  events: any[] = [];
  notifications: any[] = [];
  socket!: Socket;
  constructor(public name: string, public token: string) {}

  connect() {
    return new Promise<void>((resolve, reject) => {
      this.socket = io(BASE, { auth: { token: this.token }, reconnection: false });
      this.socket.on('session:event', (e) => this.events.push(e));
      this.socket.on('notification', (n) => this.notifications.push(n));
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', (e) => reject(new Error(`${this.name} socket: ${e.message}`)));
    });
  }
  get<T = any>(url: string) {
    return http<T>('GET', url, { token: this.token });
  }
  post<T = any>(url: string, json: unknown = {}) {
    return http<T>('POST', url, { token: this.token, json });
  }
  submit(code: string, file: string, answer: string) {
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(fixture(file))], { type: 'image/jpeg' }), file);
    form.set('answer', answer);
    return http('POST', `/api/sessions/${code}/submissions`, { token: this.token, form });
  }
  async waitFor<T>(pick: () => T | undefined, what: string, ms = 8000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = pick();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`${this.name}: timed out waiting for ${what}`);
  }
  event(type: string, since = 0) {
    return this.waitFor(() => this.events.slice(since).find((e) => e.type === type), `realtime event ${type}`);
  }
}

async function main() {
  console.log(`Acceptance run against ${BASE}`);
  const health = await http('GET', '/api/health');
  ok(health.status === 200 && health.body.ok, `server is healthy (database: ${health.body.database}, model: ${health.body.similarityModel})`);

  section('Host creates a session');
  const created = await http('POST', '/api/sessions', { json: { name: 'Acceptance run', hostName: 'Host' } });
  ok(created.status === 200 && /^[A-Z0-9]{6}$/.test(created.body.session.code), `session code generated: ${created.body.session.code}`);
  const code: string = created.body.session.code;
  const host = new User('Host', created.body.token);

  section('Users A, B and C join; waiting room');
  const users: User[] = [];
  for (const name of ['User A', 'User B', 'User C']) {
    const joined = await http('POST', `/api/sessions/${code.toLowerCase()}/join`, { json: { displayName: name } });
    ok(joined.status === 200 && joined.body.token, `${name} joined`);
    users.push(new User(name, joined.body.token));
  }
  const [A, B, C] = users;
  const everyone = [host, A, B, C];
  await Promise.all(everyone.map((u) => u.connect()));
  ok(true, 'all four users connected over WebSocket');
  const waiting = await A.get(`/api/sessions/${code}`);
  ok(waiting.body.session.status === 'WAITING' && waiting.body.participants.length === 4, 'waiting room lists 4 participants');
  const early = await A.submit(code, 'golden-1.jpg', 'too early');
  ok(early.status === 409, 'posting before the host starts is rejected');
  ok((await A.post(`/api/sessions/${code}/start`)).status === 403, 'a participant cannot start the session');

  section('Host starts the session');
  ok((await host.post(`/api/sessions/${code}/start`)).body.session.status === 'ACTIVE', 'session is ACTIVE');
  for (const u of everyone) await u.event('SESSION_STARTED');
  ok(true, 'everyone received SESSION_STARTED in real time');

  section('User A posts Image A with answer "Golden Retriever"');
  const first = await A.submit(code, 'golden-1.jpg', 'Golden Retriever');
  ok(first.status === 200 && first.body.outcome === 'NEW_QUESTION' && first.body.question.number === 1, 'Question #1 created');
  const q1: string = first.body.question.id;
  for (const u of everyone) {
    await u.event('QUESTION_CREATED');
    const list = await u.get(`/api/sessions/${code}/questions`);
    ok(list.body.total === 1 && list.body.items[0].number === 1, `Question #1 appears in the Questions tab for ${u.name}`);
  }

  section('User B posts a DIFFERENT image of the same content with answer "Labrador"');
  const second = await B.submit(code, 'golden-2.jpg', 'Labrador');
  ok(second.status === 200 && second.body.outcome === 'MATCHED', `semantic matching found an existing question (similarity ${second.body.similarity?.toFixed(3)})`);
  ok(second.body.question.id === q1, 'it is Question #1 — no new question was created');
  ok(second.body.prompt.previousAnswer?.raw === 'Golden Retriever', 'User B is shown User A\'s answer "Golden Retriever"');
  ok(second.body.prompt.yourAnswer === 'Labrador', 'User B\'s own answer "Labrador" is shown and preserved');
  ok(second.body.prompt.needsDecision && second.body.prompt.canChallenge, 'User B is asked: agree / challenge / keep');
  const refreshed = await B.get(`/api/sessions/${code}`);
  ok(refreshed.body.pending?.outcome === 'MATCHED', 'the pending prompt survives a page refresh');

  section('User B clicks "Challenge Answer"');
  const marks = everyone.map((u) => u.events.length);
  const decided = await B.post(`/api/submissions/${second.body.submissionId}/decision`, { decision: 'CHALLENGE', reason: 'This looks more like a Labrador.' });
  ok(decided.status === 200, 'challenge recorded');
  for (const u of [host, A, C]) {
    const n = await u.waitFor(() => u.notifications.find((x) => x.type === 'CHALLENGE'), 'challenge notification');
    ok(n.questionId === q1 && n.data.originalAnswer === 'Golden Retriever' && n.data.challengerAnswer === 'Labrador', `${u.name} received a realtime challenge notification with both answers`);
  }
  ok(!B.notifications.some((x) => x.type === 'CHALLENGE'), 'the challenger is not notified about their own challenge');
  for (const [i, u] of everyone.entries()) await u.event('ANSWER_CHALLENGED', marks[i]);
  const challengedList = await C.get(`/api/sessions/${code}/questions?filter=CHALLENGED`);
  ok(challengedList.body.total === 1 && challengedList.body.items[0].status === 'CHALLENGED', 'Question #1 now shows CHALLENGED status');
  ok((await A.get(`/api/sessions/${code}/notifications`)).body.unread >= 1, 'the notification is stored in User A\'s notification centre');

  section('User C opens Question #1');
  const seenByC = await C.get(`/api/questions/${q1}`);
  const ch = seenByC.body.challenges[0];
  ok(seenByC.body.originalAnswer.raw === 'Golden Retriever', 'User C sees the original answer');
  ok(ch && ch.status === 'OPEN' && ch.challenge.raw === 'Labrador' && ch.original.raw === 'Golden Retriever', 'User C sees the challenge with both answers kept separate');
  ok(ch.reason === 'This looks more like a Labrador.', 'the challenge reason is shown');

  section('User C submits their own answer; consensus updates for everyone');
  const before = everyone.map((u) => u.events.length);
  const answered = await C.post(`/api/questions/${q1}/answers`, { answer: 'golden retriever!' });
  ok(answered.status === 200 && answered.body.answerCount === 3, 'User C\'s answer recorded (3 answers)');
  for (const [i, u] of everyone.entries()) await u.event('CONSENSUS_UPDATED', before[i]);
  ok(true, 'everyone received CONSENSUS_UPDATED in real time');
  for (const u of everyone) {
    const s = (await u.get(`/api/sessions/${code}/questions`)).body.items[0];
    ok(s.consensus.pct === 67 && s.tally[0].label === 'Golden Retriever' && s.tally[0].count === 2, `${u.name} sees consensus 67% (Golden Retriever 2, Labrador 1)`);
  }
  ok((await C.post(`/api/questions/${q1}/answers`, { answer: 'second try' })).status === 409, 'a second answer from the same participant is rejected');

  section('Challenge responses and duplicate-vote protection');
  const voted = await host.post(`/api/challenges/${ch.id}/respond`, { stance: 'ORIGINAL' });
  ok(voted.status === 200 && voted.body.challenges[0].status === 'DISCUSSION', 'host supports the original → challenge moves to DISCUSSION');
  ok((await host.post(`/api/challenges/${ch.id}/respond`, { stance: 'CHALLENGE' })).status === 409, 'voting twice is rejected');
  ok((await C.post(`/api/challenges/${ch.id}/resolve`, { outcome: 'CHALLENGE_ACCEPTED' })).status === 403, 'a participant cannot resolve a challenge');

  section('Host views the full question / challenge history');
  const hostView = await host.get(`/api/questions/${q1}`);
  const types: string[] = hostView.body.history.map((e: any) => e.type);
  ok(['QUESTION_CREATED', 'QUESTION_MATCHED', 'ANSWER_CHALLENGED', 'CHALLENGE_RESPONSE_ADDED', 'CONSENSUS_UPDATED'].every((t) => types.includes(t)), `history has ${types.length} events covering creation, match, challenge and responses`);
  const dash = await host.get(`/api/sessions/${code}/dashboard`);
  ok(dash.body.stats.questions === 1 && dash.body.stats.answers === 4 && dash.body.stats.challenges === 1, 'host dashboard totals are right (1 question, 4 answers, 1 challenge)');
  ok((await A.get(`/api/sessions/${code}/dashboard`)).status === 403, 'participants cannot open the host dashboard');

  section('No answers were overwritten; images and answers stay with their users');
  const byUser = Object.fromEntries(hostView.body.answers.map((a: any) => [a.by, a.raw]));
  ok(byUser['User A'] === 'Golden Retriever' && byUser['User B'] === 'Labrador' && byUser['User C'] === 'golden retriever!', 'raw answers are exactly as each user typed them');
  ok(hostView.body.images.length === 2 && hostView.body.images.map((i: any) => i.by).sort().join() === 'User A,User B', 'both images are retained in the group, attributed to A and B');
  const img = await fetch(BASE + hostView.body.images[1].thumbUrl);
  ok(img.status === 200 && img.headers.get('content-type') === 'image/webp', 'stored thumbnails are served');
  ok((await fetch(BASE + hostView.body.images[1].thumbUrl.replace(/sig=[^&]+/, 'sig=forged'))).status === 404, 'image URLs cannot be forged');

  section('Matching states: unrelated → new question; look-alike → asks the user');
  const unrelated = await C.submit(code, 'eiffel-1.jpg', 'Paris');
  ok(unrelated.body.outcome === 'NEW_QUESTION' && unrelated.body.question.number === 2, 'an unrelated image creates Question #2');
  const lookalike = await host.submit(code, 'labrador-1.jpg', 'Labrador');
  ok(lookalike.body.outcome === 'POSSIBLE_MATCH' && lookalike.body.candidate.number === 1, `a look-alike is flagged as uncertain (similarity ${lookalike.body.similarity?.toFixed(3)}) and the user is asked`);
  const separate = await host.post(`/api/submissions/${lookalike.body.submissionId}/resolve`, { action: 'CREATE_NEW' });
  ok(separate.body.outcome === 'NEW_QUESTION' && separate.body.question.number === 3, '"No, create new question" creates Question #3');

  section('Host resolves the challenge');
  const resolved = await host.post(`/api/challenges/${ch.id}/resolve`, { outcome: 'BOTH_VALID', note: 'Hard to tell from a photo' });
  ok(resolved.body.status === 'RESOLVED' && resolved.body.challenges[0].resolution === 'BOTH_VALID', 'challenge RESOLVED: both considered valid');
  await A.waitFor(() => A.notifications.find((x) => x.type === 'CHALLENGE_RESOLVED'), 'resolution notification');
  ok(true, 'participants were notified of the resolution');
  ok(resolved.body.answers.map((a: any) => a.raw).includes('Labrador'), 'resolving did not alter any answer');

  section('Security and resilience');
  ok((await http('GET', `/api/sessions/${code}`)).status === 401, 'no token → 401');
  ok((await http('GET', `/api/sessions/${code}`, { token: 'x'.repeat(43) })).status === 401, 'unknown token → 401');
  ok((await http('POST', '/api/sessions/ZZZZ99/join', { json: { displayName: 'x' } })).status === 404, 'invalid session code → 404');
  const other = await http('POST', '/api/sessions', { json: { name: 'Other', hostName: 'Mallory' } });
  ok((await http('GET', `/api/sessions/${code}`, { token: other.body.token })).status === 403, "another session's token cannot open this session");
  ok((await http('GET', `/api/questions/${q1}`, { token: other.body.token })).status === 404, "another session's token cannot read this session's questions");
  const bad = new FormData();
  bad.set('image', new Blob(['<?php system($_GET["c"]); ?>'], { type: 'image/jpeg' }), 'shell.jpg');
  bad.set('answer', 'x');
  ok((await http('POST', `/api/sessions/${code}/submissions`, { token: A.token, form: bad })).status === 415, 'a non-image upload disguised as JPEG is rejected');
  const stateAgain = await B.get(`/api/sessions/${code}`);
  ok(stateAgain.status === 200 && stateAgain.body.me.displayName === 'User B' && stateAgain.body.session.status === 'ACTIVE', 'after a "refresh" the same token restores User B\'s session');

  section('Chat: public to everyone, private to exactly two people');
  const chatSeen = new Map<string, any[]>(everyone.map((u) => [u.name, []]));
  everyone.forEach((u) => u.socket.on('chat:message', (m) => chatSeen.get(u.name)!.push(m)));
  const ids = Object.fromEntries((await host.get(`/api/sessions/${code}`)).body.participants.map((p: any) => [p.displayName, p.id]));
  ok((await A.post(`/api/sessions/${code}/chat/messages`, { to: 'public', text: 'hello everyone' })).status === 200, 'User A sent a public message');
  for (const u of everyone) await u.waitFor(() => chatSeen.get(u.name)!.find((m) => m.text === 'hello everyone'), 'public chat message');
  ok(true, 'all four users received the public message in real time');
  const secret = `private-${Date.now()}`;
  ok((await A.post(`/api/sessions/${code}/chat/messages`, { to: ids['User B'], text: secret })).status === 200, 'User A sent a private message to User B');
  await B.waitFor(() => chatSeen.get('User B')!.find((m) => m.text === secret), 'private chat message');
  ok(true, 'User B received the private message in real time');
  await new Promise((r) => setTimeout(r, 700));
  ok(!chatSeen.get('User C')!.some((m) => m.text === secret) && !chatSeen.get('Host')!.some((m) => m.text === secret), 'User C and the host did not receive it');
  const asB = await B.get(`/api/sessions/${code}/chat/messages?with=${ids['User A']}`);
  ok(asB.body.items.some((m: any) => m.text === secret), 'User B can read the private conversation');
  for (const [u, peer] of [[C, 'User A'], [C, 'User B'], [host, 'User A'], [host, 'User B']] as const) {
    const r = await u.get(`/api/sessions/${code}/chat/messages?with=${ids[peer]}`);
    ok(r.status === 200 && !JSON.stringify(r.body).includes(secret), `${u.name} asking for the chat with ${peer} does not get it`);
  }
  ok(!JSON.stringify((await host.get(`/api/sessions/${code}/dashboard`)).body).includes(secret), 'the private message is not in the host dashboard');
  ok((await B.get(`/api/sessions/${code}/chat`)).body.direct.find((d: any) => d.participantId === ids['User A'])?.unread === 1, 'User B has 1 unread private message');
  ok((await http('GET', `/api/sessions/${code}/chat/messages`, { token: other.body.token })).status === 403, "another session's token cannot read this session's chat");

  section('Public session list and "ask to join"');
  const sessionId: string = created.body.session.id;
  const listing = await http('GET', '/api/sessions');
  const listed = listing.body.items.find((s: any) => s.id === sessionId);
  ok(listing.status === 200 && listed?.hostName === 'Host' && listed.status === 'ACTIVE', 'the session appears in the public list');
  ok(!JSON.stringify(listing.body).includes(code), 'the public list does not reveal session codes');
  const asked = await http('POST', `/api/sessions/${sessionId}/join-requests`, { json: { displayName: 'Visitor' } });
  ok(asked.status === 200 && asked.body.token, 'a visitor asked to join');
  ok((await http('GET', `/api/sessions/${code}`, { token: asked.body.token })).status === 401, 'the visitor cannot enter before being admitted');
  const waitingStatus = await http('GET', '/api/join-requests/me', { token: asked.body.token });
  ok(waitingStatus.body.status === 'PENDING' && waitingStatus.body.code === null, 'the visitor is pending and has not been given the code');
  const hostNote = await host.waitFor(() => host.notifications.find((n) => n.type === 'JOIN_REQUEST'), 'join request notification');
  ok(hostNote.title === 'Visitor wants to join', 'the host was notified in real time');
  ok(!A.notifications.some((n) => n.type === 'JOIN_REQUEST'), 'participants were not notified');
  ok((await A.get(`/api/sessions/${code}/join-requests`)).status === 403, 'participants cannot see who is waiting');
  const queue = await host.get(`/api/sessions/${code}/join-requests`);
  ok(queue.body.items.length === 1 && queue.body.items[0].displayName === 'Visitor', 'the host sees the visitor waiting');
  ok((await A.post(`/api/join-requests/${queue.body.items[0].id}/decision`, { decision: 'APPROVE' })).status === 403, 'a participant cannot admit');
  ok((await host.post(`/api/join-requests/${queue.body.items[0].id}/decision`, { decision: 'APPROVE' })).status === 200, 'the host admitted the visitor');
  const admitted = await http('GET', '/api/join-requests/me', { token: asked.body.token });
  ok(admitted.body.status === 'APPROVED' && admitted.body.code === code, 'the visitor is approved and receives the code');
  const inside = await http('GET', `/api/sessions/${code}`, { token: asked.body.token });
  ok(inside.status === 200 && inside.body.me.displayName === 'Visitor' && inside.body.me.role === 'PARTICIPANT', 'the same token now opens the session as a participant');
  const refused = await http('POST', `/api/sessions/${sessionId}/join-requests`, { json: { displayName: 'Unwanted' } });
  const queue2 = await host.get(`/api/sessions/${code}/join-requests`);
  await host.post(`/api/join-requests/${queue2.body.items[0].id}/decision`, { decision: 'DECLINE' });
  ok((await http('GET', '/api/join-requests/me', { token: refused.body.token })).body.status === 'DECLINED', 'a declined visitor is told so');
  ok((await http('GET', `/api/sessions/${code}`, { token: refused.body.token })).status === 401, 'and never gets in');

  section('Host controls: remove a participant, approve all joins, live settings, export');
  const visitorId: string = inside.body.me.id;
  ok((await A.post(`/api/sessions/${code}/participants/${visitorId}/remove`)).status === 403, 'a participant cannot remove anyone');
  const removal = await host.post(`/api/sessions/${code}/participants/${visitorId}/remove`);
  ok(removal.status === 200 && !removal.body.participants.some((p: any) => p.id === visitorId), 'the host removed the visitor');
  const afterRemoval = await http('GET', `/api/sessions/${code}`, { token: asked.body.token });
  ok(afterRemoval.status === 403 && afterRemoval.body.error.code === 'REMOVED', 'the removed person is locked out immediately');
  ok((await host.post(`/api/sessions/${code}/participants/${ids['Host']}/remove`)).status === 400, 'the host cannot remove themselves');
  ok((await A.post(`/api/sessions/${code}/settings`, { settings: { chatEnabled: false } })).status === 403, 'a participant cannot change settings');
  const locked = await host.post(`/api/sessions/${code}/settings`, { settings: { approveAllJoins: true } });
  ok(locked.status === 200 && locked.body.session.settings.approveAllJoins === true, 'the host turned on "approve everyone who joins"');
  const direct = await http('POST', `/api/sessions/${code}/join`, { json: { displayName: 'Back again' } });
  ok(direct.status === 409 && direct.body.error.code === 'APPROVAL_REQUIRED', 'the code alone no longer lets anyone in');
  const viaCode = await http('POST', `/api/sessions/${code}/join-requests`, { json: { displayName: 'Back again' } });
  ok(viaCode.status === 200, 'joining with the code now creates a request for the host');
  const queue3 = await host.get(`/api/sessions/${code}/join-requests`);
  ok(queue3.body.items.some((i: any) => i.displayName === 'Back again'), 'the host sees that request');
  const exported = await fetch(`${BASE}/api/sessions/${code}/export`, { headers: { Authorization: `Bearer ${host.token}` } });
  const csv = await exported.text();
  ok(exported.status === 200 && exported.headers.get('content-type')!.startsWith('text/csv') && csv.includes('Golden Retriever') && csv.includes('User B,Labrador'), 'the host can export all answers as CSV');
  ok((await fetch(`${BASE}/api/sessions/${code}/export`, { headers: { Authorization: `Bearer ${A.token}` } })).status === 403, 'participants cannot export');

  everyone.forEach((u) => u.socket.close());
  console.log(`\nAll acceptance checks passed against ${BASE} (session ${code}).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  },
);
