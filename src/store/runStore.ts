/**
 * The run store (TASKS:Y2.3): stage envelopes, banked payloads, worker reports, the
 * findings ledger and the run report — every one of them a file under
 * `.yama/artifacts/<slug>/`.
 *
 * The contract is the project's whole philosophy in one place: full content goes to a
 * file, conversation gets a bounded reference, and the file is read back on demand. A
 * missing store is a rebuild, not a failure; a corrupt one is a failure, loudly.
 */
import { join } from "node:path";
import type { ZodType } from "zod";
import type {
  FindingsLedger,
  RunReport,
  RunStorePaths,
  Stage,
  StageOutput,
  WorkerReport,
} from "../types/index.js";
import { ensureDir, readTextFile, writeTextFile } from "../util/fs.js";
import { readJson, writeJson } from "./json.js";
import { StoreError } from "./errors.js";
import {
  FindingsLedgerSchema,
  RunReportSchema,
  StageEnvelopeSchema,
  WorkerReportSchema,
} from "./schema.js";

/** Linear trim of leading/trailing dashes — `/^-+|-+$/` backtracks on dash runs. */
const trimDashes = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start++;
  }
  while (end > start && value[end - 1] === "-") {
    end--;
  }
  return value.slice(start, end);
};

/** Characters allowed in a banked-payload id. Everything else is folded to `-`. */
const slugify = (label: string): string =>
  trimDashes(label.replace(/[^\w.-]+/g, "-")).slice(0, 96) || "payload";

/** Creates the directory skeleton. Idempotent — every run calls it first. */
export const ensureStore = async (paths: RunStorePaths): Promise<void> => {
  for (const dir of [
    paths.dir,
    paths.stagesDir,
    paths.reportsDir,
    paths.checksDir,
    paths.workersDir,
  ]) {
    await ensureDir(dir);
  }
};

/* ------------------------------------------------------------ stage envelopes */

const stageFile = (paths: RunStorePaths, stage: Stage): string =>
  join(paths.stagesDir, `${stage}.json`);

/** Banks one stage envelope and returns where it landed. */
export const writeStage = async <T>(
  paths: RunStorePaths,
  envelope: StageOutput<Stage, T>,
): Promise<string> => {
  const file = stageFile(paths, envelope.stage);
  await writeJson(file, { ...envelope, path: file });
  return file;
};

/**
 * Reads one stage envelope back, validating the payload against the stage's own schema —
 * an envelope whose payload no longer fits the current schema is a corrupt artifact.
 */
export const readStage = async <T>(
  paths: RunStorePaths,
  stage: Stage,
  payload: ZodType<T>,
): Promise<StageOutput<Stage, T> | undefined> => {
  const file = stageFile(paths, stage);
  const envelope = await readJson(file, StageEnvelopeSchema);
  if (envelope === undefined) {
    return undefined;
  }
  const parsed = payload.safeParse(envelope.data);
  if (!parsed.success) {
    throw new StoreError(
      `stage "${stage}" payload no longer fits its schema`,
      file,
    );
  }
  return { ...envelope, stage, data: parsed.data };
};

/* ---------------------------------------------------------- banked payloads */

/**
 * Where a banked payload lives. The store owns the id-to-file mapping, so nothing else
 * has to know that a bank reference and a path are the same thing wearing two hats.
 */
export const payloadPath = (
  paths: RunStorePaths,
  id: string,
  extension = "md",
): string => join(paths.reportsDir, `${slugify(id)}.${extension}`);

/**
 * Banks a full payload under `reports/`. `label` becomes the file name, so the store is
 * browsable; the returned path is what a reference points at.
 */
export const writePayload = async (
  paths: RunStorePaths,
  label: string,
  payload: string,
  extension = "md",
): Promise<{ id: string; file: string }> => {
  const id = slugify(label);
  const file = await writeTextFile(payloadPath(paths, id, extension), payload);
  return { id, file };
};

/** Reads a banked payload by id. Absent → `undefined`; nothing is ever half-returned. */
export const readPayload = async (
  paths: RunStorePaths,
  id: string,
  extension = "md",
): Promise<string | undefined> =>
  readTextFile(payloadPath(paths, id, extension));

/* ---------------------------------------------------------- worker reports */

/** Banks one worker's report record (its full text is a payload of its own). */
export const writeWorkerReport = async (
  paths: RunStorePaths,
  report: WorkerReport,
): Promise<string> => {
  const file = join(paths.workersDir, `${slugify(report.workerId)}.json`);
  await writeJson(file, report);
  return file;
};

/** Reads one worker's report record back. */
export const readWorkerReport = async (
  paths: RunStorePaths,
  workerId: string,
): Promise<WorkerReport | undefined> =>
  readJson(
    join(paths.workersDir, `${slugify(workerId)}.json`),
    WorkerReportSchema,
  );

/* --------------------------------------------------------- findings ledger */

/** The findings ledger, or an empty one when this run has not written any yet. */
export const readLedger = async (
  paths: RunStorePaths,
): Promise<FindingsLedger> =>
  (await readJson(paths.ledgerFile, FindingsLedgerSchema)) ?? {
    updatedAt: new Date(0).toISOString(),
    findings: [],
  };

/** Replaces the ledger wholesale — the collate stage owns dedupe and ranking. */
export const writeLedger = async (
  paths: RunStorePaths,
  ledger: FindingsLedger,
): Promise<string> => {
  await writeJson(paths.ledgerFile, ledger);
  return paths.ledgerFile;
};

/* -------------------------------------------------------------- run report */

/** The previous (or in-progress) run report, when the store carries one. */
export const readRunReport = async (
  paths: RunStorePaths,
): Promise<RunReport | undefined> => readJson(paths.runFile, RunReportSchema);

/** Writes the run report. Called as the run progresses, so a crash still leaves evidence. */
export const writeRunReport = async (
  paths: RunStorePaths,
  report: RunReport,
): Promise<string> => {
  await writeJson(paths.runFile, report);
  return paths.runFile;
};
