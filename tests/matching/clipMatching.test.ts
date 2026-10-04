import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { ClipEmbedder, classifyMatch, createEmbedder } from '@/services/imageSimilarity';
import { createHarness, createRoom, type Harness } from '../helpers/harness';

/**
 * These tests run the REAL vision model (CLIP ViT-B/32 via ONNX) on real
 * photographs from Wikimedia Commons (tests/fixtures/images/ATTRIBUTION.json).
 * No stubs: this is the evidence that different photos of the same content are
 * grouped while unrelated or merely look-alike content is not auto-grouped.
 * The first run downloads the model (~90 MB) into .cache/models.
 */
const config = loadConfig();
const T = config.similarity;
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'images', `${name}.jpg`));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

let embedder: ClipEmbedder;
const cache = new Map<string, number[]>();
const embed = async (key: string, image: Buffer = fixture(key)) => {
  if (!cache.has(key)) cache.set(key, await embedder.embed(image));
  return cache.get(key)!;
};
const sim = async (a: string, b: string) => dot(await embed(a), await embed(b));
const decide = (similarity: number) => classifyMatch([{ questionId: 'q', imageId: 'i', similarity }], T).decision;

beforeAll(async () => {
  embedder = createEmbedder(config.similarity) as ClipEmbedder;
  await embedder.warmup();
});

describe('CLIP embeddings', () => {
  it('produces unit-length 512-d vectors', async () => {
    const v = await embed('golden-1');
    expect(v).toHaveLength(512);
    expect(Math.hypot(...v)).toBeCloseTo(1, 4);
  });

  it('identical image → HIGH match (also after re-encoding to another format and size)', async () => {
    expect(await sim('golden-1', 'golden-1')).toBeCloseTo(1, 4);
    const png = await sharp(fixture('golden-1')).resize(300).png().toBuffer();
    const s = dot(await embed('golden-1'), await embed('golden-1-png', png));
    expect(s).toBeGreaterThan(0.9);
    expect(decide(s)).toBe('HIGH_MATCH');
  });

  it('a DIFFERENT photo of the same subject → HIGH match', async () => {
    // three separate photographs of a golden retriever; no shared pixels
    for (const [a, b] of [['golden-1', 'golden-2'], ['golden-1', 'golden-3'], ['golden-2', 'golden-3']]) {
      const s = await sim(a, b);
      expect(s, `${a} vs ${b}`).toBeGreaterThanOrEqual(T.highThreshold);
      expect(decide(s)).toBe('HIGH_MATCH');
    }
    expect(decide(await sim('bridge-1', 'bridge-2'))).toBe('HIGH_MATCH');
  });

  it('cropped image → HIGH match', async () => {
    const m = await sharp(fixture('golden-1')).metadata();
    const crop = await sharp(fixture('golden-1'))
      .extract({ left: Math.round(m.width! * 0.15), top: Math.round(m.height! * 0.1), width: Math.round(m.width! * 0.7), height: Math.round(m.height! * 0.75) })
      .jpeg()
      .toBuffer();
    expect(decide(dot(await embed('golden-1'), await embed('golden-1-crop', crop)))).toBe('HIGH_MATCH');
  });

  it('different angle (mirrored and tilted) → HIGH match', async () => {
    const tilted = await sharp(fixture('golden-1')).flop().rotate(8, { background: '#888' }).jpeg().toBuffer();
    expect(decide(dot(await embed('golden-1'), await embed('golden-1-tilt', tilted)))).toBe('HIGH_MATCH');
  });

  it('different lighting (darker, brighter, colour-shifted) → HIGH match', async () => {
    const variants: Record<string, Buffer> = {
      dark: await sharp(fixture('golden-1')).modulate({ brightness: 0.6 }).jpeg().toBuffer(),
      bright: await sharp(fixture('golden-1')).modulate({ brightness: 1.35, saturation: 0.8 }).jpeg().toBuffer(),
      warm: await sharp(fixture('golden-1')).tint({ r: 255, g: 225, b: 190 }).jpeg().toBuffer(),
    };
    for (const [name, buf] of Object.entries(variants)) {
      const s = dot(await embed('golden-1'), await embed(`golden-1-${name}`, buf));
      expect(decide(s), `${name} (${s.toFixed(3)})`).toBe('HIGH_MATCH');
    }
  });

  it('unrelated images → NO match', async () => {
    const pairs = [
      ['golden-1', 'eiffel-1'], ['golden-1', 'apple-1'], ['golden-1', 'bridge-1'], ['golden-1', 'skeleton-1'],
      ['eiffel-1', 'apple-1'], ['bridge-1', 'cat-1'], ['apple-1', 'cat-1'], ['eiffel-3', 'tomato-1'],
    ];
    for (const [a, b] of pairs) {
      const s = await sim(a, b);
      expect(s, `${a} vs ${b}`).toBeLessThan(T.possibleThreshold);
      expect(decide(s)).toBe('NO_MATCH');
    }
  });

  it('ambiguous look-alikes → UNCERTAIN, never auto-grouped', async () => {
    // a labrador is not a golden retriever, a tomato is not an apple, a puppy
    // is not obviously the same dog: the system must ask instead of guessing
    for (const [a, b] of [['golden-1', 'labrador-1'], ['golden-1', 'labrador-2'], ['apple-1', 'tomato-1'], ['golden-1', 'golden-puppy']]) {
      const s = await sim(a, b);
      expect(decide(s), `${a} vs ${b} (${s.toFixed(3)})`).toBe('POSSIBLE_MATCH');
    }
  });

  it('never auto-groups any pair of fixtures showing different subjects', async () => {
    const subjects: Record<string, string[]> = {
      golden: ['golden-1', 'golden-2', 'golden-3'],
      labrador: ['labrador-1', 'labrador-2', 'labrador-3'],
      eiffel: ['eiffel-1', 'eiffel-2', 'eiffel-3', 'eiffel-4'],
      apple: ['apple-1', 'apple-2'],
      other: ['tomato-1', 'cat-1', 'cat-2', 'bridge-1', 'skeleton-1'],
    };
    const all = Object.entries(subjects).flatMap(([s, files]) => files.map((f) => [s, f] as const));
    let worst = { pair: '', s: 0 };
    for (const [sa, a] of all)
      for (const [sb, b] of all) {
        if (a >= b || (sa === sb && sa !== 'other')) continue;
        const s = await sim(a, b);
        if (s > worst.s) worst = { pair: `${a} vs ${b}`, s };
      }
    expect(worst.s, `closest different-subject pair: ${worst.pair}`).toBeLessThan(T.highThreshold);
  });
});

