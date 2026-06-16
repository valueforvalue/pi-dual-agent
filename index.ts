/**
 * pi-dual-agent
 * 
 * Dual-agent system with Thinker + Doer roles:
 * - Thinker: Reasoning-focused, plans and reviews
 * - Doer: Execution-focused, implements plans
 * - Human Checkpoint: Reviews between Thinker and Doer
 * - File Relay: Markdown inbox for communication
 * 
 * Modes:
 * - Simple: Next-step focus
 * - Complex: Full to-prd/to-issues workflow
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { DualAgentState, TokenStats, DualMode, ModelRef } from "./lib/types";
import { getSessionManager, resetSessionManager } from "./lib/sessions";
import { createOrchestrator, destroyOrchestrator, getOrchestrator } from "./lib/loop";
import { createInboxManager } from "./lib/inbox";

// ========================================
// State
// ========================================

interface ExtensionState {
  active: boolean;
  mode: DualMode;
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
  iteration: number;
  phase: string;
  errorCount: number;
  taskDescription: string;
  projectPath: string;
  trace: boolean;
  tracePath: string | null;
}

let state: ExtensionState = {
  active: false,
  mode: "simple",
  thinkerModel: null,
  doerModel: null,
  iteration: 0,
  phase: "idle",
  errorCount: 0,
  taskDescription: "",
  projectPath: "",
  trace: false,
  tracePath: null,
};

// ========================================
// Persistence
// ========================================

function persistState(): void {
  // Note: This is a simplified version - full persistence would save to disk
  // For now, state is session-scoped
}

function loadState(_ctx: ExtensionContext): void {
  // Load from session entries if available
  // For now, start fresh
}

// ========================================
// UI Updates
// ========================================

function getPhaseIcon(phase: string): string {
  const icons: Record<string, string> = {
    idle: "○",
    thinking: "🤔",
    checkpoint: "⏸",
    doing: "⚡",
    reviewing: "🔍",
    done: "✓",
  };
  return icons[phase] || "?";
}

function updateStatusBar(ctx: ExtensionContext): void {
  // Persistent checkpoint status - visible until the user resolves the
  // checkpoint, not just a transient notification.
  if (state.phase === "checkpoint") {
    const status = `⏸ CHECKPOINT — review .pi/inbox/plan.md (Approve/Edit/Stop)`;
    ctx.ui.setStatus("pi-dual-agent", ctx.ui.theme.fg("warning", status));
    return;
  }
  const icon = getPhaseIcon(state.phase);
  const status = `${icon} Dual:${state.mode} iter:${state.iteration}`;
  ctx.ui.setStatus("pi-dual-agent", ctx.ui.theme.fg("accent", status));
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function updateWidget(ctx: ExtensionContext): void {
  if (!state.active && state.phase === "idle") {
    ctx.ui.setWidget("pi-dual-agent", []);
    return;
  }

  const stats = getSessionManager().getTokenStats();
  const sessionManager = getSessionManager();
  const action = sessionManager.getCurrentAction();
  const activeRole = state.phase === "thinking" || state.phase === "reviewing"
    ? "thinker"
    : state.phase === "doing" ? "doer" : null;

  // Compose the "Current:" line. If we have a live action that matches
  // the active role, show it with elapsed time. Otherwise show "(idle)".
  let currentLine = `Current: (idle)`;
  if (action && action.role === activeRole) {
    const elapsed = formatDuration(Date.now() - action.startedAt);
    currentLine = `Current: [${action.role}] ${action.text} (${elapsed})`;
  } else if (activeRole && state.phase !== "checkpoint") {
    currentLine = `Current: [${activeRole}] (preparing...)`;
  } else if (state.phase === "checkpoint") {
    currentLine = `Current: ⏸ awaiting human decision`;
  }

  const lines = [
    `Thinker: ${activeRole === "thinker" ? "Active" : "Idle"} ${state.thinkerModel?.id || ""}`,
    `Doer: ${activeRole === "doer" ? "Active" : "Idle"} ${state.doerModel?.id || ""}`,
    `Mode: ${state.mode} | Phase: ${state.phase} | Iteration: ${state.iteration}`,
    currentLine,
    `Thinker: $${stats.thinker.cost.toFixed(4)} | Doer: $${stats.doer.cost.toFixed(4)}`,
    `Total: $${(stats.thinker.cost + stats.doer.cost).toFixed(4)}`,
  ];
  ctx.ui.setWidget("pi-dual-agent", lines, { placement: "belowEditor" });
}

// ========================================
// Model Selection
// ========================================

interface ModelChoice {
  value: string;  // "provider/id"
  label: string;  // "provider/id"
  description: string;  // "Reasoning" or ""
}

function buildModelChoices(available: ModelRef[]): ModelChoice[] {
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];

  for (const m of available) {
    const value = `${m.provider}/${m.id}`;
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      label: value,
      description: m.reasoning ? "reasoning" : "",
    });
  }

  return choices;
}

async function pickModelCustom(
  ctx: ExtensionContext,
  title: string,
  choices: ModelChoice[],
): Promise<string | null> {
  const items: SelectItem[] = choices.map(c => ({
    value: c.value,
    label: c.label,
    description: c.description,
  }));

  return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    // Top border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Title
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    // Subtitle with model count
    container.addChild(new Text(theme.fg("dim", `${items.length} models available - use filter to narrow`), 1, 0));

    // SelectList with theme - show max 10 items, scrolls properly
    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    // Help text
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

    // Bottom border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
    };
  });
}

async function pickModelWithFilter(
  ctx: ExtensionContext,
  title: string,
  choices: ModelChoice[],
): Promise<string | null> {
  // Ask for filter first
  const filter = await ctx.ui.input(`${title} (type to filter)`, "");

  if (filter === undefined) {
    return null; // Cancelled
  }

  if (filter.trim() === "") {
    return await pickModelCustom(ctx, title, choices);
  }

  // Filter models
  const lowerFilter = filter.toLowerCase();
  const filtered = choices.filter(c =>
    c.label.toLowerCase().includes(lowerFilter) ||
    c.description.toLowerCase().includes(lowerFilter)
  );

  if (filtered.length === 0) {
    ctx.ui.notify("No matches. Try a different filter.", "warning");
    return null;
  }

  return await pickModelCustom(ctx, `${title} (filter: ${filter})`, filtered);
}

async function pickModels(ctx: ExtensionContext): Promise<void> {
  const sessionManager = getSessionManager();
  const available = await sessionManager.getAvailableModels();

  if (available.length === 0) {
    ctx.ui.notify("No models available. Check your API keys.", "error");
    return;
  }

  const choices = buildModelChoices(available);

  // Pick Thinker
  const thinkerChoice = await pickModelWithFilter(ctx, "Select Thinker model", choices);
  if (!thinkerChoice) return;

  const [thinkerProvider, ...thinkerIdParts] = thinkerChoice.split("/");
  state.thinkerModel = {
    provider: thinkerProvider,
    id: thinkerIdParts.join("/"),
    reasoning: available.find(m => `${m.provider}/${m.id}` === thinkerChoice)?.reasoning,
  };

  // Pick Doer
  const doerChoice = await pickModelWithFilter(ctx, "Select Doer model", choices);
  if (!doerChoice) return;

  const [doerProvider, ...doerIdParts] = doerChoice.split("/");
  state.doerModel = {
    provider: doerProvider,
    id: doerIdParts.join("/"),
  };

  ctx.ui.notify(`Thinker: ${thinkerChoice}, Doer: ${doerChoice}`, "info");
  persistState();
}

// ========================================
// Main Extension
// ========================================

export default function dualAgentExtension(pi: ExtensionAPI): void {

  // ========================================
  // Commands
  // ========================================

  // Main dual command
  pi.registerCommand("dual", {
    description: "Dual agent: setup, start, pause, resume, stop, status",
    getArgumentCompletions: (prefix) => {
      const subs = ["setup", "models", "thinker", "doer", "trace", "start", "pause", "resume", "skip", "restart", "stop", "status"];
      return subs.filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      if (!args || typeof args !== "string") {
        showStatus(ctx);
        return;
      }

      const parts = args.split(" ");
      const action = parts[0] || "";
      const rest = parts.slice(1).join(" ");

      switch (action) {
        case "setup":
          await pickModels(ctx);
          break;

        case "models":
          showModels(ctx);
          break;

        case "thinker":
          if (rest) {
            const [provider, ...idParts] = rest.split("/");
            state.thinkerModel = { provider, id: idParts.join("/") };
            ctx.ui.notify(`Thinker set to: ${rest}`, "info");
            persistState();
          } else {
            showModels(ctx);
          }
          break;

        case "doer":
          if (rest) {
            const [provider, ...idParts] = rest.split("/");
            state.doerModel = { provider, id: idParts.join("/") };
            ctx.ui.notify(`Doer set to: ${rest}`, "info");
            persistState();
          } else {
            showModels(ctx);
          }
          break;

        case "trace":
          handleTrace(rest, ctx);
          break;

        case "start":
          await handleStart(ctx, rest);
          break;

        case "pause":
          handlePause(ctx);
          break;

        case "resume":
          handleResume(ctx);
          break;

        case "skip":
          handleSkip(ctx);
          break;

        case "restart":
          await handleRestart(ctx);
          break;

        case "stop":
          await handleStop(ctx);
          break;

        case "status":
          showFullStatus(ctx);
          break;

        default:
          ctx.ui.notify(`Unknown action: ${action}`, "error");
      }
    },
  });

  // Shortcut commands
  pi.registerCommand("dual-setup", {
    description: "Quick setup - pick models",
    handler: async (_args, ctx) => pickModels(ctx),
  });

  pi.registerCommand("dual-stop", {
    description: "Stop dual mode",
    handler: async (_args, ctx) => handleStop(ctx),
  });

  // ========================================
  // Event Handlers
  // ========================================

  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
    state.projectPath = ctx.cwd;
    updateStatusBar(ctx);
    if (state.active) {
      updateWidget(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // Track token usage from main session. event is AgentEndEvent
    // which has `messages: AgentMessage[]` (not a single `message`).
    const lastAssistant = [...(event.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
    if (lastAssistant && (lastAssistant as any).usage) {
      updateWidget(ctx);
    }
  });

  // ========================================
  // Command Handlers
  // ========================================

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    ctx.ui.notify(
      `pi-dual-agent\nMode: ${state.mode}\nThinker: ${state.thinkerModel?.provider}/${state.thinkerModel?.id || "not set"}\nDoer: ${state.doerModel?.provider}/${state.doerModel?.id || "not set"}\nPhase: ${state.phase}\nIteration: ${state.iteration}`,
      "info"
    );
  }

  function showModels(ctx: ExtensionContext): void {
    ctx.ui.notify(
      `Thinker: ${state.thinkerModel?.provider}/${state.thinkerModel?.id || "not set"}\nDoer: ${state.doerModel?.provider}/${state.doerModel?.id || "not set"}`,
      "info"
    );
  }

  function handleTrace(rest: string, ctx: ExtensionContext): void {
    const arg = rest.trim();
    if (arg === "on" || arg === "") {
      state.trace = true;
      state.tracePath = state.tracePath ?? `${state.projectPath}/.pi/inbox/trace.log`;
      ctx.ui.notify(`Trace ON: ${state.tracePath}`, "info");
    } else if (arg === "off") {
      state.trace = false;
      ctx.ui.notify("Trace OFF", "info");
    } else if (arg === "status") {
      ctx.ui.notify(
        `Trace: ${state.trace ? "ON" : "OFF"}\nPath: ${state.tracePath ?? "(default: .pi/inbox/trace.log)"}`,
        "info"
      );
    } else if (arg.startsWith("path ")) {
      state.tracePath = arg.slice(5).trim();
      ctx.ui.notify(`Trace path set: ${state.tracePath}`, "info");
    } else {
      ctx.ui.notify("Usage: /dual trace on|off|status|path <file>", "warning");
    }
  }

  function showFullStatus(ctx: ExtensionContext): void {
    const stats = getSessionManager().getTokenStats();
    ctx.ui.notify(
      `Active: ${state.active}\nMode: ${state.mode}\nPhase: ${state.phase}\nIteration: ${state.iteration}\nErrors: ${state.errorCount}\n\nThinker: ${state.thinkerModel?.provider}/${state.thinkerModel?.id || "—"}\nDoer: ${state.doerModel?.provider}/${state.doerModel?.id || "—"}\n\nCosts:\nThinker: $${stats.thinker.cost.toFixed(4)}\nDoer: $${stats.doer.cost.toFixed(4)}\nTotal: $${(stats.thinker.cost + stats.doer.cost).toFixed(4)}`,
      "info"
    );
  }

  async function handleStart(ctx: ExtensionContext, task: string): Promise<void> {
    if (!state.thinkerModel || !state.doerModel) {
      ctx.ui.notify("Models not set. Run /dual setup first.", "error");
      return;
    }

    if (!task.trim()) {
      ctx.ui.notify("No task specified. Usage: /dual start <task description>", "error");
      return;
    }

    // Parse mode from flags
    let mode: DualMode = state.mode;
    if (task.includes("--complex")) {
      mode = "complex";
      task = task.replace(/--complex/g, "").trim();
    } else if (task.includes("--simple")) {
      mode = "simple";
      task = task.replace(/--simple/g, "").trim();
    }

    // Check for existing artifacts to auto-detect mode
    if (mode === "simple") {
      const inbox = createInboxManager(ctx.cwd);
      const artifacts = await inbox.hasArtifacts();
      if (artifacts.research || artifacts.prd || artifacts.tasks) {
        mode = "complex";
        ctx.ui.notify("Auto-detected complex mode from existing artifacts", "info");
      }
    }

    state.active = true;
    state.mode = mode;
    state.taskDescription = task;
    state.iteration = 1;
    state.phase = "thinking";
    state.errorCount = 0;

    updateStatusBar(ctx);
    updateWidget(ctx);
    persistState();

    ctx.ui.notify(`Started dual mode (${mode}): ${task}`, "info");

    // Start the loop in background
    const orchestrator = createOrchestrator(
      pi,
      ctx,
      ctx.cwd,
      {
        onPhaseChange: (phase) => {
          state.phase = phase;
          updateStatusBar(ctx);
          updateWidget(ctx);
        },
        onIterationChange: (iter) => {
          state.iteration = iter;
          updateStatusBar(ctx);
          updateWidget(ctx);
        },
        onCostUpdate: () => {
          updateWidget(ctx);
        },
        onTrace: (role, message) => {
          // One-line-per-phase trace, visible in console even without
          // the per-event trace from sessions.ts. Useful as a smoke test:
          // if you see these lines, the orchestrator actually reached
          // each phase.
          console.log(`[pi-dual-agent:phase] [${role}] ${message}`);
        },
        onActionChange: (action) => {
          // Live status - the widget displays the current action.
          updateWidget(ctx);
        },
        onTermination: (reason) => {
          state.active = false;
          state.phase = "idle";
          updateStatusBar(ctx);
          ctx.ui.setWidget("pi-dual-agent", []);

          const reasonMessages: Record<string, string> = {
            human_stop: "Stopped by user",
            thinker_done: "Thinker declared complete",
            max_iterations: "Max iterations reached",
            error_threshold: "Too many errors",
          };
          ctx.ui.notify(`Dual mode ended: ${reasonMessages[reason] || reason}`, "info");
        },
        onError: (error) => {
          state.errorCount++;
          ctx.ui.notify(`Error: ${error.message}`, "error");
        },
      }
    );

    // Wire up tracing on the session manager. This enables the
    // per-event stream in sessions.ts (tool calls, message text, etc.)
    // and the live status tracker that updates the widget.
    const sessionManager = getSessionManager();
    sessionManager.setVerbose(state.trace, state.tracePath ?? undefined);
    sessionManager.setActionListener(() => updateWidget(ctx));
    if (state.trace) {
      ctx.ui.notify(`Trace: ${state.tracePath}`, "info");
    }

    orchestrator.setModels(state.thinkerModel, state.doerModel);
    orchestrator.setMode(state.mode);
    orchestrator.setTask(state.taskDescription);

    // Start loop asynchronously
    orchestrator.start().catch((error) => {
      ctx.ui.notify(`Loop error: ${error.message}`, "error");
      state.active = false;
      state.phase = "idle";
      updateStatusBar(ctx);
    });
  }

  function handlePause(ctx: ExtensionContext): void {
    const orchestrator = getOrchestrator();
    if (orchestrator) {
      orchestrator.pause();
      ctx.ui.notify("Paused at checkpoint", "info");
    } else {
      ctx.ui.notify("No active session to pause", "warning");
    }
  }

  function handleResume(ctx: ExtensionContext): void {
    const orchestrator = getOrchestrator();
    if (orchestrator) {
      orchestrator.resume();
      ctx.ui.notify("Resumed", "info");
    } else {
      ctx.ui.notify("No session to resume", "warning");
    }
  }

  function handleSkip(ctx: ExtensionContext): void {
    ctx.ui.notify("Skip not yet implemented - use /dual stop to end", "info");
  }

  async function handleRestart(ctx: ExtensionContext): Promise<void> {
    await handleStop(ctx);
    ctx.ui.notify("Reset complete. Run /dual start to begin again.", "info");
  }

  async function handleStop(ctx: ExtensionContext): Promise<void> {
    const orchestrator = getOrchestrator();
    if (orchestrator) {
      await orchestrator.stop();
      destroyOrchestrator();
    }
    resetSessionManager();

    state.active = false;
    state.phase = "idle";
    state.iteration = 0;
    state.errorCount = 0;

    updateStatusBar(ctx);
    ctx.ui.setWidget("pi-dual-agent", []);
    ctx.ui.notify("Stopped dual mode", "info");
    persistState();
  }

  // ========================================
  // Initialize
  // ========================================

  pi.registerFlag("dual-complex", {
    description: "Start dual mode in complex mode",
    type: "boolean",
    default: false,
  });

  console.log("[pi-dual-agent] loaded - /dual setup|start|pause|resume|stop|status");
}
