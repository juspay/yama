/**
 * Glob matching for path-scoped policy.
 *
 * A small, predictable subset rather than a full glob engine: `**` crosses
 * directory separators, `*` does not, `?` is one non-separator character, and
 * `{a,b}` alternates. Everything else is literal.
 *
 * Predictability is the point. These patterns decide who must approve a change
 * and which findings are floored to MAJOR, so a surprising match is a policy
 * failure. A dependency with its own edge cases would make that harder to reason
 * about, not easier.
 */

/** Convert one glob to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    if (char === "*") {
      const isDouble = glob[index + 1] === "*";
      if (isDouble) {
        // `**/` may match zero segments, so "src/**/x.ts" matches "src/x.ts".
        if (glob[index + 2] === "/") {
          out += "(?:[^/]*(?:/|$))*";
          index += 3;
          continue;
        }
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }

    if (char === "{") {
      const close = glob.indexOf("}", index);
      if (close !== -1) {
        const options = glob
          .slice(index + 1, close)
          .split(",")
          .map((option) => option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${options.join("|")})`;
        index = close + 1;
        continue;
      }
    }

    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  return new RegExp(`^${out}$`);
}

/** Normalise a path for matching: forward slashes, no leading "./". */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

const cache = new Map<string, RegExp>();

function compiled(glob: string): RegExp {
  let regex = cache.get(glob);
  if (!regex) {
    regex = globToRegExp(glob);
    cache.set(glob, regex);
  }
  return regex;
}

export function matchesPath(path: string, glob: string): boolean {
  return compiled(glob).test(normalizePath(path));
}

export function matchesAnyPath(
  path: string,
  globs: string[] | undefined,
): boolean {
  if (!globs || globs.length === 0) {
    return false;
  }
  const normalized = normalizePath(path);
  return globs.some((glob) => compiled(glob).test(normalized));
}

/**
 * Files that exist but that nobody writes by hand.
 *
 * Kept separate from user `excludePatterns` so a project can narrow its own
 * exclusions without accidentally opting into reviewing 40,000 lines of
 * generated protobuf.
 */
const GENERATED_MARKERS = [
  "**/*.generated.*",
  "**/*_generated.*",
  "**/*.gen.go",
  "**/*.pb.go",
  "**/*_pb2.py",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.freezed.dart",
  "**/*.g.dart",
];

export function looksGenerated(path: string): boolean {
  return matchesAnyPath(path, GENERATED_MARKERS);
}
