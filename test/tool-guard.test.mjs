// Quick test for the Thinker tool guard.
// Run with: node test/tool-guard.test.mjs
//
// Reproduces the guard logic inline so we don't need TS to run this.
// The function under test is `makeThinkerToolGuard` in lib/sessions.ts.

import { resolve, isAbsolute } from "node:path";
import { strict as assert } from "node:assert";

const THINKER_WRITE_ALLOWLIST = [".pi/inbox"];

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

// Test cases
const cwd = "/project";
const guard = makeThinkerToolGuard(cwd);

const cases = [
  // [name, ctx, expectedBlocked, expectedReasonContains]
  ["non-write tool allowed", { toolCall: { name: "read" }, args: { path: "x" } }, false],
  ["write to plan.md allowed", { toolCall: { name: "write" }, args: { path: ".pi/inbox/plan.md" } }, false],
  ["write to checkpoint.md allowed", { toolCall: { name: "write" }, args: { path: ".pi/inbox/checkpoint.md" } }, false],
  ["write to index.html BLOCKED", { toolCall: { name: "write" }, args: { path: "index.html" } }, true, "index.html"],
  ["write to src/main.ts BLOCKED", { toolCall: { name: "write" }, args: { path: "src/main.ts" } }, true, "src/main.ts"],
  ["write to style.css BLOCKED", { toolCall: { name: "write" }, args: { path: "style.css" } }, true, "style.css"],
  ["write to .pi/inbox/../index.html BLOCKED (path traversal)", { toolCall: { name: "write" }, args: { path: ".pi/inbox/../index.html" } }, true, "index.html"],
  ["write to /tmp/foo BLOCKED (absolute path outside)", { toolCall: { name: "write" }, args: { path: "/tmp/foo" } }, true, "/tmp/foo"],
  ["write to .pi/inboxery/secret.md BLOCKED (prefix attack)", { toolCall: { name: "write" }, args: { path: ".pi/inboxery/secret.md" } }, true, ".pi/inboxery"],
  ["write to docs/PRD.md BLOCKED (allowlist removed)", { toolCall: { name: "write" }, args: { path: "docs/PRD.md" } }, true, "docs/PRD.md"],
  ["write to docs/RESEARCH.md BLOCKED (allowlist removed)", { toolCall: { name: "write" }, args: { path: "docs/RESEARCH.md" } }, true, "docs/RESEARCH.md"],
  ["write to docs/TASKS.csv BLOCKED (allowlist removed)", { toolCall: { name: "write" }, args: { path: "docs/TASKS.csv" } }, true, "docs/TASKS.csv"],
  ["write with file_path field also handled", { toolCall: { name: "write" }, args: { file_path: "index.html" } }, true, "index.html"],
  ["write with no path - allows (let tool validate)", { toolCall: { name: "write" }, args: {} }, false],
];

let passed = 0;
let failed = 0;
for (const [name, ctx, expectBlock, expectReason] of cases) {
  const result = await guard(ctx);
  const blocked = !!(result && result.block);
  if (blocked !== expectBlock) {
    console.error(`FAIL: ${name}`);
    console.error(`  expected blocked=${expectBlock}, got blocked=${blocked}, result=${JSON.stringify(result)}`);
    failed++;
    continue;
  }
  if (expectBlock && expectReason && !result.reason.includes(expectReason)) {
    console.error(`FAIL: ${name}`);
    console.error(`  expected reason to contain "${expectReason}", got "${result.reason}"`);
    failed++;
    continue;
  }
  console.log(`PASS: ${name}`);
  passed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
