/**
 * @kern/tools/hooks — Hook system entry point.
 *
 * Exports hook contracts, registry, executor, and built-in hooks.
 */

export * from "./events/contracts.js";
export { HookRegistry, matchPattern } from "./registry.js";
export { HookExecutor, createHookExecutor } from "./executor.js";
export {
  redactSecretsHook,
  limitLargeToolResultsHook,
  addContextHook,
  addDateHook,
  addEnvironmentInfoHook,
  keepAwakeHook,
  getBuiltinHooks,
} from "./builtins.js";
export {
  registerBuiltinHandler,
  getBuiltinHandler,
  loadHookConfigFile,
  loadHooksDir,
  loadDefaultHookConfigs,
  defaultConfigPaths,
  defaultHooksDirs,
  type HookConfigEntry,
  type HookConfigFile,
} from "./config-loader.js";