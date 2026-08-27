/**
 * Yama-owned tooling. Workers only ever get the read-only half (TASKS:Y5.1) — posting
 * capabilities are exposed to the main agent, in Delivery, and nowhere else.
 */
export {
  acquireDiff,
  git,
  gitDefaultBranch,
  gitHasRef,
  gitHeadSha,
  gitMergeBase,
  gitShowFile,
  isGitRepo,
  resolveDiffRange,
  summarizeDiff,
} from "./git.js";
export { registerFsTools } from "./fs.js";
export {
  FINDING_MARKER_PREFIX,
  findingMarker,
  mergeFindings,
  recordFindings,
  scanMarkers,
  withFindingMarker,
  withMarker,
  yamaMarker,
} from "./markers.js";
export {
  CHECKS_PATH,
  guardChecks,
  LegacyChecksError,
  readChecksAtRef,
  registerCheckTools,
} from "./checks.js";
export {
  FACTS_DIR,
  MEMORY_INDEX,
  factIdOf,
  factPath,
  indexPath,
  readFactFiles,
  renderFact,
  renderMemoryFiles,
  renderMemoryIndex,
} from "./memory.js";
export {
  WRITABLE_PREFIX,
  checkRemote,
  commitMemory,
  currentBranch,
  headSubject,
  isWritablePath,
  planMemoryCommit,
  repoRelative,
} from "./gitWriter.js";

/** Names of Yama-side tools handed to the agent. Read-only unless said otherwise. */
export const TOOL_NAMES = {
  readFile: "read_file",
  listFiles: "list_files",
  retrieveContext: "retrieve_context",
  tasksCreate: "tasks_create",
  tasksUpdate: "tasks_update",
  tasksList: "tasks_list",
  delegateTask: "delegate_task",
  collectResults: "collect_results",
  runCommand: "run_command_bg",
  commandStatus: "command_status",
  commandOutput: "command_output",
  commandKill: "command_kill",
  runCheck: "run_check",
} as const;

/** The read-only toolset every stage before Delivery may use. */
export const READ_ONLY_TOOLS: readonly string[] = [
  TOOL_NAMES.readFile,
  TOOL_NAMES.listFiles,
  TOOL_NAMES.retrieveContext,
];

/**
 * Delegation (TASKS:N2). Only the main agent gets these: a worker that can delegate is a
 * worker that can recurse, and the pool bound is the shell's to hold, not the model's.
 */
export const DELEGATION_TOOLS: readonly string[] = [
  TOOL_NAMES.delegateTask,
  TOOL_NAMES.collectResults,
];

/** The checklist primitive. The agent writes its own plan with these (TASKS:N1). */
export const CHECKLIST_TOOLS: readonly string[] = [
  TOOL_NAMES.tasksCreate,
  TOOL_NAMES.tasksUpdate,
  TOOL_NAMES.tasksList,
];

/**
 * Running the repository's own checks as evidence (TASKS:Y5.2). Registered only when the
 * BASE branch declares checks — a check the change itself introduced is never run.
 */
export const CHECK_TOOLS: readonly string[] = [TOOL_NAMES.runCheck];
