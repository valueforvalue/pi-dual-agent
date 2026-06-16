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
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelRef, TokenStats } from "./types";

// Default tool allowlists per role.
//   Thinker: read-only exploration + write (so it can save the plan).
//   Doer:    full editor toolset (edit, write) plus exploration.
const THINKER_TOOLS = ["read", "write", "bash", "grep", "find", "ls"];
const DOER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Maximum chars of assistant text to dump to the trace per turn.
// Long outputs (e.g. file dumps) get truncated to keep traces readable.
const MAX_TEXT_CHARS = 2000;
const MAX_TOOL_ARG_CHARS = 1500;

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

  // Tracing state
  private verbose = false;
  private traceFilePath: string | null = null;
  private turnCount = { thinker: 0, doer: 0 };

  /**
   * Enable or disable verbose tracing. When enabled, every event from both
   * the Thinker and Doer sessions is written to the trace file (if provided)
   * and to the host console. The trace file is truncated on enable.
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

  isVerbose(): boolean {
    return this.verbose;
  }

  getTraceFilePath(): string | null {
    return this.traceFilePath;
  }

  /**
   * Append a line to the trace. Always also echoed to the host console
   * (pi extensions share a console with the host CLI), prefixed so the
   * source line is obvious in mixed output.
   */
  private trace(role: "thinker" | "doer", line: string): void {
    if (!this.verbose) return;
    const stamped = `[${new Date().toISOString()}] [${role}] ${line}`;
    // Console: prefix with extension tag so users can filter.
    console.log(`[pi-dual-agent:trace] ${stamped}`);
    if (this.traceFilePath) {
      try {
        appendFileSync(this.traceFilePath, stamped + "\n", "utf-8");
      } catch {
        // swallow - tracing is best-effort
      }
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

    this.turnCount.thinker = 0;
    this.trace("thinker", `session created model=${model.provider}/${model.id} tools=[${tools.join(",")}]`);

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
        break;
      case "agent_end": {
        const msgCount = event.messages?.length ?? 0;
        this.trace("thinker", `agent_end messages=${msgCount} willRetry=${event.willRetry ?? false}`);
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
        break;
      }
      case "message_update": {
        // Streaming delta. We only log the final text once on message_end,
        // but if streaming text comes through, we capture it here.
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          // Intentionally not logged per-delta to avoid trace spam.
          // Final text is dumped on message_end.
        }
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
        break;
      }
      case "tool_execution_end": {
        this.trace("thinker", `tool_end name=${event.toolName} callId=${event.toolCallId} isError=${event.isError ?? false}`);
        break;
      }
      case "tool_execution_update":
        // Per-tool streaming updates - not logged to keep trace readable.
        break;
      default:
        this.trace("thinker", `event type=${event.type}`);
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
        break;
      case "agent_end": {
        const msgCount = event.messages?.length ?? 0;
        this.trace("doer", `agent_end messages=${msgCount} willRetry=${event.willRetry ?? false}`);
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
        break;
      }
      case "tool_execution_end": {
        this.trace("doer", `tool_end name=${event.toolName} callId=${event.toolCallId} isError=${event.isError ?? false}`);
        break;
      }
      case "tool_execution_update":
        break;
      default:
        this.trace("doer", `event type=${event.type}`);
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
