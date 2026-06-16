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
    checkpoint: "👤",
    doing: "⚡",
    reviewing: "🔍",
    done: "✓",
  };
  return icons[phase] || "?";
}

function updateStatusBar(ctx: ExtensionContext): void {
  const icon = getPhaseIcon(state.phase);
  const status = `${icon} Dual:${state.mode} iter:${state.iteration}`;
  ctx.ui.setStatus("pi-dual-agent", ctx.ui.theme.fg("accent", status));
}

function updateWidget(ctx: ExtensionContext): void {
  if (!state.active && state.phase === "idle") {
    ctx.ui.setWidget("pi-dual-agent", []);
    return;
  }

  const stats = getSessionManager().getTokenStats();
  const lines = [
    `Thinker: ${state.phase === "thinking" || state.phase === "reviewing" ? "Active" : "Idle"} ${state.thinkerModel?.id || ""}`,
    `Doer: ${state.phase === "doing" ? "Active" : "Idle"} ${state.doerModel?.id || ""}`,
    `Mode: ${state.mode} | Phase: ${state.phase} | Iteration: ${state.iteration}`,
    `Thinker: $${stats.thinker.cost.toFixed(4)} | Doer: $${stats.doer.cost.toFixed(4)}`,
    `Total: $${(stats.thinker.cost + stats.doer.cost).toFixed(4)}`,
  ];
  ctx.ui.setWidget("pi-dual-agent", lines, { placement: "belowEditor" });
}

// ========================================
// Model Selection
// ========================================

async function pickModels(ctx: ExtensionContext): Promise<void> {
  const sessionManager = getSessionManager();
  const available = await sessionManager.getAvailableModels();

  if (available.length === 0) {
    ctx.ui.notify("No models available. Check your API keys.", "error");
    return;
  }

  // Group by provider
  const choices = available.map(m => `${m.provider}/${m.id}`);
  const uniqueChoices = [...new Set(choices)];

  const thinkerChoice = await ctx.ui.select("Select Thinker model:", uniqueChoices);
  if (!thinkerChoice) return;

  const [thinkerProvider, ...thinkerIdParts] = thinkerChoice.split("/");
  state.thinkerModel = {
    provider: thinkerProvider,
    id: thinkerIdParts.join("/"),
    reasoning: available.find(m => `${m.provider}/${m.id}` === thinkerChoice)?.reasoning,
  };

  const doerChoice = await ctx.ui.select("Select Doer model:", uniqueChoices);
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
      const subs = ["setup", "models", "thinker", "doer", "start", "pause", "resume", "skip", "restart", "stop", "status"];
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
    // Track token usage from main session
    if (event.message && "usage" in event.message) {
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
