// 用真实导出数据在 Node 里跑一遍本地运行时：读、写、落盘、导入导出、采集器空数据容错。
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { Actions } from "../server/actions";
import { createRuntime } from "../runtime/core";
import { exportAll, importAll, isEmpty } from "../runtime/seed";
import type { DbStorage } from "../runtime/db";

let disk: Uint8Array | null = null;
const storage: DbStorage = {
  load: async () => disk,
  save: async (b) => {
    disk = new Uint8Array(b);
  },
};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
}

const sql = await initSqlJs();
const rt = await createRuntime({ storage, sql, actions: Actions, persistDelayMs: 10 });
check("首次打开库为空", isEmpty(rt.db));
const seed = JSON.parse(readFileSync("seed.json", "utf8"));
const imp = importAll(rt.db, seed);
check("导入种子", imp.rows > 500, `${imp.tables} 表 / ${imp.rows} 行`);

const call = async (n: string, a: unknown = {}) => {
  try {
    return await rt.run(n, a);
  } catch (e) {
    check(`调用 ${n}`, false, String((e as Error).message).slice(0, 300));
    return undefined;
  }
};

const latest = (await call("getLatestDataDate", { upTo: "2026-10-27" })) as { date: string | null } | undefined;
check("getLatestDataDate", latest?.date === "2026-10-26", JSON.stringify(latest));
const date = latest?.date ?? "2026-10-26";

const ov = (await call("getOverview", { date })) as Record<string, unknown> | undefined;
check("getOverview", !!ov && "settings" in ov && "day" in ov, ov ? Object.keys(ov).join(",").slice(0, 120) : "");
for (const [n, a] of [
  ["listMarketDays", {}],
  ["listCandidates", { date }],
  ["listTrades", {}],
  ["getStats", {}],
  ["listLadderEntries", { date }],
  ["getSpatialLineage", {}],
  ["getBacktestSummary", { track: "auction" }],
  ["getBacktestSummary", { track: "leader" }],
  ["getLeaderPicks", { date }],
  ["listAbnormalWatches", { date }],
  ["listreconciliations", { limit: 10 }],
  ["getreconciliation", { date }],
  ["getSettings", {}],
  ["getConfirmState", { date }],
  ["getBreadth", { date }],
  ["getFundflow", { date }],
] as [string, unknown][]) {
  const r = await call(n, a);
  check(`读 ${n}`, r !== undefined);
}

// 采集器未运行：全部应当"无数据"而不是报错
const snap = (await call("getIntradaySnapshot", { date })) as { available?: boolean; error?: string } | undefined;
check("getIntradaySnapshot 无采集器数据", snap?.available === false, JSON.stringify({ a: snap?.available, e: snap?.error }));
const ev = await call("listintradayevents", {});
check("listintradayevents", ev !== undefined);
const sy = await call("syncintradayevents", {});
check("syncintradayevents 无数据不报错", sy !== undefined, JSON.stringify(sy).slice(0, 150));
const sb = await call("syncBreadthFundflow", {});
check("syncBreadthFundflow 无数据不报错", sb !== undefined, JSON.stringify(sb).slice(0, 150));
const sbt = await call("syncBacktestRows", { track: "auction", rows: [] });
check("syncBacktestRows(空)", sbt !== undefined, JSON.stringify(sbt ?? null).slice(0, 150));

// 写入 → 读回 → 删除
const settings = (await call("getSettings", {})) as Record<string, unknown> | undefined;
if (settings) {
  const saved = await call("saveSettings", settings);
  check("saveSettings 回写", saved !== undefined);
}
const trades0 = ((await call("listTrades", {})) as { trades: unknown[] } | undefined)?.trades?.length ?? -1;
check("初始无交易", trades0 === 0, String(trades0));

// 落盘：等防抖后，从"磁盘"重新打开，数据应一致
await rt.db.persistNow();
const rt2 = await createRuntime({ storage, sql, actions: Actions });
check("从落盘文件重开，非空", !isEmpty(rt2.db));
const ov2 = (await rt2.run("getOverview", { date })) as Record<string, unknown>;
check("重开后 getOverview 一致", JSON.stringify(ov2) === JSON.stringify(ov));

// 导出 → 导入 往返
const dump = exportAll(rt2.db);
const rt3 = await createRuntime({ storage: { load: async () => null, save: async () => {} }, sql, actions: Actions });
const imp2 = importAll(rt3.db, dump);
const dumpRows = Object.values(dump).reduce((n, r) => n + r.length, 0);
check("导出再导入往返（行数一致）", imp2.rows === dumpRows, `${imp2.rows} vs ${dumpRows}`);
const ov3 = (await rt3.run("getOverview", { date })) as Record<string, unknown>;
check("往返后 getOverview 一致", JSON.stringify(ov3) === JSON.stringify(ov));
let bad = false;
try {
  importAll(rt3.db, [1, 2, 3]);
} catch {
  bad = true;
}
check("坏备份被拒绝", bad);
check("坏备份不破坏现有数据", ((await rt3.run("getOverview", { date })) as Record<string, unknown>) != null && JSON.stringify(await rt3.run("getOverview", { date })) === JSON.stringify(ov));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
