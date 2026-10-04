import type { QuestionsRepo } from '@/lib/database/repositories/questions';
import type { ImageEmbedder, ImageSimilarityService, SimilarityMatch } from './types';

/**
 * ImageSimilarityService = pluggable embedder + pgvector cosine search.
 * Search is scoped to one session and aggregated per question group: a group's
 * score is its best-matching member, so groups get easier to hit as they
 * collect more varied photos.
 */
export class PgVectorImageSimilarityService implements ImageSimilarityService {
  constructor(
    private embedder: ImageEmbedder,
    private questions: QuestionsRepo,
    private topK: number,
  ) {}

  get modelId() {
    return this.embedder.modelId;
  }

  generateEmbedding(image: Buffer) {
    return this.embedder.embed(image);
  }

  async findSimilarImages(embedding: number[], sessionId: string): Promise<SimilarityMatch[]> {
    const rows = await this.questions.findNearestImages(sessionId, embedding, this.embedder.modelId, this.topK);
    const bestPerQuestion = new Map<string, SimilarityMatch>();
    for (const r of rows) {
      const similarity = Number(r.similarity);
      const current = bestPerQuestion.get(r.questionId);
      if (!current || similarity > current.similarity)
        bestPerQuestion.set(r.questionId, { questionId: r.questionId, imageId: r.imageId, similarity });
    }
    return [...bestPerQuestion.values()].sort((a, b) => b.similarity - a.similarity);
  }
}
