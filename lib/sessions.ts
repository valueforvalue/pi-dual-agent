/**
 * pi-dual-agent - Session Manager
 *
 * Manages Thinker and Doer agent sessions using the pi SDK.
 *
 * Verbose tracing:
 *   When `setVerbose(true, traceFilePath)` is called, every event emitted by
 *   both sessions is logged to console and appended to the trace file. This
 *   makes it possible to verify that the Thinker/Doer are actually doing
 *   work (model calls, tool calls, message content) rather than silently
 *   doing nothing.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelRef, TokenStats } from "./types";

// Default tool allowlists per role.
//
// Thinker is intentionally restricted:
//   - NO bash (could `cat > src/foo.ts` to write code)
//   - NO edit (Doer's tool)
//   - write is allowed, but a beforeToolCall hook physically blocks it
//     unless the path is in .pi/inbox/ or docs/ (plans and PRDs only).
//
// Doer keeps the full toolset.
const THINKER_TOOLS = ["read", "write", "grep", "find", "ls"];
const DOER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Paths the Thinker is allowed to write to. Resolved against cwd at hook
// installation time. Anything else is blocked.
const THINKER_WRITE_ALLOWLIST = [".pi/inbox", "docs"];

// Maximum chars of assistant text to dump to the trace per turn.
// Long outputs (e.g. file dumps) get truncated to keep traces readable.
const MAX_TEXT_CHARS = 2000;
const MAX_TOOL_ARG_CHARS = 1500;

// Max size of the on-disk trace file before it is rotated. 1 MB keeps the
// file readable and prevents the TUI's filesystem view from getting
// destroyed by a runaway trace. Each rotation splits into trace.log.1
// (the previous run) and starts a fresh trace.log.
const MAX_TRACE_BYTES = 1_048_576; // 1 MiB

// Events we never want to write to the trace. message_update fires on
// every streaming text delta from the LLM, which can be dozens-to-
// hundreds of events per turn. Logging each one is what made the trace
// blow up to 800+ KB and flood the host TUI. The default branch in the
// switch would otherwise pick these up.
const TRACE_SKIP_EVENTS = new Set<string>([
  "message_update",
  "tool_execution_update",
]);

// Public live-status shape: what the active agent is doing right now.
export interface CurrentAction {
  role: "thinker" | "doer";
  text: string;
  startedAt: number;
}

/**
 * Build a beforeToolCall hook for the Thinker that blocks the `write`
 * tool unless the target path is in THINKER_WRITE_ALLOWLIST.
 *
 * Returning { block: true, reason: "..." } from beforeToolCall tells the
 * agent loop to skip the tool and surface the reason as a tool error,
 * which the model sees in its context and can react to.
 */
function makeThinkerToolGuard(cwd: string) {
  const allowedAbs = THINKER_WRITE_ALLOWLIST.map((d) => resolve(cwd, d));
  return async (ctx: any): Promise<{ block?: boolean; reason?: string } | undefined> => {
    if (ctx?.toolCall?.name !== "write") return undefined; // not a write, allow
    const args = (ctx.args ?? {}) as { path?: string; file_path?: string };
    const rawPath = args.path ?? args.file_path ?? "";
    if (!rawPath) return undefined; // let the tool's own validation handle it
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const isAllowed = allowedAbs.some(
      (dir) => abs === dir || abs.startsWith(dir + "/") || abs.startsWith(dir + "\\"),
    );
    if (!isAllowed) {
      const relAllowed = THINKER_WRITE_ALLOWLIST.join(", ");
      return {
        block: true,
        reason:
          `Thinker cannot write to "${rawPath}". ` +
          `Allowed paths: ${relAllowed}/ (plans, PRDs, docs). ` +
          `Code files (*.html, *.js, *.ts, *.css, etc.) must be written by the Doer ` +
          `at the execution phase, after the human has approved the plan at the checkpoint.`,
      };
    }
    return undefined;
  };
}

