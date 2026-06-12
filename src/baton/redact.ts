import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface RedactPattern {
  regex: RegExp;
  label: string;
  redactCaptureGroup?: number;
}

export const DEFAULT_PATTERNS: RedactPattern[] = [
  { regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, label: "Anthropic API key" },
  { regex: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "OpenAI-style API key" },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS access key ID" },
  {
    regex: /\b(aws_secret_access_key\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(['"]?)/gi,
    label: "AWS secret access key",
    redactCaptureGroup: 2,
  },
  { regex: /\bghp_[A-Za-z0-9]{36,}\b/g, label: "GitHub classic token" },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "GitHub fine-grained token" },
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "JWT" },
  {
    regex: /\b((?:Authorization|authorization)\s*:\s*Bearer\s+)([A-Za-z0-9_\-.]+)/g,
    label: "Bearer header",
    redactCaptureGroup: 2,
  },
  {
    regex: /\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\s*[:=]\s*['"]?)([A-Za-z0-9_\-+/=]{16,})(['"]?)/g,
    label: "secret assignment",
    redactCaptureGroup: 2,
  },
];

const LABELED_PATTERN_DELIMITER = ":::";
let warnedNoRedact = false;

function parseIgnoreFile(path: string): RedactPattern[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const patterns: RedactPattern[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line || line.startsWith("#")) continue;

    let label = "user pattern";
    let regexStr = line;

    const delimiterIndex = line.indexOf(LABELED_PATTERN_DELIMITER);
    if (delimiterIndex !== -1) {
      label = line.substring(0, delimiterIndex).trim();
      regexStr = line.substring(delimiterIndex + LABELED_PATTERN_DELIMITER.length).trim();
    }

    try {
      patterns.push({
        regex: new RegExp(regexStr, "g"),
        label,
      });
    } catch (err) {
      process.stderr.write(`baton: warning: invalid regex in ${path}:${i + 1}: ${(err as Error).message}\n`);
    }
  }

  return patterns;
}

export function loadUserPatterns(userHome: string): RedactPattern[] {
  const newPath = join(userHome, ".baton", "ignore");
  const legacyPath = join(userHome, ".claude", "baton-ignore");
  return [
    ...parseIgnoreFile(newPath),
    ...(legacyPath === newPath ? [] : parseIgnoreFile(legacyPath)),
    ...parseIgnoreFile(join(userHome, ".batonredact")),
  ];
}

export function loadProjectPatterns(cwd: string): RedactPattern[] {
  return [
    ...parseIgnoreFile(join(cwd, ".batonignore")),
    ...parseIgnoreFile(join(cwd, ".batonredact")),
  ];
}

export function redactSecrets(body: string, patterns: RedactPattern[]): { body: string; hits: Array<{ label: string; count: number }> } {
  if (process.env.BATON_NO_REDACT === "1") {
    if (!warnedNoRedact) {
      process.stderr.write("baton: notice: redaction disabled via BATON_NO_REDACT=1\n");
      warnedNoRedact = true;
    }
    return { body, hits: [] };
  }

  let redactedBody = body;
  const hitCounts = new Map<string, number>();

  for (const pattern of patterns) {
    let matchCount = 0;

    redactedBody = redactedBody.replace(pattern.regex, (match, ...args) => {
      matchCount++;

      if (pattern.redactCaptureGroup !== undefined) {
        const capture = args[pattern.redactCaptureGroup - 1];
        if (typeof capture === "string") {
          // Splice by offset rather than match.replace(capture, ...), which
          // replaces the first occurrence and corrupts the match when the
          // secret string also appears in the prefix groups. Assumes groups
          // 1..N-1 are contiguous from the start of the match, which holds
          // for all (prefix)(secret)(suffix)-shaped patterns.
          let offset = 0;
          for (let g = 1; g < pattern.redactCaptureGroup; g++) {
            const part = args[g - 1];
            if (typeof part === "string") offset += part.length;
          }
          if (match.startsWith(capture, offset)) {
            return match.slice(0, offset) + `[redacted ${pattern.label}]` + match.slice(offset + capture.length);
          }
          // Group layout didn't match the assumption — redact the whole match
          // rather than risk leaving the secret in place.
        }
      }

      return `[redacted ${pattern.label}]`;
    });

    if (matchCount > 0) {
      hitCounts.set(pattern.label, (hitCounts.get(pattern.label) || 0) + matchCount);
    }
  }

  const hits = Array.from(hitCounts.entries()).map(([label, count]) => ({ label, count }));
  return { body: redactedBody, hits };
}

export const redact = redactSecrets;
