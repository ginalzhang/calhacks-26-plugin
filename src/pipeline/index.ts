/**
 * Public entry points of the pointer pipeline (agent A). Pure modules: no DOM, no React.
 */
export { createPipeline, modeState, panState, SMOOTHING_PRESETS, type ModeState, type PipelineOptions } from "./pipeline";
export { createCalibrator, mirrorCalibration, STEP_MS, STEP_PROMPTS, type CalibratorOptions } from "./calibration";
export {
  parseCommand,
  keyterms,
  closestActions,
  validateAlias,
  isAliasRefusal,
  type AliasRefusal,
  normalize,
  ALIAS_ACTION,
  MAX_COMMANDS,
} from "./grammar";
export { steadinessParams, suggestedSteadiness } from "./steadiness";
export { boxToTarget, calibratedGain, clampPointer, defaultBox, inRect, transformNormalized } from "./mapping";
export { OneEuro, OneEuro2D } from "./oneEuro";
export { LazyBrush } from "./lazyBrush";
export { TremorSim } from "./tremorSim";
export { clickZone, dwellRIn } from "./dwell";
export { hatchMargin, offsetStroke, DASH_PAUSE_DEFAULT_MS } from "./strokeModes";
