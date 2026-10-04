/**
 * Prints the pairwise similarity of every image in a folder using the
 * configured embedding model, with the decision the current thresholds would
 * make. Use it to tune SIMILARITY_HIGH_THRESHOLD / SIMILARITY_POSSIBLE_THRESHOLD
 * for your own kind of content, or to evaluate another model.
 *
 *   npm run calibrate                       # the bundled fixtures
 *   npm run calibrate -- ./my-photos
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/config';
import { classifyMatch, createEmbedder } from '../src/services/imageSimilarity';

const dir = process.argv[2] ?? path.join(import.meta.dirname, '..', 'tests', 'fixtures', 'images');
const config = loadConfig();
const embedder = createEmbedder(config.similarity);
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f)).sort();
if (files.length < 2) throw new Error(`Need at least two images in ${dir}`);

const vectors = new Map<string, number[]>();
for (const f of files) vectors.set(f, await embedder.embed(fs.readFileSync(path.join(dir, f))));

const pairs: { a: string; b: string; s: number }[] = [];
for (let i = 0; i < files.length; i++)
  for (let j = i + 1; j < files.length; j++) {
    const [a, b] = [vectors.get(files[i])!, vectors.get(files[j])!];
    pairs.push({ a: files[i], b: files[j], s: a.reduce((sum, x, k) => sum + x * b[k], 0) });
  }
pairs.sort((x, y) => y.s - x.s);

console.log(`model ${embedder.modelId} · high ≥ ${config.similarity.highThreshold} · possible ≥ ${config.similarity.possibleThreshold}\n`);
for (const p of pairs) {
  const decision = classifyMatch([{ questionId: '', imageId: '', similarity: p.s }], config.similarity).decision;
  console.log(`${p.s.toFixed(3)}  ${decision.padEnd(14)}  ${p.a}  ~  ${p.b}`);
}
