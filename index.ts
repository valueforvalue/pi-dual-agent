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
import type { DualAgentState, TokenStats, DualMode, ModelRef, PersistedConfig } from "./lib/types";
import { getSessionManager, resetSessionManager } from "./lib/sessions";
import { createOrchestrator, destroyOrchestrator, getOrchestrator } from "./lib/loop";
import { createInboxManager } from "./lib/inbox";
import { loadConfig, saveConfig, getConfigPath } from "./lib/config";

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
  consoleEcho: boolean;
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
  consoleEcho: false,
  tracePath: null,
};

// ========================================
// Persistence
// ========================================
//
// User preferences (model selection, default mode, trace settings) are
// written to ~/.pi/agent/config/pi-dual-agent.json and read back at
// session_start. Transient runtime state (active, iteration, phase,
// errorCount, taskDescription) is intentionally NOT persisted — the
// loop state is meant to die with the session. See lib/config.ts for
// the on-disk shape and failure handling.

let configLoaded = false;

function buildPersistedConfig(): PersistedConfig {
  return {
    schemaVersion: 1,
    thinkerModel: state.thinkerModel,
    doerModel: state.doerModel,
    defaultMode: state.mode,
    maxIterations: 50,
    trace: {
      enabled: state.trace,
      path: state.tracePath,
    },
    updatedAt: "", // overwritten by saveConfig with the real timestamp
  };
}

async function persistState(): Promise<void> {
  await saveConfig(buildPersistedConfig());
}

