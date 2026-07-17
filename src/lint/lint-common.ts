// Shared lint conventions for the maturity floor (signalkrebs #16). Every static-lint lane must:
//   • let a hit be suppressed with a `concurrency-ok: <reason>` pragma, and
//   • downgrade a hit in a TEST file to advisory — tests deliberately use blocking sleeps,
//     fire-and-forget tasks, and teardown-without-restore that would be bugs in production code.
// Centralising these keeps the lanes consistent and lets the maturity gate verify them uniformly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcurrencyDefect } from "../types.js";

// `// concurrency-ok:` (Go/TS/Swift/Rust) and `# concurrency-ok:` (Python).
export const SLASH_SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;
export const HASH_SUPPRESS_RE = /#\s*concurrency-ok:\s*(.+)$/;

// A path that is test code: a tests/ or __tests__/ dir, a .test./.spec. infix, Go's _test.go,
// or Python's test_*.py / *_test.py.
export const TEST_FILE_RE =
  /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.|_test\.(?:go|py|ts|js|swift|rs)$|(?:^|\/)test_[^/]*\.py$/i;

export function isTestFile(file: string): boolean {
  return TEST_FILE_RE.test(file);
}

/** A hard hit in a test file becomes advisory (tests intentionally do the things these rules flag).
 * Advisory hits and dynamic repros (a real hang/race in a test IS a bug) are left untouched. */
export function downgradeTestFileDefect(d: ConcurrencyDefect): ConcurrencyDefect {
  return isTestFile(d.file) && d.source === "static" && !d.advisory ? { ...d, advisory: true } : d;
}

/** Mark a defect suppressed when its own source line — or the line immediately above — carries a
 * `concurrency-ok:` pragma. Mutates in place; safe to call once per file's defects. */
export function applyPragmaSuppression(
  defects: ConcurrencyDefect[],
  lines: string[],
  re: RegExp = SLASH_SUPPRESS_RE,
): void {
  for (const d of defects) {
    if (d.suppressed) continue;
    const own = lines[d.line - 1] ?? "";
    const above = lines[d.line - 2] ?? "";
    const m = own.match(re) ?? above.match(re);
    if (m) {
      d.suppressed = true;
      d.suppressionReason = m[1].trim();
    }
  }
}

/** Apply the maturity floor (pragma suppression + test-file downgrade) to defects produced by a
 * COMPILED analyzer (Roslyn, SwiftSyntax) — the pragma lives in the source, so we re-read each hit's
 * file to check for it. `d.file` is relative to `repoDir`. */
export function applyAnalyzerMaturity(
  repoDir: string,
  defects: ConcurrencyDefect[],
  re: RegExp = SLASH_SUPPRESS_RE,
): ConcurrencyDefect[] {
  const byFile = new Map<string, ConcurrencyDefect[]>();
  for (const d of defects) {
    const arr = byFile.get(d.file) ?? [];
    arr.push(d);
    byFile.set(d.file, arr);
  }
  for (const [file, ds] of byFile) {
    try {
      applyPragmaSuppression(ds, readFileSync(join(repoDir, file), "utf8").split("\n"), re);
    } catch {
      /* unreadable source — leave unsuppressed */
    }
  }
  return defects.map(downgradeTestFileDefect);
}
