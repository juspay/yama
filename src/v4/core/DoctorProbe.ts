/**
 * The live half of `yama doctor`.
 *
 * `runDoctor` is pure and inspects config shape. That catches typos; it cannot
 * catch a revoked token, a server that moved, or a tool that was renamed
 * upstream — and those are precisely the failures that cost a whole run.
 *
 * So this connects for real: it registers every configured server, discovers
 * what each one actually advertises, and reads a real pull request through the
 * capability map. A doctor that passes without connecting is worse than no
 * doctor, because it converts "we do not know" into "we checked".
 */

import type {
  CapabilityReport,
  DoctorCheck,
  LiveProbeOptions,
  LiveProbeResult,
  ServerRegistration,
} from "../types/index.js";
import { CapabilityResolver } from "../connections/Capabilities.js";
import { capabilityParams, targetParams } from "../connections/invoke.js";
import { createRuntime } from "./Runtime.js";

/**
 * Connect, discover, and read a pull request.
 *
 * Always returns — a probe that throws would report a connection failure as a
 * crash. Every failure becomes a check with a remedy naming the fix.
 */
export async function probeLive(
  options: LiveProbeOptions,
): Promise<LiveProbeResult> {
  const checks: DoctorCheck[] = [];
  let registrations: ServerRegistration[] = [];
  let capabilities: CapabilityReport | undefined;

  let runtime;
  try {
    runtime = await createRuntime({
      config: options.config,
      chains: options.chains,
      context: options.context,
      role: "main",
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (error) {
    return {
      checks: [
        {
          name: "live connection",
          status: "fail",
          detail: `could not construct the runtime: ${(error as Error).message}`,
          remedy:
            "Check the provider credentials in your environment and the model names in " +
            ".yama/yama.yaml. Nothing downstream can be verified until this succeeds.",
        },
      ],
      registrations: [],
    };
  }

  try {
    registrations = runtime.capabilities.registrations;
    capabilities = runtime.capabilities;

    const failed = registrations.filter((entry) => !entry.ok);
    checks.push({
      name: "live connection",
      status: failed.length > 0 ? "fail" : "ok",
      detail:
        `${registrations.length - failed.length}/${registrations.length} server(s) ` +
        `connected and advertised tools`,
      ...(failed.length > 0
        ? {
            remedy: failed
              .map(
                (entry) =>
                  `${entry.id}: ${entry.error ?? "no tools advertised"}`,
              )
              .join("; "),
          }
        : {}),
    });

    // Reading a real pull request is the end-to-end proof: it exercises the
    // credential, the transport, the tool name, and the argument shape at once.
    const resolver = new CapabilityResolver(capabilities);
    const read = resolver.find("readPullRequest", "resolve");

    if (!read) {
      checks.push({
        name: "read a pull request",
        status: "fail",
        detail:
          "no readPullRequest capability is exposed during the resolve stage",
        remedy:
          'Map readPullRequest in .yama/mcp.yaml and include "resolve" in that ' +
          "server's stages.",
      });
    } else if (options.pullRequestId === undefined) {
      checks.push({
        name: "read a pull request",
        status: "warn",
        detail: `${read.toolName} is available but no pull request was named`,
        remedy:
          "Re-run with --pr <number> to prove the credential end to end. Without it " +
          "this only confirms the tool exists, not that it works.",
      });
    } else {
      const started = Date.now();
      try {
        const result = await runtime.invoke(
          read.toolName,
          capabilityParams(
            read,
            targetParams({
              owner: options.context.identity.owner,
              repo: options.context.identity.repo,
              pullRequestId: options.pullRequestId,
            }),
          ),
        );
        const empty =
          result === null ||
          result === undefined ||
          (typeof result === "object" && Object.keys(result).length === 0);
        checks.push({
          name: "read a pull request",
          status: empty ? "fail" : "ok",
          detail: empty
            ? `${read.toolName} returned nothing for #${options.pullRequestId}`
            : `read #${options.pullRequestId} via ${read.toolName} in ${Date.now() - started}ms`,
          ...(empty
            ? {
                remedy:
                  "The tool responded but with no content — usually a token without " +
                  "read access to this repository, or a wrong owner/repo.",
              }
            : {}),
        });
      } catch (error) {
        checks.push({
          name: "read a pull request",
          status: "fail",
          detail: `${read.toolName} failed: ${(error as Error).message}`,
          remedy:
            "This is the exact call a review makes first. Fix the credential or the " +
            "capability mapping before running a review.",
        });
      }
    }

    // Posting is not exercised against a real pull request — a doctor that
    // writes comments is a doctor nobody runs. What can be verified without
    // writing is that the tools exist and are reachable in the posting stages.
    for (const capability of ["postInlineComment", "postSummary"] as const) {
      const found = resolver.find(capability, "post");
      checks.push({
        name: `${capability} reachable`,
        status: found ? "ok" : options.mode === "live" ? "fail" : "warn",
        detail: found
          ? `${found.toolName} on ${found.serverId}, exposed during the post stage`
          : "not exposed during the post stage",
        ...(found
          ? {}
          : {
              remedy:
                `Map ${capability} in .yama/mcp.yaml and include "post" in that ` +
                `server's stages. A live run without it reviews the pull request and ` +
                `then throws the findings away.`,
            }),
      });
    }
  } finally {
    await runtime.shutdown();
  }

  return {
    checks,
    registrations,
    ...(capabilities ? { capabilities } : {}),
  };
}
