// Shared precision core for the regex lint lanes (signalkrebs #16). The unsafe-cutover rule and its
// precision gates were re-implemented per language (go-lint / ts-lint / swift-lint) and DRIFTED — on
// 2026-07-17 the same false-positive class was fixed separately in Go and TS, and swift-lint was left
// with the naive version. This module holds the reusable logic so a fix propagates to every lane.
//
// Two link models genuinely differ and both live here:
//   • reassign-slot (TS, Swift): the destroyed SLOT is reassigned to the freshly-acquired value —
//     `x.close(); const v = await acquire(); x = v` (or `x = await acquire()` directly).
//   • shares-resource (Go): the destroy and the acquisition share a resource identifier and the
//     acquisition's error path bails — exposed here as reusable gate helpers the Go rule composes.

export interface CutoverHit {
  line: number;
  ruleId: string;
  kind: string;
  summary: string;
  evidenceLine: string;
}

/** Net `{` minus `}` on a line — block-depth delta (parens/brackets ignored; scope is braces). */
export function braceDelta(line: string): number {
  return (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
}

const STOPWORDS = new Set([
  "stop", "close", "delete", "remove", "teardown", "destroy", "kill", "unregister", "revoke", "release",
  "cancel", "dispose", "shutdown", "abort", "invalidate", "deactivate",
  "create", "new", "dial", "acquire", "open", "start", "register", "provision", "prepare", "connect",
  "mint", "reserve", "make", "await", "try",
  "err", "nil", "ctx", "context", "return", "throw", "var", "let", "const", "func", "function", "defer",
  "self", "this", "the", "and", "for", "await",
]);

export function identsOf(s: string, extra?: Set<string>): Set<string> {
  const stop = extra ?? STOPWORDS;
  return new Set(
    (s.match(/\b[a-zA-Z_]\w{2,}\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !stop.has(w)),
  );
}

/** Destroy and acquire lines refer to a common non-trivial identifier (a lease/conn/receiver). */
export function sharesResource(destroy: string, acquire: string, extra?: Set<string>): boolean {
  const b = identsOf(acquire, extra);
  for (const x of identsOf(destroy, extra)) if (b.has(x)) return true;
  return false;
}

/** Is `ident` reassigned (LHS of `=`, not `==`/`===`/`=>`, not a fresh const/let/var decl) on any
 * line in (from, to)? Used to reject `x.close(); x = next; … x.open()` — a different object. */
export function isReassignedBetween(lines: string[], from: number, to: number, ident: string): boolean {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^.\\w])${esc}\\s*=[^=>]`);
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\b`);
  for (let j = from + 1; j < to; j++) {
    if (re.test(lines[j]) && !declRe.test(lines[j])) return true;
  }
  return false;
}

/** Does a `return`/`throw` sit on any line in (from, to)? A bail path between destroy and acquire
 * means they are on different control-flow branches, not a straight-line cutover. */
export function controlTransferBetween(lines: string[], from: number, to: number): boolean {
  for (let j = from + 1; j < to; j++) {
    if (/\b(?:return|throw)\b/.test(lines[j])) return true;
  }
  return false;
}

export interface ReassignCutoverConfig {
  /** Teardown call; group 1 must capture the destroyed slot, e.g. `this.socket` / `self.timer`. */
  teardownRe: RegExp;
  /** Form-A declaration of the acquired value; group 1 captures the var. `const v = await` / `let v = try`. */
  declRe: RegExp;
  /** Form-B: the acquisition keyword after `=`, e.g. /=\s*await\b/ or /=\s*try\b/. */
  acquireAssignRe: RegExp;
  restartRe: RegExp;
  /** Matches a line whose teardown match is inside a string literal (codegen), to skip. */
  isInStringLiteral?: (line: string, idx: number) => boolean;
}

const WINDOW = 15;
const REASSIGN_WINDOW = 6;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The hardened reassign-slot cutover detector shared by TS and Swift. A teardown of slot R is a
 * cutover only when R is reassigned to a value acquired by a fallible await/try, within the SAME
 * brace scope, with no intervening bail (return/throw) or restart. Anything else — including a
 * teardown in a `finally` followed by a later function reusing the name — is not this bug.
 */
export function detectReassignCutover(lines: string[], cfg: ReassignCutoverConfig): CutoverHit[] {
  const hits: CutoverHit[] = [];
  lines.forEach((text, i) => {
    const dm = text.match(cfg.teardownRe);
    if (!dm) return;
    if (cfg.isInStringLiteral?.(text, text.search(cfg.teardownRe))) return;
    const slot = dm[1];
    const reassignRe = new RegExp(`(?:^|[^.\\w])${esc(slot)}\\s*=[^=>]`);
    const windowEnd = Math.min(lines.length - 1, i + WINDOW);

    let depth = 0;
    for (let j = i + 1; j <= windowEnd; j++) {
      const L = lines[j];
      const delta = braceDelta(L);
      if (depth + delta < 0) return; // closed out of the destroy's block — sibling/later scope
      depth += delta;
      if (cfg.restartRe.test(L)) return; // re-created before the acquisition → safe
      if (/\b(?:return|throw)\b/.test(L)) return; // a bail path sits between → different branch

      // Form B — the destroyed slot itself reassigned via the acquisition: `x = await dial()`.
      if (cfg.acquireAssignRe.test(L) && reassignRe.test(L)) {
        hits.push(mk(text, i, j));
        return;
      }
      // Form A — `const v = await acquire()` then `x = …v…` a few lines later.
      const am = L.match(cfg.declRe);
      if (am) {
        const vRe = new RegExp(`\\b${esc(am[1])}\\b`);
        const reEnd = Math.min(lines.length - 1, j + REASSIGN_WINDOW);
        for (let k = j + 1; k <= reEnd; k++) {
          if (cfg.restartRe.test(lines[k])) return; // failure path restores → safe
          if (reassignRe.test(lines[k]) && vRe.test(lines[k])) {
            hits.push(mk(text, i, j));
            return;
          }
        }
        return; // acquired value not fed back into the destroyed slot → not this bug
      }
    }
  });
  return hits;

  function mk(text: string, i: number, acquireLine: number): CutoverHit {
    return {
      line: i + 1,
      ruleId: "destructive-before-confirm",
      kind: "unsafe-cutover",
      summary: `destructive teardown of '${text.trim().slice(0, 60)}' runs before the fallible acquisition on line ${acquireLine + 1} whose value replaces it; if it fails, the torn-down resource is gone and unrestored — acquire/confirm the replacement before destroying the incumbent`,
      evidenceLine: text.trim(),
    };
  }
}
