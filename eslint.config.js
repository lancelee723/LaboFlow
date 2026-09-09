// @ts-check
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist/**', '**/dist-electron/**', '**/node_modules/**', '**/release/**'],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-throw-literal': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
];
