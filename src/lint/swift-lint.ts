import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcurrencyDefect } from "../types.js";
import { parseScopeEntry } from "../git-changed-files.js";

// Static anti-pattern rules for Swift. Like the Go set, these HARD-FAIL on a
// touched line, so each is high-precision. Swift 6's actor/Sendable checking
// already eliminates most data races at compile time, so the residual hard-fail
// classes here are the timer/observer LEAKS the compiler does not catch. Every
// hit is suppressible with `// concurrency-ok: <reason>`.

const SUPPRESS_RE = /\/\/\s*concurrency-ok:\s*(.+)$/;

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

/** R1: a Timer stored in a property that is never invalidate()d in this file. */
function ruleTimerNeverInvalidated(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    // `self.timer = Timer.scheduledTimer(...)` / `foo = Timer(timeInterval:...)`
    const m = text.match(/(\w+)\s*=\s*Timer(?:\.scheduledTimer|\s*\()/);
    if (!m) return;
    const target = m[1];
    if (/\.invalidate\s*\(/.test(joined) && new RegExp(`${target}[?!]?\\.invalidate`).test(joined)) return;
    if (!/\.invalidate\s*\(/.test(joined)) {
      hits.push({
        line: i + 1,
        ruleId: "timer-never-invalidated",
        kind: "timer-leak",
        summary: `Timer stored in '${target}' is never invalidate()d in this file — it retains its target and fires for the object's lifetime`,
        evidenceLine: text.trim(),
      });
    }
  });
  return hits;
}

/** R2: a DispatchSource timer stored but never cancel()ed. */
function ruleDispatchSourceNeverCancelled(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  const joined = lines.join("\n");
  lines.forEach((text, i) => {
    const m = text.match(/(\w+)\s*=\s*DispatchSource\.makeTimerSource/);
    if (!m) return;
    const target = m[1];
    if (new RegExp(`${target}[?!]?\\.cancel\\s*\\(`).test(joined)) return;
    hits.push({
      line: i + 1,
      ruleId: "dispatchsource-timer-never-cancelled",
      kind: "timer-leak",
      summary: `DispatchSourceTimer '${target}' is never cancel()ed — the source keeps firing its handler for the process lifetime`,
      evidenceLine: text.trim(),
    });
  });
  return hits;
}

const RULES = [ruleTimerNeverInvalidated, ruleDispatchSourceNeverCancelled];

export function lintSwift(repoDir: string, touchedRanges: string[]): ConcurrencyDefect[] {
  const defects: ConcurrencyDefect[] = [];
  const byFile = new Map<string, Array<[number, number] | null>>();

  for (const entry of touchedRanges) {
    const { file, start, end } = parseScopeEntry(entry);
    if (!file.endsWith(".swift")) continue;
    const list = byFile.get(file) ?? [];
    list.push(start !== undefined && end !== undefined ? [start, end] : null);
    byFile.set(file, list);
  }

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

    for (const rule of RULES) {
      for (const hit of rule(lines)) {
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
  }
  return defects;
}
