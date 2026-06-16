/**
 * pi-dual-agent - Loop Orchestrator
 * 
 * Manages the iterative Thinker -> Human -> Doer -> Thinker loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  DualAgentState,
  DualMode,
  ModelRef,
  Phase,
  TokenStats,
  Plan,
  Results,
  TerminationReason,
} from "./types";
import { InboxManager, createInboxManager } from "./inbox";
import { getSessionManager, resetSessionManager } from "./sessions";
import { formatThinkerTask, formatDoerTask, CHECKPOINT_NOTIFICATION } from "./prompts";

export interface LoopCallbacks {
  onPhaseChange?: (phase: Phase) => void;
  onIterationChange?: (iteration: number) => void;
  onCostUpdate?: (thinkerCost: number, doerCost: number) => void;
  onTermination?: (reason: TerminationReason) => void;
  onError?: (error: Error) => void;
  /**
   * Optional hook for high-level lifecycle events. Distinct from
   * SessionManagerClass's per-event trace: this is one line per phase
   * (prompt sent / plan read / results read) so users can see what
   * happened even when the verbose per-event trace is off.
   */
  onTrace?: (role: "thinker" | "doer" | "review" | "system", message: string) => void;
}

export class LoopOrchestrator {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private inbox: InboxManager;
  private state: DualAgentState;
  private callbacks: LoopCallbacks;
  private terminated = false;

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    projectPath: string,
    callbacks: LoopCallbacks = {}
  ) {
    this.pi = pi;
    this.ctx = ctx;
    this.inbox = createInboxManager(projectPath);
    this.state = {
      active: false,
      mode: "simple",
      thinkerModel: null,
      doerModel: null,
      iteration: 0,
      phase: "idle",
      errorCount: 0,
      maxIterations: 50,
      taskDescription: "",
      projectPath,
    };
    this.callbacks = callbacks;
  }

  // ========================================
  // Configuration
  // ========================================

  setModels(thinker: ModelRef, doer: ModelRef): void {
    this.state.thinkerModel = thinker;
    this.state.doerModel = doer;
  }

  setMode(mode: DualMode): void {
    this.state.mode = mode;
  }

  setTask(task: string): void {
    this.state.taskDescription = task;
  }

  setMaxIterations(max: number): void {
    this.state.maxIterations = max;
  }

  getState(): DualAgentState {
    return { ...this.state };
  }

  // ========================================
  // Loop control
  // ========================================

  async start(): Promise<void> {
    if (!this.state.thinkerModel || !this.state.doerModel) {
      throw new Error("Models not configured. Run /dual setup first.");
    }

    this.state.active = true;
    this.state.iteration = 1;
    this.state.phase = "thinking";
    this.state.errorCount = 0;
    this.terminated = false;

    this.notifyPhaseChange();
    this.notifyIterationChange();

    try {
      // Auto-detect mode from existing artifacts
      if (this.state.mode === "simple") {
        const artifacts = await this.inbox.hasArtifacts();
        if (artifacts.research || artifacts.prd || artifacts.tasks) {
          this.state.mode = "complex";
          this.ctx.ui.notify("Auto-detected complex mode from existing artifacts", "info");
        }
      }

      // Main loop
      while (!this.terminated && this.state.active) {
        await this.loopIteration();
      }
    } catch (error) {
      this.callbacks.onError?.(error as Error);
      this.ctx.ui.notify(`Loop error: ${(error as Error).message}`, "error");
    } finally {
      await this.cleanup();
    }
  }

  private async loopIteration(): Promise<void> {
    // Check termination conditions
    if (this.state.iteration >= this.state.maxIterations) {
      this.terminate("max_iterations");
      return;
    }

    if (this.state.errorCount >= 3) {
      this.terminate("error_threshold");
      return;
    }

    // Phase: Thinker plans
    await this.phaseThinker();

    if (this.terminated) return;

    // Phase: Human checkpoint
    await this.phaseCheckpoint();

    if (this.terminated) return;

    // Phase: Doer executes
    await this.phaseDoer();

    if (this.terminated) return;

    // Phase: Thinker reviews
    await this.phaseReview();

    // Increment iteration
    this.state.iteration++;
    this.notifyIterationChange();
  }

  private async phaseThinker(): Promise<void> {
    this.state.phase = "thinking";
    this.notifyPhaseChange();

    const sessionManager = getSessionManager();

    // Create or reuse Thinker session
    if (!sessionManager.getThinkerSession()) {
      await sessionManager.createThinkerSession(
        this.state.thinkerModel!,
        this.state.projectPath
      );
    }

    // Build prompt
    const prompt = formatThinkerTask(this.state.taskDescription, this.state.mode);
    this.callbacks.onTrace?.("thinker", `prompt sent (${prompt.length} chars) mode=${this.state.mode}`);

    // Run Thinker
    try {
      await sessionManager.runThinkerPrompt(prompt);

      // Read generated plan
      const plan = await this.inbox.readPlan();
      this.callbacks.onTrace?.("thinker", plan
        ? `plan read: ${plan.steps.length} step(s), mode=${plan.mode}`
        : "plan read: <MISSING> - no plan file at .pi/inbox/plan.md");

      if (!plan || plan.steps.length === 0) {
        // Fail loudly. Previously this was silently swallowed and the
        // loop proceeded to a checkpoint with an empty plan.
        this.state.errorCount++;
        const tracePath = sessionManager.getTraceFilePath();
        const hint = tracePath
          ? `See trace: ${tracePath}`
          : "Re-run with /dual trace on to see what the Thinker did.";
        const msg = `Thinker did not produce a usable plan. ${hint}`;
        this.callbacks.onError?.(new Error(msg));
        throw new Error(msg);
      }

      // Write checkpoint for human review
      await this.inbox.writeCheckpoint({
        plan,
        humanAnnotations: "",
        decision: "approve",
        approvedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.state.errorCount++;
      this.callbacks.onError?.(error as Error);
      throw error;
    }
  }

  private async phaseCheckpoint(): Promise<void> {
    this.state.phase = "checkpoint";
    this.notifyPhaseChange();

    // Show checkpoint notification to user
    this.ctx.ui.notify(CHECKPOINT_NOTIFICATION, "info");

    // Read human's decision
    const checkpoint = await this.inbox.readCheckpoint();

    if (!checkpoint) {
      // No checkpoint file yet - prompt user
      const choice = await this.ctx.ui.select("Checkpoint - Review plan", [
        "Approve and Execute",
        "Edit Plan First",
        "Stop",
      ]);

      if (choice === "Stop" || choice === undefined) {
        this.terminate("human_stop");
        return;
      }

      if (choice === "Edit Plan First") {
        // Let user edit the plan
        const plan = await this.inbox.readPlan();
        if (plan) {
          const edited = await this.ctx.ui.editor("Edit plan:", JSON.stringify(plan, null, 2));
          if (edited) {
            // User modified the plan - we'll use their version
            this.ctx.ui.notify("Plan updated, proceeding with your changes", "info");
          }
        }
      }
    } else {
      // User already filled out checkpoint
      if (checkpoint.decision === "stop") {
        this.terminate("human_stop");
        return;
      }

      if (checkpoint.decision === "modify") {
        this.ctx.ui.notify("Plan modified, proceeding with your changes", "info");
      }
    }
  }

  private async phaseDoer(): Promise<void> {
    this.state.phase = "doing";
    this.notifyPhaseChange();

    const sessionManager = getSessionManager();

    // Create ephemeral Doer session
    await sessionManager.createDoerSession(
      this.state.doerModel!,
      this.state.projectPath
    );

    // Read current plan
    const plan = await this.inbox.readPlan();
    if (!plan) {
      throw new Error("No plan found in inbox");
    }

    // Build Doer prompt
    const prompt = formatDoerTask(JSON.stringify(plan, null, 2));
    this.callbacks.onTrace?.("doer", `prompt sent (${prompt.length} chars) planStep=${plan.steps.length}`);

    // Run Doer
    try {
      await sessionManager.runDoerPrompt(prompt);

      // Read results
      const results = await this.inbox.readResults();
      if (results) {
        this.callbacks.onTrace?.("doer", `results read: status=${results.status} changes=${results.changes.length} blockers=${results.blockers.length}`);
      } else {
        this.callbacks.onTrace?.("doer", "results read: <MISSING> - no results file at .pi/inbox/results.md");
      }
      if (results?.status === "failed") {
        this.state.errorCount++;
      }
    } catch (error) {
      this.state.errorCount++;
      this.callbacks.onError?.(error as Error);
      throw error;
    } finally {
      // Dispose Doer session (ephemeral)
      await sessionManager.disposeDoer();
    }
  }

  private async phaseReview(): Promise<void> {
    this.state.phase = "reviewing";
    this.notifyPhaseChange();

    const sessionManager = getSessionManager();

    // Read results
    const results = await this.inbox.readResults();
    this.callbacks.onTrace?.("review", `reviewing doer results status=${results?.status ?? "<missing>"}`);

    // Ask Thinker to review
    const reviewPrompt = `Review the Doer's results and determine next steps.

RESULTS:
${JSON.stringify(results, null, 2)}

Check:
1. Did the step complete successfully?
2. Are there blockers to address?
3. What's the next action?
4. Should we continue or declare done?

Update .pi/inbox/plan.md with your review. Mark the completed step as [x] and the next one as [>]. If all steps are complete, mark them all as [x].
`;

    try {
      await sessionManager.runThinkerPrompt(reviewPrompt);

      // Check if Thinker says done
      const plan = await this.inbox.readPlan();
      if (plan) {
        const completed = plan.steps.filter(s => s.status === "complete").length;
        this.callbacks.onTrace?.("review", `plan updated: ${completed}/${plan.steps.length} complete`);
        if (plan.steps.every(s => s.status === "complete")) {
          this.terminate("thinker_done");
        }
      } else {
        this.callbacks.onTrace?.("review", "review done but plan.md is missing or unparseable");
      }
    } catch (error) {
      this.state.errorCount++;
      this.callbacks.onError?.(error as Error);
    }
  }

  private terminate(reason: TerminationReason): void {
    this.terminated = true;
    this.state.active = false;
    this.state.phase = "done";
    this.notifyPhaseChange();
    this.callbacks.onTermination?.(reason);
  }

  pause(): void {
    if (this.state.active) {
      this.state.phase = "checkpoint";
      this.notifyPhaseChange();
    }
  }

  resume(): void {
    if (this.state.phase === "checkpoint") {
      this.state.phase = "doing";
      this.notifyPhaseChange();
    }
  }

  async stop(): Promise<void> {
    this.terminate("human_stop");
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    await getSessionManager().disposeAll();
    resetSessionManager();
  }

  // ========================================
  // Notifications
  // ========================================

  private notifyPhaseChange(): void {
    this.callbacks.onPhaseChange?.(this.state.phase);
  }

  private notifyIterationChange(): void {
    this.callbacks.onIterationChange?.(this.state.iteration);
  }

  private notifyCostUpdate(): void {
    const stats = getSessionManager().getTokenStats();
    this.callbacks.onCostUpdate?.(stats.thinker.cost, stats.doer.cost);
  }
}

// Singleton orchestrator instance
let orchestratorInstance: LoopOrchestrator | null = null;

export function getOrchestrator(): LoopOrchestrator | null {
  return orchestratorInstance;
}

export function createOrchestrator(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  projectPath: string,
  callbacks: LoopCallbacks = {}
): LoopOrchestrator {
  orchestratorInstance = new LoopOrchestrator(pi, ctx, projectPath, callbacks);
  return orchestratorInstance;
}

export function destroyOrchestrator(): void {
  if (orchestratorInstance) {
    orchestratorInstance.stop();
    orchestratorInstance = null;
  }
}
