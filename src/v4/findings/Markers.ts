/**
 * Comment markers — the source of truth for cross-run deduplication.
 *
 * A marker embedded in a posted comment makes the pull request itself the
 * record of what Yama has already said. That matters more than it sounds:
 * without it, dedup depends on a state file, and when that file is missing
 * (fresh CI runner, expired artifact, first run after a config change) the
 * reviewer re-posts everything it said last time. Markers survive all of that,
 * which is why the state store is an optimisation here and not a dependency.
 *
 * Trust rule: only comments authored by the configured bot identity count. A
 * marker pasted or quoted by a human must never suppress a finding, and Yama
 * must never edit someone else's comment.
 */

import { createHash } from "node:crypto";
import type {
  MarkerScan,
  CandidateFinding,
  ExistingComment,
  MarkerKind,
  ParsedMarker,
} from "../types/index.js";

const MARKER_PATTERN =
  /<!--\s*yama:(finding|summary|owners)(?::([A-Za-z0-9_-]+))?\s*-->/g;

/** Render a marker for embedding in a comment body. */
export function renderMarker(kind: MarkerKind, id?: string): string {
  return id ? `<!-- yama:${kind}:${id} -->` : `<!-- yama:${kind} -->`;
}

/** Every marker in a body. A body may legitimately carry more than one. */
export function parseMarkers(body: string): ParsedMarker[] {
  const found: ParsedMarker[] = [];
  // Fresh lastIndex per call — a module-level global regex is stateful.
  const pattern = new RegExp(MARKER_PATTERN.source, "g");
  let match: RegExpExecArray | null = pattern.exec(body);
  while (match !== null) {
    found.push({
      kind: match[1] as MarkerKind,
      ...(match[2] ? { id: match[2] } : {}),
    });
    match = pattern.exec(body);
  }
  return found;
}

/**
 * Content-derived finding identity.
 *
 * Deliberately includes the title: two findings at the same location saying
 * different things are different findings, and collapsing them would silence
 * one. Deliberately excludes the description and suggestion, which the model
 * rephrases run to run without the underlying problem changing.
 *
 * Normalisation is minimal — case and whitespace only. Anything cleverer
 * (stemming, fuzzy matching) makes identity unpredictable, and an unpredictable
 * id is worse than a slightly brittle one: it produces silent duplicates.
 */
export function buildFindingId(
  finding: Pick<CandidateFinding, "severity" | "title" | "filePath" | "line">,
): string {
  const normalize = (value: string | undefined | null): string =>
    (value ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");

  const parts = [
    normalize(finding.severity),
    normalize(finding.filePath),
    finding.line === undefined || finding.line === null
      ? ""
      : String(finding.line),
    normalize(finding.title),
  ];
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

/** True when a comment was written by the identity Yama posts as. */
export function isBotAuthored(
  comment: ExistingComment,
  botIdentity: string | undefined,
): boolean {
  if (!botIdentity) {
    // With no identity configured we cannot distinguish Yama's comments from
    // anyone else's. Trusting every marker would let a human's quoted marker
    // suppress a real finding, so trust nothing instead.
    return false;
  }
  const author = (comment.author ?? "").trim().toLowerCase();
  return author.length > 0 && author === botIdentity.trim().toLowerCase();
}

/**
 * Scan a pull request's comments for Yama's markers.
 *
 * When several bot-authored summary comments exist (races from older runs), the
 * LAST one wins. Callers update that one and leave the rest untouched — deleting
 * another run's comment risks destroying a summary a human is mid-way through
 * reading, and converging on the newest is enough to keep the PR tidy.
 */
export function scanMarkers(
  comments: ExistingComment[],
  botIdentity: string | undefined,
): MarkerScan {
  const scan: MarkerScan = {
    reportedFindingIds: new Set(),
    commentByFinding: new Map(),
    untrustedMarkers: 0,
  };

  for (const comment of comments) {
    const markers = parseMarkers(comment.body ?? "");
    if (markers.length === 0) {
      continue;
    }
    if (!isBotAuthored(comment, botIdentity)) {
      scan.untrustedMarkers += markers.length;
      continue;
    }
    for (const marker of markers) {
      if (marker.kind === "finding" && marker.id) {
        scan.reportedFindingIds.add(marker.id);
        scan.commentByFinding.set(marker.id, comment.id);
      } else if (marker.kind === "summary") {
        scan.summaryCommentId = comment.id;
      } else if (marker.kind === "owners") {
        scan.ownersCommentId = comment.id;
      }
    }
  }

  return scan;
}

/** Append a marker to a body, unless that exact marker is already present. */
export function withMarker(
  body: string,
  kind: MarkerKind,
  id?: string,
): string {
  const marker = renderMarker(kind, id);
  if (body.includes(marker)) {
    return body;
  }
  return `${body.trimEnd()}\n\n${marker}`;
}
