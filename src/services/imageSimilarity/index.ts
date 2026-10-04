import type { AppConfig } from '@/lib/config';
import { ClipEmbedder } from './clipEmbedder';
import type { ImageEmbedder } from './types';

export * from './types';
export { classifyMatch } from './matcher';
export { ClipEmbedder } from './clipEmbedder';
export { PgVectorImageSimilarityService } from './pgvectorSimilarityService';

/** Embedder registry: add SigLIP / DINOv2 / a hosted API here. */
const EMBEDDERS: Record<string, (c: AppConfig['similarity']) => ImageEmbedder> = {
  clip: (c) => new ClipEmbedder({ modelId: c.modelId, dtype: c.dtype, cacheDir: c.cacheDir, timeoutMs: c.timeoutMs }),
};

export function createEmbedder(config: AppConfig['similarity']): ImageEmbedder {
  const factory = EMBEDDERS[config.provider];
  if (!factory) throw new Error(`Unknown SIMILARITY_PROVIDER "${config.provider}"`);
  return factory(config);
}
