/**
 * Types for the doctor layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ResolvedConfig } from "./config.js";
import type { CapabilityReport, ServerRegistration } from "./connections.js";
import type { ModelChains } from "./factory.js";
import type { ModelSlotName } from "./model.js";
import type { PromptCatalog } from "./prompts.js";
import type { RunContext, RunMode } from "./run.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** What to do about it. Present whenever status is not "ok". */
  remedy?: string;
};

export type DoctorReport = {
  status: DoctorStatus;
  checks: DoctorCheck[];
  /** Model slots and how their chain is actually enforced. */
  slots: Array<{ slot: ModelSlotName; enforcement: string; chain: string }>;
  /**
   * Where each prompt came from.
   *
   * Reported because "we are running the prompt we think we are running" is not
   * something to assume: a platform that answered with its fallback and a
   * platform that was never reached look identical from the outside.
   */
  prompts?: string[];
};

export type DoctorInput = {
  config: ResolvedConfig;
  mode: RunMode;
  registrations?: ServerRegistration[];
  capabilities?: CapabilityReport;
  /** Include the write-path checks (`doctor --learn`). */
  checkLearn?: boolean;
  /** Resolved prompts, so the report can say where each one came from. */
  prompts?: PromptCatalog;
  env?: NodeJS.ProcessEnv;
};

/** What the live probe needs in order to connect. */
export type LiveProbeOptions = {
  config: ResolvedConfig;
  chains: ModelChains;
  context: RunContext;
  mode: RunMode;
  /** A real pull request to read. Without one the probe can only confirm shape. */
  pullRequestId?: number;
  env?: NodeJS.ProcessEnv;
};

export type LiveProbeResult = {
  checks: DoctorCheck[];
  registrations: ServerRegistration[];
  capabilities?: CapabilityReport;
};