describe('end-to-end grouping with the real model and pgvector', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ embedder });
  });
  afterAll(() => h.close());

  it('groups different photos of the same content, asks about look-alikes, separates the rest', async () => {
    const room = await createRoom(h);
    const post = (who: 'host' | 'a' | 'b' | 'c', file: string, answer: string) =>
      h.c.submissions.submit(room.session, room[who], { image: fixture(file), answer });

    const first = await post('a', 'golden-1', 'Golden Retriever');
    expect(first.outcome).toBe('NEW_QUESTION');

    const second = await post('b', 'golden-2', 'Labrador'); // a different photograph
    expect(second.outcome).toBe('MATCHED');
    if (second.outcome !== 'MATCHED' || first.outcome !== 'NEW_QUESTION') return;
    expect(second.question.id).toBe(first.question.id);
    expect(second.similarity).toBeGreaterThanOrEqual(T.highThreshold);
    expect(second.prompt.previousAnswer?.raw).toBe('Golden Retriever');

    const unrelated = await post('c', 'eiffel-1', 'Paris');
    expect(unrelated.outcome).toBe('NEW_QUESTION');

    const lookalike = await post('c', 'labrador-1', 'Labrador');
    expect(lookalike.outcome).toBe('POSSIBLE_MATCH');
    if (lookalike.outcome === 'POSSIBLE_MATCH') expect(lookalike.candidate.id).toBe(first.question.id);

    const third = await post('host', 'golden-3', 'Golden retriever');
    expect(third.outcome).toBe('MATCHED');

    const list = await h.c.questions.list(room.session, room.host, { sort: 'MOST_ANSWERS' });
    expect(list.total).toBe(2);
    expect(list.items[0]).toMatchObject({ number: 1, answerCount: 3, imageCount: 3 });
    // embeddings are stored in pgvector with the model that produced them
    const stored = await h.c.db.query<{ dims: number; embeddingModel: string }>(
      'SELECT vector_dims(embedding) AS dims, embedding_model FROM question_images WHERE embedding IS NOT NULL',
    );
    expect(stored).toHaveLength(5);
    expect(stored.every((r) => r.dims === 512 && r.embeddingModel === 'Xenova/clip-vit-base-patch32:q8')).toBe(true);
  });
});
