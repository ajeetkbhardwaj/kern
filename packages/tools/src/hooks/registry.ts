/**
 * @kern/tools/hooks/registry — Hook registration and storage.
 *
 * Adapts docker-agents Chapter 12 hook registration patterns for TypeScript/kern.
 * Supports global user-level hooks + per-agent/per-config hooks with priority ordering.
 */

import type { HookRegistration } from "./events/contracts.js";

/**
 * HookRegistry stores and manages hook registrations.
 * Hooks are sorted by priority (lower runs first).
 */
export class HookRegistry {
  private hooks = new Map<string, HookRegistration[]>();

  /**
   * Register a hook for an event.
   * @param registration - The hook registration to add.
   */
  register(registration: HookRegistration): void {
    const eventHooks = this.hooks.get(registration.event) ?? [];
    eventHooks.push(registration);
    // Sort by priority (lower first), then by registration order
    eventHooks.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.hooks.set(registration.event, eventHooks);
  }

  /**
   * Unregister a hook by matching event and handler identity.
   */
  unregister(event: string, handler: HookRegistration["handler"]): boolean {
    const eventHooks = this.hooks.get(event);
    if (!eventHooks) return false;
    const index = eventHooks.findIndex((h) => h.handler === handler);
    if (index === -1) return false;
    eventHooks.splice(index, 1);
    if (eventHooks.length === 0) {
      this.hooks.delete(event);
    }
    return true;
  }

  /**
   * Get all hooks registered for an event, sorted by priority.
   */
  getHooks(event: string): HookRegistration[] {
    return [...(this.hooks.get(event) ?? [])];
  }

  /**
   * Get all registered event names.
   */
  getEvents(): string[] {
    return [...this.hooks.keys()];
  }

  /**
   * Check if any hooks are registered for an event.
   */
  hasHooks(event: string): boolean {
    return this.hooks.has(event);
  }

  /**
   * Clear all hooks for an event (or all events if none specified).
   */
  clear(event?: string): void {
    if (event) {
      this.hooks.delete(event);
    } else {
      this.hooks.clear();
    }
  }

  /**
   * Get the total number of hook registrations.
   */
  size(): number {
    let total = 0;
    for (const hooks of this.hooks.values()) {
      total += hooks.length;
    }
    return total;
  }
}

/**
 * Simple glob-like matcher for hook event/tool name patterns.
 * Supports: * (match any), ? (match single char), and exact matches.
 */
export function matchPattern(pattern: string, name: string): boolean {
  if (!pattern) return true;
  if (pattern === "*") return true;
  if (pattern === name) return true;

  // Convert glob pattern to regex
  const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regexStr).test(name);
}