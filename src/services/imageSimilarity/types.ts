import type { MatchDecision } from '@/lib/domain/types';

/** One candidate question group, scored by its best-matching image. */
export interface SimilarityMatch {
  questionId: string;
  imageId: string;
  /** Cosine similarity in [-1, 1]; higher is more similar. */
  similarity: number;
}

/**
 * The application depends only on this interface. Swap the model (CLIP,
 * SigLIP, DINOv2, a hosted API…) by providing another implementation.
 */
export interface ImageSimilarityService {
  readonly modelId: string;
  generateEmbedding(image: Buffer): Promise<number[]>;
  /** Searches ONLY within the given session. */
  findSimilarImages(embedding: number[], sessionId: string): Promise<SimilarityMatch[]>;
}

/** Turns pixels into a unit-length vector. The pluggable "AI" part. */
export interface ImageEmbedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(image: Buffer): Promise<number[]>;
}

export interface MatchVerdict {
  decision: Exclude<MatchDecision, 'UNKNOWN'>;
  best: SimilarityMatch | null;
}

export class SimilarityUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SimilarityUnavailableError';
  }
}
