import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const HEX_COLOR = '/#(?:[0-9a-fA-F]{3}){1,2}(?:[0-9a-fA-F]{2})?\\b/';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/generated/**', '**/coverage/**', '**/node_modules/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Flags plain option objects passed to framework factories (NestFactory.create); no safety value here.
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
    },
  },
  {
    // Tenant isolation: only packages/db may talk to PostgreSQL directly (ADR-0003 §3).
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'pg', message: 'Import database access from @runvara/db (withTenant/withUser/withAnonymous).' }] },
      ],
    },
  },
  {
    // Design tokens are the only colour source (CLAUDE.md, §12.5).
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts', 'packages/ui/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${HEX_COLOR}]`, message: 'Hard-coded colours are forbidden; use tokens (var(--…)).' },
        { selector: `TemplateElement[value.raw=${HEX_COLOR}]`, message: 'Hard-coded colours are forbidden; use tokens (var(--…)).' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.int.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
