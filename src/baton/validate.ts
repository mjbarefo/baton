import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { BATON_REL_PATH, userHomeDir } from "../config.ts";
import { DEFAULT_PATTERNS, loadProjectPatterns, loadUserPatterns, redact } from "./redact.ts";
import { findBaton } from "./find.ts";

const REQUIRED_HEADERS = [
  "Current Goal",
  "Completed This Session",
  "Active Work",
  "Next Concrete Action",
  "Decisions & Constraints",
  "Gotchas Discovered",
  "User Preferences Observed",
  "Open Questions for the User",
  "Key Files (quick index)",
  "Recent Test / Build State",
] as const;

const VALID_STATES = new Set(["Unstarted", "edited-not-tested", "tested-failing", "tested-passing", "blocked"]);

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationReport {
  path: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function section(body: string, header: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${header}`);
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function countHeader(body: string, header: string): number {
  const re = new RegExp(`^## ${escapeRegExp(header)}\\s*$`, "gm");
  return Array.from(body.matchAll(re)).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEmptyish(value: string | null): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "_none_" || normalized.startsWith("_unknown") || normalized === "unknown";
}

function isGenericNextAction(value: string | null): boolean {
  if (isEmptyish(value)) return true;
  const normalized = value!.trim().toLowerCase();
  return [
    "continue",
    "continue the work",
    "keep going",
    "resume",
    "finish this",
    "finish the task",
  ].includes(normalized);
}

function hasCommandLikeTestState(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  if (normalized.includes("no command") || normalized.includes("not run") || normalized.includes("none run")) {
    return true;
  }
  return /`[^`]+`/.test(value) || /\b(bun|npm|pnpm|yarn|cargo|go|pytest|python|tsc|make|gradle|mvn)\b/.test(value);
}

function scanSecrets(path: string, body: string): ValidationIssue[] {
  const containingDir = dirname(path);
  const parentDir = dirname(containingDir);
  const projectRoot =
    basename(containingDir) === ".baton"
      ? parentDir
      : basename(containingDir) === "baton" && basename(parentDir) === ".claude"
        ? dirname(parentDir)
        : containingDir;
  const patterns = [
    ...DEFAULT_PATTERNS,
    ...loadUserPatterns(userHomeDir()),
    ...loadProjectPatterns(projectRoot),
  ];
  const { hits } = redact(body, patterns);
  return hits.map((hit) => ({
    level: "error",
    code: "secret",
    message: `${hit.count} possible ${hit.label}${hit.count === 1 ? "" : "s"} found`,
  }));
}

export function validateBaton(path: string): ValidationReport {
  const resolved = resolve(path);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(resolved)) {
    return {
      path: resolved,
      valid: false,
      errors: [{ level: "error", code: "missing", message: `Baton not found: ${resolved}` }],
      warnings,
    };
  }

  const body = readFileSync(resolved, "utf8");
  for (const header of REQUIRED_HEADERS) {
    const count = countHeader(body, header);
    if (count === 0) {
      errors.push({ level: "error", code: "missing-section", message: `Missing section: ${header}` });
    } else if (count > 1) {
      errors.push({ level: "error", code: "duplicate-section", message: `Duplicate section: ${header}` });
    }
  }

  if (isEmptyish(section(body, "Current Goal"))) {
    errors.push({ level: "error", code: "weak-current-goal", message: "Current Goal must be concrete" });
  }

  if (isGenericNextAction(section(body, "Next Concrete Action"))) {
    errors.push({
      level: "error",
      code: "weak-next-action",
      message: "Next Concrete Action must be specific and executable",
    });
  }

  const activeWork = section(body, "Active Work");
  for (const label of ["What", "Where", "Why", "State"]) {
    if (!new RegExp(`^\\*\\*${label}:\\*\\*`, "m").test(activeWork ?? "")) {
      errors.push({ level: "error", code: "active-work-field", message: `Active Work missing ${label}` });
    }
  }
  const state = activeWork?.match(/^\*\*State:\*\*\s*(.+)$/m)?.[1]?.trim();
  if (state && !VALID_STATES.has(state)) {
    errors.push({
      level: "error",
      code: "invalid-state",
      message: `Active Work state must be one of: ${Array.from(VALID_STATES).join(", ")}`,
    });
  }

  if (!hasCommandLikeTestState(section(body, "Recent Test / Build State"))) {
    warnings.push({
      level: "warning",
      code: "weak-test-state",
      message: "Recent Test / Build State should name a command or explicitly say none ran",
    });
  }

  const secretIssues = scanSecrets(resolved, body);
  errors.push(...secretIssues);

  return {
    path: resolved,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function runValidate(args: string[], cwd: string): number {
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const target = args.find((arg) => !arg.startsWith("--"));
  const path = target ? resolve(cwd, target) : findBaton(cwd);
  if (!path) {
    const report: ValidationReport = {
      path: resolve(cwd, BATON_REL_PATH),
      valid: false,
      errors: [{ level: "error", code: "missing", message: `No ${BATON_REL_PATH} found` }],
      warnings: [],
    };
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else printValidationReport(report);
    return 1;
  }

  const report = validateBaton(path);
  const valid = strict ? report.valid && report.warnings.length === 0 : report.valid;
  const finalReport = { ...report, valid };
  if (json) process.stdout.write(JSON.stringify(finalReport, null, 2) + "\n");
  else printValidationReport(finalReport);
  return valid ? 0 : 1;
}

export function printValidationReport(report: ValidationReport): void {
  process.stdout.write(`baton validate: ${report.valid ? "valid" : "invalid"} ${report.path}\n`);
  for (const issue of report.errors) {
    process.stdout.write(`  error ${issue.code}: ${issue.message}\n`);
  }
  for (const issue of report.warnings) {
    process.stdout.write(`  warning ${issue.code}: ${issue.message}\n`);
  }
}
