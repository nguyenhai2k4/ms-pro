import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance (f) — purity, checked independently of the linter (CLAUDE.md invariant 1).
 *
 * `eslint.config.mjs` already makes `Date`, `Date.now`, `Math.random`, `fetch` and `node:*` /
 * `pg` / `ioredis` imports errors inside this package, and `pnpm --filter @projectapp/cpm-engine
 * lint` passing is most of the purity proof. This test is the *second* check, and it exists for one
 * specific failure mode: the lint block is a few lines in a shared config file that someone
 * refactoring lint rules can loosen without ever opening this package. A test living next to the
 * engine fails loudly in that case.
 *
 * It scans the engine's own source — every `.ts` under `src/` except `*.test.ts`, which the lint
 * config exempts for the same reason this file may read the filesystem at all: a test that proves
 * the engine does no I/O necessarily does some itself.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SRC_DIR, '..');

function engineSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...engineSourceFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found.sort();
}

/**
 * Strips comments so the scan matches code rather than prose. Without this, a docstring explaining
 * that the engine must never call `Date.now()` would fail the test that enforces it — and the fix
 * someone reaches for is deleting the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN = [
  {
    what: 'a node: builtin import',
    why: 'the engine does no I/O (CLAUDE.md invariant 1, ADR-010)',
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]node:/,
  },
  {
    what: 'a database or network client import',
    why: 'the engine does no I/O; calendars are resolved into the input (ADR-010 §2)',
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:pg|ioredis|fs|net|http|https)['"]/,
  },
  {
    what: 'a clock read',
    why: 'same input must produce byte-identical output; projectStart is the only notion of "now"',
    pattern: /\bDate\.now\s*\(|\bnew\s+Date\s*\(/,
  },
  {
    what: 'a randomness source',
    why: 'same input must produce byte-identical output (leveling tie-breaks included, ADR-005)',
    pattern: /\bMath\.random\s*\(|\bcrypto\.(?:randomUUID|getRandomValues)\s*\(/,
  },
  {
    what: 'a network call',
    why: 'the engine is called in-process; it never fetches (ADR-010 §5)',
    pattern: /\bfetch\s*\(|\bXMLHttpRequest\b/,
  },
] as const;

describe('the engine is pure (CLAUDE.md invariant 1, acceptance f)', () => {
  const files = engineSourceFiles(SRC_DIR);

  it('has engine source files to scan — a scanner over nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(4);
    expect(files.some((file) => file.endsWith('graph.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);
  });

  it.each(FORBIDDEN)('contains no $what anywhere in src/ — $why', ({ pattern }) => {
    const offenders = files.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders.map((file) => relative(PACKAGE_DIR, file))).toEqual([]);
  });

  it('scans real content — the guard against a regex that can never match', () => {
    // If `stripComments` ever ate the code instead of the comments, every check above would pass
    // vacuously. Assert the stripped source still contains the things it should.
    const graph = stripComments(readFileSync(join(SRC_DIR, 'graph.ts'), 'utf8'));

    expect(graph).toContain('export function buildGraph');
    expect(graph).not.toContain('CLAUDE.md invariant 1');
    expect(FORBIDDEN.some(({ pattern }) => pattern.test("import { x } from 'node:fs';"))).toBe(
      true,
    );
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('const t = Date.now();'))).toBe(true);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('const r = Math.random();'))).toBe(true);
  });
});

describe('the package declares no runtime dependency it should not have (acceptance f)', () => {
  it('depends on @projectapp/shared-types and nothing else at runtime', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // zod arrives transitively through shared-types and is deliberately not a direct dependency:
    // every import this package makes from the contract is `import type`, so nothing from
    // shared-types survives compilation into the engine's runtime at all.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@projectapp/shared-types']);
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual(['typescript', 'vitest']);
  });

  it('imports the contract as types only, so the engine has no runtime coupling to it', () => {
    const offenders = engineSourceFiles(SRC_DIR).filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return /^\s*import\s+(?!type\b)[^;]*from\s*['"]@projectapp\/shared-types['"]/m.test(source);
    });

    expect(offenders.map((file) => relative(PACKAGE_DIR, file))).toEqual([]);
  });
});
