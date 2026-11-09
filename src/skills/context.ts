/**
 * Skill execution context
 *
 * Carries per-invocation identity (user, platform) to skill handlers without
 * changing the `(args: string) => Promise<string>` handler signature. Backed by
 * AsyncLocalStorage so concurrent messages cannot observe each other's context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SkillExecutionContext {
  userId?: string;
  platform?: string;
}

const storage = new AsyncLocalStorage<SkillExecutionContext>();

export function runWithSkillContext<T>(context: SkillExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getSkillExecutionContext(): SkillExecutionContext | undefined {
  return storage.getStore();
}
