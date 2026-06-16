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
  /**
   * Optional hook for live status changes. Fires when the active agent
   * starts/stops a tool call or a message, with a short human-readable
   * string (e.g. "write .pi/inbox/plan.md", "thinking...").
   */
  onActionChange?: (action: { role: "thinker" | "doer"; text: string; startedAt: number } | null) => void;
  /**
   * Optional hook called exactly once when the loop ends, with a
   * markdown summary of what happened. The host typically writes this
   * to disk and shows a short notification pointing at the file.
   * Skipped when undefined (e.g. unit tests).
   */
  onFinalReport?: (report: string) => void;
}

export class LoopOrchestrator {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private inbox: InboxManager;
  private state: DualAgentState;
  private callbacks: LoopCallbacks;
  private terminated = false;

  // One-time-checkpoint state. `approveAll` is set to true the first
  // time the human picks "Approve all (run to completion)" — after that
  // we skip `phaseCheckpoint()` for the rest of the loop and just
  // report at the end. `planSnapshot` is the plan that was approved,
  // used to build the final report. `perStepOutcomes` accumulates the
  // outcome of each Doer execution so the final report can list what
  // actually happened, not just the plan.
  private approveAll = false;
  private planSnapshot: Plan | null = null;
  private perStepOutcomes: Array<{ step: string; status: "complete" | "partial" | "failed"; note?: string }> = [];

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

    // Phase: Human checkpoint — only on the first iteration (or if the
    // human hasn't pre-approved all remaining steps). After the initial
    // approval, the loop runs the rest of the plan autonomously and
    // emits a single final report when it ends.
    if (!this.approveAll) {
      await this.phaseCheckpoint();
      if (this.terminated) return;
    }

    // Snapshot the plan for the final report. The first time the loop
    // reaches this point is the iteration that was approved, so the
    // snapshot reflects what the human signed off on.
    if (!this.planSnapshot) {
      this.planSnapshot = await this.inbox.readPlan();
    }

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
    this.callbacks.onTrace?.("system", "CHECKPOINT - awaiting human decision");

    // Loud, persistent notification. Combined with the persistent status
    // bar set by the extension, this makes the checkpoint impossible to
    // miss: status bar shows ⏸, notification spells out the path, and
    // the select() below is a blocking popup.
    this.ctx.ui.notify(
      `⏸ CHECKPOINT\n\nThe Thinker produced a plan. Review it before the Doer runs.\n\nPlan: .pi/inbox/plan.md\nSupport: docs/RESEARCH.md, docs/PRD.md, docs/TASKS.csv\n\nChoose: Approve this step / Approve all (run to completion) / Edit / Stop.`,
      "warning",
    );

