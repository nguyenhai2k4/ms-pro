import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Repo-wide lint rules.
 *
 * Two rules here are architectural, not stylistic — they encode invariants from CLAUDE.md and
 * the ADRs, and they exist so a violation fails CI instead of surviving code review:
 *
 *  - `no-explicit-any`: CLAUDE.md conventions — no `any` in committed TS.
 *  - the `packages/cpm-engine` purity block: invariant 1 (the engine is pure — no I/O, no clock,
 *    no randomness). Added in P0 while the package is still empty, so it is in force before the
 *    first line of engine code exists.
 *  - the `apps/web` vendor-import block: ADR-001/ADR-006 — the Gantt vendor may only be imported
 *    inside the adapter directory, which is what makes the renderer swappable later.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Invariant 1: the CPM engine is pure. Same input -> byte-identical output.
    files: ['packages/cpm-engine/**/*.ts'],
    ignores: ['packages/cpm-engine/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'cpm-engine is pure (CLAUDE.md invariant 1): no clock reads.' },
        { name: 'fetch', message: 'cpm-engine is pure (CLAUDE.md invariant 1): no network.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'cpm-engine is pure (CLAUDE.md invariant 1): no randomness.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'cpm-engine is pure (CLAUDE.md invariant 1): no clock reads.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'ioredis', 'node:fs', 'node:net', 'node:http', 'fs', 'net', 'http'],
              message: 'cpm-engine is pure (CLAUDE.md invariant 1): no I/O, no DB, no network.',
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-001 / ADR-006: the licensed Gantt component stays behind the adapter.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/gantt/adapter/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bryntum/*', 'dhtmlx-gantt', 'frappe-gantt', '*/gantt/adapter/vendor/*'],
              message:
                'ADR-001/ADR-006: vendor Gantt symbols may only be imported inside apps/web/src/gantt/adapter/. App code talks to packages/shared-types.',
            },
          ],
        },
      ],
    },
  },
);
