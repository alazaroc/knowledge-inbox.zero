// Task 2.9 — Example/edge unit tests (plain Jest, no fast-check) for the
// recommendation state-mapping boundaries and the profile/library Zod bounds.
//
// These complement the fast-check property tests (scoring.property.test.ts) with
// explicit boundary examples that pin the exact thresholds and limits.
//
// Requirements: 6.1 (single recommendation state / thresholds), 1.5 (context
// <=5000 chars), 1.8 (<=100 entries, <=200 chars/entry), 7.5 (invalid state
// filter rejected), 1.7 (trimming drops empty entries).

import {
  scoresToRecommendationState,
  profileSchema,
  libraryQuerySchema,
  type Scores,
} from '@app/shared';

// A fixed clock keeps freshness-derived tags deterministic; the state routing
// under test depends only on `mkv` and `redundancy`, not on `now`.
const NOW = new Date('2024-01-01T00:00:00Z');

// Build a Scores object with an explicit mkv and (optionally) redundancy so we
// can land precisely on the mapping boundaries.
function scoresWith(mkv: number, redundancy = 0): Scores {
  return { relevance: 0, novelty: 0, redundancy, freshness: 50, mkv };
}

function stateFor(mkv: number, redundancy = 0) {
  return scoresToRecommendationState(scoresWith(mkv, redundancy), {
    isExactPriorDuplicate: false,
    now: NOW,
  }).state;
}

// ===========================================================================
// State-mapping boundaries (Req 6.1)
// ===========================================================================

describe('scoresToRecommendationState — mkv thresholds (Req 6.1)', () => {
  // Lower boundary: mkv < 34 => SKIP, otherwise SKIM.
  it('mkv exactly 34 maps to SKIM', () => {
    expect(stateFor(34)).toBe('SKIM');
  });

  it('mkv 33 maps to SKIP', () => {
    expect(stateFor(33)).toBe('SKIP');
  });

  // Upper boundary: mkv < 67 => SKIM, otherwise READ.
  it('mkv exactly 67 maps to READ', () => {
    expect(stateFor(67)).toBe('READ');
  });

  it('mkv 66 maps to SKIM', () => {
    expect(stateFor(66)).toBe('SKIM');
  });

  it('mkv 0 maps to SKIP and mkv 100 maps to READ', () => {
    expect(stateFor(0)).toBe('SKIP');
    expect(stateFor(100)).toBe('READ');
  });
});

describe('scoresToRecommendationState — fully redundant (Req 6.1)', () => {
  it('redundancy >= 80 forces SKIP even when mkv would otherwise be READ', () => {
    // mkv 100 would normally be READ, but a fully-redundant doc must SKIP.
    const result = scoresToRecommendationState(scoresWith(100, 80), {
      isExactPriorDuplicate: false,
      now: NOW,
    });
    expect(result.state).toBe('SKIP');
    expect(result.tags).toContain('REDUNDANT');
  });

  it('redundancy 79 does not force SKIP at a READ-level mkv', () => {
    expect(stateFor(67, 79)).toBe('READ');
  });

  it('redundancy exactly 80 forces SKIP at a SKIM-level mkv too', () => {
    expect(stateFor(50, 80)).toBe('SKIP');
  });
});

// ===========================================================================
// profileSchema bounds
// ===========================================================================

describe('profileSchema — context length (Req 1.5)', () => {
  it('accepts a context of exactly 2000 characters', () => {
    const result = profileSchema.safeParse({ context: 'a'.repeat(2000) });
    expect(result.success).toBe(true);
  });

  it('rejects a context of 2001 characters', () => {
    const result = profileSchema.safeParse({ context: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });
});

describe('profileSchema — list entry count (Req 1.8)', () => {
  it('accepts a list with exactly 50 entries', () => {
    const highInterests = Array.from({ length: 50 }, (_, i) => `topic-${i}`);
    const result = profileSchema.safeParse({ highInterests });
    expect(result.success).toBe(true);
  });

  it('rejects a list with 51 entries', () => {
    const highInterests = Array.from({ length: 51 }, (_, i) => `topic-${i}`);
    const result = profileSchema.safeParse({ highInterests });
    expect(result.success).toBe(false);
  });
});

describe('profileSchema — list entry length (Req 1.8)', () => {
  it('accepts an entry of exactly 200 characters', () => {
    const result = profileSchema.safeParse({ highInterests: ['x'.repeat(200)] });
    expect(result.success).toBe(true);
  });

  it('rejects an entry of 201 characters', () => {
    const result = profileSchema.safeParse({ highInterests: ['x'.repeat(201)] });
    expect(result.success).toBe(false);
  });
});

describe('profileSchema — trimming drops empty entries (Req 1.7)', () => {
  it('trims entries and removes blank/whitespace-only ones', () => {
    const result = profileSchema.safeParse({
      highInterests: ['  ai  ', '', '   ', '\t\n', 'ml'],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.highInterests).toEqual(['ai', 'ml']);
  });

  it('an all-blank list collapses to an empty list (still valid)', () => {
    const result = profileSchema.safeParse({ highInterests: ['', '  ', '\n'] });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.highInterests).toEqual([]);
  });

  it('trimming lets a padded 200-char entry stay within bounds', () => {
    // The 200 content chars are padded with whitespace; trimming must bring it
    // back under the 200-char cap rather than rejecting it.
    const padded = `  ${'y'.repeat(200)}  `;
    const result = profileSchema.safeParse({ highInterests: [padded] });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.highInterests[0]).toBe('y'.repeat(200));
  });
});

// ===========================================================================
// libraryQuerySchema state filter (Req 7.5)
// ===========================================================================

describe('libraryQuerySchema — state filter (Req 7.5)', () => {
  it.each(['READ', 'SKIM', 'SKIP'] as const)('accepts the valid state %s', (state) => {
    const result = libraryQuerySchema.safeParse({ state });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.state).toBe(state);
  });

  it('rejects an invalid state value', () => {
    const result = libraryQuerySchema.safeParse({ state: 'FOO' });
    expect(result.success).toBe(false);
  });

  it('accepts an omitted state (optional filter)', () => {
    const result = libraryQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
