import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTools } from "../src/tool-aggregator.mjs";

test("aggregateTools: single service + auto_unwrap_single_service → raw names", () => {
  const result = aggregateTools(
    { multica: [{ name: "multica_help", description: "x", inputSchema: {} },
                { name: "multica_run",  description: "x", inputSchema: {} }] },
    { auto_unwrap_single_service: true },
  );
  assert.deepEqual(result.map(t => t.name), ["multica_help", "multica_run"]);
});

test("aggregateTools: single service WITHOUT auto_unwrap_single_service → prefixed", () => {
  const result = aggregateTools(
    { multica: [{ name: "multica_help", description: "x", inputSchema: {} }] },
    {},
  );
  assert.deepEqual(result.map(t => t.name), ["multica__multica_help"]);
});

test("aggregateTools: multi service + auto_unwrap_single_service → still prefixed", () => {
  const result = aggregateTools(
    { multica: [{ name: "run", description: "x", inputSchema: {} }],
      ashare: [{ name: "list", description: "x", inputSchema: {} }] },
    { auto_unwrap_single_service: true },
  );
  assert.deepEqual(result.map(t => t.name).sort(), ["ashare__list", "multica__run"]);
});
