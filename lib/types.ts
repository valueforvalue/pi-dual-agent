/**
 * pi-dual-agent - Types
 */

// Agent roles
export type AgentRole = "thinker" | "doer";

// Dual mode
export type DualMode = "simple" | "complex";

// Loop phases
export type Phase =
  | "idle"        // Not active
  | "thinking"    // Thinker is planning
  | "checkpoint"  // Human review
  | "doing"       // Doer is executing
  | "reviewing"  // Thinker is reviewing results
  | "done";      // Loop complete

// Model reference
export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

// Token/cost tracking
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

// Per-agent stats
export interface AgentStats {
  tokens: TokenStats;
}

// Full dual agent state
export interface DualAgentState {
  active: boolean;
  mode: DualMode;
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
  iteration: number;
  phase: Phase;
  errorCount: number;
  maxIterations: number;
  taskDescription: string;
  projectPath: string;
}

// Inbox file types
export interface Plan {
  title: string;
  context: string;
  steps: PlanStep[];
  dependencies: string[];
  notes: string;
  mode: DualMode;
  thinkerModel: string;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed";
  blockedBy: string[];
}

export interface Results {
  stepId: string;
  status: "complete" | "partial" | "failed";
  changes: string[];
  diffs: string;
  blockers: string[];
  next: string;
}

export interface Checkpoint {
  plan: Plan;
  humanAnnotations: string;
  decision: "approve" | "modify" | "stop";
  approvedAt: string;
}

// Loop termination reasons
export type TerminationReason =
  | "human_stop"
  | "thinker_done"
  | "max_iterations"
  | "error_threshold";

// ========================================
// Persisted config
// ========================================
//
// Shape of the file at ~/.pi/agent/config/pi-dual-agent.json (see
// docs/PRD.md, "Persistence" section). The schema version lets
// loadConfig() reject (or migrate) configs written by an older version
// of the extension. v1 is the initial shape; bump this whenever a
// field is added/renamed/removed in an incompatible way.

export const CONFIG_SCHEMA_VERSION = 1;

export interface TraceConfig {
  enabled: boolean;
  /** Absolute path; null means "use the project default (.pi/inbox/trace.log)". */
  path: string | null;
}

export interface PersistedConfig {
  schemaVersion: number;
  thinkerModel: ModelRef | null;
  doerModel: ModelRef | null;
  defaultMode: DualMode;
  maxIterations: number;
  trace: TraceConfig;
  /** ISO timestamp of the last write. Informational only. */
  updatedAt: string;
}

/**
 * Default config used when no file exists, the file is unreadable, or
 * the schema version is newer than what this build understands.
 */
export const DEFAULT_CONFIG: PersistedConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  thinkerModel: null,
  doerModel: null,
  defaultMode: "simple",
  maxIterations: 50,
  trace: {
    enabled: false,
    path: null,
  },
  updatedAt: "",
};

// Session info for persistence
export interface SessionInfo {
  thinkerSessionPath: string | null;
  doerSessionPath: string | null;
  state: DualAgentState;
  tokenStats: {
    thinker: TokenStats;
    doer: TokenStats;
  };
}
