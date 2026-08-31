/**
 * `yama doctor` (TASKS:Y6.2) — prove the configuration before a review depends on it.
 *
 * It runs the same startup path a review does: load `.yama/`, connect every declared MCP
 * server, and probe the capability map against the tools those servers really advertise
 * (TASKS:Y1.3). The difference is that it reports EVERY problem instead of stopping at the
 * first, and every broken row carries the fix — this is the command an operator runs at
 * 3am, and "something is wrong" is not a useful thing to tell them.
 */
import { join } from "node:path";
import {
  CONFIG_DIR,
  CONFIG_FILES,
  ConfigError,
  DELIVERY_CAPABILITIES,
  MODEL_ROLES,
  formatModelChain,
  loadConfig,
} from "../config/index.js";
import { connectMcpServers, probeCapabilities } from "../platform/index.js";
import { gitDefaultBranch, gitHasRef, isGitRepo } from "../tools/index.js";
import { LegacyChecksError, readChecksAtRef } from "../tools/index.js";
import type {
  ConfigDegradation,
  DoctorCheck,
  DoctorReport,
  Engine,
  McpConnection,
  ResolvedConfig,
  RunTarget,
} from "../types/index.js";
import { buildEngineConfig } from "./engineConfig.js";

/** One row per configured model chain — a role with no provider cannot run a stage. */
const modelChecks = (config: ResolvedConfig): DoctorCheck[] =>
  MODEL_ROLES.map((role) => {
    const chain = config.chains[role];
    return chain.length > 0
      ? {
          group: "models",
          name: role,
          status: "ok" as const,
          detail: formatModelChain(chain),
        }
      : {
          group: "models",
          name: role,
          status: "broken" as const,
          detail: "no provider resolved for this role",
          fix: `declare models.${role} in ${CONFIG_DIR}/${CONFIG_FILES.yama}`,
        };
  });

/**
 * Whether this run would actually have a memory (TASKS:Y2.5).
 *
 * Worth a row of its own because its absence is INVISIBLE at run time: with memory off
 * every stage still answers, it just answers having forgotten the stage before it — which
 * is how a review once approved a change it had never read.
 *
 * Read off CONFIG, not off the engine: initialization is lazy, so at doctor time — before
 * a single generate — no engine can honestly say more than what it was asked for. What
 * actually came up is the run report's business (`memoryStatus`).
 */
const memoryCheck = (config: ResolvedConfig): DoctorCheck => {
  if (!config.yama.memory.enabled) {
    return {
      group: "models",
      name: "memory",
      status: "off",
      detail:
        "off — every stage, retry and nudge round starts from nothing, and a stage that fails cannot be recovered",
      fix: `set memory.enabled: true in ${CONFIG_DIR}/${CONFIG_FILES.yama}`,
    };
  }
  return {
    group: "models",
    name: "memory",
    status: "ok",
    detail: `on, ${config.yama.memory.tokenThreshold} tokens of history, summarized by ${formatModelChain(config.chains.summarizer)} within ${config.yama.memory.summarizeTimeoutMs}ms`,
  };
};

/** One row per declared MCP server: what it exposed, or why it exposed nothing. */
const serverChecks = (connections: readonly McpConnection[]): DoctorCheck[] =>
  connections.length === 0
    ? [
        {
          group: "mcp",
          name: "servers",
          status: "off",
          detail: `no servers declared in ${CONFIG_DIR}/${CONFIG_FILES.mcp} — this workspace can review, but it cannot read or post on a pull request`,
        },
      ]
    : connections.map((connection) =>
        connection.error === undefined
          ? {
              group: "mcp",
              name: connection.id,
              status: "ok" as const,
              detail: `connected, ${connection.tools.length} tool(s): ${connection.tools.join(", ") || "(none)"}`,
            }
          : {
              group: "mcp",
              name: connection.id,
              status: "broken" as const,
              detail: connection.error,
              fix: "check the command, the transport and the credentials this server needs; every ${VAR} in its env or headers must be exported",
            },
      );

/**
 * The capability table, straight off the probe: mapped, live, or off and why.
 *
 * `reasonFor` comes from the config layer, because the probe only knows that a binding was
 * absent — not that it was mapped correctly and simply cannot be used by THIS target mode.
 * A row that says "not mapped" about a capability the operator did map is a bug report
 * waiting to happen.
 */
