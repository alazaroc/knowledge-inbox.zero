// Jest config for the backend workspace.
//
// The workspace is ESM ("type": "module") and @app/shared is resolved to its
// TypeScript source. Running the tests through ts-jest's classic CommonJS
// transform (module=commonjs via tsconfig.test.json) keeps the `jest` global
// available without VM-module ESM — otherwise every test file would have to
// `import { jest } from '@jest/globals'`. The shipped Lambda bundles are
// unaffected: they build from tsconfig.json (NodeNext/ESM).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@app/shared$': '<rootDir>/../shared/src/index.ts',
    // Strip the `.js` extension TS emits on relative ESM imports so Jest can
    // resolve the `.ts` source during tests.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: false, tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
