# pi-dual-agent PRD

## Problem Statement

The mattpocock slash-skill pipeline (`/grill-with-docs` -> `/to-prd` -> `/to-issues` -> `/implement` per issue) is well-designed, but it treats every step the same: the same model runs the interview, the same model drafts the PRD, the same model writes the code. That's wasteful - reasoning work and execution work have different cost/quality trade-offs, and the user pays for the reasoning model on every code write.

The user wants to keep the slash-skill pipeline but split it across two models: an expensive reasoning model for the spec work, a cheap execution model for the implementation work. The pipeline itself should not change.

## Solution

A **model router** extension for pi that:

1. Holds a configured Thinker model and a configured Doer model.
2. Intercepts `/dual <skill>` invocations and routes them to the right model:
   - Reasoning skills (`/grill-with-docs`, `/to-prd`, `/to-issues`, `/triage`, `/handoff`) -> Thinker model.
   - Execution skills (`/implement`, `/prototype`) -> Doer model.
3. Creates a fresh ephemeral sub-session for each invocation, runs the slash skill on the right model, accumulates cost against the right bucket, prints the result to the main chat.
4. Provides TUI feedback during the run: status bar, widget, throttled progress stream.

The slash skills own the pipeline. The router owns the model assignment. The user sees the same slash skill behavior they would have without the extension - just with a different model doing the work.

## User Stories

1. As a developer, I want my reasoning model to handle `/grill-with-docs` and my execution model to handle `/implement`, so I save money on the bulk of work without losing the reasoning quality.
2. As a developer, I want to see per-model costs after a run, so I can tune my model pair over time.
3. As a developer, I want a visible status bar / widget / progress stream while a sub-session runs, so I know it's not stuck.
4. As a developer, I want to be able to override the routing on a per-call basis, so I can run `/implement` on the Thinker for a hard debugging session.
5. As a developer, I want my model choice to persist across pi sessions, so I don't re-pick on every project.

## Implementation Decisions

### Routing

Skill-to-model routing is hardcoded in `lib/router-parser.ts` with sensible defaults. Per-skill configurability (a routing table in the config) is deferred - users who want to override on a per-call basis use the explicit verb forms `/dual think <prompt>` and `/dual code <prompt>`.

Default routing:

| Short name | Slash command | Class |
|---|---|---|
| grill | `/grill-with-docs` | thinker |
| me | `/grill-me` | thinker |
| prd | `/to-prd` | thinker |
| issues | `/to-issues` | thinker |
| triage | `/triage` | thinker |
| arch | `/improve-codebase-architecture` | thinker |
| handoff | `/handoff` | thinker |
| implement | `/implement` | doer |
| prototype | `/prototype` | doer |

The full slash command name also works as input (e.g. `/dual grill-with-docs <args>` and `/dual /grill-with-docs <args>`).

### Sub-session lifecycle

Each `/dual <skill> [args]` invocation creates one ephemeral sub-session:

1. Look up the model for the role (Thinker or Doer) from the persisted config.
2. Create a new `AgentSession` with that model, the project cwd, and the role-appropriate tool set.
3. Send the router preamble + the slash command + the args as the session's input.
4. Subscribe to the session's events for TUI feedback.
5. Wait for `agent_end` (or for the model to go idle).
6. Read the slash skill's final assistant message and print it to the main chat as a normal assistant message.
7. Dispose the session, accumulate cost against the role bucket.

There is no persistent session, no loop, no checkpoint, no file relay. Each invocation is one round trip.

### Router preamble

Sent to the sub-session as part of the prompt:

```
[Router context]
You are running in a dual-agent sub-session.
Model class: <thinker|doer>
Model: <provider/id>
Cost is being tracked against the <role> bucket.

The user invoked: <slash>
Run the slash command with the args provided below. Treat this as if
the user had typed the slash command directly into a fresh session.

---

<args>
```

The preamble is the only prompt this extension produces. The slash skills own the rest.

### TUI feedback

- **Status bar**: `⏵ Dual: <role> active — <provider/id> · <slash> (<elapsed>)`. Clears when the sub-session ends.
- **Widget** (below editor): live state - model, role, skill, turns, tokens, cost, current action. Clears when idle.
- **Main chat progress**: throttled caveman-style messages, prefixed `[dual:<role>]`. Throttled to ~10 messages per sub-session run.
- **Result**: the slash skill's final assistant message is printed to the main chat as a normal message.

### Tool sets per role

- **Thinker sub-session**: `["read", "write", "grep", "find", "ls"]` - no bash, no edit. The Thinker reasons and the slash skill may write artifacts (e.g. `/to-prd` publishing to the tracker, `/create-handoff` writing to OS temp).
- **Doer sub-session**: `["read", "bash", "edit", "write", "grep", "find", "ls"]` - the full set. The Doer executes code, runs tests, commits.

The slash skills are trusted to write their own artifacts. The previous tool guard (which blocked code writes by the Thinker) is gone - the slash skills' own behavior is the gate.

### Cost tracking

`ModelRegistryWrapper.recordRunCost(role, run)` accumulates the sub-session's `usage` into the appropriate bucket. `/dual status` shows the per-model totals and the grand total. Costs are in-memory; they reset when pi restarts.

### Persistence

- **Config** (`~/.pi/agent/config/pi-dual-agent.json`): model selection, trace settings. Schema v2.
- **Per-model cost**: in-memory only.
- **Slash-skill artifacts**: on the configured issue tracker (not in this extension).

The config schema was bumped from v1 to v2. The v1 fields (`defaultMode`, `maxIterations`) are no longer read or written - they were for the old orchestrator loop, which is gone.

### Error handling

- **No model configured**: error notification, prompts the user to run `/dual setup`.
- **Model not found** (e.g. provider not logged in): error notification.
- **Sub-session error**: error notification, clears the active sub-session, accumulates whatever cost was incurred.
- **Unknown skill name**: error notification listing the available skills.

## Testing Decisions

- **Unit tests** for the parser (`lib/router-parser.ts`): 18 tests covering short names, full slash command names, explicit verb forms, model-setter collision avoidance, unknown-skill errors, multiline args.
- **Unit tests** for the preamble (`lib/prompts.ts`): 5 tests pinning the structure so accidental edits to wording don't break the user experience.
- **Typecheck**: `tsc --noEmit` against the full source set.
- **E2E test**: removed. The previous e2e test was a real-LLM call that cost money and tested the now-deleted tool guard. The slash skills' own e2e tests cover their behavior; this extension's correctness is at the parser + TUI level.

## Out of Scope

- Per-skill routing configurability (the routing table is hardcoded).
- A persistent Thinker session across multiple `/dual` invocations.
- A loop that chains multiple slash skills (the slash skills' own dispatch handles this).
- The in-repo file relay (`.pi/inbox/plan.md` + `results.md`). The slash skills produce their own artifacts.
- Cost history persistence (costs reset on pi restart).

## Further Notes

- Coexists with `pi-mode-controller` and other pi extensions. Uses the named slot `pi-dual-agent` for its status bar and widget.
- The router preamble is the only thing the router writes. The slash skills handle the rest.
- Per-skill routing configurability is a deliberate follow-up, not an oversight. Hardcoded defaults cover the cost-saving use case the user described.