const capabilityChecks = (
  entries: readonly { capability: string; status: string; detail: string }[],
  reasonFor: (capability: string) => string | undefined,
): DoctorCheck[] =>
  entries.map((entry) => ({
    group: "capabilities",
    name: entry.capability,
    detail:
      entry.status === "unmapped"
        ? (reasonFor(entry.capability) ?? entry.detail)
        : entry.detail,
    status:
      entry.status === "ok"
        ? ("ok" as const)
        : entry.status === "unmapped"
          ? ("off" as const)
          : ("broken" as const),
    ...(entry.status === "tool-missing"
      ? {
          fix: `point this capability at a tool that server actually exposes, in ${CONFIG_DIR}/${CONFIG_FILES.mcp}`,
        }
      : {}),
    ...(entry.status === "pair-missing"
      ? {
          fix: "map the paired capability as well, or drop this one — posting without reading means findings cannot be deduped by marker",
        }
      : {}),
  }));

/** What Delivery could actually do, action by action, against the LIVE capability map. */
const deliveryChecks = (
  config: ResolvedConfig,
  live: (capability: string) => boolean,
): DoctorCheck[] =>
  config.deliveryActions.length === 0
    ? [
        {
          group: "delivery",
          name: "actions",
          status: "off",
          detail:
            "nothing would be delivered — either config asks for nothing, or no posting capability is mapped",
        },
      ]
    : config.deliveryActions.map((action) => {
        const capability = DELIVERY_CAPABILITIES[action];
        return live(capability)
          ? {
              group: "delivery",
              name: action,
              status: "ok" as const,
              detail: `backed by "${capability}"`,
            }
          : {
              group: "delivery",
              name: action,
              status: "off" as const,
              detail: `capability "${capability}" is not available, so this action would not run`,
            };
      });

/** Git: a work tree, and — for a branch or pull request — a base ref to diff against. */
const gitChecks = async (
  root: string,
  target: RunTarget,
): Promise<DoctorCheck[]> => {
  if (!(await isGitRepo(root))) {
    return [
      {
        group: "git",
        name: "work tree",
        status: "broken",
        detail: `${root} is not a git work tree`,
        fix: "run yama from inside the repository checkout",
      },
    ];
  }
  const checks: DoctorCheck[] = [
    { group: "git", name: "work tree", status: "ok", detail: root },
  ];
  if (target.mode === "local") {
    return checks;
  }
  const base = target.base ?? (await gitDefaultBranch(root));
  checks.push(
    base !== undefined && (await gitHasRef(root, base))
      ? {
          group: "git",
          name: "base ref",
          status: "ok",
          detail: `${base} — the diff is merge-base(${base}, head)..head`,
        }
      : {
          group: "git",
          name: "base ref",
          status: "broken",
          detail: `no base ref resolves${base !== undefined ? ` (tried "${base}")` : ""}`,
          fix: "pass --base <ref>, and make sure CI clones deep enough to have it (fetch-depth: 0)",
        },
  );
  return checks;
};

/** The checks the BASE branch declares — the only ones a review would ever run. */
const checkChecks = async (
  root: string,
  target: RunTarget,
): Promise<DoctorCheck[]> => {
  const ref =
    target.mode === "local"
      ? "HEAD"
      : (target.base ?? (await gitDefaultBranch(root)));
  if (ref === undefined) {
    return [];
  }
  try {
    const checks = await readChecksAtRef({ root, ref });
    const declared = checks?.checks ?? [];
    return [
      {
        group: "checks",
        name: `${CONFIG_FILES.checks} @ ${ref}`,
        status: declared.length > 0 ? "ok" : "off",
        detail:
          declared.length > 0
            ? declared
                .map((check) => `${check.id}: ${check.command.join(" ")}`)
                .join(" · ")
            : `no checks declared on ${ref} — run_check would refuse every call, and no command is allowlisted`,
      },
    ];
  } catch (error) {
    if (error instanceof LegacyChecksError) {
      // The format-migration run: off with the reason named, not a failed setup.
      return [
        {
          group: "checks",
          name: `${CONFIG_FILES.checks} @ ${ref}`,
          status: "off",
          detail: error.message,
        },
      ];
    }
    return [
      {
        group: "checks",
        name: `${CONFIG_FILES.checks} @ ${ref}`,
        status: "broken",
        detail: error instanceof Error ? error.message : String(error),
        fix: `fix ${CONFIG_DIR}/${CONFIG_FILES.checks} on ${ref} — it is read from the base branch, not from the working tree`,
      },
    ];
  }
};