    // Loop until the user picks Approve (this step or all) or Stop.
    // Edit goes back to the top of the loop so the user can review the
    // modified plan again.
    while (true) {
      const choice = await this.ctx.ui.select("⏸ CHECKPOINT - Review the plan", [
        "Approve this step",
        "Approve all (run to completion)",
        "Edit Plan",
        "Stop",
      ]);

      if (choice === undefined || choice === "Stop") {
        this.terminate("human_stop");
        return;
      }

      if (choice === "Approve this step" || choice === "Approve all (run to completion)") {
        // Refresh the checkpoint file with the approve decision so audit
        // trail is preserved.
        const plan = await this.inbox.readPlan();
        if (plan) {
          await this.inbox.writeCheckpoint({
            plan,
            humanAnnotations: "",
            decision: "approve",
            approvedAt: new Date().toISOString(),
          });
        }
        if (choice === "Approve all (run to completion)") {
          this.approveAll = true;
          this.callbacks.onTrace?.("system", "CHECKPOINT - approved ALL, running to completion");
          this.ctx.ui.notify("Approved all. Running remaining steps without further prompts. Final report at the end.", "info");
        } else {
          this.callbacks.onTrace?.("system", "CHECKPOINT - approved, proceeding to Doer");
        }
        return;
      }

      if (choice === "Edit Plan") {
        const plan = await this.inbox.readPlan();
        if (!plan) {
          this.ctx.ui.notify("No plan to edit.", "error");
          continue;
        }
        // Open the raw markdown so the user can edit the actual file
        // format (matching what the parser expects) rather than the
        // serialized JSON, which would round-trip awkwardly.
        const planPath = `${this.state.projectPath}/.pi/inbox/plan.md`;
        const planMarkdown = await this.readPlanMarkdown(planPath);
        const edited = await this.ctx.ui.editor(
          "Edit plan.md (you can change step descriptions, statuses, dependencies, notes):",
          planMarkdown,
        );
        if (edited !== undefined && edited !== planMarkdown) {
          await this.inbox.writeFileRaw(planPath, edited);
          this.ctx.ui.notify("Plan updated. Re-reviewing...", "info");
          this.callbacks.onTrace?.("system", "CHECKPOINT - user edited plan, re-reviewing");
          // Re-read to confirm the plan parses, then loop back to the
          // top so the user can Approve or Edit again.
          const reparsed = await this.inbox.readPlan();
          if (!reparsed || reparsed.steps.length === 0) {
            this.ctx.ui.notify("Edited plan has no parseable steps. Try again.", "error");
            continue;
          }
          // Continue the while loop to show the choice again
          continue;
        }
        // User cancelled or made no changes - show choice again
        continue;
      }
    }
  }

  /**
   * Read the raw markdown of plan.md. We read it directly rather than
   * going through the structured Plan type because the editor wants to
   * show the user the file they're actually editing.
   */
  private async readPlanMarkdown(planPath: string): Promise<string> {
    const fs = await import("node:fs/promises");
    try {
      return await fs.readFile(planPath, "utf-8");
    } catch {
      return "";
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

    // Run Doer. Record the outcome for the final report regardless of
    // success/failure — the host should be able to see what the Doer
    // actually did, not just whether the loop survived.
    let resultStatus: "complete" | "partial" | "failed" = "failed";
    let currentStep = plan.steps[0]?.description ?? "unknown";
    try {
      await sessionManager.runDoerPrompt(prompt);

      // Read results
      const results = await this.inbox.readResults();
      if (results) {
        this.callbacks.onTrace?.("doer", `results read: status=${results.status} changes=${results.changes.length} blockers=${results.blockers.length}`);
        resultStatus = results.status;
        if (results.stepId) currentStep = results.stepId;
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
      this.perStepOutcomes.push({ step: currentStep, status: resultStatus });
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
    // Fire the final report before the termination callback so the
    // host can present the report to the user in the same notification
    // as the termination reason. The report itself is no-op if no
    // callback is registered (e.g. in unit tests).
    this.emitFinalReport(reason);
    this.callbacks.onTermination?.(reason);
  }

  /**
   * Build a markdown summary of what happened and hand it to the host
   * via onFinalReport. Called exactly once, when the loop ends. The
   * report is intended to be the only thing the human reads after
   * hitting "Approve all", so it answers: what was planned, what ran,
   * what was the cost.
   */
  private emitFinalReport(reason: TerminationReason): void {
    if (!this.callbacks.onFinalReport) return;

    const plan = this.planSnapshot;
    const lines: string[] = [];
    lines.push(`# Dual Agent — Final Report`);
    lines.push("");
    lines.push(`**Reason:** ${reason}`);
    lines.push(`**Iterations:** ${this.state.iteration}`);
    lines.push(`**Errors:** ${this.state.errorCount}`);
    lines.push("");

    if (plan) {
      lines.push(`## Plan: ${plan.title}`);
      lines.push("");
      lines.push("**Steps approved:**");
      for (const s of plan.steps) {
        lines.push(`- ${s.description}`);
      }
      lines.push("");
    }

    if (this.perStepOutcomes.length) {
      lines.push("## Step outcomes");
      lines.push("");
      const icon = (s: string) => s === "complete" ? "✓" : s === "partial" ? "⚠" : "✗";
      for (const o of this.perStepOutcomes) {
        lines.push(`- ${icon(o.status)} **${o.status}** — ${o.step}`);
      }
      lines.push("");
    }

    const stats = getSessionManager().getTokenStats();
    const total = stats.thinker.cost + stats.doer.cost;
    lines.push("## Cost");
    lines.push("");
    lines.push(`- Thinker: $${stats.thinker.cost.toFixed(4)} (${stats.thinker.turns} turns)`);
    lines.push(`- Doer:    $${stats.doer.cost.toFixed(4)} (${stats.doer.turns} turns)`);
    lines.push(`- **Total: $${total.toFixed(4)}**`);
    lines.push("");

    this.callbacks.onFinalReport(lines.join("\n"));
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
