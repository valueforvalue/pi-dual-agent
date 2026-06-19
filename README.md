# pi-dual-agent

Model router for pi that splits the mattpocock slash-skill pipeline across two configured models, keeping cost down by reserving an expensive model for reasoning work and a cheap model for execution.

## Overview

- **Thinker**: Reasoning-focused model. Routes `/grill-with-docs`, `/grill-me`, `/to-prd`, `/to-issues`, `/triage`, `/handoff` to a capable-but-expensive model.
- **Doer**: Execution-focused model. Routes `/implement`, `/prototype` to a fast/cheap execution model.
- **Cost split**: per-model token and cost tracking, so you can see exactly what the reasoning work costs vs the execution work.
- **TUI feedback during a run**: status bar shows the active model, widget shows live state (tokens, cost, current action), main chat gets a throttled caveman-style progress stream.

The extension does not own the pipeline - the slash skills do. It owns the model routing and the per-skill cost tracking. Invoke any of the mattpocock skills normally; dual-agent swaps the model to the configured Thinker or Doer based on the skill class, and the right cost bucket is incremented.

## Why

A single model must balance deep reasoning with efficient execution. These are competing priorities: reasoning-focused models are slower and more expensive; execution-focused models may miss edge cases or produce suboptimal plans. The dual-agent pattern splits the work: an expensive model handles the reasoning skills (`/grill-with-docs`, `/to-prd`, `/to-issues`), a cheap model handles the execution skills (`/implement`). The slash skills already do the work - dual-agent just makes sure the right model runs each one.

## Requirements

