/**
 * Unit tests for Observability Configuration
 * Tests Langfuse configuration builder
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../../../src/v2/utils/ObservabilityConfig.js";

describe("ObservabilityConfig", () => {
  // Store original env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear observability env vars before each test
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_ENABLED;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("buildObservabilityConfigFromEnv", () => {
    it("should return null when no env vars are set", () => {
      const config = buildObservabilityConfigFromEnv();
      expect(config).toBeNull();
    });

    it("should return null when only public key is set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
      const config = buildObservabilityConfigFromEnv();
      expect(config).toBeNull();
    });

    it("should return null when only secret key is set", () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-test";
      const config = buildObservabilityConfigFromEnv();
      expect(config).toBeNull();
    });

    it("should return config when both keys are set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-test-123";
      process.env.LANGFUSE_SECRET_KEY = "sk-test-456";

      const config = buildObservabilityConfigFromEnv();

      expect(config).not.toBeNull();
      expect(config).toHaveProperty("langfuse");
      expect(config?.langfuse).toMatchObject({
        publicKey: "pk-test-123",
        secretKey: "sk-test-456",
        baseUrl: "https://cloud.langfuse.com", // default
        enabled: true, // default
      });
    });

    it("should use custom base URL when provided", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
      process.env.LANGFUSE_SECRET_KEY = "sk-test";
      process.env.LANGFUSE_BASE_URL = "https://custom.langfuse.com";

      const config = buildObservabilityConfigFromEnv();

      expect(config?.langfuse.baseUrl).toBe("https://custom.langfuse.com");
    });

    it("should respect LANGFUSE_ENABLED=false", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
      process.env.LANGFUSE_SECRET_KEY = "sk-test";
      process.env.LANGFUSE_ENABLED = "false";

      const config = buildObservabilityConfigFromEnv();

      expect(config?.langfuse.enabled).toBe(false);
    });

    it("should default to enabled=true when LANGFUSE_ENABLED not set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
      process.env.LANGFUSE_SECRET_KEY = "sk-test";

      const config = buildObservabilityConfigFromEnv();

      expect(config?.langfuse.enabled).toBe(true);
    });
  });

  describe("validateObservabilityConfig", () => {
    it("should return true for null config", () => {
      expect(validateObservabilityConfig(null)).toBe(true);
    });

    it("should return true for valid config", () => {
      const config = {
        langfuse: {
          publicKey: "pk-test",
          secretKey: "sk-test",
          baseUrl: "https://cloud.langfuse.com",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(true);
    });

    it("should return false when publicKey is missing", () => {
      const config = {
        langfuse: {
          publicKey: "",
          secretKey: "sk-test",
          baseUrl: "https://cloud.langfuse.com",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(false);
    });

    it("should return false when secretKey is missing", () => {
      const config = {
        langfuse: {
          publicKey: "pk-test",
          secretKey: "",
          baseUrl: "https://cloud.langfuse.com",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(false);
    });

    it("should return false when baseUrl is invalid (not http/https)", () => {
      const config = {
        langfuse: {
          publicKey: "pk-test",
          secretKey: "sk-test",
          baseUrl: "ftp://invalid.com",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(false);
    });

    it("should return true when baseUrl is https", () => {
      const config = {
        langfuse: {
          publicKey: "pk-test",
          secretKey: "sk-test",
          baseUrl: "https://valid.com",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(true);
    });

    it("should return true when baseUrl is http", () => {
      const config = {
        langfuse: {
          publicKey: "pk-test",
          secretKey: "sk-test",
          baseUrl: "http://localhost:3000",
          enabled: true,
        },
      };

      expect(validateObservabilityConfig(config)).toBe(true);
    });
  });
});
