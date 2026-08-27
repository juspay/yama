/**
 * Finding markers and the findings ledger (TASKS:Y5.3).
 *
 * A marker carries a finding id in every comment Yama posts, in TWO forms: an HTML
 * comment — `<!-- yama:finding:auth-token-log -->` — invisible in the rendered comment,
 * and a small visible token — `` `yama:finding:auth-token-log` `` — because some forge
 * reads return PROCESSED body text that strips HTML comments (GitHub's hosted MCP
 * review-thread listing does), and a marker that cannot be read back cannot dedupe.
 * The marker is the ONLY thing that makes a re-review idempotent: the run store is a CI
 * artifact and can be absent, but a comment that is already on the pull request always
 * carries its own id. So dedup reads the target, not the store (TASKS:Y4.3).
 *
 * The ledger is the store-side half: what this run found, by id, so a later run can ask
 * what the last one left open (TASKS:Y7.1) without re-deriving it from comments.
 */
import { readLedger, writeLedger } from "../store/index.js";
import type { Finding, FindingsLedger, RunStorePaths } from "../types/index.js";

/** Prefix of the HTML marker that makes a posted finding deduplicable across runs. */
export const FINDING_MARKER_PREFIX = "<!-- yama:finding:";

/**
 * What a marker identifies. `finding` is the one that matters for dedup; `run` marks the
 * per-run summary comment, so Delivery can confirm the summary landed by the same
 * mechanism it confirms an inline comment with (TASKS:Y4.4).
 */
const DEFAULT_KIND = "finding";

/**
 * Only the marker's PREFIX is matched by regex — literal text and `\w+` have no
 * quantifier ambiguity, so the scan is linear (the earlier `\s*(\S+?)\s*` form
 * backtracked polynomially on crafted comment bodies). Matching the bare `yama:kind:`
 * prefix reads BOTH forms — the HTML comment contains it, and so does the visible token —
 * plus the HTML form written without spaces. The id is then taken by index arithmetic
 * over its allowed characters. The KIND is captured too, so one scan cannot confuse a
 * run marker for a finding marker.
 */
const MARKER_PREFIX_PATTERN = /yama:(\w+):/g;

/** Characters an id is made of; anything else ends it. */
const ID_CHAR = /[A-Za-z0-9._-]/;

/** The id following one prefix match, or undefined when nothing id-like follows. */
const idAfterPrefix = (text: string, start: number): string | undefined => {
  let end = start;
  while (end < text.length && ID_CHAR.test(text.charAt(end))) {
    end += 1;
  }
  let id = text.slice(start, end);
  // A space-less HTML close (`<!--yama:finding:x-->`) leaves its dashes on the id.
  if (text.startsWith(">", end) && id.endsWith("--")) {
    id = id.slice(0, -2);
  }
  return id.length > 0 ? id : undefined;
};

/** The marker for one id of one kind, exactly as it is posted. */
export const yamaMarker = (kind: string, id: string): string =>
  `<!-- yama:${kind}:${id} -->`;

/** The marker for one finding id, exactly as it is posted. */
export const findingMarker = (id: string): string =>
  yamaMarker(DEFAULT_KIND, id);

/** Every id of `kind` marked in a text, in the order it appears, each id once. */
export const scanMarkers = (text: string, kind = DEFAULT_KIND): string[] => {
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKER_PREFIX_PATTERN)) {
    if (match[1] !== kind) {
      continue;
    }
    // Both forms of one marker resolve to the same id; the Set keeps it once.
    const id = idAfterPrefix(text, match.index + match[0].length);
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return [...ids];
};

/**
 * The comment body to post: the text plus its marker in both forms — the invisible HTML
 * comment and the visible token that survives forges which strip HTML from read-back
 * bodies. Idempotent — a body that already carries this marker is returned untouched, so
 * a re-render never double-marks.
 */
export const withMarker = (kind: string, id: string, body: string): string =>
  scanMarkers(body, kind).includes(id)
    ? body
    : `${body}\n\n${yamaMarker(kind, id)}\n\`yama:${kind}:${id}\``;

/** The comment body to post for one finding. */
export const withFindingMarker = (id: string, body: string): string =>
  withMarker(DEFAULT_KIND, id, body);

/**
 * Merge findings into a ledger by id: an id seen again is REPLACED (the newer run knows
 * more), an unseen one is appended. Order is stable, so the ledger reads as a history.
 */
export const mergeFindings = (
  existing: readonly Finding[],
  incoming: readonly Finding[],
): Finding[] => {
  const byId = new Map(incoming.map((finding) => [finding.id, finding]));
  const merged = existing.map((finding) => {
    const replacement = byId.get(finding.id);
    byId.delete(finding.id);
    return replacement ?? finding;
  });
  return [...merged, ...byId.values()];
};

/** Merges findings into the run store's ledger and writes it back. */
export const recordFindings = async (
  paths: RunStorePaths,
  findings: readonly Finding[],
): Promise<FindingsLedger> => {
  const ledger = await readLedger(paths);
  const updated: FindingsLedger = {
    updatedAt: new Date().toISOString(),
    findings: mergeFindings(ledger.findings, findings),
  };
  await writeLedger(paths, updated);
  return updated;
};
