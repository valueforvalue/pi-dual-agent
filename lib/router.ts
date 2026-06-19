/**
 * pi-dual-agent - Slash-Skill Model Router
 *
 * Routes slash-skill invocations to a sub-session configured with the
 * Thinker or Doer model. The sub-session is ephemeral: created for one
 * prompt, disposed when done. Cost is accumulated against the right
 * model bucket.
 *
 * TUI feedback: status bar shows the active sub-session, widget shows
 * the live state (tokens, cost, current action), and a throttled
 * caveman-style progress stream goes to the main chat.
 *
 * The old custom orchestrator loop (lib/loop.ts) and file relay
 * (lib/inbox.ts) are untouched in this commit - they will be removed
 * in later commits. This module is additive.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "./types";
import { getSessionManager } from "./sessions";
import { buildRouterPreamble } from "./prompts";
import type { DualRole, DualCommand } from "./router-parser";

// Re-export the parser for callers that already import from
// "./router". The parser itself lives in its own module so the
// test suite can import it without pulling in the session runtime.
export { parseDualRouterCommand, type DualRole, type DualCommand } from "./router-parser";

/**
 * Tool set for sub-sessions. Thinker sub-sessions don't need bash or
 * edit (they plan, not execute). Doer sub-sessions get the full set.
 */
const THINKER_SUB_TOOLS = ["read", "write", "grep", "find", "ls"];
const DOER_SUB_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Throttle for the main-chat progress stream. Bursts of tool calls
 * (a long read-then-grep-then-read sequence) get collapsed to one
 * message per PROGRESS_THROTTLE_MS.
 */
const PROGRESS_THROTTLE_MS = 3000;
const TOOL_CALL_THROTTLE_MS = 1500;

let lastProgressAt = 0;
let lastToolCallKey = "";
let lastToolCallAt = 0;

interface SubSessionState {
  role: DualRole;
  model: string;
  slash: string;
  startTime: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  lastAction: string;
}

let activeSub: SubSessionState | null = null;

/**
 * Build the router preamble that goes at the top of the sub-session's
 * prompt. Delegates to prompts.ts:buildRouterPreamble so the prompt
 * content has a single source of truth.
 */
function buildSubSessionPrompt(
  role: DualRole,
  model: string,
  slash: string,
  args: string,
): string {
  return buildRouterPreamble(role, model, slash, args);
}

/**
 * Push a throttled progress message to the main chat.
 *
 * Used for sub-session lifecycle events (start, tool calls, turn
 * end, completion, error). Throttled to avoid flooding the chat
 * during long sessions.
 */
