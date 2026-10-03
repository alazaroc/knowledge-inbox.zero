import type { RecommendationState } from './constants.js';

// User-facing LABELS for the recommendation states. The internal values
// (READ / SKIM / SKIP) are the single source of truth for data, counters, the
// GSI and scoring — they are NEVER renamed. This is the one place the UI maps
// an internal state to the words the user reads, so the strings are not
// repeated across pages.
export const RECOMMENDATION_LABEL: Record<RecommendationState, string> = {
  READ: 'Worth it',
  SKIM: 'Maybe',
  SKIP: 'Skip',
};

// Convenience: the visible label for an internal state (falls back to the raw
// value if an unexpected state ever appears).
export function recommendationLabel(state: RecommendationState | string | undefined): string {
  if (!state) return '';
  return RECOMMENDATION_LABEL[state as RecommendationState] ?? state;
}
