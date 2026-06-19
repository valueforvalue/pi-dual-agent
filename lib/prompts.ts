/**
 * pi-dual-agent - Agent Prompts
 *
 * The router (lib/router.ts) builds prompts for sub-sessions using
 * the router preamble. The old THINKER/DOER prompts (with their
 * embedded pipeline and plan.md format) are gone; the slash skills
 * own the pipeline now.
 *
 * Legacy functions formatThinkerTask / formatDoerTask are kept for
 * the old orchestrator loop in lib/loop.ts, which will be removed
 * in a follow-up commit. They delegate to the router preamble so
 * the prompt content has a single source of truth.
 */

import type { DualMode } from "./types";
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

/**
 * Legacy checkpoint notification. Still used by the old
 * orchestrator loop (lib/loop.ts) which will be removed in a
 * follow-up commit.
 */
export const CHECKPOINT_NOTIFICATION = `# Human Checkpoint

The Thinker has prepared a plan for your review.

Review the plan in .pi/inbox/plan.md

Options:
1. [ ] Approve - Execute as planned
2. [ ] Modify - Edit the plan with your changes
3. [ ] Stop - End the workflow

After making your decision, the workflow will continue based on your choice.
`;

/**
 * Legacy loop-complete notification. Same status as above.
 */
export const LOOP_COMPLETE = `# Dual Agent Complete

The workflow has finished.

Final status:
- Iterations: {count}
- Total cost: <calculated at runtime>

Results summary available in .pi/inbox/results.md
`;

/**
 * Look up the model id string for a role from the persisted config
 * shape. Used by the legacy format functions. The router reads the
 * model directly from state, not through this helper.
 */
function resolveModelId(
  mode: DualMode,
  thinkerModel: { provider: string; id: string } | null,
  doerModel: { provider: string; id: string } | null,
): string {
  // The old simple/complex mode distinction is gone; the role
  // determines the model. We default to the Thinker model for the
  // legacy function signature, which used to be called for both.
  const m = thinkerModel ?? doerModel;
  return m ? `${m.provider}/${m.id}` : "(unset)";
}

/**
 * Legacy: format the prompt for a Thinker run. Now delegates to
 * the router preamble. Kept for the old orchestrator loop.
 *
 * @deprecated Use the router (lib/router.ts) directly.
 */
export function formatThinkerTask(
  task: string,
  mode: DualMode,
  options?: { thinkerModel?: { provider: string; id: string } | null },
): string {
  const modelId = resolveModelId(mode, options?.thinkerModel ?? null, null);
  return buildRouterPreamble("thinker", modelId, "/grill-with-docs", task);
}

/**
 * Legacy: format the prompt for a Doer run. Now delegates to the
 * router preamble. Kept for the old orchestrator loop.
 *
 * @deprecated Use the router (lib/router.ts) directly.
 */
export function formatDoerTask(plan: string): string {
  return buildRouterPreamble("doer", "(unset)", "/implement", plan);
}
