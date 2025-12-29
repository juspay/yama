/**
 * Knowledge Base Manager
 * Handles reading, writing, and parsing the knowledge base markdown file
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { KnowledgeBaseConfig } from "../types/config.types.js";
import {
  KnowledgeBase,
  KnowledgeBaseMetadata,
  KnowledgeBaseSection,
  ExtractedLearning,
  LearningCategory,
  CATEGORY_SECTION_NAMES,
} from "./types.js";

/**
 * Template for a new knowledge base file
 */
const KNOWLEDGE_BASE_TEMPLATE = `# Project Knowledge Base
> Learned patterns, preferences, and guidelines from team feedback

## Metadata
- Last Updated: {{TIMESTAMP}}
- Total Learnings: 0
- Last Summarization: N/A

---

## False Positives (Don't Flag These)

Things AI incorrectly flagged as issues. Avoid repeating these mistakes.

---

## Style Preferences (Team Conventions)

Project-specific coding conventions that differ from general best practices.

---

## Missed Issues (Should Have Flagged)

Patterns AI missed that should be caught in future reviews.

---

## Context & Domain Knowledge

Project-specific context AI needs for accurate reviews.

---

## Enhancement Guidelines

How AI should provide suggestions for this project.

`;

export class KnowledgeBaseManager {
  private config: KnowledgeBaseConfig;
  private projectRoot: string;

