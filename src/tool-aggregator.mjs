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
 * Build the aggregated tool list from per-service catalogs.
 * @param {Record<string, ServiceTool[]>} catalogs — service name → tools
 * @param {{ separator?: string, prefix?: string, collision_policy?: 'prefix_upstream'|'suffix_upstream'|'error' }} [opts]
 * @returns {AggregatedTool[]}
 */
export function aggregateTools(catalogs, opts = {}) {
  const separator = opts.separator ?? "__";
  const boxPrefix = opts.prefix ?? "";
  const policy = opts.collision_policy ?? "prefix_upstream";

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
      const qualified = (policy === "suffix_upstream")
        ? `${boxPrefix}${t.name}${separator}${serviceName}`
        : `${boxPrefix}${serviceName}${separator}${t.name}`;

      // collision_policy=error: refuse to start if this qualified name was
      // already produced by a different (or same) upstream.
      if (policy === "error" && byName.has(qualified)) {
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