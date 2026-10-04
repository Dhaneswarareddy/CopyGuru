/** Pre-downloads the embedding model (used at Docker build time so the first
 *  upload in production does not wait for a download). */
import { loadConfig } from '../src/lib/config';
import { createEmbedder } from '../src/services/imageSimilarity';

const config = loadConfig();
const embedder = createEmbedder(config.similarity) as { warmup?: () => Promise<unknown>; modelId: string };
await embedder.warmup?.();
console.log(`model ready: ${embedder.modelId} (cache: ${config.similarity.cacheDir})`);
