import js from '@eslint/js';
import pluginImport from 'eslint-plugin-import';
import eslintConfigPrettier from 'eslint-config-prettier';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  Event: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  js.configs.recommended,
  {
    files: ['extension/**/*.{js,mjs}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2021,
      globals: {
        ...browserGlobals,
        chrome: 'readonly'
      }
    },
    plugins: {
      import: pluginImport
    },
    rules: {
      ...pluginImport.configs.recommended.rules,
      'no-console': ['warn', { allow: ['info', 'warn', 'error', 'debug'] }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  },
  eslintConfigPrettier
];
