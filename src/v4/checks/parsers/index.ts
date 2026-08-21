/**
 * Check output parsers.
 *
 * SARIF is the primary path and the reason "any language" is achievable rather
 * than aspirational: ESLint, semgrep, ruff, golangci-lint, clippy, detekt,
 * bandit, trivy and CodeQL all emit it, so one parser covers most of the
 * ecosystem. The named parsers exist for the common tools that do not.
 *
 * Every parser is pure and total. A parser that throws would turn a linter
 * upgrade into a failed review, so unparseable output yields no findings and the
 * runner reports that plainly instead.
 */

import type {
  CheckFinding,
  CheckOutputParser,
  FindingSeverity,
  ParserName,
} from "../../types/index.js";

/** Map a tool's own severity label through the check's configured map. */
function mapSeverity(
  level: string | undefined,
  severityMap: Record<string, FindingSeverity> | undefined,
  fallback: FindingSeverity,
): FindingSeverity {
  if (!level) {
    return fallback;
  }
  const direct = severityMap?.[level];
  if (direct) {
    return direct;
  }
  const lower = level.toLowerCase();
  const insensitive = severityMap
    ? Object.entries(severityMap).find(
        ([key]) => key.toLowerCase() === lower,
      )?.[1]
    : undefined;
  if (insensitive) {
    return insensitive;
  }
  // Sensible defaults so a check works before anyone writes a severity map.
  if (["error", "fatal", "critical", "high", "2"].includes(lower)) {
    return "MAJOR";
  }
  if (["warning", "warn", "medium", "1"].includes(lower)) {
    return "MINOR";
  }
  if (["note", "info", "low", "hint", "0"].includes(lower)) {
    return "SUGGESTION";
  }
  return fallback;
}

/** Parse JSON, or return undefined. Never throws. */
function safeJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON. Every parser is total: unparseable output yields no findings,
    // and the runner reports that rather than failing the review.
    return undefined;
  }
}

