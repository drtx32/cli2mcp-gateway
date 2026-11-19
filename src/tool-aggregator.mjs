// tool-aggregator.mjs — merge multiple service tool catalogs into one flat list.
//
// Each service contributes a set of tools (e.g. ashare contributes 22 cli
// tools, multica contributes 2 synthetic tools). We unify them under a single
// tool list, applying collision_policy:
//
//   prefix_upstream (default):  every tool name is `${upstreamName}${sep}${toolName}`
//                               e.g. `ashare__list-platforms`
//   suffix_upstream:            `${toolName}${sep}${upstreamName}` (rare)
//   error:                       refuse to start if a name would clash
//
// After the upstream list is built, we keep an internal reverse map from the
// qualified name back to (upstreamName, originalName) so that CallTool
// requests can be dispatched to the correct adapter without re-doing the
// namespace lookup on every call.

/**
 * @typedef {Object} ServiceTool
 * @property {string} name           — original name from the adapter
 * @property {string} description
 * @property {object} inputSchema
 * @property {object} [dispatch]    — adapter-specific dispatch hint (carried through)
 * @property {string} [title]       — forwarded verbatim when the adapter set it
 * @property {object} [annotations] — forwarded verbatim when the adapter set it
 * @property {object} [_meta]       — forwarded verbatim when the adapter set it
 * @property {string} serviceName    — owning service
 */

/**
 * @typedef {Object} AggregatedTool
 * @property {string} name           — fully-qualified (after namespace)
 * @property {string} description
 * @property {object} inputSchema
 * @property {string} serviceName
 * @property {string} originalName
 * @property {object} [dispatch]     — passed through from the source tool
 */

/**
 * MCP `Tool` fields the gateway forwards from an upstream catalog to the
 * downstream `tools/list` verbatim.
 *
 * Everything listed here is inert description or hint data: it changes how a
 * tool is *presented*, never how it must be *invoked*. That line is the whole
 * rule, because the gateway is not a transparent proxy for every MCP feature —
 * it advertises `capabilities: { tools: {} }`, forwards only `{name, arguments}`
 * on `tools/call`, and registers no handlers beyond the tool surface. So a field
 * that participates in capability negotiation must stay off this list until the
 * gateway actually implements the feature end to end.
 *
 * `execution` is deliberately absent. It carries `taskSupport`
 * ("required" | "optional" | "forbidden"), which is a contract about *how* a
 * client must invoke the tool. Forwarding it makes the gateway advertise task
 * support it does not have: it never forwards `params.task` and proxies no
 * task lifecycle (`tasks/result`, `tasks/get`, `tasks/cancel`). The failure is
 * not cosmetic — the official SDK client caches `taskSupport === "required"`
 * from `tools/list` and then `callTool()` refuses locally without sending a
 * request, so the tool becomes permanently unreachable through this gateway.
 * Strip the declaration and the same client call works.
 *
 * Also not forwardable:
 *   - `name` — downstream sees the *qualified* name, never the upstream's.
 *   - `inputSchema` — kept as its own first-class field.
 *   - `dispatch` — gateway-internal routing state that must never be published.
 *
 * These are all spec-defined MCP `Tool` members, so copying them is lossless
 * for any conformant upstream and a no-op for adapters that declare none (e.g.
 * the help-derived `cli` catalog). The allowlist shape also means a future SDK
 * field is simply not forwarded until someone adds it deliberately.
 */
export const UPSTREAM_TOOL_META_FIELDS = [
  "title", "outputSchema", "annotations", "icons", "_meta",
];

/**
 * Copy the forwardable metadata off an upstream MCP tool.
 * @param {object} tool
 * @returns {object} only the keys that are actually present
 */
export function pickUpstreamToolMeta(tool) {
  const out = {};
  for (const field of UPSTREAM_TOOL_META_FIELDS) {
    if (tool?.[field] !== undefined) out[field] = tool[field];
  }
  return out;
}

