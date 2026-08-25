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

test("parseSubcommandNames handles Typer/Rich boxed command panels", () => {
  // Real-world ashare jygs --help style: a `╭─ Commands ─...─╮` box with
  // `│ name   description` rows. Borders and any title row inside the box
  // must be ignored.
  const helpText = `
 Usage: ashare jygs [OPTIONS] COMMAND [ARGS]...

 A 股多平台数据统一 CLI
                                                                                
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ limit-up-diagram-url   生成指定日期的韭研公社涨停复盘图地址。                │
│ yi-zi-limit-up         获取指定日期的一字涨停股票列表。                      │
│ industrial-chains      获取韭研公社产业链文章列表。                          │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

  assert.deepEqual(
    parseSubcommandNames(helpText),
    ["limit-up-diagram-url", "yi-zi-limit-up", "industrial-chains"],
  );
});

test("discoverTools recurses through Typer/Rich command panels", async () => {
  const helpByPath = new Map([
    [JSON.stringify([]), `
                                                                                
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ jygs        韭研公社接口                                                       │
│ cls         财联社                                                             │
╰──────────────────────────────────────────────────────────────────────────────╯
`],
    [JSON.stringify(["jygs"]), `
                                                                                
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ industrial-chains      获取韭研公社产业链文章列表。                          │
│ investment-timeline    获取韭研公社投资时间线。                              │
╰──────────────────────────────────────────────────────────────────────────────╯
`],
    [JSON.stringify(["jygs", "industrial-chains"]), `
 Usage: ashare jygs industrial-chains [OPTIONS]

Options:
  -n, --name TEXT   Filter by name
`],
    [JSON.stringify(["jygs", "investment-timeline"]), `
 Usage: ashare jygs investment-timeline [OPTIONS]
`],
    [JSON.stringify(["cls"]), `
 Usage: ashare cls [OPTIONS]
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
    [
      "ashare_help",
      "ashare_jygs__industrial-chains",
      "ashare_jygs__investment-timeline",
      "ashare_cls",
    ],
  );
});

test("parseSubcommandNames ignores Options/Args panel rows even when they look command-shaped", () => {
  // `╭─ Options ─...╮` rows can leak tokens that look like subcommand
  // names (e.g. `--format <df|records|json|yaml>` puts the literal `json`
  // on a wrapped description row). Strict panel-title matching prevents
  // those rows from being misclassified.
  const helpText = `
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ ticker   获取单只股票的 BaoStock 历史 K 线数据。                              │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

  assert.deepEqual(parseSubcommandNames(helpText), ["ticker"]);
});

test("parseSubcommandNames does not treat wrapped description rows as new subcommands", () => {
  // Typer wraps long descriptions onto subsequent rows. Those rows
  // frequently start with tokens like `Args:`, `DataFrame`, or stray
  // identifiers from a subcommand's parameter list. The reliable
  // discriminator is the column position: real subcommand rows have the
  // name exactly one space after `│`, continuation rows start many
  // spaces after `│`.
  const helpText = `
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ plate-limit-up-stocks      获取指定板块涨停股票数据                          │
│                            Args:                                             │
│                                plate_code (str): 板块代码                    │
│                                date (Optional):                              │
│                            日期，格式为YYYY-MM-DD，默认今日                  │
│ plate-list                 获取板块列表                                      │
│ tradingview → wrapped 行  DataFrame。                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

  assert.deepEqual(parseSubcommandNames(helpText), [
    "plate-limit-up-stocks",
    "plate-list",
    "tradingview",
  ]);
});
