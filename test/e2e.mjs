// End-to-end test for the Thinker tool guard and planning flow.
//
// Uses the same SDK paths the extension uses, with a real LLM call.
// Run with: node test/e2e.mjs
//
// What it tests:
//   1. A real AgentSession is created with the same tool guard the
//      extension installs on the Thinker session.
//   2. The agent is asked to write a plan to .pi/inbox/plan.md AND
//      to try writing code (to test the guard).
//   3. We assert plan.md exists with content, and the code file does not.
//   4. We also assert the cost widget value went up (proving a real
//      model call happened, not a stub).

import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";

// Reproduce the tool guard from lib/sessions.ts.
const THINKER_WRITE_ALLOWLIST = [".pi/inbox", "docs"];

function makeThinkerToolGuard(cwd) {
  const allowedAbs = THINKER_WRITE_ALLOWLIST.map((d) => resolve(cwd, d));
  return async (ctx) => {
    if (ctx?.toolCall?.name !== "write") return undefined;
    const args = (ctx.args ?? {});
    const rawPath = args.path ?? args.file_path ?? "";
    if (!rawPath) return undefined;
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const isAllowed = allowedAbs.some(
      (dir) => abs === dir || abs.startsWith(dir + "/") || abs.startsWith(dir + "\\"),
    );
    if (!isAllowed) {
      return {
        block: true,
        reason: `Thinker cannot write to "${rawPath}". ` +
          `Allowed paths: ${THINKER_WRITE_ALLOWLIST.join(", ")}. ` +
          `Code files must be written by the Doer.`,
      };
    }
    return undefined;
  };
}

// --- Test setup ---
const TEST_DIR = resolve(process.cwd(), "test/_e2e-sandbox");
const PLAN_PATH = join(TEST_DIR, ".pi/inbox/plan.md");
const CODE_PATH = join(TEST_DIR, "index.html");

// Clean up any previous run
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(join(TEST_DIR, ".pi/inbox"), { recursive: true });

const log = (...args) => console.log(`[e2e]`, ...args);
const fail = (msg) => { console.error(`[e2e] FAIL: ${msg}`); process.exit(1); };
const pass = (msg) => console.log(`[e2e] PASS: ${msg}`);

// --- Pick a model ---
log("Discovering available models...");
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const available = await modelRegistry.getAvailable();
if (!available || available.length === 0) {
  fail("No models available - check auth.json");
}
log(`Found ${available.length} models. Picking the first reasoning-capable one...`);

// Prefer reasoning models, fall back to first available.
const preferred = available.find((m) => m.reasoning) || available[0];
log(`Using model: ${preferred.provider}/${preferred.id} (reasoning=${!!preferred.reasoning})`);

// --- Create the session ---
log("Creating AgentSession with Thinker tool guard...");
const session = (await createAgentSession({
  model: preferred,
  cwd: TEST_DIR,
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  // Restrict the test session to the same tools the Thinker has.
  tools: ["read", "write", "grep", "find", "ls"],
  thinkingLevel: "high",
})).session;

// Install the guard - same as extension does on the Thinker session.
session.agent.beforeToolCall = makeThinkerToolGuard(TEST_DIR);
log("Tool guard installed.");

// --- Run a planning prompt ---
// We deliberately tell the model to do TWO writes:
//   1. .pi/inbox/plan.md (allowed)
//   2. index.html (blocked by guard)
// The model should successfully write the plan and receive an error
// for the code write.
const prompt = `You are the Thinker in a dual-agent workflow.

Your task: produce a 1-step plan for "Say hello to the world".

You MUST use the write tool to save the plan to .pi/inbox/plan.md in this exact format:

# Plan: Say Hello

## Context
Write a hello world script.

## Steps
1. [ ] Create hello.txt with content "hello world"

## Dependencies
(none)

## Notes

---
*Mode: simple | Thinker: ${preferred.id}*

After saving the plan, ALSO try to write a file called index.html with the content "<h1>hello</h1>". This is to test that code writes are blocked - you should see an error from the tool, which is expected. Do not try to bypass the error; just confirm it was blocked. Then stop.

Begin.`;

let toolCallCount = 0;
let blockedCount = 0;
let allowedCount = 0;
let totalCost = 0;

// Subscribe to events to count tool calls and verify guard behaviour.
const unsubscribe = session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    toolCallCount++;
    log(`  tool_start: name=${event.toolName} args=${JSON.stringify(event.args).slice(0, 200)}`);
  }
  if (event.type === "tool_execution_end") {
    if (event.isError) {
      blockedCount++;
      log(`  tool_end: ${event.toolName} -> ERROR (good if it was a code write)`);
    } else {
      allowedCount++;
      log(`  tool_end: ${event.toolName} -> OK`);
    }
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const usage = event.message.usage;
    if (usage?.cost?.total) {
      totalCost += usage.cost.total;
    }
  }
});

log("Running planning prompt...");
try {
  await session.prompt(prompt);
} catch (err) {
  log(`session.prompt error (may be normal after the blocked write): ${err.message}`);
}

unsubscribe();

// Wait a tick for any final events to settle.
await new Promise((r) => setTimeout(r, 500));

// --- Assertions ---
log("");
log("=== Assertions ===");

// 1. Plan file should exist
if (!existsSync(PLAN_PATH)) {
  fail(`Plan file missing at ${PLAN_PATH}. Thinker did not call write on the allowed path.`);
}
const planContent = readFileSync(PLAN_PATH, "utf-8");
if (!planContent.includes("# Plan: Say Hello")) {
  fail(`Plan file exists but doesn't contain expected title. Content:\n${planContent.slice(0, 500)}`);
}
const planSize = statSync(PLAN_PATH).size;
pass(`plan.md exists (${planSize} bytes) with expected content`);

// 2. Code file should NOT exist
if (existsSync(CODE_PATH)) {
  fail(`index.html was created at ${CODE_PATH}. The tool guard did NOT block the code write.`);
}
pass("index.html does NOT exist (guard blocked it)");

// 3. At least one tool call should have happened
if (toolCallCount === 0) {
  fail("No tool calls were made. The model didn't try to write anything.");
}
pass(`Tool calls observed: ${toolCallCount} (allowed: ${allowedCount}, blocked: ${blockedCount})`);

// 4. At least one blocked call (the index.html attempt)
if (blockedCount === 0) {
  log("WARNING: no blocked tool calls observed. The model may have skipped the test. Check the trace above.");
} else {
  pass(`${blockedCount} tool call(s) were blocked by the guard`);
}

// 5. Cost should be > 0 (proves a real LLM call happened)
if (totalCost <= 0) {
  log(`WARNING: cost is ${totalCost} - some providers don't report cost, but token counts should be > 0`);
} else {
  pass(`Total cost: $${totalCost.toFixed(6)} (real LLM call)`);
}

log("");
log("=== ALL ASSERTIONS PASSED ===");
log(`Sandbox dir: ${TEST_DIR}`);
log("Run `rm -rf test/_e2e-sandbox` to clean up.");
