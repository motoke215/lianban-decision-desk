// @vitest-environment node
// 小黑板（通达信盘后包）、大钱流向、后台调度器的测试。
import iconv from "iconv-lite";
import initSqlJs from "sql.js";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Actions } from "../server/actions";
import { computeBreadth, parseBreadthPackage } from "../collector/breadth";
import type { HttpGet } from "../collector/core";
import { CollectorRunner } from "../collector/runner";
import { createRuntime } from "../runtime/core";
import { ExtraActions } from "../runtime/extra-actions";
import { KV } from "../runtime/kv";

// ---------- 合成一个通达信盘后包 ----------
function buildPackage(ymd: string, n: number) {
  const cod = new Uint8Array(n * 150);
  const md1 = new Uint8Array(n * 512);
  const cv = new DataView(cod.buffer);
  const mv = new DataView(md1.buffer);
  for (let i = 0; i < n; i++) {
    const code = String(600000 + i);
    for (let k = 0; k < 6; k++) cod[i * 150 + k] = code.charCodeAt(k);
    cv.setUint16(i * 150 + 32, i, true);
    cod.set(iconv.encode(`股票${i}`, "gbk"), i * 150 + 40);
    const b = i * 512;
    const prev = 10;
    const close = i % 3 === 0 ? 10.5 : i % 3 === 1 ? 9.5 : 10; // 涨/跌/平
    mv.setFloat64(b + 4, prev, true);
    mv.setFloat64(b + 12 + 24, close, true);
    mv.setBigUint64(b + 56, BigInt(i % 3 === 0 ? 2000 : 1000), true);
    mv.setFloat64(b + 72, i % 3 === 0 ? 3e7 : 1e7, true);
  }
  return zipSync({ [`sh${ymd.slice(2)}.cod`]: cod, [`sh${ymd.slice(2)}.md1`]: md1 });
}

describe("小黑板：通达信盘后包", () => {
  it("解析并算出红盘率与 TRIN", () => {
    const rows = parseBreadthPackage(buildPackage("20261026", 1200), "20261026");
    expect(rows.length).toBe(1200);
    expect(rows[0]!.name).toBe("股票0");
    const r = computeBreadth(rows, "2026-10-26");
    expect(r.up).toBe(400);
    expect(r.down).toBe(400);
    expect(r.flat).toBe(400);
    expect(r.red).toBe(33.3);
    // TRIN(额) = (400/400) / (400×3e7 ÷ 400×1e7) = 1/3
    expect(r.trin_amt).toBe(0.333);
    // TRIN(量) = 1 / (2000/1000) = 0.5
    expect(r.trin_vol).toBe(0.5);
  });
});

// ---------- 假服务器 + 假时钟 ----------
const emPool = (c: string, n: string, extra: object = {}) => ({ c, m: c.startsWith("6") ? 1 : 0, n, p: 10000, zdp: 10, amount: 1e8, hs: 5, hybk: "测试", zttj: { days: 2, ct: 2 }, ...extra });

function makeWorld(startIso: string) {
  let clock = Date.parse(startIso);
  const calls: string[] = [];
  let tdxReady = false;
  let flowFailOnce = true;
  const http: HttpGet = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === "push2ex.eastmoney.com") {
      const ep = u.pathname.slice(1);
      const pools: Record<string, object[]> = {
        getTopicZTPool: [emPool("600001", "测试甲", { lbc: 3, fbt: 93000, fund: 5e7, zbc: 0 })],
        getTopicZBPool: [emPool("000001", "测试丁", { lbc: 1, ztp: 11000, zf: 8, zs: 1 })],
        getTopicDTPool: [],
        getYesterdayZTPool: [emPool("600001", "测试甲", { ylbc: 2, yfbt: 92500, zf: 5, zs: 1 })],
      };
      const list = pools[ep] ?? [];
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: { tc: list.length, pool: list } })) };
    }
    if (u.host === "hq.sinajs.cn") {
      const f = ["测试甲", "10", "10", "11", "11", "10", "11", "0", "1000000", "5e7", "800000", "11", "0", "0", "0", "0", "0", "0", "0", "0", "0", "11.01", "0", "0", "0", "0", "0", "0", "0", "0", "2026-10-26", "15:00:00", "00"];
      return { status: 200, bytes: new Uint8Array(iconv.encode(`var hq_str_sh600001="${f.join(",")}";\nvar hq_str_sz000001="";\n`, "gbk")) };
    }
    if (u.host === "data.10jqka.com.cn") return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: { info: [{ code: "600001", name: "测试甲", reason_type: "机器人", first_limit_up_time: "1792000000" }] } })) };
    if (u.host === "www.szse.cn") {
      const [y, m] = (u.searchParams.get("month") ?? "2026-10").split("-").map(Number) as [number, number];
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const days = [];
      for (let d = 1; d <= last; d++) {
        const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        days.push({ jyrq: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, jybz: wd !== 0 && wd !== 6 ? "1" : "0" });
      }
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: days })) };
    }
    if (u.host === "push2.eastmoney.com") {
      const kind = u.searchParams.get("fs") === "m:90+t:2" ? "industry" : "concept";
      const pn = Number(u.searchParams.get("pn"));
      if (kind === "industry" && pn === 2 && flowFailOnce) {
        flowFailOnce = false; // 第一次 502，重试应成功
        return { status: 502, bytes: new Uint8Array() };
      }
      const total = kind === "industry" ? 150 : 120;
      const from = (pn - 1) * 100;
      const diff = [];
      for (let i = from; i < Math.min(total, from + 100); i++) {
        diff.push({ f12: `${kind[0]}${i}`, f14: `${kind === "industry" ? "行业" : "概念"}${i}`, f3: 1.5, f62: (total - i) * 1e6 - 3e7, f204: "龙头" });
      }
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: { total, diff } })) };
    }
    if (u.host === "www.tdx.com.cn") {
      if (!tdxReady) return { status: 404, bytes: new Uint8Array() };
      const ymd = u.pathname.split("/").pop()!.replace(".zip", "");
      return { status: 200, bytes: buildPackage(ymd, 1200) };
    }
    return { status: 404, bytes: new Uint8Array() };
  };
  return { http, calls, now: () => clock, sleep: async (ms: number) => { clock += ms; }, set: (iso: string) => { clock = Date.parse(iso); }, tdx: (v: boolean) => { tdxReady = v; } };
}

