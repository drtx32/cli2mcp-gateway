import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverTools,
  parseSubcommandNames,
  toolNameForPath,
} from "../src/help-parser.js";

test("parseSubcommandNames handles cobra-style command sections", () => {
  const helpText = `
Usage: ashare [OPTIONS] COMMAND [ARGS]...

Available Commands:
  jygs   聚合入口
  cls    同花顺入口

Flags:
  -h, --help  Show this message and exit.
`;

  assert.deepEqual(parseSubcommandNames(helpText), ["jygs", "cls"]);
});

test("discoverTools recurses to leaf commands and preserves single-layer names", async () => {
  const helpByPath = new Map([
    [JSON.stringify([]), `
Usage: ashare [OPTIONS] COMMAND [ARGS]...

Available Commands:
  jygs   聚合入口
  cls    同花顺入口
`],
    [JSON.stringify(["jygs"]), `
Usage: ashare jygs [OPTIONS] COMMAND [ARGS]...

Available Commands:
  industrial-chains  产业链
  reports            研报
`],
    [JSON.stringify(["jygs", "industrial-chains"]), `
Usage: ashare jygs industrial-chains [OPTIONS] SYMBOL

Options:
  -n, --name TEXT   Filter by name
  -q, --quiet       Quiet mode
`],
    [JSON.stringify(["jygs", "reports"]), `
Usage: ashare jygs reports [OPTIONS] SYMBOL

Options:
  -n, --name TEXT   Filter by name
`],
    [JSON.stringify(["cls"]), `
Usage: ashare cls [OPTIONS] CODE

Options:
  -d, --detail TEXT  Detail level
`],
  ]);

  const tools = await discoverTools(
    "ashare",
    null,
    {
      captureHelpFn: async (_cmd, commandPath) => {
        const key = JSON.stringify(commandPath);
        return helpByPath.get(key) || "";
      },
    },
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["ashare_help", "ashare_jygs__industrial-chains", "ashare_jygs__reports", "ashare_cls"],
  );

  const nested = tools.find((tool) => tool.name === "ashare_jygs__industrial-chains");
  assert.deepEqual(nested.dispatch.commandPath, ["jygs", "industrial-chains"]);
  assert.match(nested.description, /commandPath=\["jygs", "industrial-chains"\]/);
  assert.equal(nested.inputSchema.properties.positional.type, "array");
  assert.equal(nested.inputSchema.properties.name.type, "string");
  assert.equal(nested.inputSchema.properties.quiet.type, "boolean");

  const flat = tools.find((tool) => tool.name === "ashare_cls");
  assert.deepEqual(flat.dispatch.commandPath, ["cls"]);
  assert.equal(flat.inputSchema.properties.detail.type, "string");
});

test("toolNameForPath keeps the old single-level naming scheme", () => {
  assert.equal(toolNameForPath("ashare", ["jygs"]), "ashare_jygs");
  assert.equal(toolNameForPath("ashare", ["jygs", "industrial-chains"]), "ashare_jygs__industrial-chains");
  assert.equal(toolNameForPath("ashare", []), "ashare");
});
