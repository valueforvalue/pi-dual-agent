/**
 * pi-dual-agent
 *
 * Model router for the mattpocock slash-skill pipeline. Splits a task
 * across two configured models to keep cost down:
 * - Thinker: Reasoning-focused. Routes /grill-with-docs, /to-prd,
 *   /to-issues, /triage, /handoff to a capable-but-expensive model.
 * - Doer: Execution-focused. Routes /implement, /prototype to a
 *   fast/cheap execution model.
 *
 * Sessions are managed per-skill-class so cost is tracked on the
 * right bucket. The two models are configured via /dual setup.
 *
 * Backward-compat: the older in-repo file relay (.pi/inbox/plan.md +
 * results.md) still works for users who prefer an explicit checkpoint
 * between Thinker and Doer runs. New flows should use the slash skills
 * directly.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ModelRef, PersistedConfig } from "./lib/types";
import { getSessionManager, resetSessionManager } from "./lib/sessions";
import { loadConfig, saveConfig, getConfigPath } from "./lib/config";
import { parseDualRouterCommand, runDualCommand, isSubSessionActive, clearActiveSubSession } from "./lib/router";

// ========================================
// State
// ========================================

interface ExtensionState {
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
  projectPath: string;
  trace: boolean;
  consoleEcho: boolean;
  tracePath: string | null;
}

let state: ExtensionState = {
  thinkerModel: null,
  doerModel: null,
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
    schemaVersion: 2,
    thinkerModel: state.thinkerModel,
    doerModel: state.doerModel,
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
    description: "Dual agent: setup, models, slash-skill router, status",
    getArgumentCompletions: (prefix) => {
      const subs = [
        // Legacy commands
        "setup", "models", "thinker", "doer", "trace", "config", "status",
        // Router short names
        "grill", "me", "prd", "issues", "triage", "arch", "handoff",
        "implement", "prototype",
        // Router explicit verbs
        "think", "code",
      ];
      return subs.filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      if (!args || typeof args !== "string") {
        showStatus(ctx);
        return;
      }

      // Try the new slash-skill router first. If the args match a
      // known skill (short name or /<slash>), or the explicit verb
      // forms `think` / `code`, dispatch to the router. Anything
      // not recognised by the router falls through to the legacy
      // command parser below.
      try {
        const routed = parseDualRouterCommand(args);
        if (routed) {
          await runDualCommand(ctx, routed, {
            thinkerModel: state.thinkerModel,
            doerModel: state.doerModel,
          });
          return;
        }
      } catch (err) {
        // parseDualRouterCommand throws on unknown skills with a
        // helpful list. Surface that and bail out - the legacy
        // parser would just say "Unknown action" which is less
        // helpful for a typo'd skill name.
        ctx.ui.notify((err as Error).message, "error");
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

        case "stop":
          if (isSubSessionActive()) {
            clearActiveSubSession();
            ctx.ui.notify("Stopped active sub-session", "info");
          } else {
            ctx.ui.notify("No active sub-session to stop", "info");
          }
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
    description: "Stop the active sub-session",
    handler: async (_args, ctx) => {
      if (isSubSessionActive()) {
        clearActiveSubSession();
        ctx.ui.notify("Stopped active sub-session", "info");
      } else {
        ctx.ui.notify("No active sub-session to stop", "info");
      }
    },
  });

  // ========================================
  // Event Handlers
  // ========================================

  pi.on("session_start", async (_event, ctx) => {
    state.projectPath = ctx.cwd;
    await loadState(ctx);
    // The router owns the status bar and widget while a sub-session
    // is active. When idle, leave them empty.
    if (!isSubSessionActive()) {
      ctx.ui.setStatus("pi-dual-agent", "");
      ctx.ui.setWidget("pi-dual-agent", []);
    }
  });

  // ========================================
  // Command Handlers
  // ========================================

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    const t = state.thinkerModel
      ? `${state.thinkerModel.provider}/${state.thinkerModel.id}`
      : "(not set)";
    const d = state.doerModel
      ? `${state.doerModel.provider}/${state.doerModel.id}`
      : "(not set)";
    ctx.ui.notify(
      `pi-dual-agent\nThinker: ${t}\nDoer: ${d}\n\nUse /dual <skill> [args] to run a slash command with model routing.`,
      "info",
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
    const sub = isSubSessionActive() ? "Yes (router sub-session)" : "No";
    ctx.ui.notify(
      `Sub-session active: ${sub}\n\nThinker: ${state.thinkerModel?.provider}/${state.thinkerModel?.id || "—"}\nDoer: ${state.doerModel?.provider}/${state.doerModel?.id || "—"}\n\nCosts:\nThinker: $${stats.thinker.cost.toFixed(4)}\nDoer: $${stats.doer.cost.toFixed(4)}\nTotal: $${(stats.thinker.cost + stats.doer.cost).toFixed(4)}`,
      "info"
    );
  }
} // end of dualAgentExtension