function pushProgress(
  ctx: ExtensionContext,
  msg: string,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  if (!options.force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
  lastProgressAt = now;
  ctx.ui.notify(msg, "info");
}

/**
 * Push a throttled tool-call progress message. Same key collapses
 * to a single message (so 5 reads in a row show as one).
 */
function pushToolCallProgress(
  ctx: ExtensionContext,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const key = toolName;
  const now = Date.now();
  if (key === lastToolCallKey && now - lastToolCallAt < TOOL_CALL_THROTTLE_MS) return;
  lastToolCallKey = key;
  lastToolCallAt = now;
  const action = describeToolCall(toolName, args);
  pushProgress(ctx, `[dual:${activeSub?.role}] ${action}`, { force: true });
}

/**
 * Compact description of a tool call for the progress stream.
 * Caveman-style: short verbs, no articles, no fluff.
 */
function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  const arg = (args as { path?: string; file_path?: string; command?: string; pattern?: string; query?: string });
  switch (toolName) {
    case "read": {
      const p = arg.path || arg.file_path || "";
      return p ? `read ${p}` : "read";
    }
    case "write": {
      const p = arg.path || arg.file_path || "";
      return p ? `write ${p}` : "write";
    }
    case "edit": {
      const p = arg.path || arg.file_path || "";
      return p ? `edit ${p}` : "edit";
    }
    case "bash":
      return arg.command ? `run: ${truncate(arg.command, 60)}` : "run bash";
    case "grep":
      return arg.pattern || arg.query ? `grep ${arg.pattern || arg.query}` : "grep";
    case "find":
      return "find";
    case "ls":
      return "ls";
    default:
      return toolName;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}

/**
 * Update the status bar to show the active sub-session.
 */
function updateStatusBarForActive(ctx: ExtensionContext): void {
  if (!activeSub) {
    ctx.ui.setStatus("pi-dual-agent", "");
    return;
  }
  const elapsed = formatDuration(Date.now() - activeSub.startTime);
  const status = `⏵ Dual: ${activeSub.role} active — ${activeSub.model} · ${activeSub.slash} (${elapsed})`;
  ctx.ui.setStatus("pi-dual-agent", status);
}

/**
 * Update the widget to show the active sub-session's live state.
 */
function updateWidgetForActive(ctx: ExtensionContext): void {
  if (!activeSub) {
    ctx.ui.setWidget("pi-dual-agent", []);
    return;
  }
  const lines = [
    `┌─ Sub-session ─────────────────────┐`,
    `│ Model:    ${activeSub.model.padEnd(20)} │`,
    `│ Class:    ${activeSub.role.padEnd(20)} │`,
    `│ Skill:    ${activeSub.slash.padEnd(20)} │`,
    `│ Turns:    ${String(activeSub.turns).padEnd(20)} │`,
    `│ Tokens:   ${(activeSub.tokensIn + activeSub.tokensOut).toString().padEnd(20)} │`,
    `│ Cost:     $${activeSub.cost.toFixed(4).padEnd(19)} │`,
    `│ Action:   ${activeSub.lastAction.slice(0, 20).padEnd(20)} │`,
    `└────────────────────────────────────┘`,
  ];
  ctx.ui.setWidget("pi-dual-agent", lines, { placement: "belowEditor" });
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}

/**
 * Look up the configured model for a role from the dual-agent state.
 * The state is held in the index.ts module - we accept it as a
 * parameter to keep this module decoupled from index.ts internals.
 */
export interface RoleModels {
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
}

function getRoleModel(roles: RoleModels, role: DualRole): ModelRef | null {
  return role === "thinker" ? roles.thinkerModel : roles.doerModel;
}

/**
 * Handle a single event from the sub-session. Updates activeSub state
 * and pushes throttled progress.
 */
function handleSubSessionEvent(event: any, ctx: ExtensionContext): void {
  if (!activeSub) return;

  switch (event.type) {
    case "agent_start":
      pushProgress(ctx, `[dual:${activeSub.role}] ${activeSub.slash}`, { force: true });
      break;
    case "message_start":
      if (event.message?.role === "assistant") {
        activeSub.lastAction = "thinking...";
        updateWidgetForActive(ctx);
      }
      break;
    case "message_end": {
      const m = event.message;
      if (m?.role === "assistant" && m.usage) {
        activeSub.turns += 1;
        activeSub.tokensIn += m.usage.input || 0;
        activeSub.tokensOut += m.usage.output || 0;
        if (m.usage.cost && typeof m.usage.cost === "object") {
          activeSub.cost += m.usage.cost.total || 0;
        }
        updateWidgetForActive(ctx);
        updateStatusBarForActive(ctx);
      }
      break;
    }
    case "tool_execution_start":
      activeSub.lastAction = describeToolCall(event.toolName, event.args || {});
      updateWidgetForActive(ctx);
      pushToolCallProgress(ctx, event.toolName, event.args || {});
      break;
    case "tool_execution_end":
      updateWidgetForActive(ctx);
      break;
    case "agent_end":
      pushProgress(
        ctx,
        `[dual:${activeSub.role}] done — ${activeSub.turns} turns, ${activeSub.tokensIn + activeSub.tokensOut} tokens, $${activeSub.cost.toFixed(4)}`,
        { force: true },
      );
      break;
  }
}

/**
 * Run a dual command. Creates an ephemeral sub-session with the
 * configured model for the role, sends the prompt, waits for
 * completion, accumulates cost, and disposes the session.
 *
 * The slash command's output is printed to the main chat as a normal
 * assistant message. The throttled progress stream gives the user
 * a narrative of what the sub-session did while it ran.
 */
export async function runDualCommand(
  ctx: ExtensionContext,
  cmd: DualCommand,
  roles: RoleModels,
): Promise<void> {
  const model = getRoleModel(roles, cmd.role);
  if (!model) {
    ctx.ui.notify(
      `No ${cmd.role} model configured. Run /dual setup to pick one.`,
      "error",
    );
    return;
  }

  const sm = getSessionManager();
  await sm.ensureReady(); // type-only; ensureInitialized is the real one - see below
  const modelObj = sm.findModel(model.provider, model.id);
  if (!modelObj) {
    ctx.ui.notify(
      `Model not found: ${model.provider}/${model.id}. Run /dual setup.`,
      "error",
    );
    return;
  }

  // Set up active sub-session state for TUI feedback
  activeSub = {
    role: cmd.role,
    model: `${model.provider}/${model.id}`,
    slash: cmd.slash,
    startTime: Date.now(),
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    lastAction: "starting...",
  };
  updateStatusBarForActive(ctx);
  updateWidgetForActive(ctx);

  // Create ephemeral sub-session
  const ephemeralManager = SessionManager.inMemory();
  const tools = cmd.role === "thinker" ? THINKER_SUB_TOOLS : DOER_SUB_TOOLS;
  const prompt = buildSubSessionPrompt(cmd.role, activeSub.model, cmd.slash, cmd.args);

  let session: any = null;
  let unsubscribe: (() => void) | null = null;
  try {
    const created = await createAgentSession({
      model: modelObj,
      cwd: ctx.cwd,
      sessionManager: ephemeralManager,
      tools,
    });
    session = created.session;
    unsubscribe = session.subscribe((event: any) => handleSubSessionEvent(event, ctx));

    await session.prompt(prompt);
    await session.agent.waitForIdle();

    // Print the slash command's output to the main chat as a normal
    // assistant message. The progress stream already showed the user
    // what happened; this is the actual result.
    const entries = (ephemeralManager.getEntries() ?? []) as any[];
    const lastAssistant = entries
      .slice()
      .reverse()
      .find((e) => e?.type === "message" && e?.message?.role === "assistant");
    const text = extractAssistantText(lastAssistant?.message);
    if (text) {
      ctx.ui.notify(text, "info");
    }
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    pushProgress(ctx, `[dual:${cmd.role}] error: ${message}`, { force: true });
    ctx.ui.notify(`Sub-session failed: ${message}`, "error");
  } finally {
    if (unsubscribe) unsubscribe();
    if (session) {
      try { await session.dispose(); } catch { /* ignore */ }
    }
    // Accumulate the run's cost into the appropriate bucket. Read
    // activeSub before nulling it.
    const runCost = activeSub
      ? {
          inputTokens: activeSub.tokensIn,
          outputTokens: activeSub.tokensOut,
          cost: activeSub.cost,
          turns: activeSub.turns,
        }
      : { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 };
    getSessionManager().recordRunCost(cmd.role, runCost);
    activeSub = null;
    updateStatusBarForActive(ctx);
    updateWidgetForActive(ctx);
  }
}

/**
 * Extract text content from an assistant message entry.
 */
function extractAssistantText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Whether a sub-session is currently active. Used by `/dual stop` to
 * decide whether to cancel something.
 */
export function isSubSessionActive(): boolean {
  return activeSub !== null;
}

/**
 * Clear the active sub-session state. Used by `/dual stop` and on
 * extension unload.
 */
export function clearActiveSubSession(): void {
  activeSub = null;
}
