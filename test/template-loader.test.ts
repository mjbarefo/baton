import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTemplateBodyWithOverride, readTemplate } from "../src/baton/template-loader.ts";

describe("template-loader", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "baton-test-home-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("missing override file returns bundled", () => {
    const result = readTemplateBodyWithOverride();
    expect(result.source).toBe("bundled");
    expect(result.body).toContain("# /baton");
  });

  test("valid override with frontmatter is used verbatim", () => {
    const overridePath = join(tmpHome, ".claude", "baton-template.md");
    const content = `---\nname: baton\ndescription: Custom\n---\n# Custom Header\nSome content`;
    writeFileSync(overridePath, content, "utf8");

    const result = readTemplateBodyWithOverride();
    expect(result.source).toBe("override");
    expect(result.body).toBe(content);
  });

  test("override with extend marker splices bundled body", () => {
    const overridePath = join(tmpHome, ".claude", "baton-template.md");
    const content = `---\nname: baton\ndescription: Custom\n---\n# Custom Header\n<!-- baton:extend -->\n## Company Fields\n`;
    writeFileSync(overridePath, content, "utf8");

    const result = readTemplateBodyWithOverride();
    expect(result.source).toBe("extended");
    expect(result.body).toContain("# Custom Header");
    expect(result.body).toContain("## Company Fields");
    expect(result.body).toContain("# /baton — Session baton"); // From the bundled body
    expect(result.body).not.toContain("<!-- baton:extend -->");
    // Ensure we stripped the bundled frontmatter
    expect(result.body).not.toMatch(/---\nname: baton\ndescription: Snapshot/);
  });

  test("invalid override (missing name: baton) falls back to bundled and emits warning", () => {
    const overridePath = join(tmpHome, ".claude", "baton-template.md");
    const content = `---\ndescription: Custom\n---\n# Custom Header\nSome content`;
    writeFileSync(overridePath, content, "utf8");

    const originalWrite = process.stderr.write;
    let warningEmitted = false;
    let warningMessage = "";
    process.stderr.write = ((msg: string) => {
      warningEmitted = true;
      warningMessage = msg;
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = readTemplateBodyWithOverride();
      expect(result.source).toBe("bundled");
      expect(warningEmitted).toBe(true);
      expect(warningMessage).toContain("frontmatter check failed");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("invalid override (no frontmatter) falls back to bundled and emits warning", () => {
    const overridePath = join(tmpHome, ".claude", "baton-template.md");
    const content = `# Custom Header\nSome content`;
    writeFileSync(overridePath, content, "utf8");

    const originalWrite = process.stderr.write;
    let warningEmitted = false;
    process.stderr.write = (() => { warningEmitted = true; return true; }) as typeof process.stderr.write;

    try {
      const result = readTemplateBodyWithOverride();
      expect(result.source).toBe("bundled");
      expect(warningEmitted).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("readTemplate uses readTemplateBodyWithOverride", () => {
    const overridePath = join(tmpHome, ".claude", "baton-template.md");
    const content = `---\nname: baton\n---\nOverride`;
    writeFileSync(overridePath, content, "utf8");

    const result = readTemplate();
    expect(result).toBe(content);
  });
});
