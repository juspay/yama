/**
 * File banking, engine-native (TASKS:N3, docs/engine-spec.md section 2).
 *
 * The seam-local fallback had to register a `retrieve_context` of its own. The engine ships
 * one, and it is the SAME tool the MCP output normalizer externalizes into — so a banked
 * report, an oversized MCP result and a command log are all read back through one call the
 * model already knows. Yama registers nothing here; it only ensures the store exists, which
 * is what registers the tool.
 *
 * What Yama adds on top is durability: every banked payload is mirrored into the run store
 * (see ./artifacts.ts), and `read` falls back to that copy, so evidence outlives the
 * engine's temp directory.
 */
import type { NeuroLink } from "@juspay/neurolink";
import { readPayload } from "../../store/index.js";
import type {
  EngineBankApi,
  EngineBankRequest,
  EngineBankedRef,
  RunStorePaths,
} from "../../types/index.js";
import { mirrorArtifact, toEngineRef } from "./artifacts.js";

/**
 * Banks through `nl.bankArtifact` and mirrors into the run store. Creating the artifact
 * store up front is deliberate: that is what registers `retrieve_context`, so the tool is
 * on the registry before the first stage builds its toolset, not only after something has
 * been banked.
 */
export const createBankNative = (options: {
  nl: NeuroLink;
  paths: RunStorePaths;
  /** Session the artifacts belong to, recorded on the engine's metadata. */
  currentSession: () => string;
}): EngineBankApi => {
  options.nl.getArtifactStore();

  const bank = async (req: EngineBankRequest): Promise<EngineBankedRef> => {
    const ref = await options.nl.bankArtifact(req.payload, {
      kind: req.kind,
      label: req.label,
      sessionId: options.currentSession(),
      ...(req.previewChars !== undefined
        ? { previewChars: req.previewChars }
        : {}),
    });
    await mirrorArtifact({
      nl: options.nl,
      paths: options.paths,
      artifactId: ref.artifactId,
      payload: req.payload,
    });
    return toEngineRef(ref);
  };

  const read = async (
    id: string,
    page?: { offset?: number; limit?: number },
  ): Promise<string | undefined> => {
    const whole =
      (await options.nl.readArtifact(id)) ??
      (await readPayload(options.paths, id));
    if (whole === undefined || whole === null) {
      return undefined;
    }
    const offset = page?.offset ?? 0;
    return whole.slice(offset, offset + (page?.limit ?? whole.length));
  };

  return { bank, read };
};
