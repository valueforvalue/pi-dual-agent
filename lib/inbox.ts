/**
 * pi-dual-agent - Inbox Manager
 * 
 * Handles file relay between Thinker and Doer agents.
 * Inbox lives at: /project/.pi/inbox/
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Plan, PlanStep, Results, Checkpoint } from "./types";

const INBOX_DIR = ".pi/inbox";
const ARTIFACTS_DIR = ".pi";

// File names
export const FILES = {
  PLAN: "plan.md",
  RESULTS: "results.md",
  DIFF: "diff.md",
  CHECKPOINT: "checkpoint.md",
  ARTIFACTS: {
    RESEARCH: "RESEARCH.md",
    PRD: "PRD.md",
    TASKS: "TASKS.csv",
  },
} as const;

export class InboxManager {
  private basePath: string;

  constructor(projectPath: string) {
    this.basePath = projectPath;
  }

  private inboxPath(): string {
    return resolve(this.basePath, INBOX_DIR);
  }

  private artifactsPath(): string {
    return resolve(this.basePath, ARTIFACTS_DIR);
  }

  async ensureExists(): Promise<void> {
    try {
      await mkdir(this.inboxPath(), { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  // ========================================
  // Plan file operations
  // ========================================

  async writePlan(plan: Plan): Promise<void> {
    await this.ensureExists();

    const content = this.serializePlan(plan);
    await writeFile(join(this.inboxPath(), FILES.PLAN), content, "utf-8");
  }

  /**
   * Write raw content to an arbitrary path inside the inbox. Used by
   * the checkpoint flow when the user edits plan.md directly in the
   * editor - we want to save the user's literal text, not re-serialize
   * a Plan struct (which would normalize away their formatting).
   */
  async writeFileRaw(absolutePath: string, content: string): Promise<void> {
    // Validate that the path is inside the inbox directory so this
    // method cannot be repurposed to write outside the project.
    const inboxAbs = this.inboxPath();
    if (!absolutePath.startsWith(inboxAbs)) {
      throw new Error(`writeFileRaw: path must be inside ${inboxAbs}`);
    }
    await writeFile(absolutePath, content, "utf-8");
  }

  async readPlan(): Promise<Plan | null> {
    try {
      const content = await readFile(join(this.inboxPath(), FILES.PLAN), "utf-8");
      return this.parsePlan(content);
    } catch {
      return null;
    }
  }

  private serializePlan(plan: Plan): string {
    const steps = plan.steps
      .map((s, i) => `${i + 1}. [${s.status === "complete" ? "x" : s.status === "in_progress" ? ">" : " "}] ${s.description}${s.blockedBy.length ? ` (blocked by: ${s.blockedBy.join(", ")})` : ""}`)
      .join("\n");

    return `# Plan: ${plan.title}

## Context
${plan.context}

## Steps
${steps}

## Dependencies
${plan.dependencies.length ? plan.dependencies.map(d => `- ${d}`).join("\n") : "(none)"}

## Notes
${plan.notes || "<!-- Human annotations here -->"}

---
*Mode: ${plan.mode} | Thinker: ${plan.thinkerModel}*
`;
  }

  private parsePlan(content: string): Plan {
    const lines = content.split("\n");
    const plan: Plan = {
      title: "",
      context: "",
      steps: [],
      dependencies: [],
      notes: "",
      mode: "simple",
      thinkerModel: "",
    };

    let section = "";
    let stepIndex = 0;

    for (const line of lines) {
      if (line.startsWith("# Plan:")) {
        plan.title = line.replace("# Plan:", "").trim();
      } else if (line === "## Context") {
        section = "context";
      } else if (line === "## Steps") {
        section = "steps";
      } else if (line === "## Dependencies") {
        section = "dependencies";
      } else if (line === "## Notes") {
        section = "notes";
      } else if (line.startsWith("---")) {
        section = "meta";
      } else if (section === "context" && line.trim()) {
        plan.context += line + "\n";
      } else if (section === "steps") {
        const match = line.match(/^\d+\.\s*\[([ x>])\]\s*(.+?)(?:\s*\(blocked by:\s*(.+)\))?$/);
        if (match) {
          const status = match[1] === "x" ? "complete" : match[1] === ">" ? "in_progress" : "pending";
          const description = match[2].trim();
          const blockedBy = match[3] ? match[3].split(",").map(s => s.trim()) : [];
          plan.steps.push({ id: `step-${++stepIndex}`, description, status, blockedBy });
        }
      } else if (section === "dependencies" && line.trim().startsWith("-")) {
        plan.dependencies.push(line.replace("-", "").trim());
      } else if (section === "notes" && !line.startsWith("<!--")) {
        plan.notes += line + "\n";
      } else if (section === "meta" && line.startsWith("*Mode:")) {
        const modeMatch = line.match(/\*Mode:\s*(\w+)/);
        if (modeMatch) plan.mode = modeMatch[1] as Plan["mode"];
      }
    }

    plan.context = plan.context.trim();
    plan.notes = plan.notes.trim();
    return plan;
  }

  // ========================================
  // Results file operations
  // ========================================

  async writeResults(results: Results): Promise<void> {
    await this.ensureExists();
    
    const content = this.serializeResults(results);
    await writeFile(join(this.inboxPath(), FILES.RESULTS), content, "utf-8");
  }

  async readResults(): Promise<Results | null> {
    try {
      const content = await readFile(join(this.inboxPath(), FILES.RESULTS), "utf-8");
      return this.parseResults(content);
    } catch {
      return null;
    }
  }

  private serializeResults(results: Results): string {
    const statusIcon = results.status === "complete" ? "✓" : results.status === "partial" ? "⚠" : "✗";
    
    return `# Results: ${results.stepId}

## Status: ${statusIcon} ${results.status.charAt(0).toUpperCase() + results.status.slice(1)}

## Changes Made
${results.changes.length ? results.changes.map(c => `- ${c}`).join("\n") : "(none)"}

## Diffs
${results.diffs || "No diffs available"}

## Blockers
${results.blockers.length ? results.blockers.map(b => `- ${b}`).join("\n") : "(none)"}

## Next
${results.next}
`;
  }

  private parseResults(content: string): Results {
    const lines = content.split("\n");
    const results: Results = {
      stepId: "",
      status: "complete",
      changes: [],
      diffs: "",
      blockers: [],
      next: "",
    };

    let section = "";

    for (const line of lines) {
      if (line.startsWith("# Results:")) {
        results.stepId = line.replace("# Results:", "").trim();
      } else if (line.startsWith("## Status:")) {
        const statusStr = line.replace("## Status:", "").toLowerCase().trim();
        if (statusStr.includes("complete")) results.status = "complete";
        else if (statusStr.includes("partial")) results.status = "partial";
        else results.status = "failed";
      } else if (line === "## Changes Made") {
        section = "changes";
      } else if (line === "## Diffs") {
        section = "diffs";
      } else if (line === "## Blockers") {
        section = "blockers";
      } else if (line === "## Next") {
        section = "next";
      } else if (section === "changes" && line.trim().startsWith("-")) {
        results.changes.push(line.replace("-", "").trim());
      } else if (section === "diffs" && !line.startsWith("##")) {
        results.diffs += line + "\n";
      } else if (section === "blockers" && line.trim().startsWith("-")) {
        results.blockers.push(line.replace("-", "").trim());
      } else if (section === "next" && line.trim()) {
        results.next += line + "\n";
      }
    }

    results.next = results.next.trim();
    return results;
  }

  // ========================================
  // Checkpoint operations
  // ========================================

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.ensureExists();
    
    const content = `# Checkpoint Review

## Thinker's Plan
${this.serializePlan(checkpoint.plan)}

## Human Annotations
${checkpoint.humanAnnotations || "<!-- Your edits here -->"}

## Decision
[ ] Approve - Execute as planned
[ ] Modify - Edits above reflect changes  
[ ] Stop - End the loop

## Approved at: ${checkpoint.approvedAt}
`;
    
    await writeFile(join(this.inboxPath(), FILES.CHECKPOINT), content, "utf-8");
  }

  async readCheckpoint(): Promise<{ decision: "approve" | "modify" | "stop"; annotations: string } | null> {
    try {
      const content = await readFile(join(this.inboxPath(), FILES.CHECKPOINT), "utf-8");
      
      let decision: "approve" | "modify" | "stop" = "approve";
      let annotations = "";

      const lines = content.split("\n");
      let section = "";

      for (const line of lines) {
        if (line === "## Human Annotations") {
          section = "annotations";
        } else if (line === "## Decision") {
          section = "decision";
        } else if (section === "annotations" && !line.startsWith("<!--")) {
          annotations += line + "\n";
        } else if (section === "decision" && line.includes("[x]")) {
          if (line.includes("Approve")) decision = "approve";
          else if (line.includes("Modify")) decision = "modify";
          else if (line.includes("Stop")) decision = "stop";
        }
      }

      return { decision, annotations: annotations.trim() };
    } catch {
      return null;
    }
  }

  // ========================================
  // Artifact helpers
  // ========================================

  async hasArtifacts(): Promise<{ research: boolean; prd: boolean; tasks: boolean }> {
    // Helper: returns true on success, false on any read error.
    // (Any error is treated as "missing" - this is a probe, not a validation.)
    const exists = async (name: string): Promise<boolean> => {
      try {
        await readFile(join(this.artifactsPath(), name), "utf-8");
        return true;
      } catch {
        return false;
      }
    };
    const [research, prd, tasks] = await Promise.all([
      exists(FILES.ARTIFACTS.RESEARCH),
      exists(FILES.ARTIFACTS.PRD),
      exists(FILES.ARTIFACTS.TASKS),
    ]);
    return { research, prd, tasks };
  }

  async clearInbox(): Promise<void> {
    // Just remove plan and results, keep checkpoint
    const fs = await import("node:fs/promises");
    try {
      await fs.unlink(join(this.inboxPath(), FILES.PLAN));
    } catch { /* ignore */ }
    try {
      await fs.unlink(join(this.inboxPath(), FILES.RESULTS));
    } catch { /* ignore */ }
    try {
      await fs.unlink(join(this.inboxPath(), FILES.DIFF));
    } catch { /* ignore */ }
  }
}

export function createInboxManager(projectPath: string): InboxManager {
  return new InboxManager(projectPath);
}
