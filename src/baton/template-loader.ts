import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { legacyUserBatonTemplateOverridePath, userBatonTemplateOverridePath } from "../config.ts";

/**
 * Resolve the absolute path of the embedded baton template, relative to this module.
 * Used by host installers (Claude slash commands, Codex skills, Gemini commands)
 * and by UserPromptSubmit to inline the body at the hard threshold.
 */
export function templatePath(): string {
  const candidates = [
    fileURLToPath(new URL("./template.md", import.meta.url)),
    fileURLToPath(new URL("./baton/template.md", import.meta.url)),
  ];
  const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  return path.replace(/\\/g, "/");
}

export interface TemplateResult {
  body: string;
  source: "bundled" | "override" | "extended";
}

function readBundledTemplate(): string {
  return readFileSync(templatePath(), "utf8");
}

export function readTemplateBodyWithOverride(): TemplateResult {
  const overridePath = existsSync(userBatonTemplateOverridePath())
    ? userBatonTemplateOverridePath()
    : legacyUserBatonTemplateOverridePath();
  const bundledTemplate = readBundledTemplate();

  if (!existsSync(overridePath)) {
    return { body: bundledTemplate, source: "bundled" };
  }

  let overrideContent = "";
  try {
    overrideContent = readFileSync(overridePath, "utf8");
  } catch {
    process.stderr.write(`baton: ${overridePath} exists but could not be read — using bundled template.\n`);
    return { body: bundledTemplate, source: "bundled" };
  }

  // Minimal validation: must start with --- and have name: baton
  if (!overrideContent.startsWith("---")) {
    process.stderr.write(`baton: ${overridePath} exists but frontmatter check failed — using bundled template.\n`);
    return { body: bundledTemplate, source: "bundled" };
  }

  const endFrontmatter = overrideContent.indexOf("\n---", 3);
  if (endFrontmatter === -1) {
    process.stderr.write(`baton: ${overridePath} exists but frontmatter check failed — using bundled template.\n`);
    return { body: bundledTemplate, source: "bundled" };
  }

  const frontmatter = overrideContent.slice(3, endFrontmatter);
  if (!frontmatter.includes("name: baton")) {
    process.stderr.write(`baton: ${overridePath} exists but frontmatter check failed — using bundled template.\n`);
    return { body: bundledTemplate, source: "bundled" };
  }

  if (overrideContent.includes("<!-- baton:extend -->")) {
    const bundledBody = stripFrontmatter(bundledTemplate);
    return {
      body: overrideContent.replace("<!-- baton:extend -->", bundledBody),
      source: "extended",
    };
  }

  return { body: overrideContent, source: "override" };
}

export function readTemplate(): string {
  return readTemplateBodyWithOverride().body;
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
