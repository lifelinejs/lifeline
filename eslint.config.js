// ESLint flat config (the modern format; no .eslintrc file).
// "js.configs.recommended" is ESLint's own recommended rule set.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // Files/directories ESLint should never look at.
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module', // ESM: we use import/export
      // Names Node gives us for free, like `process` and `console`.
      globals: globals.node,
    },
    rules: {
      // Allow unused arguments that start with an underscore, like `_index`.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
