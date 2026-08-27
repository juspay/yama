/**
 * Engine artifacts, mirrored into the run store (docs/engine-spec.md section 2 + TASKS:Y2.3).
 *
 * NeuroLink banks into a process-wide directory under `tmpdir()`; Yama's run store is a CI
 * artifact that is uploaded, downloaded and read by the NEXT run. Both matter and neither
 * replaces the other, so every artifact the engine hands us is copied into
 * `<run store>/reports/` under the engine's own id:
 *
 *   - the model reads it back with the engine's `retrieve_context`, which is what the
 *     preview's `readBackHint` spells out;
 *   - the shell reads it back with `readPayload`, which still works in tomorrow's CI job
 *     after `tmpdir()` is long gone;
 *   - `payloadPath(paths, id)` resolves, so `reportPath` keeps pointing at a real file.
 *
 * Copying costs one read and one write per artifact. Losing a worker's report to a cleaned
 * temp directory costs the finding it was the evidence for.
 */
import type { BankedArtifactRef, NeuroLink } from "@juspay/neurolink";
import { payloadPath, writePayload } from "../../store/index.js";
import type { EngineBankedRef, RunStorePaths } from "../../types/index.js";

/** The engine's reference in the seam's vocabulary. Nothing is dropped, only renamed. */
export const toEngineRef = (ref: BankedArtifactRef): EngineBankedRef => ({
  id: ref.artifactId,
  label: ref.label,
  sizeBytes: ref.sizeBytes,
  preview: ref.preview,
  readBackHint: ref.readBackHint,
});

/**
 * Copies one banked artifact into the run store, keyed by the engine's id.
 *
 * Returns where it landed, or `undefined` when the engine could no longer produce the
 * payload — in which case NOTHING is written, because an empty file standing in for
 * evidence is worse than an absent one.
 */
export const mirrorArtifact = async (options: {
  nl: NeuroLink;
  paths: RunStorePaths;
  artifactId: string;
  /** The payload when the caller already has it, saving a read-back. */
  payload?: string;
}): Promise<string | undefined> => {
  const payload =
    options.payload ?? (await options.nl.readArtifact(options.artifactId));
  if (payload === null || payload === undefined) {
    return undefined;
  }
  await writePayload(options.paths, options.artifactId, payload);
  return payloadPath(options.paths, options.artifactId);
};
