// Unit coverage for the upstream tool-metadata passthrough (ELI-467).
//
// The gateway used to rebuild every advertised tool as exactly
// {name, description, inputSchema}, silently dropping `title`, `annotations`,
// `outputSchema` and `_meta`. These pin the fix without any I/O.

import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTools, buildDispatchTable, pickUpstreamToolMeta, UPSTREAM_TOOL_META_FIELDS,
} from "../src/tool-aggregator.mjs";

test("pickUpstreamToolMeta: copies only present, forwardable fields", () => {
  assert.deepEqual(pickUpstreamToolMeta({ name: "x", description: "d", inputSchema: {} }), {});
  assert.deepEqual(
    pickUpstreamToolMeta({ title: "T", annotations: { readOnlyHint: true }, _meta: { a: 1 } }),
    { title: "T", annotations: { readOnlyHint: true }, _meta: { a: 1 } },
  );
  // A field explicitly set to null/undefined is "absent", not forwarded.
  assert.deepEqual(pickUpstreamToolMeta({ title: undefined }), {});
});

test("pickUpstreamToolMeta: never leaks name, inputSchema, description or dispatch", () => {
  const picked = pickUpstreamToolMeta({
    name: "real_name", description: "real description", inputSchema: { type: "object" },
    dispatch: { kind: "run" }, title: "T",
  });
  assert.deepEqual(Object.keys(picked), ["title"]);
  for (const forbidden of ["name", "description", "inputSchema", "dispatch"]) {
    assert.ok(!UPSTREAM_TOOL_META_FIELDS.includes(forbidden));
    assert.ok(!(forbidden in picked));
  }
});

test("pickUpstreamToolMeta: tolerates a null/undefined tool", () => {
  assert.deepEqual(pickUpstreamToolMeta(null), {});
  assert.deepEqual(pickUpstreamToolMeta(undefined), {});
});

test("aggregateTools: forwards upstream metadata through the namespace rename", () => {
  const [tool] = aggregateTools({
    alpha: [{
      name: "probe",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      title: "Probe",
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      _meta: { vendor: "acme" },
    }],
  });
  assert.equal(tool.name, "alpha__probe");
  assert.equal(tool.title, "Probe");
  assert.deepEqual(tool.annotations, { readOnlyHint: true });
  assert.deepEqual(tool.outputSchema, { type: "object", properties: { ok: { type: "boolean" } } });
  assert.deepEqual(tool._meta, { vendor: "acme" });
  // Dispatch bookkeeping is unaffected.
  assert.deepEqual(buildDispatchTable([tool]).get("alpha__probe"),
    { serviceName: "alpha", originalName: "probe" });
});

test("aggregateTools: metadata cannot clobber the qualified name or the schema", () => {
  // Even a hostile/odd upstream cannot re-point the tool by smuggling a
  // `name` or `inputSchema` through a forwarded field — neither is copyable,
  // and the forwarded keys are assigned before the gateway-owned ones.
  const [tool] = aggregateTools({
    alpha: [{
      name: "probe",
      description: "d",
      inputSchema: { type: "object", properties: { real: { type: "string" } } },
      _meta: { name: "spoofed", inputSchema: { type: "object", properties: {} } },
    }],
  });
  assert.equal(tool.name, "alpha__probe");
  assert.deepEqual(tool.inputSchema.properties, { real: { type: "string" } });
  // _meta is forwarded verbatim but stays inert data, not a rename hook.
  assert.deepEqual(tool._meta, { name: "spoofed", inputSchema: { type: "object", properties: {} } });
});

test("aggregateTools: tools with no metadata gain no placeholder keys", () => {
  const [tool] = aggregateTools({
    alpha: [{ name: "plain", description: "d", inputSchema: { type: "object" } }],
  });
  assert.deepEqual(Object.keys(tool).sort(),
    ["description", "dispatch", "inputSchema", "name", "originalName", "serviceName"]);
});

test("aggregateTools: auto_unwrap_single_service keeps metadata on the raw name", () => {
  const [tool] = aggregateTools({
    only: [{ name: "plain", description: "d", inputSchema: { type: "object" }, title: "Plain" }],
  }, { auto_unwrap_single_service: true });
  assert.equal(tool.name, "plain");
  assert.equal(tool.title, "Plain");
});