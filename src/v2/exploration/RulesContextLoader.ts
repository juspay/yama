import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import {
  MemoryBankConfig,
  ProjectStandardsConfig,
} from "../types/config.types.js";

const ROOT_RULE_FILES = ["CLAUDE.md", ".clinerules", "CONTRIBUTING.md"];
const CONTEXT_EXTENSIONS = new Set([".md", ".txt", ".yml", ".yaml"]);

export class RulesContextLoader {
  constructor(
    private readonly memoryBank: MemoryBankConfig,
    private readonly projectStandards?: ProjectStandardsConfig,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  async load(): Promise<string | null> {
    const sections: string[] = [];

    for (const file of ROOT_RULE_FILES) {
      const absolutePath = resolve(this.projectRoot, file);
      const content = await this.tryReadFile(absolutePath);
      if (content) {
        sections.push(`## ${file}\n\n${content}`);
      }
    }

    const memoryBankDir = this.resolveMemoryBankDir();
    if (memoryBankDir) {
      const standardFiles = this.memoryBank.standardFiles || [];
      for (const file of standardFiles) {
        const absolutePath = join(memoryBankDir, file);
        const content = await this.tryReadFile(absolutePath);
        if (content) {
          sections.push(`## memory-bank/${file}\n\n${content}`);
        }
      }

      const directoryEntries = await this.tryReadDirectory(memoryBankDir);
      for (const entry of directoryEntries) {
        if (standardFiles.includes(entry)) {
          continue;
        }
        const extension = entry.slice(entry.lastIndexOf("."));
        if (!CONTEXT_EXTENSIONS.has(extension)) {
          continue;
        }
        const absolutePath = join(memoryBankDir, entry);
        const content = await this.tryReadFile(absolutePath);
        if (content) {
          sections.push(`## memory-bank/${entry}\n\n${content}`);
        }
      }
    }

    if (this.projectStandards?.customPromptsPath) {
      const promptDir = resolve(
        this.projectRoot,
        this.projectStandards.customPromptsPath,
      );
      const promptFiles = [
        "review-standards.md",
        "security-guidelines.md",
        "coding-conventions.md",
      ];

      for (const file of promptFiles) {
        const content = await this.tryReadFile(join(promptDir, file));
        if (content) {
          sections.push(`## prompts/${file}\n\n${content}`);
        }
      }
    }

    if (sections.length === 0) {
      return null;
    }

    return sections.join("\n\n---\n\n");
  }

  private resolveMemoryBankDir(): string | null {
    if (!this.memoryBank.enabled) {
      return null;
    }

    const candidates = [this.memoryBank.path, ...this.memoryBank.fallbackPaths];
    for (const candidate of candidates) {
      const absolutePath = resolve(this.projectRoot, candidate);
      if (existsSync(absolutePath)) {
        return absolutePath;
      }
    }

    return null;
  }

  private async tryReadDirectory(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }
  }

  private async tryReadFile(path: string): Promise<string | null> {
    if (!existsSync(path)) {
      return null;
    }

    try {
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }
}
