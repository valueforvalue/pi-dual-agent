/**
 * pi-dual-agent - Slash-Skill Router Parser
 *
 * Pure-function parser for the `/dual <skill>` command surface.
 * Kept in its own module (no value imports) so it's trivially
 * unit-testable without loading the session/runtime code.
 *
 * The router's runtime side (sub-session creation, TUI feedback,
 * cost tracking) lives in lib/router.ts. This file is just the
 * parser.
 */

export type DualRole = "thinker" | "doer";

export interface DualCommand {
  role: DualRole;
  slash: string;
  args: string;
  shortName: string;
}

/**
 * Legacy command names handled by the switch statement in index.ts.
 * The parser returns null for these so they fall through to the
 * legacy parser, which can do things like set model assignments
 * (`/dual thinker anthropic/claude-opus-4-5`) or run config
 * commands (`/dual setup`).
 */
const LEGACY_COMMANDS = new Set([
  "setup", "models", "thinker", "doer", "trace", "config",
  "start", "pause", "resume", "skip", "restart", "stop", "status",
]);

/**
 * Skill-to-model routing map.
 *
 * Keys are accepted as either a short name (the user types `/dual grill`)
 * or the slash command tail (the user types `/dual /grill-with-docs` or
 * `/dual grill-with-docs`). Values name the slash command that gets sent
 * to the sub-session and the model class to route it to.
 *
 * Defaults are hardcoded; per-skill configurability is deferred to a
 * follow-up. Users who want to override on a per-call basis can use
 * the explicit verb forms `/dual think <prompt>` or `/dual code <prompt>`.
 */
const SKILL_ROUTES: Record<string, { slash: string; class: DualRole }> = {
  // Short names
  grill:     { slash: "/grill-with-docs",                  class: "thinker" },
  me:        { slash: "/grill-me",                          class: "thinker" },
  prd:       { slash: "/to-prd",                            class: "thinker" },
  issues:    { slash: "/to-issues",                         class: "thinker" },
  triage:    { slash: "/triage",                            class: "thinker" },
  arch:      { slash: "/improve-codebase-architecture",     class: "thinker" },
  handoff:   { slash: "/handoff",                           class: "thinker" },
  implement: { slash: "/implement",                         class: "doer" },
  prototype: { slash: "/prototype",                         class: "doer" },
  // Full slash command names
  "grill-with-docs":              { slash: "/grill-with-docs",              class: "thinker" },
  "grill-me":                     { slash: "/grill-me",                     class: "thinker" },
  "to-prd":                       { slash: "/to-prd",                       class: "thinker" },
  "to-issues":                    { slash: "/to-issues",                    class: "thinker" },
  "improve-codebase-architecture": { slash: "/improve-codebase-architecture", class: "thinker" },
  "create-handoff":               { slash: "/create-handoff",               class: "thinker" },
  "resume-handoff":               { slash: "/resume-handoff",               class: "thinker" },
  "revise":                       { slash: "/revise",                       class: "thinker" },
};

/**
 * Parse a `/dual <args...>` invocation into a DualCommand.
 *
 * Recognised forms:
 *   /dual <short-name> [args]            - smart route by skill class
 *   /dual /<slash-command> [args]        - smart route by slash command
 *   /dual think <text...>                - explicit Thinker run (verb form)
 *   /dual code <text...>                 - explicit Doer run (verb form)
 *
 * Note: `think` and `code` (verbs) are used for the explicit form to
 * avoid collision with the model-setter commands
 * `/dual thinker <provider/id>` and `/dual doer <provider/id>`.
 *
 * Returns null if the input is not a router command (caller falls
 * through to the legacy command parser). Throws on unknown skill
 * with the list of available skills.
 */
export function parseDualRouterCommand(
  args: string,
): DualCommand | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  // Look at the first token. If it's a known legacy command name,
  // fall through to the legacy parser (it can do things the router
  // can't, like set model assignments).
  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

  if (LEGACY_COMMANDS.has(head)) {
    return null;
  }

  // Explicit role forms (verb form to avoid model-setter collision)
  const explicit = trimmed.match(/^(think|code)\s+([\s\S]*)$/);
  if (explicit) {
    const verb = explicit[1];
    const role: DualRole = verb === "think" ? "thinker" : "doer";
    const rest = explicit[2].trim();
    // If the rest starts with a slash, treat it as a slash command;
    // otherwise it's a plain text prompt.
    const slash = rest.startsWith("/") ? rest.split(/\s+/)[0] : rest;
    return {
      role,
      slash,
      args: rest,
      shortName: role,
    };
  }

  // Smart-routing forms: <name> or /<slash>
  const cleanHead = head.replace(/^\//, "");
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  const route = SKILL_ROUTES[cleanHead];
  if (!route) {
    const available = Object.keys(SKILL_ROUTES)
      .filter((k) => !k.includes("-")) // show short names only in the error
      .sort()
      .join(", ");
    throw new Error(
      `Unknown dual command: "${cleanHead}". Available: ${available}\n` +
      `Or use explicit role: /dual think <prompt> | /dual code <prompt>`,
    );
  }

  return {
    role: route.class,
    slash: route.slash,
    args: rest,
    shortName: cleanHead,
  };
}
