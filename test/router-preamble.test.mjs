/**
 * Unit tests for the router preamble builder.
 *
 * The preamble is the single source of truth for what a sub-session
 * sees at the top of its prompt. These tests pin the structure so
 * accidental edits to wording don't break the user experience.
 */

import { strict as assert } from "node:assert";
import { buildRouterPreamble } from "../lib/prompts.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${e.message}`);
    failed++;
  }
}

test("preamble includes all required sections for thinker", () => {
  const p = buildRouterPreamble("thinker", "anthropic/claude-opus-4-5", "/grill-with-docs", "interview me about auth");
  assert.match(p, /\[Router context\]/);
  assert.match(p, /dual-agent sub-session/);
  assert.match(p, /Model class: thinker/);
  assert.match(p, /Model: anthropic\/claude-opus-4-5/);
  assert.match(p, /Cost is being tracked against the thinker bucket/);
  assert.match(p, /The user invoked: \/grill-with-docs/);
  assert.match(p, /interview me about auth/);
});

test("preamble includes all required sections for doer", () => {
  const p = buildRouterPreamble("doer", "openai/gpt-4o", "/implement", "build the login page");
  assert.match(p, /Model class: doer/);
  assert.match(p, /Model: openai\/gpt-4o/);
  assert.match(p, /Cost is being tracked against the doer bucket/);
  assert.match(p, /The user invoked: \/implement/);
  assert.match(p, /build the login page/);
});

test("preamble with empty args shows the (no args) placeholder", () => {
  const p = buildRouterPreamble("thinker", "anthropic/claude-opus-4-5", "/grill-with-docs", "");
  assert.match(p, /\(no args\)/);
});

test("preamble preserves multiline args verbatim", () => {
  const args = "line1\nline2\nline3";
  const p = buildRouterPreamble("thinker", "anthropic/claude-opus-4-5", "/grill-with-docs", args);
  assert.ok(p.includes("line1\nline2\nline3"));
});

test("preamble section order is stable: context, model, cost, slash, args", () => {
  // Pinning the order makes it easy to spot regressions if someone
  // reorders the array in buildRouterPreamble.
  const p = buildRouterPreamble("thinker", "m", "/s", "args");
  const ctxIdx = p.indexOf("[Router context]");
  const modelIdx = p.indexOf("Model class:");
  const costIdx = p.indexOf("Cost is being tracked");
  const slashIdx = p.indexOf("The user invoked:");
  const argsIdx = p.indexOf("args");
  assert.ok(ctxIdx < modelIdx, "context before model");
  assert.ok(modelIdx < costIdx, "model before cost");
  assert.ok(costIdx < slashIdx, "cost before slash");
  assert.ok(slashIdx < argsIdx, "slash before args");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
