/**
 * pi-dual-agent - Persisted Config
 *
 * Reads and writes the user's pi-dual-agent preferences to a single
 * JSON file at ~/.pi/agent/config/pi-dual-agent.json (see docs/PRD.md,
 * "Persistence" section). The file holds preferences only — not
 * transient runtime state like the active phase, current iteration,
 * or in-flight task description.
 *
 * Why a global config: model selection is a user preference, not a
 * project setting. The same Thinker/Doer pair should follow the user
 * across projects so they don't have to re-pick on every repo. A
 * per-project override can be layered on top later by checking
 * `<project>/.pi/dual-agent.json` first; that is out of scope here.
 *
 * Failure handling: every error path falls back to DEFAULT_CONFIG and
 * logs a single warning. Persistence is a convenience — the extension
 * must keep working if the file is missing, corrupt, or on a read-only
 * filesystem. We never throw from loadConfig or saveConfig.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
  type PersistedConfig,
  type TraceConfig,
  type ModelRef,
} from "./types";

// Filename kept in sync with docs/PRD.md.
const CONFIG_DIR = join(homedir(), ".pi", "agent", "config");
const CONFIG_PATH = join(CONFIG_DIR, "pi-dual-agent.json");

/**
 * Where the config file lives. Exposed so the /dual config command
 * (and any troubleshooting) can point the user at the actual path,
 * which differs per OS (Windows: %USERPROFILE%\.pi\agent\config\...,
 * macOS/Linux: ~/.pi/agent/config/...).
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Load the persisted config from disk. Returns DEFAULT_CONFIG (and
 * logs a warning) on any failure: missing file, unreadable, malformed
 * JSON, or schema version from a newer build.
 *
 * Note: the warning goes to console.error, not the TUI, because this
 * is called during extension load before we have a UI handle.
 */
export async function loadConfig(): Promise<PersistedConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // Most common case: first run, no config yet. Not a warning.
      return { ...DEFAULT_CONFIG };
    }
    console.warn(
      `[pi-dual-agent] could not read config at ${CONFIG_PATH}: ${(err as Error).message}. Using defaults.`,
    );
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[pi-dual-agent] config at ${CONFIG_PATH} is not valid JSON: ${(err as Error).message}. Using defaults.`,
    );
    return { ...DEFAULT_CONFIG };
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn(`[pi-dual-agent] config at ${CONFIG_PATH} is not an object. Using defaults.`);
    return { ...DEFAULT_CONFIG };
  }

  const obj = parsed as Record<string, unknown>;

  // Schema version check. If the file was written by a newer build
  // (schemaVersion > CONFIG_SCHEMA_VERSION), we don't know what the
  // extra fields mean — fall back to defaults rather than guess.
  const fileVersion = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;
  if (fileVersion > CONFIG_SCHEMA_VERSION) {
    console.warn(
      `[pi-dual-agent] config schema v${fileVersion} is newer than supported v${CONFIG_SCHEMA_VERSION}. Using defaults.`,
    );
    return { ...DEFAULT_CONFIG };
  }

  return sanitizeConfig(obj);
}

/**
 * Coerce a parsed JSON object into a valid PersistedConfig. Missing
 * fields are filled from DEFAULT_CONFIG so a partial file (e.g. one
 * written by an older version that only knew about thinkerModel and
 * doerModel) still loads cleanly.
 */
function sanitizeConfig(obj: Record<string, unknown>): PersistedConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    thinkerModel: sanitizeModelRef(obj.thinkerModel),
    doerModel: sanitizeModelRef(obj.doerModel),
    trace: sanitizeTrace(obj.trace),
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
  };
}

function sanitizeModelRef(value: unknown): ModelRef | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
  return {
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" ? m.name : undefined,
    reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
  };
}

function sanitizeTrace(value: unknown): TraceConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CONFIG.trace };
  }
  const t = value as Record<string, unknown>;
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : false,
    // `consoleEcho` is accepted on read so a config from a future
    // build that adds the field still loads, but we don't surface it
    // in this build.
    path: typeof t.path === "string" && t.path.length > 0 ? t.path : null,
  };
}

/**
 * Write the config to disk, replacing any existing file. Creates the
 * parent directory if it does not exist. Returns true on success.
 *
 * On failure, logs a warning and returns false. The caller should
 * treat a `false` return as "user preference not saved" but should
 * NOT roll back the in-memory state change — losing the preference
 * silently is worse than the user seeing the change work in-session
 * and finding out at the end that it wasn't persisted.
 */
export async function saveConfig(config: PersistedConfig): Promise<boolean> {
  const toWrite: PersistedConfig = {
    ...config,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  try {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.warn(
      `[pi-dual-agent] could not write config at ${CONFIG_PATH}: ${(err as Error).message}. ` +
        `Your preferences will be lost when this session ends.`,
    );
    return false;
  }
}