async function makeRunner(w: ReturnType<typeof makeWorld>) {
  const sql = await initSqlJs();
  const rt = await createRuntime({ storage: { load: async () => null, save: async () => {} }, sql, actions: { ...Actions, ...ExtraActions }, persistDelayMs: 99999 });
  const runner = new CollectorRunner(rt, w.http, { now: w.now, sleep: w.sleep });
  return { rt, runner };
}

describe("后台调度器", () => {
  it("交易时段：池子/行情/题材按节奏跑，休市日不跑", async () => {
    const w = makeWorld("2026-10-26T09:30:00+08:00"); // 周一
    const { rt, runner } = await makeRunner(w);
    await runner.tick();
    expect(w.calls.some((u) => u.includes("getTopicZTPool"))).toBe(true);
    expect(w.calls.some((u) => u.includes("hq.sinajs.cn"))).toBe(true);
    expect(w.calls.some((u) => u.includes("10jqka"))).toBe(true);
    expect(rt.kv.get(KV.pools("20261026"))).toBeTruthy();
    const st = runner.status();
    expect(st.active).toBe(true);
    expect(st.watchlistSize).toBe(2);
    // 1 秒后：行情不到 5 秒间隔，不重复请求（假 sleep 会推进时钟，故以当前时刻为基准）
    const n = w.calls.length;
    const t0 = w.now();
    w.set(new Date(t0 + 1000).toISOString());
    await runner.tick();
    expect(w.calls.length).toBe(n);
    // 6 秒后：只更新行情（池子 60 秒才一轮）
    w.set(new Date(t0 + 6000).toISOString());
    await runner.tick();
    expect(w.calls.slice(n).every((u) => u.includes("hq.sinajs.cn"))).toBe(true);
    expect(w.calls.length).toBeGreaterThan(n);
  });

  it("收盘后：补收盘快照、抓大钱流向（含 502 重试）、盘后包发布后补小黑板", async () => {
    const w = makeWorld("2026-10-26T15:30:00+08:00");
    const { rt, runner } = await makeRunner(w);
    // 先放一份旧快照，表示不是全新安装
    rt.kv.set(KV.pools("20261023"), JSON.stringify({ date: "20261023", fetched_at: "2026-10-23T15:06:00+08:00", pools: {} }));
    await runner.tick();
    const post: any = JSON.parse(rt.kv.get(KV.pools("20261026"))!);
    expect(post.fetched_at.slice(11, 16) >= "15:05").toBe(true);
    // 大钱流向：行业 150 + 概念 120，第二页第一次 502 后重试成功
    const ff: any = JSON.parse(rt.kv.get(KV.fundflow("2026-10-26"))!);
    expect(ff.industry.rows.length).toBe(150);
    expect(ff.industry.complete).toBe(true);
    expect(ff.concept.rows.length).toBe(120);
    expect(ff.industry.rows[0].main_net).toBeGreaterThan(ff.industry.rows[1].main_net); // 按主力净额降序
    expect(JSON.parse(rt.kv.get(KV.fundflowSummary)!)).toEqual({ days_available: 1, latest_date: "2026-10-26" });
    // 盘后包 17:00 前不试（也还没发布）
    expect(rt.kv.get(KV.breadthSeries)).toBeNull();

    // 17:40：盘后包已发布 → 补上最近 7 天里缺的交易日
    w.tdx(true);
    w.set("2026-10-26T17:40:00+08:00");
    await runner.tick();
    const series: any = JSON.parse(rt.kv.get(KV.breadthSeries)!);
    const dates = series.records.map((r: any) => r.date);
    expect(dates).toContain("2026-10-26");
    expect(dates).toContain("2026-10-23"); // 回补
    expect(series.records[0].red).toBe(33.3);
    // 决策台里已有当日阶段定调 → 抄进小黑板，不自创
    expect(typeof series.records[0].stage).toBe("string");

    // 经本地处理器同步进决策台库
    const sync: any = await rt.run("syncBreadthFundflow", {});
    expect(sync.error ?? "").toBe("");
    const bf: any = await rt.run("getFundflow", { date: "2026-10-26" });
    expect(JSON.stringify(bf)).toContain("行业0");
  });

  it("休市日：不采集；全新安装则抓一轮最近交易日垫底", async () => {
    const w = makeWorld("2026-10-25T10:00:00+08:00"); // 周日
    const { rt, runner } = await makeRunner(w);
    await runner.tick();
    expect(runner.status().active).toBe(false);
    expect(runner.status().tradingDay).toBe(false);
    // 全新安装：为了界面不空，抓一轮并回退到最近交易日
    expect(rt.kv.keys("collector/pools-").length).toBe(1);
    // 之后不再重复抓
    const n = w.calls.length;
    w.set("2026-10-25T10:00:20+08:00");
    await runner.tick();
    expect(w.calls.filter((u) => u.includes("push2ex")).length).toBe(w.calls.slice(0, n).filter((u) => u.includes("push2ex")).length);
  });
});
