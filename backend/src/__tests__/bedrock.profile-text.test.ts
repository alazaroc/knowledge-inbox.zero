import { buildProfileText, MAX_PROFILE_CONTEXT_CHARS } from '../lib/bedrock.js';
import type { Profile } from '@app/shared';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'u1',
    highInterests: [],
    mediumInterests: [],
    currentlyResearching: [],
    alreadyKnown: [],
    avoidContentTypes: [],
    activeContexts: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildProfileText — context cap (block 2c)', () => {
  it('passes a short context through unchanged', () => {
    const text = buildProfileText(profile({ context: 'I am a cloud architect.' }));
    expect(text).toContain('I am a cloud architect.');
    expect(text).not.toContain('[context truncated]');
  });

  it('caps an over-long context at MAX_PROFILE_CONTEXT_CHARS and flags truncation', () => {
    const long = 'x'.repeat(MAX_PROFILE_CONTEXT_CHARS + 500);
    const text = buildProfileText(profile({ context: long }));
    // The emitted context slice is exactly the cap, plus the truncation notice.
    expect(text).toContain('[context truncated]');
    const body = text.replace('About the user:\n', '').replace('\n[context truncated]', '');
    expect(body.length).toBe(MAX_PROFILE_CONTEXT_CHARS);
  });

  it('includes list fields as readable sentences', () => {
    const text = buildProfileText(
      profile({ highInterests: ['serverless', 'bedrock'], alreadyKnown: ['lambda'] })
    );
    expect(text).toContain('High interests: serverless; bedrock.');
    expect(text).toContain('Already known');
  });
});
