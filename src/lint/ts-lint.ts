import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";

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
}

/** R1: setInterval stored on a property (this.x/obj.field) never cleared in this file. */
function ruleIntervalNeverCleared(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    const m = text.match(/(?:this|[A-Za-z_$][\w$]*)\.([\w$]+)\s*=\s*setInterval\s*\(/);
    if (!m) return;
    const field = m[1];
    // cleared via clearInterval(this.x) / clearInterval(obj.x), or the field is
    // handed to clearInterval indirectly (clearInterval(<anything>.x)).
    const clearRe = new RegExp(`clearInterval\\s*\\(\\s*[\\w$.]*\\b${field}\\b`);
    if (clearRe.test(joined)) return;
    hits.push({
      line: i + 1,
      ruleId: "interval-never-cleared",
      kind: "timer-leak",
      summary: `setInterval stored in '.${field}' is never clearInterval()ed in this file — it keeps firing (and retains its closure) for the owner's lifetime`,
      evidenceLine: text.trim(),
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
function ruleGlobalListenerNeverRemoved(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  if (/removeEventListener|removeListener|\.off\s*\(/.test(joined)) return hits;
  lines.forEach((text, i) => {
    const m = text.match(/\b(process|globalThis)\.(addListener|on|addEventListener)\s*\(\s*['"]([\w:]+)['"]/);
    if (!m) return;
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

const CUSTOM_RULES = [ruleIntervalNeverCleared, ruleGlobalListenerNeverRemoved];

/**
 * ESLint pass over the touched files, using signalkrebs' own bundled eslint +
 * typescript-eslint via a generated flat config (the target repo's own ESLint
 * setup, or lack of one, is irrelevant). Core `require-atomic-updates` runs on
 * every file; type-aware `no-floating-promises` only where the repo has a
 * tsconfig.json (type info is required and comes from the repo's own project).
 */
function runEslint(repoDir: string, files: string[]): Map<string, RawHit[]> {
  const out = new Map<string, RawHit[]>();
  if (files.length === 0) return out;
  const hasTsconfig = existsSync(join(repoDir, "tsconfig.json"));
  const tsFiles = files.filter((f) => TS_EXT.test(f));
  const wantTypeAware = hasTsconfig && tsFiles.length > 0;

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
        });
      }
      if (hits.length) out.set(rel, hits);
    }
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
  return out;
}

export function lintTs(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
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

  const eslintHits = runEslint(repoDir, [...byFile.keys()]);

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
        suppressed: reason !== undefined,
        suppressionReason: reason,
      });
    }
  }
  return defects;
}