/**
 * The degradation matrix: every optional piece this workspace would run without, in one
 * list, exactly as a run report carries it.
 *
 * Both sources can name the same thing — an unmapped capability is a config degradation
 * AND a probe degradation — so the first reason wins. Config's is the more specific of the
 * two (it knows the capability was never mapped, or that this target mode cannot use it);
 * the probe only knows the binding was absent.
 */
const mergeDegradations = (
  ...sources: readonly (readonly ConfigDegradation[])[]
): ConfigDegradation[] => {
  const byWhat = new Map<string, ConfigDegradation>();
  for (const degradation of sources.flat()) {
    if (!byWhat.has(degradation.what)) {
      byWhat.set(degradation.what, degradation);
    }
  }
  return [...byWhat.values()];
};

/**
 * Runs the whole probe. The engine is injectable for the same reason it is on `runReview`:
 * everything except the MCP connect is testable without a provider.
 */
export const runDoctor = async (options: {
  root: string;
  target: RunTarget;
  engine?: Engine;
}): Promise<DoctorReport> => {
  const { root, target } = options;
  let config: ResolvedConfig;
  try {
    config = await loadConfig(root, target);
  } catch (error) {
    // ConfigError already appends its hint to the message; the report has its own
    // column for it, so the two must not print the same sentence twice.
    const message = error instanceof Error ? error.message : String(error);
    const broken: DoctorCheck = {
      group: "config",
      name: CONFIG_DIR,
      status: "broken",
      detail: message.split("\n  fix: ")[0],
      ...(error instanceof ConfigError && error.hint !== undefined
        ? { fix: error.hint }
        : { fix: "run `yama init` to scaffold a valid .yama/" }),
    };
    return { root, target, checks: [broken], degradations: [], ok: false };
  }

  const engine =
    options.engine ??
    (await import("../engine/index.js")).createEngine(
      buildEngineConfig(config, {
        runId: "doctor",
        target,
        root,
        storeDir: join(config.paths.artifactsDir, "doctor"),
        dryRun: true,
      }),
    );
  const connections = await connectMcpServers(
    engine,
    config.mcp.servers,
    config.paths.mcpFile,
  );
  const probe = probeCapabilities({
    bindings: config.capabilities,
    connections,
  });

  const checks: DoctorCheck[] = [
    {
      group: "config",
      name: CONFIG_DIR,
      status: "ok",
      detail: `${config.paths.dir} loaded`,
    },
    ...modelChecks(config),
    memoryCheck(config),
    ...(await gitChecks(root, target)),
    ...serverChecks(connections),
    ...capabilityChecks(
      probe.entries,
      (capability) =>
        config.degradations.find(
          (degradation) => degradation.what === capability,
        )?.reason,
    ),
    ...(await checkChecks(root, target)),
    ...deliveryChecks(config, (capability) =>
      probe.entries.some(
        (entry) => entry.capability === capability && entry.status === "ok",
      ),
    ),
  ];

  return {
    root,
    target,
    checks,
    degradations: mergeDegradations(config.degradations, probe.degradations),
    probe,
    ok: !checks.some((check) => check.status === "broken"),
  };
};

const SYMBOL = { ok: "ok  ", off: "off ", broken: "BROKEN" } as const;

/**
 * The report as an operator reads it: one line per check, the fix under anything broken,
 * and then the degradation matrix (TASKS:Y1.2, Y6.2).
 *
 * The matrix is printed even though several of its rows also appear as `off` checks above,
 * because it is the SAME list a run report prints under "switched off for this run"
 * (`renderRunSummary`). An operator comparing a failed review against `doctor` has to be
 * able to read the two lists as one thing; a doctor that showed a shorter list would be
 * read as "the review switched something off that doctor said was fine".
 */
export const renderDoctorReport = (report: DoctorReport): string => {
  const lines: string[] = [`yama doctor — ${report.root}`, ""];
  let group = "";
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push(group);
    }
    lines.push(`  ${SYMBOL[check.status]}  ${check.name} — ${check.detail}`);
    if (check.fix !== undefined) {
      lines.push(`         fix: ${check.fix}`);
    }
  }
  if (report.degradations.length > 0) {
    lines.push(
      "",
      "switched off — a review would run, without these",
      ...report.degradations.map(
        (degradation) => `  ${degradation.what} — ${degradation.reason}`,
      ),
    );
  }
  lines.push(
    "",
    report.ok
      ? "everything this workspace declares is reachable"
      : "something above is BROKEN — a review would fail on it",
  );
  return lines.join("\n");
};
