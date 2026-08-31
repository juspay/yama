/**
 * The smallest path matcher a review needs (TASKS:Y5.6).
 *
 * Deliberately not a dependency: the patterns a repository writes are `pnpm-lock.yaml`,
 * `*.svg`, `dist/**` — a handful of shapes, matched against repository-relative paths git
 * has already normalised. A full glob library would be a supply chain for that.
 *
 * Supported and nothing else: `*` (any run of characters inside one segment), `**` (any
 * number of segments), `?` (one character). A pattern naming no directory also matches by
 * BASENAME, which is what every ignore file means by `*.svg`.
 */

/** Everything a regular expression would read as syntax, except the wildcards. */
const escapeLiteral = (text: string): string =>
  text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern, anchored. `**` spans separators; `*` and `?` never do.
 *
 * A `**` segment followed by a separator spans ZERO or more directories, the way every
 * ignore file reads it. Joining it as a plain `.*` left a separator that something had to
 * fill, so the conventional double-star spelling of "any .svg anywhere" matched nothing at
 * the repository root — and since the basename fallback below is off for patterns with a
 * slash, a repository whose generated files sit at the root got no exclusion at all from
 * that spelling (reproduced against a real diff).
 */
const toRegExp = (pattern: string): RegExp => {
  const parts = pattern.split("**").map((between) =>
    between
      .split("*")
      .map((part) => escapeLiteral(part).replace(/\?/g, "[^/]"))
      .join("[^/]*"),
  );
  let source = parts[0] ?? "";
  for (const next of parts.slice(1)) {
    source += next.startsWith("/") ? `(?:.*/)?${next.slice(1)}` : `.*${next}`;
  }
  return new RegExp(`^${source}$`);
};

/** Whether one repository-relative path matches one pattern. */
export const matchesGlob = (path: string, pattern: string): boolean => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const cleaned = pattern.replace(/^\.\//, "");
  const expression = toRegExp(cleaned);
  if (expression.test(normalized)) {
    return true;
  }
  if (!cleaned.includes("/")) {
    return expression.test(normalized.slice(normalized.lastIndexOf("/") + 1));
  }
  return false;
};

/** Whether a path matches ANY pattern. An empty list matches nothing. */
export const matchesAnyGlob = (
  path: string,
  patterns: readonly string[],
): boolean => patterns.some((pattern) => matchesGlob(path, pattern));
