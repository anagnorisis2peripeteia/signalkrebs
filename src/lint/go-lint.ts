import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";

// Static anti-pattern rules for Go. These HARD-FAIL the gate on a touched line
// (per gate policy), so every rule here is chosen to be high-precision: a hit is
// a real, well-known concurrency bug, not a style nit. Fuzzy heuristics (the
// partial-synchronization struct smell, goroutine-in-constructor) deliberately
// do NOT live here — they belong to the hunt skill's LLM discovery layer, where a
// false positive costs a wasted look, not a blocked PR. Every hit is suppressible
// with a `// concurrency-ok: <reason>` pragma on the offending line or the line
// directly above it.

const SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;

interface LineSuppression {
  reason: string;
}

/** A suppression applies to its own line and the immediately following line. */
function collectSuppressions(lines: string[]): Map<number, LineSuppression> {
  const map = new Map<number, LineSuppression>();
  lines.forEach((text, i) => {
    const m = text.match(SUPPRESS_RE);
    if (m) {
      const reason = m[1].trim();
      map.set(i + 1, { reason }); // 1-indexed: same line
      map.set(i + 2, { reason }); // and the line below
    }
  });
  return map;
}

interface RawHit {
  line: number; // 1-indexed
  ruleId: string;
  kind: ConcurrencyDefect["kind"];
  summary: string;
  evidenceLine: string;
}

/** R1: a ticker/timer stored in a struct field that is never Stop()ed in this file. */
function ruleTimerWithoutStop(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    // Match `s.foo = time.NewTicker(...)` / `p.timer = time.NewTimer(...)` — the
    // assignment target is a selector (a field), so the ticker outlives the call.
    const m = text.match(/(\w+)\.(\w+)\s*=\s*time\.New(Ticker|Timer)\s*\(/);
    if (!m) return;
    const field = m[2];
    const kind = m[3]; // Ticker | Timer
    // Look for any Stop() on that field name anywhere in the file. A field named
    // `ticker` stopped via `s.ticker.Stop()` or a captured `ticker.Stop()` clears it.
    const stopRe = new RegExp(`\\.${field}\\.Stop\\s*\\(|\\b${field}\\.Stop\\s*\\(`);
    if (stopRe.test(joined)) return;
    hits.push({
      line: i + 1,
      ruleId: "timer-without-stop",
      kind: "timer-leak",
      summary: `time.New${kind} stored in field '${field}' is never Stop()ed in this file — it fires for the lifetime of the owning object`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R2: a range/select loop over a ticker channel with no exit path (unstoppable goroutine). */
function ruleRangeOverTickerNoExit(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  lines.forEach((text, i) => {
    // `for range x.C {` or `for range x.C` — a bare consume loop over a timer/ticker channel.
    const m = text.match(/for\s+range\s+([\w.]+)\.C\b/);
    if (!m) return;
    // Scan the loop body (until matching close-brace at the for's indent) for an exit:
    // return / break, or a select that watches a done/ctx channel. Absence => the
    // goroutine can never exit once the ticker is stopped elsewhere.
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    let hasExit = false;
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = lines[j];
      const bodyIndent = bodyLine.match(/^\s*/)?.[0].length ?? 0;
      if (bodyLine.trim() === "}" && bodyIndent <= indent) break; // end of loop
      if (/\b(return|break)\b/.test(bodyLine)) hasExit = true;
      if (/select\s*\{/.test(bodyLine)) hasExit = true;
      if (/case\s+<-/.test(bodyLine)) hasExit = true;
    }
    if (hasExit) return;
    hits.push({
      line: i + 1,
      ruleId: "range-over-ticker-no-exit",
      kind: "goroutine-leak",
      summary: `'for range ${m[1]}.C' has no return/break/done-select — this goroutine cannot exit once the ticker is stopped, leaking it for the process lifetime`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

/** R3: WaitGroup.Add called inside a spawned goroutine (classic Add-after-Wait race). */
function ruleWaitGroupAddInGoroutine(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  let goDepth = -1; // brace depth at which the current `go func(` opened, or -1
  let depth = 0;
  lines.forEach((text, i) => {
    const opensGoFunc = /\bgo\s+func\s*\(/.test(text);
    // Track brace depth crudely to know if an Add() is lexically inside a go func literal.
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    if (opensGoFunc && goDepth === -1) goDepth = depth;
    if (goDepth !== -1 && /\b\w+\.Add\s*\(/.test(text) && /wg|group|WaitGroup/i.test(text)) {
      hits.push({
        line: i + 1,
        ruleId: "waitgroup-add-in-goroutine",
        kind: "waitgroup-misuse",
        summary:
          "WaitGroup.Add() called inside a spawned goroutine — it can run after Wait() returns, a classic Add-after-Wait race; call Add() before `go`",
        evidenceLine: text.trim(),
      });
    }
    depth += opens - closes;
    if (goDepth !== -1 && depth <= goDepth) goDepth = -1; // left the go func literal
  });
  return hits;
}

const RULES = [ruleTimerWithoutStop, ruleRangeOverTickerNoExit, ruleWaitGroupAddInGoroutine];

/**
 * Lint the touched line ranges of Go files. Only `.go` non-test files are scanned;
 * a hit is emitted only when its line falls inside a touched range. Suppressed
 * hits are retained (source of record) but marked so they do not drive the verdict.
 */
export function lintGo(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const byFile = new Map<string, Array<[number, number] | null>>();

  for (const entry of touchedRanges) {
    const { file, start, end } = parseScopeEntry(entry);
    if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
    const list = byFile.get(file) ?? [];
    list.push(start !== undefined && end !== undefined ? [start, end] : null); // null = whole file
    byFile.set(file, list);
  }

  for (const [file, ranges] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue; // deleted or unreadable — nothing to lint
    }
    const lines = text.split("\n");
    const suppressions = collectSuppressions(lines);
    const wholeFile = ranges.includes(null);
    const inScope = (line: number) =>
      wholeFile ||
      ranges.some((r) => r !== null && line >= r[0] && line <= r[1]);

    for (const rule of RULES) {
      for (const hit of rule(lines)) {
        if (!inScope(hit.line)) continue;
        const suppression = suppressions.get(hit.line);
        defects.push({
          kind: hit.kind,
          source: "static",
          file,
          line: hit.line,
          summary: hit.summary,
          evidence: `[${hit.ruleId}] ${file}:${hit.line}\n    ${hit.evidenceLine}`,
          ruleId: hit.ruleId,
          suppressed: suppression !== undefined,
          suppressionReason: suppression?.reason,
        });
      }
    }
  }
  return defects;
}
