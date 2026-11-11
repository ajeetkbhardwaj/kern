/**
 * @kern/tools/safety — Safety mode system entry point.
 */

export type { SafetyMode } from "./safety-mode.js";
export type { CommandClass } from "./safety-patterns.js";
export {
  DEFAULT_SAFETY_MODE,
  evaluateSafetyMode,
  parseSafetyMode,
  type SafetyPolicyConfig,
  DEFAULT_SAFETY_POLICY_CONFIG,
} from "./safety-mode.js";
export {
  DESTRUCTIVE_PATTERNS,
  SAFE_PATTERNS,
  classifyCommand,
  matchDestructivePattern,
} from "./safety-patterns.js";