import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";
import { type ReassignCutoverConfig, detectReassignCutover } from "./cutover-core.js";

// Static async-safety rules for TypeScript/JavaScript. JS is single-threaded, so
// the bug classes differ from Go/Swift: the "race" is check-then-act across an
// `await`, the "leak" is an interval/listener that outlives its owner. The heavy
// lifting rides ESLint's own engine (core `require-atomic-updates` for the await
// race; type-aware `no-floating-promises` where a tsconfig exists) — real AST +
// type info, far more precise than regex. The custom rules below cover only the
// leak shapes ESLint has no rule for, with the same field-ownership precision the
// Go/Swift lanes learned (a binding that escapes the scope is owned elsewhere).
// Every hit is suppressible with `// concurrency-ok: <reason>`.

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const JS_EXT = /\.(js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__\/|\/test\/|\/tests\/)/;

function collectSuppressions(lines: string[]): Map<number, string> {
  const map = new Map<number, string>();
  lines.forEach((text, i) => {
    const m = text.match(SUPPRESS_RE);
    if (m) {
      map.set(i + 1, m[1].trim());
      map.set(i + 2, m[1].trim());
    }
  });
  return map;
}

interface RawHit {
  line: number;
  ruleId: string;
  kind: ConcurrencyDefect["kind"];
  summary: string;
  evidenceLine: string;
  advisory?: boolean;
}

/** Is character offset `at` inside a single/double/backtick string on this line?
 * Cheap heuristic: an odd count of unescaped quotes of any kind before `at`. */
