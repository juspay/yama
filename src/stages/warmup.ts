/**
 * WarmUp (TASKS:Y3.1) — read the rulebook and the memory, distil the OperatingBrief.
 *
 * Index-first, and read by the AGENT rather than slurped by the shell: a rulebook is a
 * document tree, and which parts matter depends on what it says. The shell's job is only
 * to say where things are and which of them are absent, so the agent never hunts for a
 * directory that was never configured.
 *
 * The brief is what workers get a slice of later; the raw rulebook never travels.
 */
import { relative } from "node:path";
import { checkpointWithSchemaGate } from "../gates/index.js";
import { READ_ONLY_TOOLS } from "../tools/index.js";
import type {
  OperatingBrief,
  ResolvedConfig,
  SessionRunner,
  Stage,
  StageOutput,
} from "../types/index.js";
import { OperatingBriefSchema } from "./schema.js";

/** Enough steps to walk a rulebook tree and read it; not enough to wander. */
const WARMUP_MAX_STEPS = 48;

const rel = (root: string, path: string): string => relative(root, path) || ".";

/** Everything the agent needs to find the rulebook, and what it will not find. */
export const buildWarmUpPrompt = (config: ResolvedConfig): string => {
  const root = config.paths.root;
  const lines: string[] = [
    "WARM UP. Work out how this repository wants its code reviewed, then report it as an OperatingBrief.",
    "",
    "What is on disk:",
  ];

  if (config.rulebook) {
    lines.push(`  rulebook: ${rel(root, config.rulebook.dir)}`);
    lines.push(
      config.rulebook.index
        ? `  rulebook index: ${rel(root, config.rulebook.index)} — read this FIRST and follow what it points at`
        : "  rulebook index: none — list the rulebook directory and read what looks load-bearing",
    );
  } else {
    lines.push(
      "  rulebook: none configured. Derive the review posture from the repository itself — its README, its lint and type configuration, and the conventions its existing code actually follows.",
    );
  }

  lines.push(
    config.memoryDir
      ? `  memory: ${rel(root, config.memoryDir)} — accumulated knowledge from earlier reviews; treat it as hard-won, not as gospel`
      : "  memory: none yet. This repository has no accumulated review knowledge.",
  );

  if (config.degradations.length > 0) {
    lines.push("", "Switched off for this run (do not plan around them):");
    for (const degradation of config.degradations) {
      lines.push(`  ${degradation.what} — ${degradation.reason}`);
    }
  }

  lines.push(
    "",
    "How to do it:",
    "  1. list_files to see what is actually there, then read_file the index and follow its references.",
    "  2. Read the memory files too. A note from a past review outranks a general principle.",
    "  3. Prefer rules that are stated. Where the rulebook is silent, say so in `gaps` instead of inventing a house style.",
    "  4. Every file you read goes in `sources`, repository-relative. The brief has to be auditable.",
    "",
    "Report the OperatingBrief: the persona this repository wants, the rules worth enforcing with the file each came from, the areas it cares about most, the sources you read, and the gaps you found.",
  );
  return lines.join("\n");
};

/**
 * Runs WarmUp as a checkpoint on the main session and banks the brief. The call goes
 * through the schema gate, so a brief that came back cut short is asked for again rather
 * than carried into Task Insertion half-read (TASKS:Y4.1).
 */
export const runWarmUp = (options: {
  session: SessionRunner;
  config: ResolvedConfig;
  /** Live review-phase capability tools (TASKS:Y5.1); never a posting tool. */
  extraTools?: readonly string[];
}): Promise<StageOutput<Stage, OperatingBrief>> =>
  checkpointWithSchemaGate({
    session: options.session,
    request: {
      stage: "warmup",
      prompt: buildWarmUpPrompt(options.config),
      schema: OperatingBriefSchema,
      tools: [...READ_ONLY_TOOLS, ...(options.extraTools ?? [])],
      maxSteps: WARMUP_MAX_STEPS,
    },
  });
