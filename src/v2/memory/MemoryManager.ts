/**
 * Memory Manager
 *
 * Provides per-repository condensed memory configuration for NeuroLink.
 *
 * This manager builds the NeuroLink-compatible memory SDK config with
 * file-based custom storage, so that NeuroLink's generate()/stream() calls
 * can retrieve and store memory using context.userId as the per-repo key.
 *
 * Callers control WHEN memory is read/written via per-call flags:
 *   memory: { enabled: true, read: true, write: false }
 *
 * This avoids noise from operational calls (e.g., fetching PR data)
 * polluting the condensed memory.
 *
 * Storage: file-based (.yama/memory/{workspace}-{repository}.txt) (lowercased)
 * Condensation: LLM-powered via NeuroLink's built-in Hippocampus
 */

import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { MemoryConfig } from "../types/config.types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

/**
 * Condensation prompt tailored for code review memory.
 * Guides the LLM to retain review patterns, team conventions, and
 * frequently flagged issues rather than individual PR details.
 */
const REVIEW_MEMORY_CONDENSATION_PROMPT = `You are a memory condensation engine for an AI code reviewer called Yama.
You receive:
1. OLD_MEMORY: the existing condensed memory for a specific repository (may be empty)
2. NEW_CONTENT: new information from a recent code review or learning extraction

Your job: merge old memory with the new information into a single condensed summary.

Rules:
- Output ONLY the condensed memory text, nothing else
- Maximum {{MAX_WORDS}} words
- PRIORITIZE retaining (most important first):
  1. False positive patterns: things the team confirmed are NOT issues
  2. Team coding conventions and style preferences
  3. Recurring review themes and common issue categories
  4. Repository-specific domain knowledge and architecture decisions
  5. Patterns the AI missed that developers caught
  6. Review outcome trends (approval rate, common blocking reasons)
- DROP: individual PR numbers, timestamps, one-off issues, greeting text
- Keep learnings GENERIC and applicable to future reviews
- If NEW_CONTENT has nothing worth remembering, return OLD_MEMORY unchanged
- If both are empty, return empty string`;

// ============================================================================
// Manager
// ============================================================================

export class MemoryManager {
  private readonly config: MemoryConfig;
  private readonly projectRoot: string;
  private readonly aiProvider: string;
  private readonly aiModel: string;

  constructor(
    config: MemoryConfig,
    aiProvider: string,
    aiModel: string,
    projectRoot?: string,
  ) {
    this.config = config;
    this.aiProvider = aiProvider;
    this.aiModel = aiModel;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Resolve the storage directory path (handles both absolute and relative paths).
   */
  private resolveStorageDir(): string {
    return isAbsolute(this.config.storagePath)
      ? this.config.storagePath
      : join(this.projectRoot, this.config.storagePath);
  }

  /**
   * Build the NeuroLink-compatible Memory config object.
   *
   * Passed to NeuroLink constructor as `conversationMemory.memory`.
   * NeuroLink internally initializes Hippocampus with our file-based
   * storage and review-specific condensation prompt.
   */
  buildNeuroLinkMemoryConfig(): Record<string, unknown> {
    const storageDir = this.resolveStorageDir();

    return {
      enabled: true,
      storage: this.config.storage || {
        type: "custom" as const,
        onGet: async (ownerId: string): Promise<string | null> => {
          const filePath = this.ownerIdToFilePath(storageDir, ownerId);
          if (!existsSync(filePath)) {
            return null;
          }
          try {
            return await readFile(filePath, "utf-8");
          } catch {
            return null;
          }
        },
        onSet: async (ownerId: string, memory: string): Promise<void> => {
          const filePath = this.ownerIdToFilePath(storageDir, ownerId);
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
          }
          await writeFile(filePath, memory, "utf-8");
        },
        onDelete: async (ownerId: string): Promise<void> => {
          const filePath = this.ownerIdToFilePath(storageDir, ownerId);
          if (existsSync(filePath)) {
            await unlink(filePath);
          }
        },
      },
      neurolink: this.config.neurolink || {
        provider: this.aiProvider,
        model: this.aiModel,
        temperature: 0.1,
      },
      maxWords: this.config.maxWords,
      prompt: this.config.prompt || REVIEW_MEMORY_CONDENSATION_PROMPT,
    };
  }

  /**
   * Build a deterministic owner ID from workspace and repository.
   * This value is passed as `context.userId` in generate() calls.
   */
  static buildOwnerId(workspace: string, repository: string): string {
    return `${workspace}-${repository}`.toLowerCase();
  }

  /**
   * Read persisted condensed memory for a repository owner ID.
   */
  async readMemory(ownerId: string): Promise<string | null> {
    const storageDir = this.resolveStorageDir();
    const filePath = this.ownerIdToFilePath(storageDir, ownerId);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Read persisted condensed memory for a workspace/repository pair.
   */
  async readRepositoryMemory(
    workspace: string,
    repository: string,
  ): Promise<string | null> {
    return this.readMemory(MemoryManager.buildOwnerId(workspace, repository));
  }

  /**
   * Commit memory files to the repository if autoCommit is enabled.
   *
   * Checks git status for changes in the storagePath directory,
   * then stages, commits, and pushes. Uses [skip ci] to prevent
   * infinite CI loops. Never throws — failures are logged and ignored
   * so they never block the review result.
   */
  async commitMemoryChanges(): Promise<boolean> {
    if (!this.config.autoCommit) {
      return false;
    }

    const storageDir = this.resolveStorageDir();
    if (!existsSync(storageDir)) {
      return false;
    }

    try {
      // Check if there are any changes to commit
      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain", storageDir],
        { cwd: this.projectRoot },
      );

      if (!statusOutput.trim()) {
        console.log("   🧠 No memory changes to commit");
        return false;
      }

      const commitMessage =
        this.config.commitMessage ||
        "chore: update yama review memory [skip ci]";

      // Stage memory files
      await execFileAsync("git", ["add", storageDir], {
        cwd: this.projectRoot,
      });

      // Commit with [skip ci] to prevent infinite loops
      await execFileAsync("git", ["commit", "-m", commitMessage], {
        cwd: this.projectRoot,
      });

      // Push to the current branch
      await execFileAsync("git", ["push"], {
        cwd: this.projectRoot,
      });

      console.log("   🧠 Memory changes committed and pushed");
      return true;
    } catch (error) {
      console.warn(
        `   ⚠️ Memory auto-commit failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Map an ownerId to a safe file path.
   */
  private ownerIdToFilePath(storageDir: string, ownerId: string): string {
    const safeId = ownerId.replace(/[^a-zA-Z0-9-]/g, "-");
    return join(storageDir, `${safeId}.md`);
  }
}