- [pi](https://pi.dev) - The coding agent harness
- Node.js 18+ (for extension loading)

## Installation

### Option 1: Clone and Install

```bash
git clone https://github.com/valueforvalue/pi-dual-agent.git
cd pi-dual-agent
pi install .
```

### Option 2: Manual Installation

```bash
cp -r /path/to/pi-dual-agent ~/.pi/agent/extensions/pi-dual-agent
# In pi:
/reload
```

### Option 3: npm

```bash
pi install git:github.com:valueforvalue/pi-dual-agent
```

## Quick Start

```bash
# 1. Pick your models
/dual setup

# 2. Run a slash skill - the right model is picked automatically
/dual grill my goal            # Thinker model
/dual implement #42            # Doer model
/dual triage                   # Thinker model

# 3. Or use the explicit form to override the routing
/dual think /grill-with-docs my goal   # force Thinker
/dual code /implement #42              # force Doer
```

Each invocation is one ephemeral sub-session. No persistent state between calls. The slash skills do the actual work; dual-agent just routes the model.

## Commands

### Setup

```bash
/dual setup                  # Interactively pick Thinker + Doer models
/dual models                 # Show current model assignments
/dual thinker <provider/id>  # Set Thinker model (e.g. anthropic/claude-opus-4-5)
/dual doer <provider/id>     # Set Doer model (e.g. anthropic/claude-sonnet-4-5)
/dual config                 # Show the persisted config (path + values)
/dual status                 # Per-model cost + active sub-session info
/dual trace on|off|path <f>  # Toggle verbose tracing
```

### Slash-Skill Router

```bash
# Smart-routing by skill class
/dual grill [args]            # -> /grill-with-docs on Thinker
/dual me [args]               # -> /grill-me on Thinker
/dual prd [args]              # -> /to-prd on Thinker
/dual issues [args]           # -> /to-issues on Thinker
/dual triage [args]           # -> /triage on Thinker
/dual arch [args]             # -> /improve-codebase-architecture on Thinker
/dual handoff [args]          # -> /handoff on Thinker
/dual implement [args]        # -> /implement on Doer
/dual prototype [args]        # -> /prototype on Doer

# Full slash command name also works
/dual grill-with-docs [args]  # same as /dual grill
/dual /implement [args]      # same as /dual implement

# Explicit override (verb form, avoids model-setter collision)
/dual think <prompt>          # run any prompt on the Thinker model
/dual code <prompt>           # run any prompt on the Doer model
```

### Control

```bash
/dual stop                    # Cancel the active sub-session (if any)
```

### Shortcuts

```bash
/dual-setup                   # Quick setup (alias for /dual setup)
/dual-stop                    # Quick stop (alias for /dual stop)
```

## How Routing Works

Each `/dual <skill> [args]` invocation:

1. Parses the args (smart-route by skill class, or explicit form)
2. Looks up the configured model for the role (Thinker or Doer)
3. Creates a new ephemeral `AgentSession` with that model
4. Sends the prompt + slash command + args to the sub-session
5. Captures events from the sub-session: status bar, widget, progress stream
6. Prints the slash skill's output to the main chat as a normal assistant message
7. Disposes the sub-session and accumulates cost against the right model bucket

The sub-session is fresh per invocation. Conversation history is not carried over. If you want to chain work across invocations, use the slash skills' own state (e.g. `/handoff` for OS-temp handoffs, or the issue tracker for cross-session work).

## TUI Feedback

During a sub-session run:

**Status bar:**
```
⏵ Dual: Thinker active — anthropic/claude-opus-4-5 · /grill-with-docs (12s)
```

**Widget (below editor):**
```
┌─ Sub-session ─────────────────────┐
│ Model:    anthropic/claude-opus-4-5 │
│ Class:    thinker                  │
│ Skill:    /grill-with-docs         │
│ Turns:    3                        │
│ Tokens:   1.2k                     │
│ Cost:     $0.0123                  │
│ Action:   read CONTEXT.md          │
└────────────────────────────────────┘
```

**Main chat progress (caveman-style, throttled):**
```
[dual:thinker] /grill-with-docs
[dual:thinker] read CONTEXT.md
[dual:thinker] ask Q1: clarify goal
[dual:thinker] done — 4 turns, 1.2k tokens, $0.012
```

**Result:** the slash skill's final output appears as a normal assistant message in the main chat.

The throttling caps the progress stream at ~10 messages per sub-session run, even on long sessions. Bursts of tool calls (a long read-grep-read sequence) get collapsed to one message per 3 seconds.

## Architecture

```
User invokes /dual <skill> [args]
        │
        ▼
┌──────────────────────┐
│ Router (index.ts)    │   parses, looks up model class
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Sub-session factory  │   creates ephemeral AgentSession
│ (lib/router.ts)      │   with Thinker or Doer model
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Sub-session          │   runs the slash skill
│ (single turn)        │   emits events
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Result + cost        │   cost accumulated against role bucket
│                      │   result printed to main chat
└──────────────────────┘
```

There is no persistent session. No loop. No checkpoint. Each `/dual` invocation is one round trip.

## Model Selection

### Recommended Pairings

**Thinker (reasoning-focused):**
- `anthropic/claude-opus-4-5` - best reasoning, slowest, most expensive
- `anthropic/claude-sonnet-4-5` - good balance
- `openai/o3-mini` - fast reasoning
- `google/gemini-2.5-pro` - capable reasoning

**Doer (execution-focused):**
- `anthropic/claude-sonnet-4-5` - reliable tool use
- `openai/gpt-4o` - fast execution
- `google/gemini-2.0-flash` - very fast

The skill classes map to the default routing in `lib/router-parser.ts`:
- **Thinker** (reasoning, planning, specs): `grill`, `me`, `prd`, `issues`, `triage`, `arch`, `handoff`, plus the full slash names
- **Doer** (execution, implementation): `implement`, `prototype`

To override on a per-call basis, use the verb forms: `/dual think <prompt>` or `/dual code <prompt>`.

## Persistence

| Data | Location |
|------|----------|
| Model config | `~/.pi/agent/config/pi-dual-agent.json` |
| Per-model cost totals | in-memory (reset on session restart) |
| Slash-skill artifacts | the configured issue tracker (not in this extension) |

The config file holds only user preferences (model selection, trace settings). It does NOT hold session state, iteration counts, or in-flight task descriptions - there are no sessions to resume in the router model.

### When the config is read and written

- **Read once** at `session_start` - the saved models and trace settings are restored.
- **Written** every time a preference changes:
  - `/dual setup` (interactive picker)
  - `/dual thinker <provider/id>` and `/dual doer <provider/id>`
  - `/dual trace on|off|path <file>`

### Inspecting the saved config

```
/dual config
```

prints the current values and the absolute path of the file. If the file is missing, unreadable, contains invalid JSON, or was written by a newer schema version, the defaults are used and a warning is logged. The extension never fails to load because of a config problem.

## Cost Tracking

The router accumulates token and cost totals per model bucket. The router reads `usage` from the sub-session's `message_end` events and adds to the appropriate bucket via `ModelRegistryWrapper.recordRunCost()`.

`/dual status` shows:
- Whether a sub-session is currently active
- Per-model cost (thinker and doer)
- Total cost

The totals are in-memory; they reset when pi restarts. Per-session cost history is not persisted (the slash skills' own history is on the configured issue tracker).

## TUI Sibling Compatibility

Dual-agent uses the named slot `pi-dual-agent` for its status bar entry and widget. The widget is placed `belowEditor`. Other extensions using the same slot would conflict; pick a different slot name in those extensions.

## Troubleshooting

### Extension not loading

```
/reload
```

Check console for errors. The extension logs `[pi-dual-agent] loaded` on success.

### "No <role> model configured"

Run `/dual setup` to pick models for both roles.

### "Model not found: <provider>/<id>"

The model from your config isn't currently available. Either log in to the provider (`/login`) or re-pick the model (`/dual setup`).

### Sub-session seems stuck

`/dual stop` cancels the active sub-session. The router doesn't currently support partial cancellation mid-tool-call (the sub-session finishes its current event), but the cost and the result are still accounted for.

### Cost totals look wrong

The router only accumulates cost from sub-sessions it ran. The slash skills' own /commit-style operations and the user's main session are not counted. This is by design - dual-agent tracks its own spend, not the global pi spend.

## Development

This repo is the source of truth. The live install at `%USERPROFILE%\.pi\agent\extensions\pi-dual-agent` is a separate clone that you sync from this one - **do not edit files in the install directly**, since uncommitted changes there can be silently destroyed. See [WORKFLOW.md](./WORKFLOW.md) for the full loop. The short version:

```bash
# 1. Edit, test, commit in this dev repo
cd C:\Development\pi-dual-agent
# ... make changes ...
npm run typecheck              # tsc --noEmit
npm test                       # router-parser + router-preamble tests
git add -A && git commit -m "..."

# 2. Push, then sync to the live install
git push origin master
scripts\sync-to-install.bat     # or ./scripts/sync-to-install.sh

# 3. In pi, reload to pick up the new code
/reload
```

The `sync-to-install` script refuses to run if either side has uncommitted changes - fail-fast is intentional.

## Tests

```bash
npm test                        # 23 tests: router-parser (18) + router-preamble (5)
npm run typecheck               # tsc --noEmit
```

- `test/router-parser.test.mjs` - the parser that maps `/dual <skill>` to (role, slash, args)
- `test/router-preamble.test.mjs` - the preamble sent to sub-sessions

## License

MIT

## Credits

- Token/cost tracking patterns adapted from [pi-aftc-cache-optimizer](https://github.com/DarceyLloyd/pi-aftc-cache-optimizer)
- Slash-skill workflow from [Matt Pocock's skills](https://github.com/mattpockock/skills)