/**
 * Build the aggregated tool list from per-service catalogs.
 * @param {Record<string, ServiceTool[]>} catalogs — service name → tools
 * @param {{ separator?: string, prefix?: string, collision_policy?: 'prefix_upstream'|'suffix_upstream'|'error' }} [opts]
 * @returns {AggregatedTool[]}
 */
export function aggregateTools(catalogs, opts = {}) {
  const separator = opts.separator ?? "__";
  const boxPrefix = opts.prefix ?? "";
  const policy = opts.collision_policy ?? "prefix_upstream";
  // Opt-in: when a box has exactly one service, skip the per-service
  // prefix. This keeps single-service deployments (e.g. a standalone
  // multica MCP exposed on its own port) from renaming `multica_run` into
  // `multica__multica_run` and breaking clients that were wired against the
  // legacy raw-name shape. Multi-service boxes still prefix by default —
  // collision policy handles any genuine name clash. Set `auto_unwrap_single_service:
  // false` to force prefix even for single-service boxes.
  const unwrapSingle = opts.auto_unwrap_single_service === true
    && Object.keys(catalogs).length === 1;
  // When unwrapping, just pass the raw name through — no separator, no
  // service prefix. Otherwise behave as before.
  const effectiveBoxPrefix = unwrapSingle ? "" : boxPrefix;
  const effectivePolicy = unwrapSingle ? "error" : policy;

  /** @type {AggregatedTool[]} */
  const out = [];
  /** @type {Map<string, AggregatedTool>} */
  const byName = new Map();

  for (const [serviceName, tools] of Object.entries(catalogs)) {
    for (const t of tools) {
      // Compute the qualified name. With prefix_upstream (default), the name
      // is unique per (serviceName, originalName) by construction; with
      // suffix_upstream it is too; with `separator: ""` and matching original
      // names, two services collide — error policy must catch that.
      const qualified = unwrapSingle
        ? t.name
        : (effectivePolicy === "suffix_upstream")
          ? `${effectiveBoxPrefix}${t.name}${separator}${serviceName}`
          : `${effectiveBoxPrefix}${serviceName}${separator}${t.name}`;

      // collision_policy=error: refuse to start if this qualified name was
      // already produced by a different (or same) upstream.
      if (effectivePolicy === "error" && byName.has(qualified)) {
        throw new Error(
          `tool-aggregator: namespace collision on "${qualified}" ` +
          `between service "${byName.get(qualified).serviceName}" ` +
          `and "${serviceName}". Pick a different separator or collision_policy.`);
      }

      // For non-error policies, if a name has already been emitted (only
      // possible with separator="" and matching tool names), keep the FIRST
      // and skip the duplicate — this is a safe default for prefix/suffix
      // policies that happen to produce equal qualified names.
      let agg;
      if (byName.has(qualified)) {
        continue;
      }

      /** @type {AggregatedTool} */
      agg = {
        name: qualified,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        // Carry the upstream's own metadata (title / annotations / outputSchema
        // / icons / execution / _meta) through the rename. It cannot clobber
        // `name` or `inputSchema` — neither key is forwardable.
        ...pickUpstreamToolMeta(t),
        serviceName,
        originalName: t.name,
        dispatch: t.dispatch,
      };
      out.push(agg);
      byName.set(qualified, agg);
    }
  }

  // Stable ordering: by service name, then by original tool name.
  out.sort((a, b) => {
    if (a.serviceName !== b.serviceName) return a.serviceName.localeCompare(b.serviceName);
    return a.originalName.localeCompare(b.originalName);
  });

  return out;
}

/**
 * Build a dispatch table: qualified tool name → (serviceName, originalName).
 */
export function buildDispatchTable(aggTools) {
  /** @type {Map<string, { serviceName: string, originalName: string }>} */
  const dispatch = new Map();
  for (const t of aggTools) {
    dispatch.set(t.name, { serviceName: t.serviceName, originalName: t.originalName });
  }
  return dispatch;
}

/**
 * Resolve a downstream tool call back to its (serviceName, originalName).
 * Returns null if the qualified name is not in the dispatch table.
 */
export function resolveToolCall(dispatch, qualifiedName) {
  return dispatch.get(qualifiedName) ?? null;
}