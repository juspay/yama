/**
 * `yama doctor` — prove the setup before anyone depends on it.
 *
 * Doctor exists because every expensive failure in v3 was a late failure: a run
 * that reviewed a PR for twenty minutes and then discovered it could not post.
 * Every check here is one that, if deferred, costs a whole run.
 *
 * It never calls a model and never writes to a pull request. Pure diagnosis.
 */

import type {
  CapabilityReport,
  ConfigNotice,
  DoctorCheck,
  DoctorInput,
  DoctorReport,
  DoctorStatus,
  ModelChains,
  ModelSlotName,
  ResolvedConfig,
  RunMode,
  ServerRegistration,
} from "../types/index.js";
import {
  CAPABILITY_PAIRS,
  REQUIRED_LIVE_CAPABILITIES,
} from "../types/index.js";
import {
  SLOT_ENFORCEMENT,
  describeSlotEnforcement,
  resolveModelChains,
} from "./NeurolinkFactory.js";
import { describePrompts } from "../prompts/PromptStore.js";

const worst = (statuses: DoctorStatus[]): DoctorStatus =>
  statuses.includes("fail")
    ? "fail"
    : statuses.includes("warn")
      ? "warn"
      : "ok";

/** Config-shape checks that need no network. */
export function inspectConfig(config: ResolvedConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const serverCount = Object.keys(config.mcp.servers).filter(
    (id) => config.mcp.servers[id].enabled !== false,
  ).length;
  checks.push({
    name: "connections",
    status: serverCount > 0 ? "ok" : "fail",
    detail: `${serverCount} server(s) enabled`,
    ...(serverCount === 0
      ? {
          remedy:
            "Add at least one server to .yama/mcp.yaml — Yama cannot read a pull request without one.",
        }
      : {}),
  });

  const declaring = Object.values(config.mcp.servers).filter(
    (server) =>
      server.capabilities && Object.keys(server.capabilities).length > 0,
  ).length;
  checks.push({
    name: "capability map",
    status: declaring > 0 ? "ok" : "warn",
    detail: `${declaring} server(s) declare capabilities`,
    ...(declaring === 0
      ? {
          remedy:
            "No server declares a `capabilities:` block. The agent can still use tools, " +
            "but code-driven posting and status need an explicit map.",
        }
      : {}),
  });

  // Checks are the one place Yama executes project-authored commands. Saying so
  // out loud in doctor is deliberate — this is the highest-blast-radius setting
  // in the product.
  const commandChecks = config.checks.checks.filter(
    (check) => check.run,
  ).length;
  if (commandChecks > 0) {
    checks.push({
      name: "checks",
      status: config.checks.allowForks ? "warn" : "ok",
      detail:
        `${commandChecks} command check(s) configured; ` +
        `forks ${config.checks.allowForks ? "ALLOWED" : "blocked"}`,
      ...(config.checks.allowForks
        ? {
            remedy:
              "allowForks runs project scripts on code from forks. That is arbitrary code " +
              "execution with this job's credentials. Enable it only for trusted forks.",
          }
        : {}),
    });
  }

  const blockingOwnership = config.ownership.filter(
    (rule) => rule.blocking,
  ).length;
  if (blockingOwnership > 0) {
    checks.push({
      name: "ownership",
      status: "ok",
      detail: `${blockingOwnership} blocking ownership rule(s) — listApprovals is required`,
    });
  }

  if (config.learn.trigger === "disabled") {
    checks.push({
      name: "learning",
      status: "warn",
      detail: "disabled",
      remedy:
        "Yama will review but never improve. Set learn.trigger to merge-event and " +
        "configure learn.git to let it write what it learns back to the repo.",
    });
  } else if (config.learn.mergeStrategy === "rebase") {
    checks.push({
      name: "learning",
      status: config.learn.trigger === "merge-event" ? "ok" : "fail",
      detail: `rebase merges, trigger=${config.learn.trigger}`,
      ...(config.learn.trigger !== "merge-event"
        ? {
            remedy:
              "Rebase merges leave no PR number in commit history. Learning must run on " +
              "the merge event, or it will attribute feedback to the wrong pull request.",
          }
        : {}),
    });
  }

  return checks;
}