async function loadState(_ctx: ExtensionContext): Promise<void> {
  const config = await loadConfig();
  configLoaded = true;

  // Restore user preferences into the in-memory state. We do NOT touch
  // the transient fields (active, iteration, phase, errorCount,
  // taskDescription) — those always start fresh.
  if (config.thinkerModel) state.thinkerModel = config.thinkerModel;
  if (config.doerModel) state.doerModel = config.doerModel;
  state.mode = config.defaultMode;
  state.trace = config.trace.enabled;
  // `consoleEcho` is accepted on read so a config from a future build
  // that adds the field still loads, but this build's sanitizer
  // doesn't surface it. The in-memory default stays at false; the
  // user can opt in with `/dual trace echo`.
  state.tracePath = config.trace.path ?? null;
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
  await persistState();
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
      const subs = ["setup", "models", "thinker", "doer", "trace", "config", "start", "pause", "resume", "skip", "restart", "stop", "status"];
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
            await persistState();
          } else {
            showModels(ctx);
          }
          break;

        case "doer":
          if (rest) {
            const [provider, ...idParts] = rest.split("/");
            state.doerModel = { provider, id: idParts.join("/") };
            ctx.ui.notify(`Doer set to: ${rest}`, "info");
            await persistState();
          } else {
            showModels(ctx);
          }
          break;

        case "trace":
          await handleTrace(rest, ctx);
          break;

        case "config":
          showConfig(ctx);
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
    state.projectPath = ctx.cwd;
    await loadState(ctx);
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

  function showConfig(ctx: ExtensionContext): void {
    // Show the user where their preferences are stored, plus a summary.
    // This is the "I want to know what's persisted" escape hatch.
    const thinker = state.thinkerModel
      ? `${state.thinkerModel.provider}/${state.thinkerModel.id}`
      : "(not set)";
    const doer = state.doerModel
      ? `${state.doerModel.provider}/${state.doerModel.id}`
      : "(not set)";
    const tracePath = state.tracePath ?? `(default: ${state.projectPath}/.pi/inbox/trace.log)`;
    ctx.ui.notify(
      `Persisted config: ${getConfigPath()}\n\n` +
        `Thinker: ${thinker}\n` +
        `Doer:    ${doer}\n` +
        `Default mode: ${state.mode}\n` +
        `Trace: ${state.trace ? "ON" : "OFF"}\n` +
        `Trace path: ${tracePath}\n\n` +
        (configLoaded
          ? "Loaded from disk at session start. Use /dual setup or /dual thinker|doer to change."
          : "Config has not been loaded yet in this session."),
      "info",
    );
  }

  async function handleTrace(rest: string, ctx: ExtensionContext): Promise<void> {
    const arg = rest.trim();
    let changed = false;
    if (arg === "on" || arg === "") {
      state.trace = true;
      state.tracePath = state.tracePath ?? `${state.projectPath}/.pi/inbox/trace.log`;
      ctx.ui.notify(`Trace ON (file only): ${state.tracePath}`, "info");
      changed = true;
    } else if (arg === "off") {
      state.trace = false;
      ctx.ui.notify("Trace OFF", "info");
      changed = true;
    } else if (arg === "echo" || arg === "console") {
      state.consoleEcho = true;
      state.trace = true;
      state.tracePath = state.tracePath ?? `${state.projectPath}/.pi/inbox/trace.log`;
      ctx.ui.notify(`Trace ON (file + console echo): ${state.tracePath}`, "info");
      changed = true;
    } else if (arg === "quiet") {
      state.consoleEcho = false;
      ctx.ui.notify("Console echo OFF (file trace unchanged)", "info");
      changed = true;
    } else if (arg === "status") {
      // Status is a read-only query - no state change, no need to persist.
      ctx.ui.notify(
        `Trace: ${state.trace ? "ON" : "OFF"} (console: ${state.consoleEcho ? "ON" : "OFF"})\nPath: ${state.tracePath ?? "(default: .pi/inbox/trace.log)"}`,
        "info"
      );
    } else if (arg.startsWith("path ")) {
      state.tracePath = arg.slice(5).trim();
      ctx.ui.notify(`Trace path set: ${state.tracePath}`, "info");
      changed = true;
    } else {
      ctx.ui.notify("Usage: /dual trace on|off|echo|quiet|status|path <file>", "warning");
    }
    if (changed) await persistState();
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

    // Parse mode from flags. Track whether the user EXPLICITLY set it
    // with a flag — we persist that as the new default, but we do NOT
    // persist the auto-detected mode below, since that's per-run
    // behaviour, not a user preference.
    let mode: DualMode = state.mode;
    let userSetMode = false;
    if (task.includes("--complex")) {
      mode = "complex";
      task = task.replace(/--complex/g, "").trim();
      userSetMode = true;
    } else if (task.includes("--simple")) {
      mode = "simple";
      task = task.replace(/--simple/g, "").trim();
      userSetMode = true;
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
    // Only update the persisted default if the user asked for it.
    // Auto-detected mode is a property of the current run, not a
    // preference, so we don't want to leak it into the saved default.
    if (userSetMode) {
      await persistState();
    } else {
      // Still write the file so any in-flight model/trace changes
      // are captured. We pass through the current defaultMode, which
      // equals the value loaded from disk at session_start.
      await saveConfig(buildPersistedConfig());
    }

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
          // One-line-per-phase trace. We deliberately do NOT write this
          // to stdout via console.log — that bypasses the TUI's render
          // region and paints orphan text over the screen ("UI clobber").
          //
          // The full per-event stream still goes to the trace file
          // (sessions.ts) when /dual trace on is set, so nothing is
          // lost. This callback is a no-op for now; if a future
          // iteration needs a live "what just happened" line, the right
          // place for it is the widget (setWidget) or status bar
          // (setStatus), not stdout.
        },
        onActionChange: (action) => {
          // Live status - the widget displays the current action.
          updateWidget(ctx);
        },
        onFinalReport: (report: string) => {
          // Single end-of-loop summary. Persist to disk for the user
          // to review, and surface a short notification pointing at it.
          const reportPath = `${state.projectPath}/.pi/inbox/final-report.md`;
          (async () => {
            const fs = await import("node:fs/promises");
            await fs.writeFile(reportPath, report, "utf-8").catch(() => {});
          })();
          // First ~400 chars fit in a notification without truncation.
          const head = report.length > 400 ? report.slice(0, 400) + "..." : report;
          ctx.ui.notify(`Dual mode complete. Full report: ${reportPath}\n\n${head}`, "info");
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
    // and the live status tracker that updates the widget. Console
    // echo is opt-in via `/dual trace echo` so the host TUI does not
    // get spammed with event lines.
    const sessionManager = getSessionManager();
    sessionManager.setVerbose(state.trace, state.tracePath ?? undefined);
    sessionManager.setConsoleEcho(state.consoleEcho);
    sessionManager.setActionListener(() => updateWidget(ctx));
    if (state.trace) {
      ctx.ui.notify(
        state.consoleEcho
          ? `Trace ON (file + console echo): ${state.tracePath}`
          : `Trace ON (file only): ${state.tracePath}`,
        "info",
      );
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
    await persistState();
  }

  // ========================================
  // Initialize
  // ========================================

  pi.registerFlag("dual-complex", {
    description: "Start dual mode in complex mode",
    type: "boolean",
    default: false,
  });

  // Intentionally no console.log here. The TUI uses an alternate
  // screen buffer, and stdout writes from extension load code persist
  // as orphan lines on screen. /dual status (or the widget) is how the
  // user discovers the extension.
}
