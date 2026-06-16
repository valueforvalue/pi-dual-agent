/**
 * pi-dual-agent - Session Manager
 * 
 * Manages Thinker and Doer agent sessions using the pi SDK.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelRef, TokenStats, Phase } from "./types";

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
  private authStorage: any;
  private modelRegistry: any;
  private thinkerSession: SessionHandle | null = null;
  private doerSession: SessionHandle | null = null;
  private tokenStats: { thinker: TokenStats; doer: TokenStats } = {
    thinker: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    doer: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  };

  constructor() {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
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
    await ensureImports();
    const models = await this.modelRegistry.getAvailable();
    return models.map((m: any) => ({
      provider: m.provider,
      id: m.id,
      name: m.name || m.id,
      reasoning: m.reasoning === true,
    }));
  }

  findModel(provider: string, id: string): any {
    return this.modelRegistry.find(provider, id);
  }

  async createThinkerSession(
    model: ModelRef,
    cwd: string,
    sessionPath?: string
  ): Promise<SessionHandle> {
    await ensureImports();

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
    });

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
    sessionPath?: string
  ): Promise<SessionHandle> {
    await ensureImports();

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
      // Doer might need different tool config
    });

    const handle: SessionHandle = {
      session,
      unsubscribe: session.subscribe((event: any) => this.handleDoerEvent(event)),
    };

    this.doerSession = handle;
    return handle;
  }

  private handleThinkerEvent(event: any): void {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.accumulateStats(this.tokenStats.thinker, event.message.usage);
    }
  }

  private handleDoerEvent(event: any): void {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.accumulateStats(this.tokenStats.doer, event.message.usage);
    }
  }

  private accumulateStats(stats: TokenStats, usage: any): void {
    if (!usage) return;
    stats.inputTokens += usage.input || 0;
    stats.outputTokens += usage.output || 0;
    stats.cacheRead += usage.cacheRead || 0;
    stats.cacheWrite += usage.cacheWrite || 0;
    stats.totalTokens += usage.totalTokens || 0;
    stats.cost += usage.cost?.total || 0;
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
