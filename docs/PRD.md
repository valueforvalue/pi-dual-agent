# pi-dual-agent PRD

## Problem Statement

Single-agent workflows have inherent limitations when handling complex, multi-step software engineering tasks. A single model must balance deep reasoning (planning, architecture, edge-case analysis) with efficient execution (tool use, file operations, code implementation). These are competing priorities: reasoning-focused models are slower and more expensive; execution-focused models may miss edge cases or produce suboptimal plans.

The user needs a system that separates thinking from doing, allowing specialized models for each role, with human oversight at key checkpoints.

## Solution

A dual-agent system for pi consisting of:

1. **Thinker Agent** - Reasoning-focused model that analyzes, plans, decomposes tasks, and reviews results
2. **Doer Agent** - Execution-focused model that implements plans, runs tools, and produces artifacts
3. **Human Checkpoint** - Human reviews Thinker's output before Doer executes
4. **File Relay** - Markdown-based inbox for agent-to-agent communication

The system runs in iterative loops until the task is complete, the human stops it, or failures exceed a threshold.

## User Stories

1. As a developer, I want a Thinker to analyze complex tasks and produce detailed plans, so I can review and refine them before execution begins
2. As a developer, I want the system to auto-detect project complexity, so complex projects get thorough planning and simple tasks get quick execution
3. As a developer, I want to pick specialized models for Thinker and Doer from my available logins, so I can optimize for cost and capability
4. As a developer, I want to edit Thinker's plans directly, so my annotations and modifications flow into execution
5. As a developer, I want to see real-time status and cost tracking, so I know what's happening and how much it's costing
6. As a developer, I want to pause, resume, or stop the loop at any time, so I maintain full control
7. As a developer, I want the system to recover gracefully from errors, so failures don't derail the entire session
8. As a developer, I want session state and artifacts to persist, so I can resume interrupted work

## Implementation Decisions

### Architecture

- **Thinker Session**: Persistent across iterations, maintains conversation context
- **Doer Session**: Created fresh per iteration, ephemeral
- **Communication**: File relay via project-local inbox
- **Inbox Location**: `./project/.pi/inbox/`

### Agent Roles

| Agent | Focus | Model Traits |
|-------|-------|--------------|
| Thinker | Reasoning, planning, analysis, review | High capability, reasoning-enabled, slower |
| Doer | Execution, tool use, implementation | Fast, reliable tool use, cost-effective |

### Iterative Loop

```
User Request -> Thinker (Plan) -> Human (Review) -> Doer (Execute) -> Thinker (Review) -> (repeat)
```

Loop terminates when:
- Human says "stop"
- Thinker declares "done"
- 3 consecutive failures

### Modes

**Simple Mode (Next-Step Focus):**
- Thinker identifies only the immediate next action
- Explains reasoning and expected outcome
- Waits for human approval
- Use for: quick fixes, small changes, single-file edits

**Complex Mode (Slash-Skill Pipeline):**
- Thinker drives the mattpocock slash skills: /grill-with-docs -> /to-prd -> /to-issues
- PRDs and issues publish to the configured issue tracker (GitHub/GitLab/local)
- Breaks into tracer-bullet vertical slices
- Reviews Doer results, refines as needed
- Use for: new features, system refactors, architecture changes

**Mode Detection:**
- Default: simple mode
- User override: --complex or --simple flag on /dual start
- Future: tracker-based auto-detect (ready-for-agent issues -> complex)

### Commands

**Setup:**
- `/dual setup` - Interactively pick Thinker & Doer models
- `/dual models` - Show current model assignments
- `/dual thinker <id>` - Override Thinker model
- `/dual doer <id>` - Override Doer model

**Control:**
- `/dual start <task>` - Start with current settings
- `/dual start <task> --complex` - Force complex mode
- `/dual start <task> --simple` - Force simple mode
- `/dual pause` - Pause at checkpoint
- `/dual resume` - Resume after human input
- `/dual skip` - Skip current step
- `/dual restart` - Restart current phase
- `/dual stop` - Stop everything
- `/dual status` - Full state: phase, models, iteration, costs

### Inbox Files

**plan.md (Thinker -> Human -> Doer):**
```md
# Plan: <Task Name>

## Context
<User request and Thinker analysis>

## Steps
1. [ ] <Step description>
2. [ ] <Step description>

## Dependencies
- Step 2 depends on Step 1

## Notes
<!-- Human annotations here -->
```

**results.md (Doer -> Thinker):**
```md
# Results: <Step>

## Status: Complete | Partial | Failed

## Changes Made
- <Files changed>
- <Actions taken>

## Diffs
\`\`\`diff
<git-style diff>
\`\`\`

## Blockers
<Issues encountered>

## Next
<What Thinker should do>
```

**checkpoint.md (Human Review):**
```md
# Checkpoint Review

## Thinker's Plan
<Full plan.md>

## Human Annotations
<!-- User edits here -->

## Decision
[ ] Approve - Execute as planned
[ ] Modify - Edits above reflect changes
[ ] Stop - End the loop
```

### Token & Cost Tracking

Adapted from pi-aftc-cache-optimizer patterns:
- Accumulate usage per agent session
- Track: input tokens, output tokens, cache read/write, total cost
- Calculate: per-turn rates, aggregate rates, cost estimates

**Display:**
- Status bar: Thinker/Doer state + costs
- Widget: Full iteration state
- Notifications: Key events with cost deltas
- Pre-execution estimates

### Persistence

- Model config: `~/.pi/agent/config/pi-dual-agent.json`
- Sessions: `~/.pi/agent/sessions/pi-dual-agent/`
- Cost history: `~/.pi/agent/stats/pi-dual-agent/`

### Error Handling

**Doer Errors:**
- Parse error -> Report to Thinker, revised approach
- Tool blocked -> Retry once, then escalate
- 3 retries failed -> Mark failed, move to next or stop

**Thinker Errors:**
- Unclear request -> Ask human for clarification
- Loop detection -> Notify human, suggest manual intervention

**Session Errors:**
- Invalid API key -> Notify human, pause
- Network error -> Retry with backoff, then pause

## Testing Decisions

- Unit test session creation/destruction
- Integration test file relay
- E2E test full loop with mock models
- Cost tracking accuracy tests

## Out of Scope

- Multi-user/shared sessions
- Real-time collaboration
- Cloud execution
- Custom model fine-tuning
- Integration with external CI/CD

## Further Notes

- Separate npm package: pi-dual-agent
- Coexists with mode-controller
- Thinker session can be reset independently
- Doer session always ephemeral per iteration
- Inbox files human-editable at checkpoints
- Cost tracking from cache-optimizer patterns
