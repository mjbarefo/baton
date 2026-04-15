import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path of the embedded baton template, relative to this module.
 * Used by both the installer (to copy it into ~/.claude/skills/) and the UserPromptSubmit
 * hook (to inline the body at the hard threshold for automatic baton writing).
 */
export function templatePath(): string {
  const candidates = [
    fileURLToPath(new URL("./template.md", import.meta.url)),
    fileURLToPath(new URL("./baton/template.md", import.meta.url)),
  ];
  const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  return path.replace(/\\/g, "/");
}

export function readTemplate(): string {
  return readFileSync(templatePath(), "utf8");
}

/**
 * Strip YAML frontmatter from a SKILL.md-style document.
 * Used when inlining the template into an `additionalContext` payload where
 * the frontmatter would be meaningless noise.
 */
export function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return body;
  const after = body.slice(end + 4);
  return after.replace(/^\s*\n/, "");
}

export function readTemplateBody(): string {
  return stripFrontmatter(readTemplate());
}
