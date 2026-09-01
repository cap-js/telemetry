import cds from '@sap/cds/eslint.config.mjs'
export default [
  ...cds.recommended,
  {
    // The cds eslint config declares jest/mocha test globals but not vitest's `vi`.
    files: ['**/+(test|tests)/**/*.+(js|cjs|mjs)', '**/*.test.+(js|cjs|mjs)', '**/*-test.+(js|cjs|mjs)'],
    languageOptions: {
      globals: {
        vi: 'readonly'
      }
    }
  }
]
