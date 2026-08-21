/**
 * Types for the watermark layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { LearnWatermark } from "./window.js";

export type WatermarkLoad = {
  watermark: LearnWatermark;
  existed: boolean;
  warning?: string;
};
