/**
 * pi-dual-agent - Model Registry and Cost Tracking
 *
 * Thin wrapper over the pi SDK's model registry. Provides:
 *   - lazy initialization of the auth storage and model registry
 *   - a single source of truth for available models
 *   - per-model (thinker / doer) cost and token totals
 *
 * The router (lib/router.ts) and the model picker in index.ts use
 * this to look up models and accumulate cost. The router itself
 * creates ephemeral sub-sessions directly via createAgentSession -
 * no persistent session management here.
 *
 * The previous version of this file managed persistent Thinker/Doer
 * sessions, an event capture system, verbose tracing, and a tool
 * guard for the Thinker. All of that is gone in the router model:
 * the slash skills own the pipeline, the router creates one
 * sub-session per command, and the slash skills are trusted to
 * write their own artifacts.
 */

import type { ModelRef, TokenStats } from "./types";

let AuthStorage: any = null;
let ModelRegistry: any = null;

async function ensureImports(): Promise<void> {
  if (!ModelRegistry) {
    const mod = await import("@earendil-works/pi-coding-agent");
    AuthStorage = mod.AuthStorage;
    ModelRegistry = mod.ModelRegistry;
  }
}

export class ModelRegistryWrapper {
  private authStorage: any = null;
  private modelRegistry: any = null;
  private tokenStats: { thinker: TokenStats; doer: TokenStats } = {
    thinker: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    doer: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  };
  private initialized = false;

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await ensureImports();
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.initialized = true;
  }

  /**
   * Public alias for ensureInitialized. The router (and any other
   * caller that needs the model registry ready before using findModel)
   * calls this instead of reaching into a private method.
   */
  async ensureReady(): Promise<void> {
    await this.ensureInitialized();
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

  getTokenStats(): { thinker: TokenStats; doer: TokenStats } {
    return {
      thinker: { ...this.tokenStats.thinker },
      doer: { ...this.tokenStats.doer },
    };
  }

  /**
   * Accumulate cost and token usage from an external run (typically a
   * router sub-session) into the appropriate model bucket. Lets the
   * router contribute to the same per-model totals that the rest of
   * the extension sees in /dual status.
   */
  recordRunCost(
    role: "thinker" | "doer",
    run: { inputTokens: number; outputTokens: number; cost: number; turns: number },
  ): void {
    const stats = this.tokenStats[role];
    stats.inputTokens += run.inputTokens || 0;
    stats.outputTokens += run.outputTokens || 0;
    stats.cost += run.cost || 0;
    stats.turns += run.turns || 0;
  }

  resetStats(): void {
    this.tokenStats = {
      thinker: this.emptyTokenStats(),
      doer: this.emptyTokenStats(),
    };
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
}

let managerInstance: ModelRegistryWrapper | null = null;

export function getSessionManager(): ModelRegistryWrapper {
  if (!managerInstance) {
    managerInstance = new ModelRegistryWrapper();
  }
  return managerInstance;
}

export function resetSessionManager(): void {
  managerInstance = null;
}
