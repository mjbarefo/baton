import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redact, DEFAULT_PATTERNS, loadUserPatterns, loadProjectPatterns } from "../src/baton/redact.ts";

describe("redact", () => {
  let originalStderr: typeof process.stderr.write;
  let stderrOutput = "";

  beforeEach(() => {
    originalStderr = process.stderr.write;
    stderrOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderr;
    delete process.env.BATON_NO_REDACT;
  });

  test("redacts Anthropic API key", () => {
    const text = "Here is my key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("Here is my key: [redacted Anthropic API key]");
    expect(res.hits).toEqual([{ label: "Anthropic API key", count: 1 }]);
  });

  test("redacts OpenAI API key", () => {
    const text = "My token: sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("My token: [redacted OpenAI-style API key]");
    expect(res.hits).toEqual([{ label: "OpenAI-style API key", count: 1 }]);
  });

  test("redacts generic KEY=value", () => {
    const text = "export API_KEY=abcdefghijklmnopqrstuvwxyz123456";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("export API_KEY=[redacted secret assignment]");
    expect(res.hits).toEqual([{ label: "secret assignment", count: 1 }]);
  });

  test("redacts generic KEY=value with quotes", () => {
    const text = "SECRET_TOKEN='abcdefghijklmnopqrstuvwxyz123456'";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("SECRET_TOKEN='[redacted secret assignment]'");
  });

  test("redacts AWS access key", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("AWS_ACCESS_KEY_ID=[redacted AWS access key ID]");
  });

  test("redacts AWS secret access key", () => {
    const text = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("aws_secret_access_key = [redacted AWS secret access key]");
  });

  test("prefers specific Anthropic match over generic secret assignment", () => {
    const text = "ANTHROPIC_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("ANTHROPIC_KEY=[redacted Anthropic API key]");
    expect(res.hits).toEqual([{ label: "Anthropic API key", count: 1 }]);
  });

  test("redacts GitHub PAT classic", () => {
    const text = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("[redacted GitHub classic token]");
  });

  test("redacts GitHub PAT fine-grained", () => {
    const text = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("[redacted GitHub fine-grained token]");
  });

  test("redacts JWT", () => {
    const text = "token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("token: [redacted JWT]");
  });

  test("redacts Bearer header", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe("Authorization: Bearer [redacted Bearer header]");
  });

  test("preserves non-secrets", () => {
    const text = "This is a normal sentence with API=123 and test=true.";
    const res = redact(text, DEFAULT_PATTERNS);
    expect(res.body).toBe(text);
    expect(res.hits).toEqual([]);
  });

  test("respects BATON_NO_REDACT escape hatch", async () => {
    process.env.BATON_NO_REDACT = "1";
    const freshModule = await import(`../src/baton/redact.ts?escape=${crypto.randomUUID()}`);
    const text = "Here is my key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    const res = freshModule.redact(text, freshModule.DEFAULT_PATTERNS);
    expect(res.body).toBe(text);
    expect(res.hits).toEqual([]);
    expect(stderrOutput).toContain("redaction disabled");
  });

  test("logs BATON_NO_REDACT notice once per process", async () => {
    process.env.BATON_NO_REDACT = "1";
    const freshModule = await import(`../src/baton/redact.ts?once=${Date.now()}`);
    freshModule.redact("first", freshModule.DEFAULT_PATTERNS);
    freshModule.redact("second", freshModule.DEFAULT_PATTERNS);
    expect(stderrOutput.match(/redaction disabled/g)?.length).toBe(1);
  });
});

describe("loadUserPatterns & loadProjectPatterns", () => {
  const tmpDir = join(import.meta.dir, ".tmp-redact");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads user patterns correctly", () => {
    const userPath = join(tmpDir, ".claude", "baton-ignore");
    writeFileSync(userPath, "# comment\n\ncustom token:::my-custom-token-[a-z0-9]+\n\\bfoo_bar\\b\n");
    const patterns = loadUserPatterns(tmpDir);
    expect(patterns.length).toBe(2);
    expect(patterns[0]?.label).toBe("custom token");
    expect(patterns[0]?.regex?.source).toBe("my-custom-token-[a-z0-9]+");
    expect(patterns[1]?.label).toBe("user pattern");
    expect(patterns[1]?.regex?.source).toBe("\\bfoo_bar\\b");
  });

  test("loadUserPatterns loads .batonredact from home directory", () => {
    writeFileSync(join(tmpDir, ".batonredact"), "home token:::HOME_SECRET_[A-Z0-9]+\n");
    const patterns = loadUserPatterns(tmpDir);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.label).toBe("home token");
    expect(patterns[0]?.regex?.source).toBe("HOME_SECRET_[A-Z0-9]+");
  });

  test("loads project patterns correctly", () => {
    const projectPath = join(tmpDir, ".batonignore");
    writeFileSync(projectPath, "project_secret_\\d+");
    const patterns = loadProjectPatterns(tmpDir);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.label).toBe("user pattern");
    expect(patterns[0]?.regex?.source).toBe("project_secret_\\d+");
  });

  test("handles invalid regex gracefully", () => {
    const userPath = join(tmpDir, ".claude", "baton-ignore");
    writeFileSync(userPath, "foo:::invalid[regex\nvalid:::bar");

    const originalStderr = process.stderr.write;
    let localStderrOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      localStderrOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      const patterns = loadUserPatterns(tmpDir);
      expect(patterns.length).toBe(1);
      expect(patterns[0]?.label).toBe("valid");
      expect(localStderrOutput).toContain("invalid regex");
    } finally {
      process.stderr.write = originalStderr;
    }
  });

  test("supports alternation in labeled ignore patterns", () => {
    const projectPath = join(tmpDir, ".batonignore");
    writeFileSync(projectPath, "credential:::(token|secret)[a-z]+\n");
    const patterns = loadProjectPatterns(tmpDir);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.label).toBe("credential");
    expect(patterns[0]?.regex?.source).toBe("(token|secret)[a-z]+");
  });

  test("loads .batonredact overrides", () => {
    writeFileSync(join(tmpDir, ".batonredact"), "override:::custom_secret_[a-z]+\n");
    const patterns = loadProjectPatterns(tmpDir);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.label).toBe("override");
    expect(patterns[0]?.regex?.source).toBe("custom_secret_[a-z]+");
  });
});