/** SARIF 2.x — the universal path. */
export const parseSarif: CheckOutputParser = (output, context) => {
  const document = safeJson(output.stdout) as
    | { runs?: Array<{ results?: unknown[]; tool?: unknown }> }
    | undefined;
  if (!document?.runs) {
    return [];
  }

  const findings: CheckFinding[] = [];
  for (const run of document.runs) {
    for (const raw of run.results ?? []) {
      const result = raw as Record<string, unknown>;
      const location = (
        result.locations as Array<Record<string, unknown>> | undefined
      )?.[0]?.physicalLocation as Record<string, unknown> | undefined;
      const artifact = location?.artifactLocation as
        | Record<string, unknown>
        | undefined;
      const region = location?.region as Record<string, unknown> | undefined;
      const message = (result.message as Record<string, unknown> | undefined)
        ?.text;

      const level = typeof result.level === "string" ? result.level : undefined;
      findings.push({
        filePath:
          typeof artifact?.uri === "string"
            ? artifact.uri.replace(/^file:\/\//, "")
            : undefined,
        line: typeof region?.startLine === "number" ? region.startLine : null,
        level,
        // SARIF's default level is "warning" when omitted, per the spec.
        severity: mapSeverity(level ?? "warning", context.severityMap, "MINOR"),
        ruleId: typeof result.ruleId === "string" ? result.ruleId : undefined,
        message: typeof message === "string" ? message : "(no message)",
      });
    }
  }
  return findings;
};

/** ESLint `--format json`. */
export const parseEslint: CheckOutputParser = (output, context) => {
  const document = safeJson(output.stdout) as
    | Array<{ filePath?: string; messages?: unknown[] }>
    | undefined;
  if (!Array.isArray(document)) {
    return [];
  }

  const findings: CheckFinding[] = [];
  for (const file of document) {
    for (const raw of file.messages ?? []) {
      const message = raw as Record<string, unknown>;
      // ESLint encodes severity numerically: 2 = error, 1 = warning.
      const level = message.severity === 2 ? "error" : "warning";
      findings.push({
        filePath: file.filePath,
        line: typeof message.line === "number" ? message.line : null,
        level,
        severity: mapSeverity(level, context.severityMap, "MINOR"),
        ruleId: typeof message.ruleId === "string" ? message.ruleId : undefined,
        message:
          typeof message.message === "string"
            ? message.message
            : "(no message)",
      });
    }
  }
  return findings;
};

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** TypeScript compiler diagnostics. */
export const parseTsc: CheckOutputParser = (output, context) => {
  const findings: CheckFinding[] = [];
  for (const line of `${output.stdout}\n${output.stderr}`.split("\n")) {
    const match = TSC_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    findings.push({
      filePath: match[1],
      line: Number(match[2]),
      level: match[4],
      severity: mapSeverity(match[4], context.severityMap, "MAJOR"),
      ruleId: match[5],
      message: match[6],
    });
  }
  return findings;
};

/** JUnit XML — the common denominator for test reporters. */
export const parseJunit: CheckOutputParser = (output, context) => {
  const findings: CheckFinding[] = [];
  // Match only the OPENING tag, capturing whether it self-closes. Matching the
  // whole `<testcase ...>...</testcase>` in one pattern lets `[^>]*` swallow the
  // `/` of a self-closing tag, so one match spans two test cases and the wrong
  // test gets reported as the failing one.
  const openPattern = /<testcase\b([^>]*?)(\/?)>/g;
  // Anchored on a boundary: an unanchored /name="/ also matches inside
  // classname="...", which silently reports the suite as the test name.
  const attribute = (source: string, name: string): string | undefined =>
    new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source)?.[1];

  let match: RegExpExecArray | null = openPattern.exec(output.stdout);
  while (match !== null) {
    const attributes = match[1] ?? "";
    const selfClosing = match[2] === "/";

    if (!selfClosing) {
      const bodyStart = match.index + match[0].length;
      const bodyEnd = output.stdout.indexOf("</testcase>", bodyStart);
      const body = output.stdout.slice(
        bodyStart,
        bodyEnd === -1 ? output.stdout.length : bodyEnd,
      );
      const failure = /<(failure|error)\b([^>]*)/.exec(body);
      if (failure) {
        const name = attribute(attributes, "name") ?? "(unnamed test)";
        const suite = attribute(attributes, "classname");
        findings.push({
          filePath: attribute(attributes, "file"),
          line: null,
          level: failure[1],
          severity: mapSeverity(failure[1], context.severityMap, "MAJOR"),
          ruleId: suite,
          message: `${suite ? `${suite} \u203a ` : ""}${name}: ${
            attribute(failure[2] ?? "", "message") ?? "failed"
          }`,
        });
      }
    }
    match = openPattern.exec(output.stdout);
  }
  return findings;
};

/**
 * Generic `file:line: message` lines — the last resort before `parse: agent`.
 *
 * Deliberately conservative: it requires a path-like first field and a numeric
 * line, so ordinary prose in a script's output does not become a finding.
 */
const GENERIC_LINE = /^([^\s:][^:]*?):(\d+)(?::(\d+))?:\s*(?:(\w+):\s*)?(.+)$/;

export const parseRegex: CheckOutputParser = (output, context) => {
  const findings: CheckFinding[] = [];
  for (const line of `${output.stdout}\n${output.stderr}`.split("\n")) {
    const match = GENERIC_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    findings.push({
      filePath: match[1],
      line: Number(match[2]),
      level: match[4],
      severity: mapSeverity(match[4], context.severityMap, "MINOR"),
      message: match[5],
    });
  }
  return findings;
};

/**
 * `parse: agent` produces nothing here on purpose.
 *
 * Extraction needs a model, which this pure layer must not reach for. The runner
 * detects the empty result plus the "agent" parser and hands the raw output to
 * the extraction pass instead.
 */
export const parseAgent: CheckOutputParser = () => [];

export const PARSERS = {
  sarif: parseSarif,
  eslint: parseEslint,
  tsc: parseTsc,
  junit: parseJunit,
  regex: parseRegex,
  agent: parseAgent,
} as const;

export function getParser(name: ParserName | undefined): CheckOutputParser {
  // A config may name a parser this build does not ship; fall back rather than
  // fail the review over it.
  return PARSERS[name ?? "regex"] ?? PARSERS.regex;
}
