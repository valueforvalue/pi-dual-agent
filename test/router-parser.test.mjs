/**
 * Unit tests for the dual-agent slash-skill router parser.
 *
 * The parser is the entry point for the new `/dual <skill>` command
 * surface. It decides:
 *   - whether the args are a router command at all
 *   - which model class (thinker/doer) the skill maps to
 *   - what slash command gets sent to the sub-session
 *
 * These tests run without any model API access. They use Node 24's
 * built-in TypeScript support to import the .ts file directly.
 */

import { strict as assert } from "node:assert";
import { parseDualRouterCommand } from "../lib/router-parser.ts";

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

// === Empty / non-router input ===
test("empty input returns null (fall through to legacy parser)", () => {
  assert.equal(parseDualRouterCommand(""), null);
  assert.equal(parseDualRouterCommand("   "), null);
});

test("legacy command names return null (handled by switch)", () => {
  assert.equal(parseDualRouterCommand("setup"), null);
  assert.equal(parseDualRouterCommand("models"), null);
  assert.equal(parseDualRouterCommand("thinker anthropic/claude-opus-4-5"), null);
  assert.equal(parseDualRouterCommand("doer anthropic/claude-opus-4-5"), null);
  assert.equal(parseDualRouterCommand("status"), null);
  assert.equal(parseDualRouterCommand("trace on"), null);
});

// === Short-name smart routing ===
test("grill short name routes to thinker + /grill-with-docs", () => {
  const r = parseDualRouterCommand("grill my goal");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/grill-with-docs");
  assert.equal(r.args, "my goal");
  assert.equal(r.shortName, "grill");
});

test("me short name routes to thinker + /grill-me", () => {
  const r = parseDualRouterCommand("me my plan");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/grill-me");
  assert.equal(r.args, "my plan");
});

test("prd short name routes to thinker + /to-prd", () => {
  const r = parseDualRouterCommand("prd");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/to-prd");
  assert.equal(r.args, "");
});

test("issues short name routes to thinker + /to-issues", () => {
  const r = parseDualRouterCommand("issues");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/to-issues");
});

test("triage short name routes to thinker + /triage", () => {
  const r = parseDualRouterCommand("triage #42");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/triage");
  assert.equal(r.args, "#42");
});

test("implement short name routes to doer + /implement", () => {
  const r = parseDualRouterCommand("implement #42");
  assert.equal(r.role, "doer");
  assert.equal(r.slash, "/implement");
  assert.equal(r.args, "#42");
});

test("prototype short name routes to doer + /prototype", () => {
  const r = parseDualRouterCommand("prototype the wizard");
  assert.equal(r.role, "doer");
  assert.equal(r.slash, "/prototype");
  assert.equal(r.args, "the wizard");
});

// === Full slash command names ===
test("full slash command name grill-with-docs routes to thinker", () => {
  const r = parseDualRouterCommand("grill-with-docs my goal");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/grill-with-docs");
});

test("full slash command name with leading /", () => {
  const r = parseDualRouterCommand("/grill-with-docs my goal");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/grill-with-docs");
  assert.equal(r.args, "my goal");
});

// === Explicit verb forms (avoid model-setter collision) ===
test("think verb is explicit Thinker", () => {
  const r = parseDualRouterCommand("think interview me about auth");
  assert.equal(r.role, "thinker");
  assert.equal(r.args, "interview me about auth");
});

test("code verb is explicit Doer", () => {
  const r = parseDualRouterCommand("code build the login page");
  assert.equal(r.role, "doer");
  assert.equal(r.args, "build the login page");
});

test("think verb with slash command passthrough", () => {
  const r = parseDualRouterCommand("think /grill-with-docs my goal");
  assert.equal(r.role, "thinker");
  assert.equal(r.slash, "/grill-with-docs");
});

// === Model-setter collision avoidance ===
test("thinker <provider/id> is a model-setter, NOT a router command", () => {
  // The router parser must return null for this so the legacy
  // model-setter handles it.
  assert.equal(parseDualRouterCommand("thinker anthropic/claude-opus-4-5"), null);
});

test("doer <provider/id> is a model-setter, NOT a router command", () => {
  assert.equal(parseDualRouterCommand("doer openai/gpt-4o"), null);
});

// === Unknown skill fails fast (option a) ===
test("unknown short name throws with available list", () => {
  assert.throws(
    () => parseDualRouterCommand("foo bar"),
    /Unknown dual command/,
  );
  assert.throws(
    () => parseDualRouterCommand("foo bar"),
    /grill/,
  );
  assert.throws(
    () => parseDualRouterCommand("foo bar"),
    /implement/,
  );
});

// === Multiline args preserved ===
test("multiline args are preserved verbatim in the args field", () => {
  // The parser only looks at the first token to determine the
  // command, then takes everything after the first space as args.
  // Multiline input is preserved verbatim.
  const r = parseDualRouterCommand("grill line1\nline2\nline3");
  assert.equal(r.role, "thinker");
  assert.equal(r.args, "line1\nline2\nline3");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
