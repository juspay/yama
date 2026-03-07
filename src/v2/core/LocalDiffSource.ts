/**
 * Local diff source for SDK mode.
 * Extracts git diffs from a local repository without requiring MCP tools.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { LocalReviewRequest } from "../types/v2.types.js";

export interface LocalDiffContext {
  repoPath: string;
  diffSource: "staged" | "uncommitted" | "range";
  baseRef?: string;
  headRef?: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
}

export class LocalDiffSource {
  getDiffContext(request: LocalReviewRequest): LocalDiffContext {
    const repoPath = resolve(request.repoPath || process.cwd());
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    this.ensureGitRepo(repoPath);

    const diffSource = request.diffSource || "uncommitted";
    const includePaths = request.includePaths || [];
    const maxDiffChars = request.maxDiffChars || 120_000;
    const contextLines = 3;

    const diffArgs = this.buildDiffArgs(
      diffSource,
      request.baseRef,
      request.headRef,
      contextLines,
      includePaths,
    );
    const nameOnlyArgs = this.buildNameOnlyArgs(
      diffSource,
      request.baseRef,
      request.headRef,
      includePaths,
    );
    const numStatArgs = this.buildNumStatArgs(
      diffSource,
      request.baseRef,
      request.headRef,
      includePaths,
    );

    const diffOutput = this.runGit(repoPath, diffArgs);
    const changedFilesOutput = this.runGit(repoPath, nameOnlyArgs);
    const numStatOutput = this.runGit(repoPath, numStatArgs);
    const changedFiles = changedFilesOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const { additions, deletions } = this.parseNumStat(numStatOutput);

    const truncated = diffOutput.length > maxDiffChars;
    const diff = truncated ? diffOutput.slice(0, maxDiffChars) : diffOutput;

    return {
      repoPath,
      diffSource,
      baseRef: diffSource === "range" ? request.baseRef : undefined,
      headRef: diffSource === "range" ? request.headRef || "HEAD" : undefined,
      changedFiles,
      additions,
      deletions,
      diff,
      truncated,
    };
  }

  private ensureGitRepo(repoPath: string): void {
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

    if (probe.status !== 0 || probe.stdout.trim() !== "true") {
      throw new Error(`Path is not a git repository: ${repoPath}`);
    }
  }

  private runGit(repoPath: string, args: string[]): string {
    const result = spawnSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
      );
    }

    return result.stdout || "";
  }

  private buildDiffArgs(
    diffSource: "staged" | "uncommitted" | "range",
    baseRef: string | undefined,
    headRef: string | undefined,
    contextLines: number,
    includePaths: string[],
  ): string[] {
    const args = ["diff", "--no-color", `--unified=${contextLines}`];
    if (diffSource === "staged") {
      args.push("--staged");
    } else if (diffSource === "range") {
      if (!baseRef) {
        throw new Error("baseRef is required when diffSource is 'range'");
      }
      args.push(`${baseRef}..${headRef || "HEAD"}`);
    }
    if (includePaths.length > 0) {
      args.push("--", ...includePaths);
    }
    return args;
  }

  private buildNameOnlyArgs(
    diffSource: "staged" | "uncommitted" | "range",
    baseRef: string | undefined,
    headRef: string | undefined,
    includePaths: string[],
  ): string[] {
    const args = ["diff", "--name-only"];
    if (diffSource === "staged") {
      args.push("--staged");
    } else if (diffSource === "range") {
      if (!baseRef) {
        throw new Error("baseRef is required when diffSource is 'range'");
      }
      args.push(`${baseRef}..${headRef || "HEAD"}`);
    }
    if (includePaths.length > 0) {
      args.push("--", ...includePaths);
    }
    return args;
  }

  private buildNumStatArgs(
    diffSource: "staged" | "uncommitted" | "range",
    baseRef: string | undefined,
    headRef: string | undefined,
    includePaths: string[],
  ): string[] {
    const args = ["diff", "--numstat"];
    if (diffSource === "staged") {
      args.push("--staged");
    } else if (diffSource === "range") {
      if (!baseRef) {
        throw new Error("baseRef is required when diffSource is 'range'");
      }
      args.push(`${baseRef}..${headRef || "HEAD"}`);
    }
    if (includePaths.length > 0) {
      args.push("--", ...includePaths);
    }
    return args;
  }

  private parseNumStat(numStat: string): {
    additions: number;
    deletions: number;
  } {
    let additions = 0;
    let deletions = 0;
    const lines = numStat
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const [addRaw, delRaw] = line.split("\t");
      const addCount = addRaw === "-" ? 0 : parseInt(addRaw, 10);
      const delCount = delRaw === "-" ? 0 : parseInt(delRaw, 10);
      additions += Number.isNaN(addCount) ? 0 : addCount;
      deletions += Number.isNaN(delCount) ? 0 : delCount;
    }

    return { additions, deletions };
  }
}