function isInStringLiteral(text: string, at: number): boolean {
  if (at < 0) return false;
  const before = text.slice(0, at);
  const dq = (before.match(/(?<!\\)"/g) || []).length;
  const sq = (before.match(/(?<!\\)'/g) || []).length;
  const bt = (before.match(/(?<!\\)`/g) || []).length;
  return dq % 2 === 1 || sq % 2 === 1 || bt % 2 === 1;
}

/** R1: setInterval stored on a property never cleared in this file. */
function ruleIntervalNeverCleared(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    if (isInStringLiteral(text, text.indexOf("setInterval"))) return; // codegen, not a real call
    const m = text.match(/(?:this|[A-Za-z_$][\w$]*)\.([\w$]+)\s*=\s*setInterval\s*\(/);
    if (!m) return;
    const field = m[1];
    // Node aliases clearTimeout/clearInterval, so EITHER clears a setInterval field.
    const clearRe = new RegExp(`clear(?:Interval|Timeout)\\s*\\(\\s*[\\w$.]*\\b${field}\\b`);
    if (clearRe.test(joined)) return;
    // A protected/public field can be torn down by a subclass or another file, so
    // this file-scoped "never cleared" check cannot prove a leak — advisory only.
    // A private field's lifecycle is entirely in-file, so it hard-fails.
    const nonPrivate = new RegExp(`\\b(?:protected|public)\\s+(?:readonly\\s+)?${field}\\b`).test(joined);
    hits.push({
      line: i + 1,
      ruleId: "interval-never-cleared",
      kind: "timer-leak",
      summary: `setInterval stored in '.${field}' is never cleared in this file — it keeps firing (and retains its closure) for the owner's lifetime`,
      evidenceLine: text.trim(),
      advisory: nonPrivate,
    });
  });
  return hits;
}

/**
 * R2: addEventListener on a long-lived global (process/globalThis) inside a
 * class/constructor scope with no matching removeEventListener/off in the file —
 * each construction stacks another permanent listener (the classic MaxListeners
 * leak). Restricted to process/globalThis targets to stay high-precision.
 */
// Process-lifecycle events are legitimately registered once at startup and never
// removed — they are singletons, not per-instance listeners that stack. Firing on
// them is a false positive (seen on openclaw's index.ts / unhandled-rejections.ts).
const SINGLETON_EVENTS = new Set([
  "uncaughtException",
  "unhandledRejection",
  "exit",
  "beforeExit",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
  "warning",
  "rejectionHandled",
]);

function ruleGlobalListenerNeverRemoved(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  if (/removeEventListener|removeListener|\.off\s*\(/.test(joined)) return hits;
  lines.forEach((text, i) => {
    const m = text.match(/\b(process|globalThis)\.(addListener|on|addEventListener)\s*\(\s*['"]([\w:]+)['"]/);
    if (!m) return;
    if (isInStringLiteral(text, m.index ?? 0)) return; // codegen inside a string, not a real registration
    if (SINGLETON_EVENTS.has(m[3])) return; // once-per-process lifecycle handler, not a stacking leak
    // Only flag when registered from within a class (constructor/method) — a
    // module-top-level registration is once-per-process and usually intended.
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0) return;
    hits.push({
      line: i + 1,
      ruleId: "global-listener-never-removed",
      kind: "goroutine-leak",
      summary: `${m[1]}.${m[2]}('${m[3]}') registered in an instance scope with no removal anywhere in the file — every construction stacks another permanent listener`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R3: unsafe-cutover (port of go-lint's destructive-before-confirm; crabbox #1103 class).
 * A destructive teardown (`x.stop()/close()/cancel()/destroy()/…`) that runs BEFORE an
 * `await`ed acquisition of its replacement, with no re-create in between — if the acquire
 * rejects, the torn-down resource is gone and unrestored. Acquire/confirm the replacement
 * before destroying the incumbent. Abstains on a restart between the teardown and the
 * acquisition or in the failure path just after it. */
// TS/JS cutover: the acquisition is a fallible `await`, the failure a rejection. Delegates to the
// shared reassign-slot core (signalkrebs #16) so the precision gates stay in one place.
const TS_CUTOVER_CFG: ReassignCutoverConfig = {
  teardownRe: /([\w.$]+)\.(?:stop|close|cancel|destroy|teardown|dispose|shutdown|abort|kill|unregister|revoke)\w*\s*\(/i,
  declRe: /\b(?:const|let|var)\s+(\w+)\s*=\s*await\b/,
  acquireAssignRe: /=\s*await\b/,
  restartRe: /\b(?:start|restart|reopen|reconnect|recreate|restore|revive|renew|reprovision|reacquire)\w*\s*\(/i,
  isInStringLiteral,
};
function ruleUnsafeCutover(lines: string[]): RawHit[] {
  return detectReassignCutover(lines, TS_CUTOVER_CFG).map((h) => ({ ...h, kind: h.kind as RawHit["kind"] }));
}

// leak-on-error (Go's flagship, ported — signalkrebs #16 item 3). A resource handle acquired via a
// fallible await that must be explicitly closed, where the function then bails (return/throw) and the
// handle is NEVER closed anywhere in its scope and does not escape (returned / assigned out / passed).
// High-precision by construction: a try/finally that closes it, or `return handle`, both abstain.
function ruleLeakOnError(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  // Direct-ownership handles only: `.open()` → handle.close(), `.acquire()` → client.release(). NOT
  // `.connect()`, whose result is usually a view into a manager-owned connection closed elsewhere
  // (mcporter: `runtime.connect()` closed by the caller's `runtime.close()` — a false positive).
  const ACQUIRE_RE = /\b(?:const|let)\s+(\w+)\s*=\s*await\s+[\w.$]*\.(?:open|acquire)\s*\(/;
  const CLOSE = "close|release|destroy|dispose|end|unref|disconnect|free|cleanup";
  lines.forEach((text, i) => {
    const am = text.match(ACQUIRE_RE);
    if (!am) return;
    if (isInStringLiteral(text, text.search(ACQUIRE_RE))) return;
    const h = am[1];
    // The enclosing block of the acquisition.
    let depth = 0;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
      if (depth < 0) {
        end = j;
        break;
      }
    }
    const scope = lines.slice(i + 1, end + 1).join("\n");
    const closeRe = new RegExp(`\\b${h}\\??\\.(?:${CLOSE})\\s*\\(`); // handle.close() anywhere → safe (incl. finally)
    const escapeRe = new RegExp(`(?:return\\s+|[=,(\\[]\\s*)\\b${h}\\b`); // returned / assigned out / passed → owned elsewhere
    if (closeRe.test(scope)) return;
    if (escapeRe.test(scope)) return;
    const bail = scope.match(/\b(return|throw)\b/);
    if (!bail) return;
    hits.push({
      line: i + 1,
      ruleId: "leak-on-error-return",
      kind: "goroutine-leak",
      summary: `resource '${h}' is acquired via await but never closed on the ${bail[1]} path — the early exit leaks it; close it (try/finally) before bailing`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

const CUSTOM_RULES = [ruleIntervalNeverCleared, ruleGlobalListenerNeverRemoved, ruleUnsafeCutover, ruleLeakOnError];

/**
 * ESLint pass over the touched files, using signalkrebs' own bundled eslint +
 * typescript-eslint via a generated flat config (the target repo's own ESLint
 * setup, or lack of one, is irrelevant). Core `require-atomic-updates` runs on
 * every file; type-aware `no-floating-promises` only where the repo has a
 * tsconfig.json (type info is required and comes from the repo's own project).
 */
function runEslint(repoDir: string, files: string[], skipTypeAware: boolean): Map<string, RawHit[]> {
  const out = new Map<string, RawHit[]>();
  if (files.length === 0) return out;
  const hasTsconfig = existsSync(join(repoDir, "tsconfig.json"));
  const tsFiles = files.filter((f) => TS_EXT.test(f));
  // Type-aware no-floating-promises needs the whole TS project loaded; skip it for
  // fast whole-repo discovery (require-atomic-updates + the regex leak rules still run).
  const wantTypeAware = hasTsconfig && tsFiles.length > 0 && !skipTypeAware;

  const cfgDir = mkdtempSync(join(tmpdir(), "sk-eslint-"));
  const cfgPath = join(cfgDir, "sk.config.mjs");
  const tseslintUrl = pathToFileURL(join(SELF_ROOT, "node_modules", "typescript-eslint", "dist", "index.js")).href;
  const config = `
import tseslint from ${JSON.stringify(tseslintUrl)};
export default [
  { files: ["**/*.{js,jsx,mjs,cjs}"], rules: { "require-atomic-updates": "error" } },
  ...(${wantTypeAware} ? [{
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: ${JSON.stringify(repoDir)} },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "require-atomic-updates": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  }] : [{
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser },
    rules: { "require-atomic-updates": "error" },
  }]),
];
`;
  writeFileSync(cfgPath, config);
  try {
    const eslintBin = join(SELF_ROOT, "node_modules", "eslint", "bin", "eslint.js");
    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath,
        [eslintBin, "--no-warn-ignored", "--no-ignore", "--config", cfgPath, "--format", "json", ...files],
        { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      // eslint exits 1 when it finds problems — that IS the result. Anything else
      // (config/parse crash) yields no findings; the caller's fail-closed layers
      // (liveness fixture must catch a planted violation) surface a dead engine.
      stdout = err.stdout?.toString() ?? "";
      if (!stdout.trim().startsWith("[")) return out;
    }
    const results = JSON.parse(stdout) as Array<{
      filePath: string;
      messages: Array<{ ruleId: string | null; line: number; message: string }>;
    }>;
    for (const r of results) {
      // eslint returns absolute (and on macOS /private-symlinked) paths; the caller
      // keys by the exact input file string. Match the result back to its input by
      // suffix so the merge in lintTs() actually finds these hits.
      const rel =
        files.find((f) => r.filePath === f || r.filePath.endsWith(`/${f}`)) ??
        (r.filePath.startsWith(repoDir) ? r.filePath.slice(repoDir.length + 1) : r.filePath);
      const hits: RawHit[] = [];
      for (const msg of r.messages) {
        if (!msg.ruleId) continue; // parse errors are not findings
        const isRace = msg.ruleId === "require-atomic-updates";
        const isFloat = msg.ruleId.endsWith("no-floating-promises");
        if (!isRace && !isFloat) continue;
        hits.push({
          line: msg.line,
          ruleId: msg.ruleId,
          kind: isRace ? "toctou" : "channel-misuse",
          summary: isRace
            ? `check-then-act across an await: ${msg.message}`
            : `floating promise: ${msg.message}`,
          evidenceLine: msg.message,
          // require-atomic-updates is a heuristic (over-fires on local-let
          // reassignment and idempotent ref writes) — advisory, not hard-fail.
          advisory: isRace,
        });
      }
      if (hits.length) out.set(rel, hits);
    }
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
  return out;
}

export function lintTs(repoDir: string, touchedRanges: string[], opts?: { skipTypeAware?: boolean }): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const byFile = new Map<string, Array<[number, number] | null>>();

  for (const entry of touchedRanges) {
    const { file, start, end } = parseScopeEntry(entry);
    if (!TS_EXT.test(file) && !JS_EXT.test(file)) continue;
    if (TEST_FILE.test(file)) continue; // leaks in tests are the suite's business
    const list = byFile.get(file) ?? [];
    list.push(start !== undefined && end !== undefined ? [start, end] : null);
    byFile.set(file, list);
  }
  if (byFile.size === 0) return defects;

  const eslintHits = runEslint(repoDir, [...byFile.keys()], opts?.skipTypeAware ?? false);

  for (const [file, ranges] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const suppressions = collectSuppressions(lines);
    const wholeFile = ranges.includes(null);
    const inScope = (line: number) =>
      wholeFile || ranges.some((r) => r !== null && line >= r[0] && line <= r[1]);

    const raw: RawHit[] = [
      ...CUSTOM_RULES.flatMap((rule) => rule(lines)),
      ...(eslintHits.get(file) ?? []),
    ];
    for (const hit of raw) {
      if (!inScope(hit.line)) continue;
      const reason = suppressions.get(hit.line);
      defects.push({
        kind: hit.kind,
        source: "static",
        file,
        line: hit.line,
        summary: hit.summary,
        evidence: `[${hit.ruleId}] ${file}:${hit.line}\n    ${hit.evidenceLine}`,
        ruleId: hit.ruleId,
        advisory: hit.advisory,
        suppressed: reason !== undefined,
        suppressionReason: reason,
      });
    }
  }
  return defects;
}
