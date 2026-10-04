import type { ImageRow, QuestionRow } from '@/lib/domain/types';

/**
 * Chooses the image that represents a question group. Today: the first image
 * submitted. Replace with "most central embedding", "highest quality",
 * host-selected or AI-selected strategies without touching callers.
 */
export interface RepresentativeImageStrategy {
  /** Returns the image id to use, or null to keep the current one. */
  select(question: QuestionRow, newImage: Pick<ImageRow, 'id'>): string | null;
}

export const firstSubmittedStrategy: RepresentativeImageStrategy = {
  select: (question, newImage) => (question.representativeImageId ? null : newImage.id),
};