/** Turn loader notices into doctor rows so nothing is only in a log line. */
export function inspectNotices(notices: ConfigNotice[]): DoctorCheck[] {
  return notices.map((notice) => ({
    name: "config notice",
    status: notice.level === "warn" ? ("warn" as const) : ("ok" as const),
    detail: notice.message,
  }));
}

/** Registration outcomes, one row per server. */
export function inspectRegistrations(
  registrations: ServerRegistration[],
): DoctorCheck[] {
  return registrations.map((registration) => {
    if (!registration.ok) {
      return {
        name: `server:${registration.id}`,
        status: "fail" as const,
        detail: registration.error ?? "registration failed",
        remedy: `Check the url/command, credentials, and network reachability for "${registration.id}".`,
      };
    }
    if (registration.tools.length === 0) {
      return {
        name: `server:${registration.id}`,
        status: "warn" as const,
        detail: "registered but advertised no tools",
        remedy:
          "Usually a credential or scope problem — the server connected but exposed nothing.",
      };
    }
    return {
      name: `server:${registration.id}`,
      status: "ok" as const,
      detail:
        `${registration.tools.length} tools` +
        (registration.allowlistEnforced ? " (allowlist enforced)" : ""),
    };
  });
}

/**
 * Capability checks.
 *
 * A capability missing in dry-run is a warning; the same gap in live mode is a
 * failure, because a live run that cannot post produces silence that reads to
 * the team as "no issues found".
 */
