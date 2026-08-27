/**
 * The capability catalogue. `mcp.yaml` maps each capability to one discovered MCP tool
 * (PLAN.md section 3); an unmapped capability is simply off. Posting capabilities are
 * delivery-phase and are never exposed to workers (TASKS:Y5.1).
 */
// Needs `export * from "./config.js"` in src/types/index.ts (TASKS:Y1.1 integrate step).
import type {
  CapabilityId,
  DeliveryAction,
  RunTarget,
} from "../types/index.js";

/** Every capability Yama knows how to use. Unknown keys in `mcp.yaml` are rejected. */
export const CAPABILITY_IDS = [
  "pr.read",
  "pr.diff",
  "pr.describe",
  "comment.list",
  "comment.inline.create",
  "comment.summary.create",
  "comment.update",
  "verdict.set",
  "review.begin",
  "review.submit",
] as const;

/**
 * Phase decides when the tool may be exposed; `requires` are the paired capabilities that
 * must be mapped alongside it — posting without reading means no marker dedup (TASKS:Y4.3).
 */
export const CAPABILITIES = {
  "pr.read": { phase: "review", requires: [] },
  "pr.diff": { phase: "review", requires: [] },
  "pr.describe": { phase: "delivery", requires: ["pr.read"] },
  "comment.list": { phase: "review", requires: [] },
  "comment.inline.create": { phase: "delivery", requires: ["comment.list"] },
  "comment.summary.create": { phase: "delivery", requires: ["comment.list"] },
  "comment.update": { phase: "delivery", requires: ["comment.list"] },
  "verdict.set": { phase: "delivery", requires: [] },
  // The pending-review lifecycle, for forges where an inline comment is written into a
  // review that must be created first and submitted after (GitHub's consolidated server —
  // comments on a review nobody submits are invisible to everyone). Mapped BOTH or
  // NEITHER: each requires the other, so the probe refuses half a pair. Forges where an
  // inline comment is one call simply leave both unmapped — `comment.inline.create` does
  // not require them, so nothing else changes.
  "review.begin": {
    phase: "delivery",
    requires: ["review.submit", "comment.inline.create"],
  },
  "review.submit": { phase: "delivery", requires: ["review.begin"] },
} as const satisfies Record<
  (typeof CAPABILITY_IDS)[number],
  {
    phase: "review" | "delivery";
    requires: readonly (typeof CAPABILITY_IDS)[number][];
  }
>;

/**
 * Capabilities a run cannot be CORRECT without. Local and branch runs need no platform at
 * all, and neither needs a diff capability: the diff comes from git on every forge.
 *
 * A pull-request run needs exactly one thing — the comments already on it. Without them
 * marker dedup (TASKS:Y4.3) has nothing to read, and a re-review posts every finding a
 * second time. Everything else a pull-request run could want is a named degradation:
 * posting nothing is a visible, recoverable outcome; posting everything twice is not.
 */
export const requiredCapabilitiesFor = (target: RunTarget): CapabilityId[] =>
  target.mode === "pr" ? ["comment.list"] : [];

/** Capabilities only the main agent may hold, and only during Delivery (TASKS:Y5.1). */
export const isDeliveryCapability = (capability: CapabilityId): boolean =>
  CAPABILITIES[capability].phase === "delivery";

/**
 * The capability each delivery action cannot run without (TASKS:Y3.5). Config asking for
 * an action whose capability is unmapped turns that action off and says so — the same
 * degradation matrix as everywhere else (TASKS:Y1.2).
 */
export const DELIVERY_CAPABILITIES = {
  inlineComments: "comment.inline.create",
  summaryComment: "comment.summary.create",
  verdict: "verdict.set",
  describe: "pr.describe",
} as const satisfies Record<DeliveryAction, CapabilityId>;
