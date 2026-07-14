import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
}

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Derive the changed-file set for a locally staged PR: everything the branch
 * changed since its merge-base with `base`, plus staged/unstaged edits and
 * untracked files — i.e. what a local review would see before anything is
 * pushed. Deleted files are excluded (there is nothing left to analyze).
 */
export function getChangedFilesFromGit(dir: string, base: string): string[] {
  const fromBranch = lines(git(dir, ["diff", "--name-only", `${base}...HEAD`]));
  const fromWorkingTree = lines(git(dir, ["diff", "--name-only", "HEAD"]));
  const untracked = lines(git(dir, ["ls-files", "--others", "--exclude-standard"]));

  const all = new Set([...fromBranch, ...fromWorkingTree, ...untracked]);
  const files = [...all].filter((file) => existsSync(join(dir, file))).sort();
  console.error(
    `[signalkrebs] changed files vs ${base}: ${files.length} total ` +
      `(${fromBranch.length} branch, ${fromWorkingTree.length} working-tree, ${untracked.length} untracked)`,
  );
  return files;
}

/**
 * Like getChangedFilesFromGit, but each entry carries the changed line ranges as
 * "file:12-40" suffixes (one entry per hunk), derived from -U0 diffs of the branch
 * vs merge-base plus the working tree. Untracked files get NO suffix (every line is
 * new). The anti-pattern lint uses these ranges to fail only on TOUCHED lines; a
 * pre-existing anti-pattern in an untouched region is not this PR's problem.
 */
export function getChangedLineRangesFromGit(dir: string, base: string): string[] {
  const ranges = new Map<string, Array<[number, number]>>();

  const collect = (diffArgs: string[]) => {
    const out = git(dir, ["diff", "-U0", ...diffArgs]);
    let file: string | null = null;
    for (const line of out.split("\n")) {
      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (fileMatch) {
        file = fileMatch[1];
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunk && file) {
        const start = parseInt(hunk[1], 10);
        const count = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
        if (count === 0) continue; // pure deletion hunk — nothing to analyze here
        const list = ranges.get(file) ?? [];
        list.push([start, start + count - 1]);
        ranges.set(file, list);
      }
    }
  };
  collect([`${base}...HEAD`]);
  collect(["HEAD"]);

  const untracked = lines(git(dir, ["ls-files", "--others", "--exclude-standard"]));

  const entries: string[] = [];
  for (const [file, list] of ranges) {
    if (!existsSync(join(dir, file))) continue;
    list.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of list) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    for (const [s, e] of merged) entries.push(`${file}:${s}-${e}`);
  }
  for (const file of untracked) {
    if (existsSync(join(dir, file))) entries.push(file);
  }
  return entries.sort();
}

/** Parse a "file:12-40" scope entry into its path and inclusive line range (or whole-file). */
export function parseScopeEntry(entry: string): { file: string; start?: number; end?: number } {
  const m = entry.match(/^(.*):(\d+)-(\d+)$/);
  if (!m) return { file: entry };
  return { file: m[1], start: parseInt(m[2], 10), end: parseInt(m[3], 10) };
}
