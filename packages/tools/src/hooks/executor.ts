/**
 * @kern/tools/hooks/executor — Hook execution engine.
 *
 * Adapts docker-agents Chapter 12 executor.go patterns for TypeScript/kern.
 * Runs hooks for each event, supports blocking, transform lanes, and verdict aggregation.
 */

import type {
  HookHandler,
  HookPipelineResult,
  HookRegistration,
  TransformResult,
} from "./events/contracts.js";
import { HookRegistry } from "./registry.js";
import { matchPattern } from "./registry.js";

/**
 * HookExecutor runs hooks registered with a HookRegistry.
 * Supports sequential execution (for blocking hooks) and parallel execution (for metadata hooks).
 */
export class HookExecutor {
  constructor(private registry: HookRegistry) {}

  /**
   * Run all hooks for an event, sequentially.
   * Returns whether execution should proceed (false if any blocking hook returned false).
   */
  async run(event: string, ...params: unknown[]): Promise<HookPipelineResult> {
    const hooks = this.registry.getHooks(event);
    const verdicts: Array<{ event: string; matched: boolean; decision: boolean }> = [];
    let proceed = true;

    for (const hook of hooks) {
      const handler = hook.handler as HookHandler;
      try {
        const decision = (await handler(...params)) as boolean;
        verdicts.push({ event, matched: true, decision });
        if (hook.canBlock !== false && decision === false) {
          proceed = false;
          break;
        }
      } catch (error) {
        verdicts.push({ event, matched: true, decision: false });
        proceed = false;
        break;
      }
    }

    return { proceed, verdicts };
  }

  /**
   * Run transform hooks for an event, composing results left-to-right.
   * Returns the final transformed params.
   */
  async runTransform(event: string, params: unknown[]): Promise<TransformResult> {
    const hooks = this.registry.getHooks(event);
    let currentParams = [...params];
    let transformed = false;

    for (const hook of hooks) {
      const handler = hook.handler as HookHandler;
      try {
        const result = (await handler(...currentParams)) as unknown as unknown[];
        if (Array.isArray(result) && result.length > 0) {
          currentParams = result;
          transformed = true;
        }
      } catch {
        // Hook errors don't block transform hooks - continue with current params
      }
    }

    return { transformed, params: transformed ? currentParams : undefined };
  }

  /**
   * Run guard hooks that return PolicyDecision objects.
   * Returns the first non-"allow" decision, or "allow" if all hooks return "allow".
   */
  async runGuard(event: string, ...params: unknown[]): Promise<{ decision: "allow" } | { decision: "deny"; reason: string } | { decision: "require_approval"; prompt: string }> {
    const hooks = this.registry.getHooks(event);

    for (const hook of hooks) {
      const handler = hook.handler as HookHandler;
      try {
        const result = (await handler(...params)) as unknown as
          | { decision: "allow" }
          | { decision: "deny"; reason: string }
          | { decision: "require_approval"; prompt: string };
        if (result.decision !== "allow") {
          return result;
        }
      } catch {
        // Guard hook errors default to deny
        return { decision: "deny", reason: `Hook ${event} threw an error` };
      }
    }

    return { decision: "allow" };
  }

  /**
   * Run notification hooks (fire-and-forget). Errors are swallowed.
   */
  async runNotify(event: string, ...params: unknown[]): Promise<void> {
    const hooks = this.registry.getHooks(event);
    await Promise.all(
      hooks.map(async (hook) => {
        try {
          await (hook.handler as HookHandler)(...params);
        } catch {
          // Swallow errors from notification hooks
        }
      }),
    );
  }

  /**
   * Run hooks for a tool-specific event with matcher filtering.
   * Only hooks whose matcher matches the toolName will run.
   */
  async runToolEvent(
    event: string,
    toolName: string,
    ...params: unknown[]
  ): Promise<HookPipelineResult> {
    const hooks = this.registry.getHooks(event);
    const verdicts: Array<{ event: string; matched: boolean; decision: boolean }> = [];
    let proceed = true;

    for (const hook of hooks) {
      // Skip hooks whose matcher doesn't match the tool name
      if (hook.matcher && !matchPattern(hook.matcher, toolName)) {
        verdicts.push({ event, matched: false, decision: true });
        continue;
      }

      const handler = hook.handler as HookHandler;
      try {
        const decision = (await handler(...params)) as boolean;
        verdicts.push({ event, matched: true, decision });
        if (hook.canBlock !== false && decision === false) {
          proceed = false;
          break;
        }
      } catch {
        verdicts.push({ event, matched: true, decision: false });
        proceed = false;
        break;
      }
    }

    return { proceed, verdicts };
  }
}

/**
 * Create a HookExecutor from a HookRegistry.
 */
export function createHookExecutor(registry: HookRegistry): HookExecutor {
  return new HookExecutor(registry);
}