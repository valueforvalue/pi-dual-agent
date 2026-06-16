# pi-dual-agent

Dual-agent system for pi with Thinker + Doer roles and human checkpoints.

## Overview

This extension implements a dual-agent workflow for complex software engineering tasks:

- **Thinker**: Reasoning-focused model that analyzes, plans, and reviews
- **Doer**: Execution-focused model that implements plans
- **Human Checkpoint**: Human reviews Thinker's output before Doer executes
- **File Relay**: Markdown inbox for agent-to-agent communication

The system runs in iterative loops until the task is complete, the human stops it, or failures exceed a threshold.

## Requirements

- [pi](https://pi.dev) - The coding agent harness
- Node.js 18+ (for extension loading)

## Installation

### Option 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pi-dual-agent.git

# Install via pi
cd pi-dual-agent
pi install .
```

### Option 2: Manual Installation

```bash
# Copy to pi extensions directory
cp -r /path/to/pi-dual-agent ~/.pi/agent/extensions/pi-dual-agent

# Reload pi to load the extension
/reload
```

### Option 3: npm Package

```bash
# Install from npm (when published)
npm install pi-dual-agent

# Or install from git
npm install github:YOUR_USERNAME/pi-dual-agent
```

## Quick Start

```bash
# 1. Setup - pick your models
/dual setup

# 2. Start a task (simple mode)
/dual start Fix the login bug

# 3. Review the plan, then approve/modify/stop
# The Thinker creates a plan, you review it

# 4. Doer executes approved steps
# Loop continues until done or you stop
```

## Commands

### Setup Commands

```bash
/dual setup          # Interactively pick Thinker & Doer models
/dual models         # Show current model assignments
/dual thinker <id>   # Set Thinker model (e.g., anthropic/claude-opus-4-5)
/dual doer <id>      # Set Doer model (e.g., anthropic/claude-sonnet-4-5)
/dual config         # Show the persisted config (path + values)
```

### Control Commands

```bash
/dual start <task>           # Start with current settings
/dual start <task> --complex  # Force complex mode
/dual start <task> --simple   # Force simple mode
/dual pause                   # Pause at checkpoint
/dual resume                  # Resume after pause
/dual skip                    # Skip current step
/dual restart                 # Restart current phase
/dual stop                    # Stop everything
/dual status                  # Full state display
```

### Shortcuts

```bash
/dual-setup   # Quick setup
/dual-stop    # Quick stop
```

## Modes

### Simple Mode (Next-Step Focus)

Thinker identifies only the immediate next action. Human approves or modifies. Repeat.

**Thinker behavior:**
- Identifies next action
- Explains reasoning
- Describes expected outcome
- Waits for approval

**Use for:**
- Quick fixes
- Small changes
- Single-file edits

### Complex Mode (Full Pipeline)

Thinker follows the to-prd → to-issues → TASKS.csv workflow.

**Thinker behavior:**
- Creates docs/RESEARCH.md
- Creates docs/PRD.md
- Breaks into vertical slices
- Creates docs/TASKS.csv
- Reviews Doer results
- Refines as needed

**Use for:**
- New features
- System refactors
- Architecture changes
- Multi-file changes

### Mode Detection

**Auto-detect (default):**
- `docs/RESEARCH.md` or `docs/PRD.md` exists → Complex
- Request contains keywords: "architecture", "refactor", "system", "migrate" → Complex

**User override:**
```bash
/dual start <task> --complex  # Force complex mode
/dual start <task> --simple   # Force simple mode
```

## Architecture

```
User Request
     │
     ▼
┌─────────────┐
│   Thinker   │ ◄──────────────┐
│   (Plan)    │                │
└──────┬──────┘                │
       │                       │
       ▼                       │
┌─────────────┐               │
│   Human     │               │
│   Review    │               │
└──────┬──────┘               │
       │                       │
       ▼                       │
┌─────────────┐               │
│    Doer     │               │
│  (Execute)  │               │
└──────┬──────┘               │
       │                       │
       ▼                       │
┌─────────────┐───────────────┘
│   Thinker   │
│   (Review)  │
└─────────────┘

Loop until: Human "stop", Thinker "done", or 3 failures
```

### Session Architecture

- **Thinker Session**: Persistent across iterations, maintains context
- **Doer Session**: Created fresh per iteration, ephemeral
- **Communication**: File relay via project-local inbox

## Inbox

Files live at `./project/.pi/inbox/`:

| File | Purpose |
|------|---------|
| `plan.md` | Thinker's current plan |
| `results.md` | Doer's execution results |
| `checkpoint.md` | Human review checkpoint |
| `diff.md` | Code changes (optional) |

Artifacts for complex mode:
- `docs/RESEARCH.md`
- `docs/PRD.md`
- `docs/TASKS.csv`

### Plan Format

```markdown
# Plan: <Task Name>

## Context
<User request and Thinker analysis>

## Steps
1. [x] Completed step
2. [>] Current step
3. [ ] Pending step

## Dependencies
- Step 2 depends on Step 1

## Notes
<!-- Human annotations here -->
```

### Results Format

```markdown
# Results: <Step>

## Status: ✓ Complete

## Changes Made
- Added auth middleware
- Created user model

## Diffs
\`\`\`diff
+ const auth = ...
\`\`\`

## Blockers
(none)

## Next
Proceed to step 3
```

## Token & Cost Tracking

The extension tracks token usage and costs for both agents:

**Display:**
- Status bar: Current phase and iteration
- Widget: Per-agent costs and totals
- Notifications: Cost updates at key events

**Example widget:**
```
Thinker: Active anthropic/claude-opus-4-5
Doer: Idle anthropic/claude-sonnet-4-5
Mode: simple | Phase: thinking | Iteration: 1
Thinker: $0.0234 | Doer: $0.0000
Total: $0.0234
```

## Model Selection

### Recommended Models

**Thinker (Reasoning-focused):**
- `anthropic/claude-opus-4-5` - Best reasoning, slower
- `anthropic/claude-sonnet-4-5` - Good balance
- `openai/o3-mini` - Fast reasoning

**Doer (Execution-focused):**
- `anthropic/claude-sonnet-4-5` - Good tool use
- `openai/gpt-4o` - Fast execution
- `google/gemini-2.0-flash` - Very fast

### How Model Selection Works

1. Run `/dual setup` for interactive picker
2. Extension queries `modelRegistry.getAvailable()`
3. You select from your logged-in providers
4. Config saved to `~/.pi/agent/config/pi-dual-agent.json`

## Persistence

| Data | Location |
|------|----------|
| Model config | `~/.pi/agent/config/pi-dual-agent.json` |
| Sessions | `~/.pi/agent/sessions/pi-dual-agent/` |
| Cost history | `~/.pi/agent/stats/pi-dual-agent/` |

### What is persisted

User **preferences** survive across pi sessions:

- Thinker and Doer model selection
- Default mode (`simple` or `complex`)
- Trace settings (enabled, output path)

Transient loop state (active phase, current iteration, in-flight task description) is **not** persisted — when you close pi, the running loop dies with it. The next session starts fresh, but your model selection is already loaded.

### When it is read and written

- **Read once** at `session_start` — the saved models and defaults are restored into the in-memory state.
- **Written** every time a preference changes:
  - `/dual setup` (interactive picker)
  - `/dual thinker <provider/id>` and `/dual doer <provider/id>`
  - `/dual start <task> --complex` / `--simple` (only when the user passes the flag — auto-detected mode from existing artifacts is not persisted as the new default)
  - `/dual trace on|off|path <file>` (the `status` subcommand is read-only)
  - `/dual stop`

### Inspecting the saved config

```
/dual config
```

prints the current persisted values and the absolute path of the file, so you can `cat` / edit / back it up. (The path differs per OS — Windows uses `%USERPROFILE%\.pi\agent\config\pi-dual-agent.json`, macOS/Linux use `~/.pi/agent/config/pi-dual-agent.json`.)

If the file is missing, unreadable, contains invalid JSON, or was written by a newer version of the extension, the defaults are used and a warning is logged to the console. The extension never fails to load because of a config problem.

## Error Handling

### Doer Errors
- Parse error → Report to Thinker, ask for revised approach
- Tool blocked → Retry once, then escalate
- 3 retries failed → Mark step failed, move to next or stop

### Thinker Errors
- Unclear request → Ask human for clarification
- Loop detection → Notify human, suggest manual intervention

### Session Errors
- Invalid API key → Notify human, pause until resolved
- Network error → Retry with backoff, then pause

## Loop Termination

Loop ends when:
- Human says `/dual stop`
- Thinker declares "done" (all steps complete)
- 3 consecutive failures (error_threshold)
- Max iterations reached (default: 50)

## Configuration

### Flags

```bash
# Start in complex mode by default
pi --dual-complex
```

### Environment Variables

The extension uses pi's model registry. Ensure your API keys are configured:

```bash
# In ~/.pi/agent/auth.json or environment
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

## Troubleshooting

### Extension not loading

```bash
/reload
```

Check console for errors:
```
[pi-dual-agent] loaded - /dual setup|start|pause|resume|stop|status
```

### No models available

1. Run `/login` to configure a provider
2. Run `/dual setup` again

### Session stuck

```bash
/dual stop     # Stop current session
/reload        # Reload extension
/dual setup    # Reset if needed
```

## Development

This repo is the source of truth. The live install at
`%USERPROFILE%\.pi\agent\extensions\pi-dual-agent` is a separate
clone that you sync from this one — **do not edit files in the
install directly**, since uncommitted changes there can be
silently destroyed. See [WORKFLOW.md](./WORKFLOW.md) for the
full loop. The short version:

```bash
# 1. Edit, test, commit in this dev repo
cd C:\Development\pi-dual-agent
# ... make changes ...
node test/tool-guard.test.mjs   # quick sanity check
git add -A && git commit -m "..."

# 2. Push, then sync to the live install
git push origin master
scripts\sync-to-install.bat     # or ./scripts/sync-to-install.sh

# 3. In pi, reload to pick up the new code
/reload
```

The `sync-to-install` script refuses to run if either side has
uncommitted changes — fail-fast is intentional, so you don't
accidentally wipe working changes.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Test with `/reload`
5. Submit a pull request

## License

MIT

## Credits

- Token/cost tracking adapted from [pi-aftc-cache-optimizer](https://github.com/DarceyLloyd/pi-aftc-cache-optimizer)
- Workflow inspired by [Matt Pocock's skills](https://github.com/mattpockock/skills)