export function inspectCapabilities(
  report: CapabilityReport,
  mode: RunMode,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const severity: DoctorStatus = mode === "live" ? "fail" : "warn";

  for (const entry of report.missing) {
    checks.push({
      name: `capability:${entry.capability}`,
      status: severity,
      detail: `"${entry.serverId}" declares "${entry.declared}", which that server does not provide`,
      remedy:
        entry.available.length > 0
          ? `That server advertises: ${entry.available.slice(0, 20).join(", ")}`
          : "That server registered no tools — fix its registration first.",
    });
  }

  const have = new Set(report.resolved.map((entry) => entry.capability));
  for (const capability of REQUIRED_LIVE_CAPABILITIES) {
    if (!have.has(capability)) {
      checks.push({
        name: `capability:${capability}`,
        status: severity,
        detail: "not provided by any configured server",
        remedy: `Add "${capability}" to a server's \`capabilities:\` block in .yama/mcp.yaml.`,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: "capabilities",
      status: "ok",
      detail: `${report.resolved.length} resolved`,
    });
  }
  return checks;
}

/**
 * Report which model slots actually fail over.
 *
 * Stated explicitly because the alternative — letting an operator assume every
 * slot has fallback — turns a known limitation into a surprise outage.
 */
export function inspectModelSlots(chains: ModelChains): DoctorCheck[] {
  const probeOnly = (Object.keys(SLOT_ENFORCEMENT) as ModelSlotName[]).filter(
    (slot) =>
      SLOT_ENFORCEMENT[slot] === "probe" && chains[slot].members.length > 1,
  );

  const checks: DoctorCheck[] = [
    {
      name: "model fallback",
      status: "ok",
      detail: `${chains.base.members.length} member(s) in the base chain`,
    },
  ];

  if (probeOnly.length > 0) {
    checks.push({
      name: "model fallback (probe-only slots)",
      status: "warn",
      detail: `${probeOnly.join(", ")} carry multi-member chains that cannot pool`,
      remedy:
        "These slots take a single provider+model upstream. Yama picks the first reachable " +
        "member at startup, so they fail over between runs but not mid-run.",
    });
  }
  return checks;
}

/**
 * Checks specific to `yama doctor --learn`.
 *
 * Learning is the only path that holds write credentials, so it gets its own
 * proof. A team that discovers at merge time that the bot cannot push has
 * already lost the feedback from that pull request.
 */
export function inspectLearnWrite(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const git = config.learn.git;

  if (config.learn.trigger === "disabled") {
    return [
      {
        name: "learn:write",
        status: "warn",
        detail: "learning is disabled, so no write credential is needed",
      },
    ];
  }

  if (!git) {
    return [
      {
        name: "learn:write",
        status: "fail",
        detail: "learn.git is not configured",
        remedy:
          "Add learn.git with auth, the credential env var name, remote and branch. " +
          "Without it Yama can compute what it learned but cannot record it.",
      },
    ];
  }

  const auth = git.auth ?? "ssh";
  const variable =
    auth === "ssh"
      ? (git.sshKeyEnv ?? "YAMA_SSH_KEY")
      : (git.tokenEnv ?? "YAMA_GIT_TOKEN");
  const present = Boolean(env[variable] && env[variable]?.trim().length > 0);

  checks.push({
    name: `learn:credential (${auth})`,
    status: present ? "ok" : "fail",
    detail: present ? `${variable} is set` : `${variable} is unset or empty`,
    ...(present
      ? {}
      : {
          remedy:
            auth === "ssh"
              ? `Set ${variable} to the private key BODY (not a path) in your CI secret store.`
              : `Set ${variable} to a token with push access in your CI secret store.`,
        }),
  });

  checks.push({
    name: "learn:remote",
    status: git.remote ? "ok" : "fail",
    detail: git.remote ?? "not configured",
    ...(git.remote ? {} : { remedy: "Set learn.git.remote to the push URL." }),
  });

  if (config.learn.mode === "commit") {
    checks.push({
      name: "learn:branch",
      status: "warn",
      detail: `will push directly to ${git.branch ?? "main"}`,
      remedy:
        "If that branch is protected, this will fail at merge time. Set learn.mode to " +
        "'pull-request' to open a bot pull request instead.",
    });
  }

  return checks;
}

/** Assemble the full report. */
/**
 * Capabilities that only work as a pair.
 *
 * Mapping `beginReview` without `submitReview` opens a review for every run and
 * submits none of them: the comments are written, Yama reports success, and
 * nobody ever sees them. Silent and total, so it is checked at setup time.
 */
export function inspectCapabilityPairs(config: ResolvedConfig): DoctorCheck[] {
  const mapped = new Set<string>();
  for (const server of Object.values(config.mcp.servers)) {
    if (server.enabled === false) {
      continue;
    }
    for (const [name, binding] of Object.entries(server.capabilities ?? {})) {
      if (binding) {
        mapped.add(name);
      }
    }
  }

  return CAPABILITY_PAIRS.filter(
    ([first, second]) => mapped.has(first) !== mapped.has(second),
  ).map(([first, second]) => {
    const present = mapped.has(first) ? first : second;
    const absent = mapped.has(first) ? second : first;
    return {
      name: `capability pair: ${first} + ${second}`,
      status: "fail" as DoctorStatus,
      detail: `"${present}" is mapped but "${absent}" is not`,
      remedy:
        `Map "${absent}" too, or remove "${present}". Half of this pair posts ` +
        `comments that nobody can see.`,
    };
  });
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const chains = resolveModelChains(input.config);

  const checks: DoctorCheck[] = [
    ...inspectConfig(input.config),
    ...inspectCapabilityPairs(input.config),
    ...inspectModelSlots(chains),
    ...(input.registrations ? inspectRegistrations(input.registrations) : []),
    ...(input.capabilities
      ? inspectCapabilities(input.capabilities, input.mode)
      : []),
    ...(input.checkLearn
      ? inspectLearnWrite(input.config, input.env ?? process.env)
      : []),
    ...inspectNotices(input.config.notices),
  ];

  return {
    status: worst(checks.map((check) => check.status)),
    checks,
    slots: describeSlotEnforcement(chains),
    ...(input.prompts ? { prompts: describePrompts(input.prompts) } : {}),
  };
}

/** Render a report for a terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines: string[] = [];

  for (const check of report.checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.remedy) {
      lines.push(`    → ${check.remedy}`);
    }
  }

  lines.push("");
  lines.push("Model slots:");
  for (const slot of report.slots) {
    const note =
      slot.enforcement === "pool"
        ? "fails over mid-run"
        : slot.enforcement === "probe"
          ? "resolved at startup"
          : "NOT USED — setting this changes nothing";
    lines.push(`  ${slot.slot.padEnd(12)} ${slot.chain}  (${note})`);
  }

  if (report.prompts && report.prompts.length > 0) {
    lines.push("");
    lines.push("Prompts:");
    for (const prompt of report.prompts) {
      lines.push(`  ${prompt}`);
    }
  }

  lines.push("");
  lines.push(
    report.status === "ok"
      ? "All checks passed."
      : report.status === "warn"
        ? "Usable, with warnings above."
        : "Not ready — fix the failures above.",
  );
  return lines.join("\n");
}
