/**
 * What the HOST permits, shared by both seam implementations (fallback and engine-native).
 *
 * Two decisions live here because the model must not make either of them, and because the
 * two implementations must not be able to disagree about them: which tools a delegated
 * worker may use (TASKS:Y5.1), and what a run says when it is asked to execute a command it
 * never declared (TASKS:Y5.2).
 */

/**
 * What a run says when something asks it to execute a command and no policy exists.
 *
 * It names the FILE rather than the engine call, because the person who has to act on it
 * edits a repository, not Yama's source. The refusal is identical on both paths on purpose:
 * a message that changed when the engine changed would send that person to the wrong place.
 */
export const NO_COMMAND_POLICY =
  "background commands are disabled: no command policy is configured. Declare the commands in .yama/checks.yaml so the run can allowlist them.";

/**
 * Narrows a requested toolset to the permitted one. A request that names nothing
 * permitted gets the WHOLE permitted list rather than nothing — a worker with no tools
 * cannot investigate anything, and silently spawning a blind worker is worse than
 * ignoring an over-reaching request.
 */
export const clampWorkerTools = (
  requested: string[] | undefined,
  permitted: readonly string[],
): string[] => {
  const kept = (requested ?? []).filter((tool) => permitted.includes(tool));
  return kept.length > 0 ? kept : [...permitted];
};
