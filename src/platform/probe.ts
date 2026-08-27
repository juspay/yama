/**
 * The startup capability probe (TASKS:Y1.3).
 *
 * The config layer already checks that the capability map is well FORMED. This checks that
 * it is TRUE: every capability it claims is compared against the tools the servers really
 * advertised, and paired capabilities are checked together against the live set rather
 * than the declared one — posting without reading means findings cannot be deduped by
 * marker (TASKS:Y4.3), and that has to be caught before the first comment is posted.
 *
 * Two failure modes, deliberately treated differently:
 *   - a mapped tool no connected server exposes is a config LIE — always loud, and the
 *     message lists the tools that server does expose, which is the fix;
 *   - a server that would not connect is an OUTAGE — the capabilities behind it degrade,
 *     and the run only fails if it needed one of them (`required`).
 */
import { CAPABILITIES, CAPABILITY_IDS } from "../config/capabilities.js";
import { ConfigError } from "../config/errors.js";
import type {
  CapabilityBindings,
  CapabilityId,
  CapabilityProbe,
  CapabilityProbeEntry,
  ConfigDegradation,
  McpConnection,
} from "../types/index.js";

const listed = (names: readonly string[]): string =>
  names.length > 0 ? names.join(", ") : "(none)";

/** Classifies one mapped capability against what the servers actually advertised. */
const classify = (
  capability: CapabilityId,
  bindings: CapabilityBindings,
  connections: readonly McpConnection[],
): CapabilityProbeEntry => {
  const binding = bindings[capability];
  if (binding === undefined) {
    return {
      capability,
      status: "unmapped",
      detail: "not mapped in mcp.yaml",
    };
  }
  const { server, tool } = binding;
  const connection = connections.find((entry) => entry.id === server);
  if (connection === undefined) {
    return {
      capability,
      status: "server-unknown",
      server,
      tool,
      detail: `server "${server}" was never connected`,
    };
  }
  if (connection.error !== undefined) {
    return {
      capability,
      status: "server-unavailable",
      server,
      tool,
      detail: `server "${server}" did not connect: ${connection.error}`,
    };
  }
  if (!connection.tools.includes(tool)) {
    return {
      capability,
      status: "tool-missing",
      server,
      tool,
      detail: `server "${server}" exposes no tool "${tool}" — it exposes: ${listed(connection.tools)}`,
    };
  }
  return {
    capability,
    status: "ok",
    server,
    tool,
    detail: `${server}.${tool}`,
  };
};

/**
 * Probes the declared capability map against the discovered tools.
 *
 * Returns the whole table — `yama doctor` prints it verbatim — plus the `live` map a run
 * may act on. Nothing throws here: `assertProbe` decides what is fatal, so the doctor can
 * report every problem at once instead of stopping at the first.
 */
export const probeCapabilities = (input: {
  bindings: CapabilityBindings;
  connections: readonly McpConnection[];
}): CapabilityProbe => {
  const entries = CAPABILITY_IDS.map((capability) =>
    classify(capability, input.bindings, input.connections),
  );
  const live: CapabilityBindings = {};
  for (const entry of entries) {
    const binding = input.bindings[entry.capability];
    if (entry.status === "ok" && binding !== undefined) {
      live[entry.capability] = binding;
    }
  }

  // Paired capabilities, re-checked against what survived. A pair that is dead for the
  // same reason (their shared server is down) is not a pair violation — both are off.
  const pairProblems: string[] = [];
  for (const entry of entries) {
    if (entry.status !== "ok") {
      continue;
    }
    for (const pair of CAPABILITIES[entry.capability].requires) {
      if (live[pair] === undefined) {
        const reason =
          entries.find((row) => row.capability === pair)?.detail ?? "unmapped";
        delete live[entry.capability];
        entry.status = "pair-missing";
        entry.detail = `needs "${pair}", which is not available — ${reason}`;
        pairProblems.push(
          `capability "${entry.capability}" is live but its pair "${pair}" is not (${reason})`,
        );
      }
    }
  }

  const degradations: ConfigDegradation[] = entries
    .filter((entry) => entry.status !== "ok")
    .map((entry) => ({ what: entry.capability, reason: entry.detail }));

  const problems = [
    ...entries
      .filter((entry) => entry.status === "tool-missing")
      .map((entry) => `capability "${entry.capability}": ${entry.detail}`),
    ...pairProblems,
  ];

  return {
    connections: [...input.connections],
    entries,
    live,
    degradations,
    problems,
  };
};

/**
 * Fails the run when a capability it cannot start without is not live.
 *
 * Everything else the probe disliked — a mapped tool nobody serves, a pair broken by an
 * outage — DEGRADES here, for the same reason the config layer degrades an unmapped
 * delivery action rather than refusing to review: a misconfigured optional capability
 * should cost that capability, not the whole review, and the run report names every one
 * that was switched off. It is still carried in `probe.problems`, and `yama doctor` calls
 * it BROKEN and exits non-zero — which is the right moment to be loud about it, before CI
 * ever depends on it.
 */
export const assertProbe = (
  probe: CapabilityProbe,
  required: readonly CapabilityId[],
  file: string,
): void => {
  const reasons = required
    .filter((capability) => probe.live[capability] === undefined)
    .map((capability) => {
      const detail =
        probe.entries.find((entry) => entry.capability === capability)
          ?.detail ?? "unmapped";
      return `this run cannot start without "${capability}": ${detail}`;
    });
  if (reasons.length === 0) {
    return;
  }
  throw new ConfigError(
    `${file}: the capability probe failed —\n  ${reasons.join("\n  ")}`,
    {
      file,
      hint: "run `yama doctor` for the full table: every capability, the server behind it, and the tools that server actually exposes",
    },
  );
};
