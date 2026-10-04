import { describe, expect, it } from 'vitest';
import { DefaultAnswerMatchingService } from '@/services/answerMatching';
import { computeConsensus, consensusLevel } from '@/services/consensus/consensus';

const m = new DefaultAnswerMatchingService();
const T = { high: 75, moderate: 50, low: 25 };

describe('answer normalization', () => {
  it('treats case, whitespace and punctuation variants as equivalent', () => {
    for (const v of ['Paris', ' paris ', 'PARIS', 'Paris!', 'paris.', '  PaRiS?!  '])
      expect(m.normalize(v)).toBe('paris');
  });
  it('collapses inner whitespace and punctuation', () => {
    expect(m.normalize('Golden   Retriever')).toBe('golden retriever');
    expect(m.normalize('golden-retriever')).toBe('golden retriever');
  });
  it('folds accents and drops a leading article', () => {
    expect(m.normalize('Café')).toBe('cafe');
    expect(m.normalize('The Eiffel Tower')).toBe('eiffel tower');
    expect(m.normalize('A dog')).toBe('dog');
    expect(m.normalize("it's")).toBe('its');
  });
  it('does not reduce an answer that is only an article to nothing', () => {
    expect(m.normalize('A')).toBe('a');
  });
  it('keeps non-latin text', () => {
    expect(m.normalize(' 東京 ')).toBe('東京');
  });
  it('does not merge genuinely different answers', () => {
    expect(m.compare('Labrador', 'Golden Retriever').equivalent).toBe(false);
    expect(m.compare('Paris', 'paris!').equivalent).toBe(true);
    expect(m.compare('12', '1 2').equivalent).toBe(false);
  });
});

const ans = (raw: string, effective = m.normalize(raw)) => ({
  rawAnswer: raw,
  normalizedAnswer: m.normalize(raw),
  effectiveNormalized: effective,
});

describe('consensus', () => {
  it('uses the configured thresholds', () => {
    expect(consensusLevel(75, T)).toBe('HIGH_AGREEMENT');
    expect(consensusLevel(74, T)).toBe('MODERATE_AGREEMENT');
    expect(consensusLevel(50, T)).toBe('MODERATE_AGREEMENT');
    expect(consensusLevel(49, T)).toBe('LOW_AGREEMENT');
    expect(consensusLevel(25, T)).toBe('LOW_AGREEMENT');
    expect(consensusLevel(24, T)).toBe('HIGH_DISAGREEMENT');
    expect(consensusLevel(null, T)).toBe('NONE');
    expect(consensusLevel(60, { high: 60, moderate: 40, low: 10 })).toBe('HIGH_AGREEMENT');
  });

  it('computes the share of the most common answer', () => {
    const c = computeConsensus(
      [...Array(7).fill('Golden Retriever'), 'Labrador', 'labrador!', 'German Shepherd'].map((r) => ans(r)),
      m,
      T,
    );
    expect(c.total).toBe(10);
    expect(c.pct).toBe(70);
    expect(c.level).toBe('MODERATE_AGREEMENT');
    expect(c.groups.map((g) => [g.label, g.count])).toEqual([
      ['Golden Retriever', 7],
      ['Labrador', 2],
      ['German Shepherd', 1],
    ]);
  });

  it('reports 50% for an even split and nothing for no answers', () => {
    expect(computeConsensus(['Apple', 'apple', 'Orange', 'orange'].map((r) => ans(r)), m, T).pct).toBe(50);
    const empty = computeConsensus([], m, T);
    expect(empty.pct).toBeNull();
    expect(empty.level).toBe('NONE');
  });

  it('counts an "agrees" answer for the endorsed answer while keeping the label of what was typed', () => {
    const c = computeConsensus([ans('Golden Retriever'), ans('Labrador', 'golden retriever')], m, T);
    expect(c.pct).toBe(100);
    expect(c.groups).toHaveLength(1);
    expect(c.groups[0].label).toBe('Golden Retriever');
  });
});
