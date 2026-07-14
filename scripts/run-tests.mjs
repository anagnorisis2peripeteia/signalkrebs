#!/usr/bin/env node
// Build first (tests import from dist/), then run the node:test suite.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const build = spawnSync("npx", ["tsc"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);

const test = spawnSync(process.execPath, ["--test", "test/*.test.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(test.status ?? 1);