/**
 * Turn a tool call into a short, human-readable description for the
 * live status display and trace.
 */
function describeToolCall(name: string, args: any): string {
  if (!args || typeof args !== "object") return name;
  const path = (args as any).path ?? (args as any).file_path;
  const cmd = (args as any).command;
  const pattern = (args as any).pattern;
  const truncCmd = (s: string) => (s.length > 60 ? s.slice(0, 60) + "..." : s);
  switch (name) {
    case "read":         return path ? `read ${path}` : "read";
    case "write":        return path ? `write ${path}` : "write";
    case "edit":         return path ? `edit ${path}` : "edit";
    case "bash":         return cmd ? `run: ${truncCmd(cmd)}` : "run bash";
    case "grep":         return pattern ? `grep ${pattern}` : "grep";
    case "find":         return pattern ? `find ${pattern}` : "find";
    case "ls":           return path ? `ls ${path}` : "ls";
    default:             return name;
  }
}

// We need to dynamically import to avoid issues when extension loads
let createAgentSession: any;
let SessionManager: any;
let AuthStorage: any;
let ModelRegistry: any;

async function ensureImports(): Promise<void> {
  if (!createAgentSession) {
    const mod = await import("@earendil-works/pi-coding-agent");
    createAgentSession = mod.createAgentSession;
    SessionManager = mod.SessionManager;
    AuthStorage = mod.AuthStorage;
    ModelRegistry = mod.ModelRegistry;
  }
}

export interface SessionHandle {
  session: AgentSession;
  unsubscribe: () => void;
}

export class SessionManagerClass {
  private authStorage: any = null;
  private modelRegistry: any = null;
  private thinkerSession: SessionHandle | null = null;
  private doerSession: SessionHandle | null = null;
  private tokenStats: { thinker: TokenStats; doer: TokenStats } = {
    thinker: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    doer: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  };
  private initialized = false;

  // Tracing state. `verbose` enables file+console output; `consoleEcho`
  // is a separate opt-in because file-only traces are usually what you
  // want — the host TUI does not need a live copy of every event.
  private verbose = false;
  private consoleEcho = false;
  private traceFilePath: string | null = null;
  private turnCount = { thinker: 0, doer: 0 };

  // Live status: what the active agent is doing right now.
  private currentAction: CurrentAction | null = null;
  private actionListener: ((action: CurrentAction | null) => void) | null = null;

  setActionListener(fn: ((action: CurrentAction | null) => void) | null): void {
    this.actionListener = fn;
  }

  getCurrentAction(): CurrentAction | null {
    return this.currentAction ? { ...this.currentAction } : null;
  }

  private setAction(role: "thinker" | "doer", text: string | null): void {
    if (text === null) {
      // Clear only if the cleared action belongs to this role, so we don't
      // wipe the Doer's status when the Thinker finishes.
      if (this.currentAction?.role === role) {
        this.currentAction = null;
        this.actionListener?.(null);
      }
    } else {
      this.currentAction = { role, text, startedAt: Date.now() };
      this.actionListener?.(this.currentAction);
    }
  }

