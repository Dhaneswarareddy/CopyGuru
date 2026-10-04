export interface AnswerMatchResult {
  equivalent: boolean;
  /** 1 = identical after normalisation, 0 = different. Room for fuzzy scores. */
  score: number;
  method: string;
}

/** Swap in an embedding/LLM-based matcher later without touching callers. */
export interface AnswerMatchingService {
  normalize(answer: string): string;
  compare(answerA: string, answerB: string): AnswerMatchResult;
}

const LEADING_ARTICLE = /^(a|an|the)\s+(?=\S)/;

/**
 * Rule-based normalisation: Unicode-normalise, lowercase, strip accents and
 * punctuation, collapse whitespace, drop a leading article.
 * "Paris", " paris ", "PARIS", "Paris!" → "paris"
 */
export class DefaultAnswerMatchingService implements AnswerMatchingService {
  normalize(answer: string): string {
    const cleaned = answer
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '') // combining accents
      .toLowerCase()
      .replace(/[‘’'`]/g, '') // apostrophes vanish: "don't" → "dont"
      .replace(/[^\p{L}\p{N}]+/gu, ' ') // other punctuation becomes a space
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.replace(LEADING_ARTICLE, '') || cleaned;
  }

  compare(answerA: string, answerB: string): AnswerMatchResult {
    const equivalent = this.normalize(answerA) === this.normalize(answerB);
    return { equivalent, score: equivalent ? 1 : 0, method: 'normalized-exact' };
  }
}
