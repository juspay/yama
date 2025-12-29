/**
 * Langfuse Prompt Manager
 * Fetches prompts from Langfuse Prompt Management with local fallbacks
 *
 * Prompt Names in Langfuse:
 * - yama-review: Review system prompt
 * - yama-enhancement: Enhancement system prompt
 */

import { Langfuse } from "langfuse";
import { REVIEW_SYSTEM_PROMPT } from "./ReviewSystemPrompt.js";
import { ENHANCEMENT_SYSTEM_PROMPT } from "./EnhancementSystemPrompt.js";
import {
  LEARNING_EXTRACTION_PROMPT,
  LEARNING_SUMMARIZATION_PROMPT,
} from "./LearningSystemPrompt.js";

export class LangfusePromptManager {
  private client: Langfuse | null = null;
  private initialized = false;

  constructor() {
    this.initializeClient();
  }

  /**
   * Initialize Langfuse client if credentials are available
   */
  private initializeClient(): void {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL;

    if (publicKey && secretKey) {
      try {
        this.client = new Langfuse({
          publicKey,
          secretKey,
          baseUrl: baseUrl || "https://cloud.langfuse.com",
        });
        this.initialized = true;
        console.log("   📝 Langfuse prompt management enabled");
      } catch (error) {
        console.warn(
          "   ⚠️ Failed to initialize Langfuse client:",
          error instanceof Error ? error.message : String(error),
        );
        this.client = null;
        this.initialized = false;
      }
    }
  }

  /**
   * Get the review system prompt
   * Fetches from Langfuse if available, otherwise returns local fallback
   */
  async getReviewPrompt(): Promise<string> {
    if (!this.client) {
      return REVIEW_SYSTEM_PROMPT;
    }

    try {
      const prompt = await this.client.getPrompt("yama-review", undefined, {
        type: "text",
        fallback: REVIEW_SYSTEM_PROMPT,
      });
      console.log("   ✅ Fetched review prompt from Langfuse");
      return prompt.prompt as string;
    } catch (error) {
      console.warn(
        "   ⚠️ Failed to fetch review prompt from Langfuse, using fallback:",
        error instanceof Error ? error.message : String(error),
      );
      return REVIEW_SYSTEM_PROMPT;
    }
  }

  /**
   * Get the enhancement system prompt
   * Fetches from Langfuse if available, otherwise returns local fallback
   */
  async getEnhancementPrompt(): Promise<string> {
    if (!this.client) {
      return ENHANCEMENT_SYSTEM_PROMPT;
    }

    try {
      const prompt = await this.client.getPrompt(
        "yama-enhancement",
        undefined,
        {
          type: "text",
          fallback: ENHANCEMENT_SYSTEM_PROMPT,
        },
      );
      console.log("   ✅ Fetched enhancement prompt from Langfuse");
      return prompt.prompt as string;
    } catch (error) {
      console.warn(
        "   ⚠️ Failed to fetch enhancement prompt from Langfuse, using fallback:",
        error instanceof Error ? error.message : String(error),
      );
      return ENHANCEMENT_SYSTEM_PROMPT;
    }
  }

  /**
   * Get the learning extraction prompt
   * Fetches from Langfuse if available, otherwise returns local fallback
   * Langfuse prompt name: "yama-learning"
   */
  async getLearningPrompt(): Promise<string> {
    if (!this.client) {
      return LEARNING_EXTRACTION_PROMPT;
    }

    try {
      const prompt = await this.client.getPrompt("yama-learning", undefined, {
        type: "text",
        fallback: LEARNING_EXTRACTION_PROMPT,
      });
      console.log("   ✅ Fetched learning prompt from Langfuse");
      return prompt.prompt as string;
    } catch (error) {
      console.warn(
        "   ⚠️ Failed to fetch learning prompt from Langfuse, using fallback:",
        error instanceof Error ? error.message : String(error),
      );
      return LEARNING_EXTRACTION_PROMPT;
    }
  }

  /**
   * Get the summarization prompt
   * Fetches from Langfuse if available, otherwise returns local fallback
   * Langfuse prompt name: "yama-summarization"
   */
  async getSummarizationPrompt(): Promise<string> {
    if (!this.client) {
      return LEARNING_SUMMARIZATION_PROMPT;
    }

    try {
      const prompt = await this.client.getPrompt(
        "yama-summarization",
        undefined,
        {
          type: "text",
          fallback: LEARNING_SUMMARIZATION_PROMPT,
        },
      );
      console.log("   ✅ Fetched summarization prompt from Langfuse");
      return prompt.prompt as string;
    } catch (error) {
      console.warn(
        "   ⚠️ Failed to fetch summarization prompt from Langfuse, using fallback:",
        error instanceof Error ? error.message : String(error),
      );
      return LEARNING_SUMMARIZATION_PROMPT;
    }
  }

  /**
   * Check if Langfuse is enabled
   */
  isEnabled(): boolean {
    return this.initialized;
  }

  /**
   * Shutdown Langfuse client gracefully
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.shutdownAsync();
    }
  }
}
