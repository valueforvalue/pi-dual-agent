/**
 * pi-dual-agent - Types
 */

export type AgentRole = "thinker" | "doer";

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export const CONFIG_SCHEMA_VERSION = 2;

export interface TraceConfig {
  enabled: boolean;
  /** Absolute path; null means "use the project default (.pi/inbox/trace.log)". */
  path: string | null;
}

export interface PersistedConfig {
  schemaVersion: number;
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
  trace: TraceConfig;
  /** ISO timestamp of the last write. Informational only. */
  updatedAt: string;
}

/**
 * Default config used when no file exists, the file is unreadable, or
 * the schema version is newer than what this build understands.
 *
 * Note: previous versions (schema v1) also persisted `defaultMode` and
 * `maxIterations` for the old orchestrator loop. Those are gone in v2
 * - the router model doesn't need a global mode or iteration cap.
 * The sanitizer in lib/config.ts ignores those fields when reading
 * an older config file.
 */
export const DEFAULT_CONFIG: PersistedConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  thinkerModel: null,
  doerModel: null,
  trace: {
    enabled: false,
    path: null,
  },
  updatedAt: "",
};