  constructor(config: KnowledgeBaseConfig, projectRoot?: string) {
    this.config = config;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Get the full path to the knowledge base file
   */
  getFilePath(): string {
    return join(this.projectRoot, this.config.path);
  }

  /**
   * Check if knowledge base file exists
   */
  exists(): boolean {
    return existsSync(this.getFilePath());
  }

  /**
   * Load and parse the knowledge base file
   */
  async load(): Promise<KnowledgeBase> {
    if (!this.exists()) {
      return this.createEmptyKnowledgeBase();
    }

    const content = await readFile(this.getFilePath(), "utf-8");
    return this.parseMarkdown(content);
  }

  /**
   * Append new learnings to the knowledge base
   * Returns count of learnings actually added (excludes duplicates)
   */
  async append(learnings: ExtractedLearning[]): Promise<number> {
    const kb = await this.load();
    let addedCount = 0;

    for (const learning of learnings) {
      // Check for duplicates
      if (this.isDuplicate(kb, learning)) {
        continue;
      }

      // Get or create section
      let section = kb.sections.get(learning.category);
      if (!section) {
        section = {
          category: learning.category,
          subcategories: new Map(),
        };
        kb.sections.set(learning.category, section);
      }

      // Get or create subcategory
      const subcatKey = learning.subcategory || "General";
      let learningsList = section.subcategories.get(subcatKey);
      if (!learningsList) {
        learningsList = [];
        section.subcategories.set(subcatKey, learningsList);
      }

      // Add the learning
      learningsList.push(learning.learning);
      addedCount++;
    }

    // Update metadata
    kb.metadata.lastUpdated = new Date().toISOString();
    kb.metadata.totalLearnings += addedCount;

    // Write back
    await this.write(kb);

    return addedCount;
  }

  /**
   * Write the knowledge base back to file
   */
  async write(kb: KnowledgeBase): Promise<void> {
    const content = this.toMarkdown(kb);
    const filePath = this.getFilePath();
    const dir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Write raw markdown content directly to file
   * Used by summarization to write AI-generated consolidated content
   */
  async writeRaw(content: string): Promise<void> {
    const filePath = this.getFilePath();
    const dir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Create a new knowledge base file from template
   */
  async create(): Promise<void> {
    const content = KNOWLEDGE_BASE_TEMPLATE.replace(
      "{{TIMESTAMP}}",
      new Date().toISOString(),
    );
    const filePath = this.getFilePath();
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Get knowledge base content formatted for AI prompt injection
   */
  async getForPrompt(): Promise<string | null> {
    if (!this.config.enabled || !this.exists()) {
      return null;
    }

    try {
      const content = await readFile(this.getFilePath(), "utf-8");

      // Remove metadata section for cleaner prompt
      const lines = content.split("\n");
      const filteredLines: string[] = [];
      let inMetadata = false;

      for (const line of lines) {
        if (line.startsWith("## Metadata")) {
          inMetadata = true;
          continue;
        }
        if (inMetadata && line.startsWith("---")) {
          inMetadata = false;
          continue;
        }
        if (!inMetadata) {
          filteredLines.push(line);
        }
      }

      return filteredLines.join("\n").trim();
    } catch {
      return null;
    }
  }

  /**
   * Get count of learnings in the knowledge base
   */
  async getLearningCount(): Promise<number> {
    const kb = await this.load();
    return kb.metadata.totalLearnings;
  }

  /**
   * Check if summarization is needed based on entry count
   */
  async needsSummarization(): Promise<boolean> {
    const count = await this.getLearningCount();
    return count >= this.config.maxEntriesBeforeSummarization;
  }

  /**
   * Commit the knowledge base file to git
   * Uses execFile with argument arrays to prevent command injection
   */
  async commit(prId: number, learningsAdded: number): Promise<void> {
    const filePath = this.config.path; // Relative path for git

    // Validate inputs to prevent injection
    const safePrId = Math.floor(Number(prId));
    const safeLearningsAdded = Math.floor(Number(learningsAdded));

    if (!Number.isFinite(safePrId) || safePrId < 0) {
      throw new Error("Invalid PR ID");
    }

    try {
      // Stage the file using execFile with args array (safe from injection)
      await execFileAsync("git", ["add", filePath], { cwd: this.projectRoot });

      // Create commit message
      const commitMessage = `chore(yama): update knowledge base from PR #${safePrId}

Added ${safeLearningsAdded} new learning${safeLearningsAdded !== 1 ? "s" : ""}.

🤖 Generated with Yama`;

      // Commit using execFile with args array (safe from injection)
      await execFileAsync("git", ["commit", "-m", commitMessage], {
        cwd: this.projectRoot,
      });
    } catch (error) {
      throw new Error(
        `Failed to commit knowledge base: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Generate a hash for deduplication
   */
  generateLearningId(learning: string): string {
    return createHash("md5")
      .update(learning.toLowerCase().trim())
      .digest("hex")
      .substring(0, 12);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create an empty knowledge base structure
   */
  private createEmptyKnowledgeBase(): KnowledgeBase {
    return {
      metadata: {
        lastUpdated: new Date().toISOString(),
        totalLearnings: 0,
      },
      sections: new Map(),
    };
  }

  /**
   * Check if a learning already exists in the knowledge base
   */
  private isDuplicate(kb: KnowledgeBase, learning: ExtractedLearning): boolean {
    const section = kb.sections.get(learning.category);
    if (!section) {
      return false;
    }

    const normalizedNew = learning.learning.toLowerCase().trim();

    for (const [, learnings] of section.subcategories) {
      for (const existing of learnings) {
        const normalizedExisting = existing.toLowerCase().trim();
        // Check for exact match or high similarity
        if (
          normalizedExisting === normalizedNew ||
          this.isSimilar(normalizedExisting, normalizedNew)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if two learnings are similar (simple similarity check)
   */
  private isSimilar(a: string, b: string): boolean {
    // Remove common words and check overlap
    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 3));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 3));

    if (wordsA.size === 0 || wordsB.size === 0) {
      return false;
    }

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) {
        overlap++;
      }
    }

    const similarity = overlap / Math.max(wordsA.size, wordsB.size);
    return similarity > 0.7; // 70% word overlap = similar
  }

  /**
   * Parse markdown content into structured knowledge base
   */
  private parseMarkdown(content: string): KnowledgeBase {
    const kb = this.createEmptyKnowledgeBase();
    const lines = content.split("\n");

    let currentCategory: LearningCategory | null = null;
    let currentSubcategory = "General";
    let inMetadata = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Parse metadata
      if (trimmed.startsWith("## Metadata")) {
        inMetadata = true;
        continue;
      }

      if (inMetadata) {
        if (trimmed.startsWith("---")) {
          inMetadata = false;
          continue;
        }

        if (trimmed.startsWith("- Last Updated:")) {
          kb.metadata.lastUpdated = trimmed
            .replace("- Last Updated:", "")
            .trim();
        } else if (trimmed.startsWith("- Total Learnings:")) {
          kb.metadata.totalLearnings =
            parseInt(trimmed.replace("- Total Learnings:", "").trim(), 10) || 0;
        } else if (trimmed.startsWith("- Last Summarization:")) {
          const value = trimmed.replace("- Last Summarization:", "").trim();
          if (value !== "N/A") {
            kb.metadata.lastSummarization = value;
          }
        }
        continue;
      }

      // Parse category headers (## level)
      if (trimmed.startsWith("## ")) {
        const sectionName = trimmed.substring(3);
        currentCategory = this.categoryFromSectionName(sectionName);
        currentSubcategory = "General";

        if (currentCategory) {
          kb.sections.set(currentCategory, {
            category: currentCategory,
            subcategories: new Map(),
          });
        }
        continue;
      }

      // Parse subcategory headers (### level)
      if (trimmed.startsWith("### ")) {
        currentSubcategory = trimmed.substring(4);
        continue;
      }

      // Parse learning entries (- bullet points)
      if (trimmed.startsWith("- ") && currentCategory) {
        const learning = trimmed.substring(2);
        const section = kb.sections.get(currentCategory);

        if (section) {
          let learnings = section.subcategories.get(currentSubcategory);
          if (!learnings) {
            learnings = [];
            section.subcategories.set(currentSubcategory, learnings);
          }
          learnings.push(learning);
        }
      }
    }

    return kb;
  }

  /**
   * Convert category section name back to category enum
   */
  private categoryFromSectionName(name: string): LearningCategory | null {
    for (const [category, sectionName] of Object.entries(
      CATEGORY_SECTION_NAMES,
    )) {
      if (name.includes(sectionName) || sectionName.includes(name)) {
        return category as LearningCategory;
      }
    }

    // Fallback matching
    const lowerName = name.toLowerCase();
    if (
      lowerName.includes("false positive") ||
      lowerName.includes("don't flag")
    ) {
      return "false_positive";
    }
    if (lowerName.includes("missed") || lowerName.includes("should have")) {
      return "missed_issue";
    }
    if (lowerName.includes("style") || lowerName.includes("convention")) {
      return "style_preference";
    }
    if (lowerName.includes("context") || lowerName.includes("domain")) {
      return "domain_context";
    }
    if (lowerName.includes("enhancement") || lowerName.includes("guideline")) {
      return "enhancement_guideline";
    }

    return null;
  }

  /**
   * Convert knowledge base structure to markdown
   */
  private toMarkdown(kb: KnowledgeBase): string {
    const lines: string[] = [];

    // Header
    lines.push("# Project Knowledge Base");
    lines.push(
      "> Learned patterns, preferences, and guidelines from team feedback",
    );
    lines.push("");

    // Metadata
    lines.push("## Metadata");
    lines.push(`- Last Updated: ${kb.metadata.lastUpdated}`);
    lines.push(`- Total Learnings: ${kb.metadata.totalLearnings}`);
    lines.push(
      `- Last Summarization: ${kb.metadata.lastSummarization || "N/A"}`,
    );
    lines.push("");
    lines.push("---");
    lines.push("");

    // Sections in order
    const categoryOrder: LearningCategory[] = [
      "false_positive",
      "missed_issue",
      "style_preference",
      "domain_context",
      "enhancement_guideline",
    ];

    for (const category of categoryOrder) {
      const sectionName = CATEGORY_SECTION_NAMES[category];
      lines.push(`## ${sectionName}`);
      lines.push("");

      const section = kb.sections.get(category);
      if (section && section.subcategories.size > 0) {
        // Sort subcategories
        const sortedSubcats = Array.from(section.subcategories.entries()).sort(
          ([a], [b]) => a.localeCompare(b),
        );

        for (const [subcategory, learnings] of sortedSubcats) {
          if (subcategory !== "General") {
            lines.push(`### ${subcategory}`);
          }

          for (const learning of learnings) {
            lines.push(`- ${learning}`);
          }
          lines.push("");
        }
      } else {
        // Add description placeholder for empty sections
        lines.push(this.getSectionDescription(category));
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Get description text for empty sections
   */
  private getSectionDescription(category: LearningCategory): string {
    switch (category) {
      case "false_positive":
        return "Things AI incorrectly flagged as issues. Avoid repeating these mistakes.";
      case "missed_issue":
        return "Patterns AI missed that should be caught in future reviews.";
      case "style_preference":
        return "Project-specific coding conventions that differ from general best practices.";
      case "domain_context":
        return "Project-specific context AI needs for accurate reviews.";
      case "enhancement_guideline":
        return "How AI should provide suggestions for this project.";
      default:
        return "";
    }
  }
}