  /**
   * Enable or disable verbose tracing. When enabled, every event from both
   * the Thinker and Doer sessions is written to the trace file (if provided).
   * Console echoing is opt-in via setConsoleEcho() — by default we only
   * write to disk, so the host TUI is not spammed with event lines.
   * The trace file is truncated on enable.
   */
  setVerbose(verbose: boolean, traceFilePath?: string): void {
    this.verbose = verbose;
    this.traceFilePath = traceFilePath ?? null;
    if (verbose && this.traceFilePath) {
      try {
        writeFileSync(this.traceFilePath, `# pi-dual-agent trace\n# enabled at ${new Date().toISOString()}\n`, "utf-8");
      } catch (err) {
        // Best-effort: tracing must never break the loop.
        console.error(`[pi-dual-agent] trace file write failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * When true, trace lines are also printed to the host console. Off by
   * default — file-only traces are the common case, and the host TUI
   * does not benefit from a live firehose of event lines.
   */
  setConsoleEcho(echo: boolean): void {
    this.consoleEcho = echo;
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  getTraceFilePath(): string | null {
    return this.traceFilePath;
  }

  /**
   * Append a line to the trace. File output is gated by `verbose`;
   * console output is additionally gated by `consoleEcho` so that
   * turning the file trace on does not flood the host TUI.
   *
   * The on-disk file is rotated to trace.log.1 when it crosses
   * MAX_TRACE_BYTES, so a long-running session never produces a
   * multi-megabyte trace file that destroys the TUI's filesystem view.
   */
  private trace(role: "thinker" | "doer", line: string): void {
    if (!this.verbose) return;
    const stamped = `[${new Date().toISOString()}] [${role}] ${line}`;
    if (this.consoleEcho) {
      console.log(`[pi-dual-agent:trace] ${stamped}`);
    }
    if (this.traceFilePath) {
      try {
        this.rotateIfTooBig(this.traceFilePath);
        appendFileSync(this.traceFilePath, stamped + "\n", "utf-8");
      } catch {
        // swallow - tracing is best-effort
      }
    }
  }

  /**
   * If the trace file has exceeded MAX_TRACE_BYTES, rotate it to
   * `<path>.1` (overwriting any previous rotation) and start a fresh
   * file. We keep only one generation to avoid filling the inbox.
   */
  private rotateIfTooBig(path: string): void {
    try {
      const { statSync, renameSync } = require("node:fs") as typeof import("node:fs");
      const stats = statSync(path);
      if (stats.size < MAX_TRACE_BYTES) return;
      renameSync(path, `${path}.1`);
    } catch {
      // stat fails (file missing) — nothing to rotate.
    }
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + `... [+${s.length - max} chars truncated]`;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await ensureImports();
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.initialized = true;
  }

  private emptyTokenStats(): TokenStats {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      turns: 0,
    };
  }

  async getAvailableModels(): Promise<ModelRef[]> {
    await this.ensureInitialized();
    const models = await this.modelRegistry.getAvailable();
    return models.map((m: any) => ({
      provider: m.provider,
      id: m.id,
      name: m.name || m.id,
      reasoning: m.reasoning === true,
    }));
  }

  findModel(provider: string, id: string): any {
    return this.modelRegistry?.find(provider, id);
  }

  async createThinkerSession(
    model: ModelRef,
    cwd: string,
    sessionPath?: string,
    tools: string[] = THINKER_TOOLS,
  ): Promise<SessionHandle> {
    await this.ensureInitialized();

    const modelObj = this.findModel(model.provider, model.id);
    if (!modelObj) {
      throw new Error(`Model not found: ${model.provider}/${model.id}`);
    }

    const manager = sessionPath
      ? SessionManager.create(cwd, sessionPath)
      : SessionManager.inMemory();

    const { session } = await createAgentSession({
      model: modelObj,
      cwd,
      sessionManager: manager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      // Constrain tools so the Thinker cannot accidentally act as a Doer.
      tools,
      // Bias the Thinker toward deep reasoning. Providers that do not
      // support thinking ignore this; providers that do will use it.
      thinkingLevel: "high",
    });

    // Install the tool guard. Without this, the Thinker could `write` to
    // any path and silently do the Doer's work before the checkpoint.
    // The hook is checked per tool call by the agent loop, so it cannot
    // be bypassed by clever prompt-engineering.
    session.agent.beforeToolCall = makeThinkerToolGuard(cwd);

    this.turnCount.thinker = 0;
    this.trace("thinker", `session created model=${model.provider}/${model.id} tools=[${tools.join(",")}] guard=write:${THINKER_WRITE_ALLOWLIST.join(",")}`);

    const handle: SessionHandle = {
      session,
      unsubscribe: session.subscribe((event: any) => this.handleThinkerEvent(event)),
    };

    this.thinkerSession = handle;
    return handle;
  }

  async createDoerSession(
    model: ModelRef,
    cwd: string,
    sessionPath?: string,
    tools: string[] = DOER_TOOLS,
  ): Promise<SessionHandle> {
    await this.ensureInitialized();

    const modelObj = this.findModel(model.provider, model.id);
    if (!modelObj) {
      throw new Error(`Model not found: ${model.provider}/${model.id}`);
    }

    // Doer sessions are ephemeral by default
    const manager = sessionPath
      ? SessionManager.create(cwd, sessionPath)
      : SessionManager.inMemory();

    const { session } = await createAgentSession({
      model: modelObj,
      cwd,
      sessionManager: manager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools,
    });

    this.turnCount.doer = 0;
    this.trace("doer", `session created model=${model.provider}/${model.id} tools=[${tools.join(",")}]`);

    const handle: SessionHandle = {
      session,
      unsubscribe: session.subscribe((event: any) => this.handleDoerEvent(event)),
    };

    this.doerSession = handle;
    return handle;
  }

  /**
   * Trace every event emitted by the Thinker session. The handler is the
   * only place we can see what the model is actually doing - prompt text,
   * tool calls, tool results, message text - so it doubles as our proof
   * of life for the agent.
   */
  private handleThinkerEvent(event: any): void {
    if (!this.verbose) {
      // No-trace fast path: still accumulate token stats.
      if (event.type === "message_end" && event.message?.role === "assistant") {
        this.accumulateStats(this.tokenStats.thinker, event.message.usage);
      }
      return;
    }

    switch (event.type) {
      case "agent_start":
        this.trace("thinker", "agent_start");
        this.setAction("thinker", "starting...");
        break;
      case "agent_end": {
        const msgCount = event.messages?.length ?? 0;
        this.trace("thinker", `agent_end messages=${msgCount} willRetry=${event.willRetry ?? false}`);
        this.setAction("thinker", null);
        break;
      }
      case "turn_start":
        this.turnCount.thinker++;
        this.trace("thinker", `turn_start #${this.turnCount.thinker}`);
        break;
      case "turn_end": {
        const m = event.message;
        const role = m?.role ?? "?";
        const stop = m?.stopReason ?? "?";
        this.trace("thinker", `turn_end #${this.turnCount.thinker} role=${role} stopReason=${stop} toolResults=${event.toolResults?.length ?? 0}`);
        break;
      }
      case "message_start": {
        const role = event.message?.role ?? "?";
        this.trace("thinker", `message_start role=${role}`);
        if (role === "assistant") {
          this.setAction("thinker", "thinking...");
        }
        break;
      }
      case "message_update": {
        // Streaming delta. Intentionally swallowed — not logging per-delta
        // avoids trace spam (the SDK fires dozens of these per turn). The
        // final text is dumped on message_end instead.
        break;
      }
      case "message_end": {
        const m = event.message;
        if (m?.role === "assistant") {
          this.accumulateStats(this.tokenStats.thinker, m.usage);
          const text = this.extractAssistantText(m);
          const toolCalls = this.extractToolCalls(m);
          const thinking = this.extractThinking(m);
          this.trace("thinker", `assistant message_end usage_in=${m.usage?.input ?? 0} out=${m.usage?.output ?? 0} cost=${this.fmtCost(m.usage)}`);
          if (thinking) {
            this.trace("thinker", `assistant thinking: ${this.truncate(thinking, MAX_TEXT_CHARS)}`);
          }
          if (text) {
            this.trace("thinker", `assistant text: ${this.truncate(text, MAX_TEXT_CHARS)}`);
          }
          if (toolCalls.length) {
            for (const tc of toolCalls) {
              this.trace("thinker", `assistant tool_call: ${tc}`);
            }
          }
          if (!text && !thinking && !toolCalls.length) {
            this.trace("thinker", "assistant message_end with NO text/thinking/tool_calls (empty turn)");
          }
        } else {
          const role = m?.role ?? "?";
          this.trace("thinker", `message_end role=${role}`);
        }
        break;
      }
      case "tool_execution_start": {
        const args = this.truncate(JSON.stringify(event.args ?? {}), MAX_TOOL_ARG_CHARS);
        this.trace("thinker", `tool_start name=${event.toolName} callId=${event.toolCallId} args=${args}`);
        // Update live status so the widget can show "write_artifact plan.md"
        this.setAction("thinker", describeToolCall(event.toolName, event.args));
        break;
      }
      case "tool_execution_end": {
        this.trace("thinker", `tool_end name=${event.toolName} callId=${event.toolCallId} isError=${event.isError ?? false}`);
        // Don't clear action on tool end - the next event (next tool, or
        // agent_end) will update it. Leaving the action visible while the
        // model is thinking about the tool result is more informative.
        break;
      }
      case "tool_execution_update":
        // Per-tool streaming updates - not logged to keep trace readable.
        break;
      default:
        // Drop noisy events entirely instead of logging them. The previous
        // behaviour was to log every unknown event type, which (combined
        // with the default fall-through for message_update) produced the
        // 14k-line / 800KB+ trace that trashed the TUI.
        if (!TRACE_SKIP_EVENTS.has(event.type)) {
          this.trace("thinker", `event type=${event.type}`);
        }
    }
  }

  private handleDoerEvent(event: any): void {
    if (!this.verbose) {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        this.accumulateStats(this.tokenStats.doer, event.message.usage);
      }
      return;
    }

    switch (event.type) {
      case "agent_start":
        this.trace("doer", "agent_start");
        this.setAction("doer", "starting...");
        break;
      case "agent_end": {
        const msgCount = event.messages?.length ?? 0;
        this.trace("doer", `agent_end messages=${msgCount} willRetry=${event.willRetry ?? false}`);
        this.setAction("doer", null);
        break;
      }
      case "turn_start":
        this.turnCount.doer++;
        this.trace("doer", `turn_start #${this.turnCount.doer}`);
        break;
      case "turn_end": {
        const m = event.message;
        this.trace("doer", `turn_end #${this.turnCount.doer} role=${m?.role ?? "?"} stopReason=${m?.stopReason ?? "?"} toolResults=${event.toolResults?.length ?? 0}`);
        break;
      }
      case "message_start": {
        this.trace("doer", `message_start role=${event.message?.role ?? "?"}`);
        if (event.message?.role === "assistant") {
          this.setAction("doer", "thinking...");
        }
        break;
      }
      case "message_end": {
        const m = event.message;
        if (m?.role === "assistant") {
          this.accumulateStats(this.tokenStats.doer, m.usage);
          const text = this.extractAssistantText(m);
          const toolCalls = this.extractToolCalls(m);
          this.trace("doer", `assistant message_end usage_in=${m.usage?.input ?? 0} out=${m.usage?.output ?? 0} cost=${this.fmtCost(m.usage)}`);
          if (text) {
            this.trace("doer", `assistant text: ${this.truncate(text, MAX_TEXT_CHARS)}`);
          }
          if (toolCalls.length) {
            for (const tc of toolCalls) {
              this.trace("doer", `assistant tool_call: ${tc}`);
            }
          }
          if (!text && !toolCalls.length) {
            this.trace("doer", "assistant message_end with NO text/tool_calls (empty turn)");
          }
        } else {
          this.trace("doer", `message_end role=${m?.role ?? "?"}`);
        }
        break;
      }
      case "tool_execution_start": {
        const args = this.truncate(JSON.stringify(event.args ?? {}), MAX_TOOL_ARG_CHARS);
        this.trace("doer", `tool_start name=${event.toolName} callId=${event.toolCallId} args=${args}`);
        this.setAction("doer", describeToolCall(event.toolName, event.args));
        break;
      }
      case "tool_execution_end": {
        this.trace("doer", `tool_end name=${event.toolName} callId=${event.toolCallId} isError=${event.isError ?? false}`);
        break;
      }
      case "tool_execution_update":
        break;
      default:
        if (!TRACE_SKIP_EVENTS.has(event.type)) {
          this.trace("doer", `event type=${event.type}`);
        }
    }
  }

  // ========================================
  // Message content extractors
  // ========================================

  private extractAssistantText(message: any): string {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }

  private extractThinking(message: any): string {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
      .filter((c: any) => c?.type === "thinking" && typeof c.thinking === "string")
      .map((c: any) => c.thinking)
      .join("");
  }

  private extractToolCalls(message: any): string[] {
    if (!message || !Array.isArray(message.content)) return [];
    return message.content
      .filter((c: any) => c?.type === "toolCall" && c?.name)
      .map((c: any) => `${c.name}(${this.truncate(JSON.stringify(c.arguments ?? {}), MAX_TOOL_ARG_CHARS)})`);
  }

  private fmtCost(usage: any): string {
    if (!usage?.cost) return "n/a";
    const c = usage.cost;
    if (typeof c === "object") {
      return `$${(c.total ?? 0).toFixed(6)}`;
    }
    if (typeof c === "number") {
      return `$${c.toFixed(6)}`;
    }
    return "n/a";
  }

  private accumulateStats(stats: TokenStats, usage: any): void {
    if (!usage) return;
    stats.inputTokens += usage.input || 0;
    stats.outputTokens += usage.output || 0;
    stats.cacheRead += usage.cacheRead || 0;
    stats.cacheWrite += usage.cacheWrite || 0;
    stats.totalTokens += usage.totalTokens || 0;
    // Handle cost - may not exist on all providers
    if (usage.cost && typeof usage.cost === "object") {
      stats.cost += (usage.cost as { total?: number }).total || 0;
    }
    stats.turns += 1;
  }

  getTokenStats(): { thinker: TokenStats; doer: TokenStats } {
    return {
      thinker: { ...this.tokenStats.thinker },
      doer: { ...this.tokenStats.doer },
    };
  }

  async runThinkerPrompt(prompt: string): Promise<void> {
    if (!this.thinkerSession) {
      throw new Error("Thinker session not initialized");
    }
    await this.thinkerSession.session.prompt(prompt);
  }

  async runDoerPrompt(prompt: string): Promise<void> {
    if (!this.doerSession) {
      throw new Error("Doer session not initialized");
    }
    await this.doerSession.session.prompt(prompt);
  }

  async waitForThinkerIdle(): Promise<void> {
    if (this.thinkerSession) {
      await this.thinkerSession.session.agent.waitForIdle();
    }
  }

  async waitForDoerIdle(): Promise<void> {
    if (this.doerSession) {
      await this.doerSession.session.agent.waitForIdle();
    }
  }

  getThinkerSession(): AgentSession | null {
    return this.thinkerSession?.session || null;
  }

  getDoerSession(): AgentSession | null {
    return this.doerSession?.session || null;
  }

  async disposeThinker(): Promise<void> {
    if (this.thinkerSession) {
      this.thinkerSession.unsubscribe();
      await this.thinkerSession.session.dispose();
      this.thinkerSession = null;
    }
  }

  async disposeDoer(): Promise<void> {
    if (this.doerSession) {
      this.doerSession.unsubscribe();
      await this.doerSession.session.dispose();
      this.doerSession = null;
    }
  }

  async disposeAll(): Promise<void> {
    await this.disposeThinker();
    await this.disposeDoer();
  }

  resetStats(): void {
    this.tokenStats = {
      thinker: this.emptyTokenStats(),
      doer: this.emptyTokenStats(),
    };
  }
}

let managerInstance: SessionManagerClass | null = null;

export function getSessionManager(): SessionManagerClass {
  if (!managerInstance) {
    managerInstance = new SessionManagerClass();
  }
  return managerInstance;
}

export function resetSessionManager(): void {
  if (managerInstance) {
    managerInstance.disposeAll();
    managerInstance = null;
  }
}
