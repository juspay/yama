/**
 * Operator surfaces (TASKS:Y6.2, Y6.3): what `yama doctor` reports and what `yama init`
 * writes. Both exist for the same reason — a review that fails at 3am should fail with the
 * fix in the message, and a repository should be able to get a correct `.yama/` without
 * anyone reading the schema source.
 */
import type { ConfigDegradation } from "./config.js";
import type { CapabilityProbe } from "./platform.js";
import type { RunTarget } from "./run.js";

/** How one doctor check came out. `off` is a capability that is simply not configured. */
export type DoctorStatus = "ok" | "off" | "broken";

/** One line of the doctor report: what was probed, what came of it, and the fix. */
export type DoctorCheck = {
  /** Grouping, e.g. `config`, `models`, `mcp`, `capabilities`, `checks`, `delivery`. */
  group: string;
  name: string;
  status: DoctorStatus;
  detail: string;
  /** What to do about it. Present on everything `broken`. */
  fix?: string;
};

/** The whole probe, as `yama doctor` prints it and as a test reads it. */
export type DoctorReport = {
  root: string;
  target: RunTarget;
  checks: DoctorCheck[];
  degradations: ConfigDegradation[];
  /** Absent when the config could not be loaded at all. */
  probe?: CapabilityProbe;
  /** True when nothing came back `broken`. */
  ok: boolean;
};

/** Platforms `yama init` ships a capability map for (TASKS:Y6.2). */
export type InitPlatform = "github" | "bitbucket" | "none";

/** What `yama init` did: nothing is ever overwritten unless it was asked to. */
export type InitResult = {
  root: string;
  platform: InitPlatform;
  /** Absolute paths written. */
  written: string[];
  /** Absolute paths left alone because they already existed. */
  skipped: string[];
};
