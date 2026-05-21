import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";
import { runRedactCommand } from "../src/baton/redact-cmd.ts";

let tempDir: string;
let stdoutCapture = "";
let stderrCapture = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let originalNoRedact: string | undefined;

function writeBaton(root: string, body: string): void {
  const batonDir = join(root, ".claude", "baton");
  mkdirSync(batonDir, { recursive: true });
  writeFileSync(join(batonDir, "BATON.md"), body, "utf8");
}

describe("baton redact command", () => {
  beforeEach(() => {
    tempDir = join(tmpdir(), `baton-redact-cmd-${crypto.randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(TEST_HOME, ".batonredact"), { force: true });
    originalNoRedact = process.env.BATON_NO_REDACT;
    delete process.env.BATON_NO_REDACT;
    stdoutCapture = "";
    stderrCapture = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(TEST_HOME, ".batonredact"), { force: true });
    if (originalNoRedact === undefined) delete process.env.BATON_NO_REDACT;
    else process.env.BATON_NO_REDACT = originalNoRedact;
  });

  test("applies patterns and strips secrets from stdout", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    writeBaton(tempDir, `# Baton\n\nkey: ${secret}\n`);

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toContain("[redacted Anthropic API key]");
    expect(stdoutCapture).not.toContain(secret);
    expect(stderrCapture).toBe("Redacted 1 secret(s)\n");
  });

  test("keeps redacted body on stdout and status on stderr", () => {
    writeBaton(tempDir, "# Baton\n\nnormal context\n");

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("# Baton\n\nnormal context\n");
    expect(stdoutCapture).not.toContain("Redacted");
    expect(stderrCapture).toBe("Redacted 0 secret(s)\n");
  });

  test("zero redactions still exits 0 and reports the count", () => {
    writeBaton(tempDir, "# Baton\n\nno secrets here\n");

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("# Baton\n\nno secrets here\n");
    expect(stderrCapture).toBe("Redacted 0 secret(s)\n");
  });

  test("missing BATON.md exits 1 with stderr", () => {
    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(1);
    expect(stdoutCapture).toBe("");
    expect(stderrCapture).toContain("baton redact: no .claude/baton/BATON.md found");
  });

  test("user .batonredact patterns are applied", () => {
    writeFileSync(join(TEST_HOME, ".batonredact"), "user token:::USER_SECRET_[A-Z0-9]+\n", "utf8");
    writeBaton(tempDir, "# Baton\n\nUSER_SECRET_ABC123\n");

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toContain("[redacted user token]");
    expect(stdoutCapture).not.toContain("USER_SECRET_ABC123");
    expect(stderrCapture).toBe("Redacted 1 secret(s)\n");
  });

  test("project .batonredact patterns are applied", () => {
    writeFileSync(join(tempDir, ".batonredact"), "project token:::PROJECT_SECRET_[A-Z0-9]+\n", "utf8");
    writeBaton(tempDir, "# Baton\n\nPROJECT_SECRET_ABC123\n");

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toContain("[redacted project token]");
    expect(stdoutCapture).not.toContain("PROJECT_SECRET_ABC123");
  });

  test("project .batonignore patterns are applied", () => {
    writeFileSync(join(tempDir, ".batonignore"), "project ignore:::IGNORE_SECRET_[A-Z0-9]+\n", "utf8");
    writeBaton(tempDir, "# Baton\n\nIGNORE_SECRET_ABC123\n");

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toContain("[redacted project ignore]");
    expect(stdoutCapture).not.toContain("IGNORE_SECRET_ABC123");
  });

  test("BATON_NO_REDACT=1 passes body through unchanged", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    process.env.BATON_NO_REDACT = "1";
    writeBaton(tempDir, `# Baton\n\nkey: ${secret}\n`);

    const code = runRedactCommand({ cwd: tempDir });

    expect(code).toBe(0);
    expect(stdoutCapture).toContain(secret);
    expect(stdoutCapture).not.toContain("[redacted Anthropic API key]");
    expect(stderrCapture).toContain("redaction disabled");
  });
});
