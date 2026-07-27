/**
 * Optional generate() option fragments: temperature is never defaulted — when
 * the user has not configured one, the field must be omitted from the
 * NeuroLink call so the provider default applies.
 */
import { describe, it, expect } from "@jest/globals";
import { temperatureOption } from "../../../src/v2/utils/generateOptions.js";
import { DefaultConfig } from "../../../src/v2/config/DefaultConfig.js";

describe("temperatureOption", () => {
  it("includes finite numbers, including 0", () => {
    expect(temperatureOption(0.2)).toEqual({ temperature: 0.2 });
    expect(temperatureOption(0)).toEqual({ temperature: 0 });
    expect(temperatureOption(1)).toEqual({ temperature: 1 });
  });

  it("omits the field when unset", () => {
    expect(temperatureOption(undefined)).toEqual({});
    expect("temperature" in temperatureOption(undefined)).toBe(false);
  });

  it("treats non-finite and non-number values as unset", () => {
    // A bare `temperature:` YAML key parses to null; strings and NaN can leak
    // in through untyped config sources — none of them may reach the provider.
    expect(temperatureOption(null)).toEqual({});
    expect(temperatureOption(Number.NaN)).toEqual({});
    expect(temperatureOption(Number.POSITIVE_INFINITY)).toEqual({});
    expect(temperatureOption("0.2")).toEqual({});
  });

  it("spreads into an options object without a temperature key when unset", () => {
    const options = { model: "m", ...temperatureOption(undefined) };
    expect(Object.keys(options)).toEqual(["model"]);
  });
});

describe("DefaultConfig temperature", () => {
  it("ships no temperature default for the main or explore AI config", () => {
    const config = DefaultConfig.get();
    expect("temperature" in config.ai).toBe(false);
    expect("temperature" in config.ai.explore).toBe(false);
  });
});
