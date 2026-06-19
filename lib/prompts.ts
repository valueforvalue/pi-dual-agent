/**
 * pi-dual-agent - Router Preamble
 *
 * The router (lib/router.ts) sends a preamble to each sub-session so
 * the sub-session's model knows which model class it's playing, which
 * specific model is active, and what slash command the user invoked.
 *
 * The router preamble is the only prompt this extension produces. The
 * old THINKER/DOER system prompts (with their embedded pipelines and
 * plan.md formats) and the file-relay checkpoint notifications are
 * gone - the slash skills own the pipeline, and the file relay no
 * longer exists.
 */

import type { DualRole } from "./router-parser";

/**
 * Build the router preamble sent to a sub-session.
 *
 * The preamble tells the sub-session's model:
 *   - which model class it's playing (thinker or doer)
 *   - which specific model is active
 *   - that cost is being tracked against the role's bucket
 *   - what slash command the user invoked
 *
 * The slash command itself is what does the work - the preamble
 * just sets context.
 */
export function buildRouterPreamble(
  role: DualRole,
  model: string,
  slash: string,
  args: string,
): string {
  return [
    `[Router context]`,
    `You are running in a dual-agent sub-session.`,
    `Model class: ${role}`,
    `Model: ${model}`,
    `Cost is being tracked against the ${role} bucket.`,
    ``,
    `The user invoked: ${slash}`,
    `Run the slash command with the args provided below. Treat this as if the user had typed the slash command directly into a fresh session.`,
    ``,
    `---`,
    ``,
    args || "(no args)",
  ].join("\n");
}
