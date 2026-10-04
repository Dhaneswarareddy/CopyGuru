import sharp from 'sharp';
import { loadConfig, type AppConfig } from '@/lib/config';
import { createContainer, type Container } from '@/lib/container';
import { createDb, type Db } from '@/lib/database/client';
import type { ParticipantRow, SessionRow } from '@/lib/domain/types';
import type { RealtimeGateway } from '@/lib/realtime/gateway';
import { SimilarityUnavailableError, type ImageEmbedder } from '@/services/imageSimilarity';
import type { StorageService, StoredObject } from '@/services/storage';

/**
 * Deterministic stand-in for the vision model, used ONLY to test application
 * logic (grouping, challenges, permissions) quickly. The real CLIP model is
 * exercised in tests/matching and by the end-to-end script.
 *
 * It reads the picture's mean colour: red selects a "concept" axis, green
 * rotates the vector away from it, so cosine similarity to the base picture of
 * the same concept is cos(green/255 · π/2).
 */
export class FakeEmbedder implements ImageEmbedder {
  readonly modelId = 'fake-color-embedder';
  readonly dimensions = 512;
  fail = false;
  calls = 0;
  async embed(image: Buffer): Promise<number[]> {
    this.calls++;
    if (this.fail) throw new SimilarityUnavailableError('model offline (test)');
    const { data } = await sharp(image).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    const concept = Math.round(data[0] / 20);
    const theta = (data[1] / 255) * (Math.PI / 2);
    const v = new Array<number>(512).fill(0);
    v[concept] = Math.cos(theta);
    v[256 + concept] = Math.sin(theta);
    return v;
  }
}

/** Solid-colour test picture. `variation` 0 = base; larger = less similar. */
export function picture(concept: number, variation: 'same' | 'high' | 'possible' | 'far' = 'same'): Promise<Buffer> {
  const g = { same: 0, high: 40, possible: 120, far: 230 }[variation];
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: concept * 20, g, b: 128 } } })
    .png()
    .toBuffer();
}

export class MemoryStorage implements StorageService {
  objects = new Map<string, StoredObject>();
  async put(key: string, data: Buffer, mime: string) {
    this.objects.set(key, { data, mime });
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export class RecordingGateway implements RealtimeGateway {
  sessionEvents: { sessionId: string; event: string; data: any }[] = [];
  participantEvents: { participantId: string; event: string; data: any }[] = [];
  emitToSession(sessionId: string, event: string, data: unknown) {
    this.sessionEvents.push({ sessionId, event, data });
  }
  emitToParticipant(participantId: string, event: string, data: unknown) {
    this.participantEvents.push({ participantId, event, data });
  }
  disconnected: string[] = [];
  disconnectParticipant(participantId: string) {
    this.disconnected.push(participantId);
  }
  /** Participant ids to report as connected (tests set this directly). */
  online: string[] = [];
  onlineParticipantIds() {
    return this.online;
  }
  notificationsFor(participantId: string) {
    return this.participantEvents.filter((e) => e.participantId === participantId).map((e) => e.data);
  }
}

export interface Harness {
  c: Container;
  embedder: FakeEmbedder;
  storage: MemoryStorage;
  gateway: RecordingGateway;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Embedded Postgres (PGlite) by default. Set TEST_DATABASE_URL to a real
 * PostgreSQL server with pgvector to run the same tests there; each harness
 * then gets its own throw-away database.
 */
async function createTestDb(): Promise<Db> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return createDb({ url: null, pgliteDir: 'memory://' });
  const name = `vqa_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const root = await createDb({ url: admin, pgliteDir: '' });
  await root.exec(`CREATE DATABASE ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = await createDb({ url: url.toString(), pgliteDir: '' });
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await root.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.close();
  };
  return db;
}

export async function createHarness(opts: { embedder?: ImageEmbedder; env?: Record<string, string> } = {}): Promise<Harness> {
  const config = loadConfig({ ...process.env, DATABASE_URL: '', NODE_ENV: 'test', ...opts.env } as NodeJS.ProcessEnv);
  const db = await createTestDb();
  const embedder = new FakeEmbedder();
  const storage = new MemoryStorage();
  const gateway = new RecordingGateway();
  const c = await createContainer({ config, db, embedder: opts.embedder ?? embedder, storage, realtime: gateway });
  return { c, embedder, storage, gateway, config, close: () => db.close() };
}

export interface Room {
  session: SessionRow;
  host: ParticipantRow;
  a: ParticipantRow;
  b: ParticipantRow;
  c: ParticipantRow;
  tokens: Record<'host' | 'a' | 'b' | 'c', string>;
}

/** Host + three participants, session started unless told otherwise. */
export async function createRoom(h: Harness, settings: Record<string, unknown> = {}, start = true): Promise<Room> {
  const created = await h.c.sessions.create({ name: 'Test session', hostName: 'Host', settings });
  const join = (name: string) => h.c.sessions.join(created.session.code, { displayName: name });
  const [a, b, c] = [await join('User A'), await join('User B'), await join('User C')];
  const session = start ? await h.c.sessions.start(created.session, created.participant) : created.session;
  return {
    session,
    host: created.participant,
    a: a.participant,
    b: b.participant,
    c: c.participant,
    tokens: { host: created.token, a: a.token, b: b.token, c: c.token },
  };
}

/** Asserts that a promise rejects with an AppError of the given HTTP status. */
export async function expectStatus(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err: any) {
    if (err?.status !== status) throw new Error(`expected status ${status}, got ${err?.status}: ${err?.message}`);
    if (code && err.code !== code) throw new Error(`expected code ${code}, got ${err.code}`);
    return err;
  }
  throw new Error(`expected rejection with status ${status}, but it resolved`);
}
