import { DETECTOR_TOOLS, type DetectorConfig, type DetectorTool } from "./types.js";

export class UsageError extends Error {}

export interface CliArgs {
  dir: string;
  tool: DetectorTool;
  base?: string;
  changedFiles?: string[];
  config: DetectorConfig;
}

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`${name} requires a value`);
  return value;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let dir: string | undefined;
  let tool: DetectorTool | undefined;
  let base: string | undefined;
  let changedFiles: string[] | undefined;

  const config: DetectorConfig = { tool: "go-race" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => requireValue(arg, argv[++i]);
    switch (arg) {
      case "--dir":
        dir = next();
        break;
      case "--tool": {
        const t = next();
        if (!DETECTOR_TOOLS.includes(t as DetectorTool)) {
          throw new UsageError(`unknown --tool '${t}'; expected one of: ${DETECTOR_TOOLS.join(", ")}`);
        }
        tool = t as DetectorTool;
        break;
      }
      case "--base":
        base = next();
        break;
      case "--changed-files":
        changedFiles = next()
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
        break;
      case "--reps":
        config.reps = parseInt(next(), 10);
        break;
      case "--gomaxprocs":
        config.gomaxprocs = next()
          .split(",")
          .map((n) => parseInt(n.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case "--timeout":
        config.timeoutMs = parseInt(next(), 10);
        break;
      case "--test-command":
        config.testCommand = next();
        break;
      case "--allow-unexercised":
        config.allowUnexercised = true;
        break;
      case "--skip-liveness":
        config.skipLiveness = true;
        break;
      case "--lint-only":
        config.lintOnly = true;
        break;
      case "--fast-lint":
        config.skipTypeAware = true;
        break;
      case "--report-file":
        config.reportFile = next();
        break;
      case "--swift-package-path":
        config.swiftPackagePath = next();
        break;
      case "--swift-test-target":
        config.swiftTestTarget = next();
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (!dir) throw new UsageError("--dir is required");
  if (!tool) throw new UsageError("--tool is required");
  config.tool = tool;
  config.base = base;

  if (!base && !changedFiles) {
    throw new UsageError("provide --base <ref> or --changed-files <a,b,...>");
  }

  return { dir, tool, base, changedFiles, config };
}
