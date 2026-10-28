// @vitest-environment node
// 采集器移植测试：先跑原 collector.py --selftest 的全部断言，再用假的行情/东财服务器
// 走一遍完整流程：池子 → 监控列表 → 行情轮 → 封板/炸板/回封事件 → 同步进决策台数据库。
import iconv from "iconv-lite";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { Actions } from "../server/actions";
import { Collector, type HttpGet } from "../collector/core";
import { normalizePoolItem, parseSinaText } from "../collector/parse";
import { exclusionCategory, limitPrices, sinaSymbol, isActiveWindow, isoSh } from "../collector/rules";
import { createRuntime } from "../runtime/core";
import { ExtraActions } from "../runtime/extra-actions";
import { createKv } from "../runtime/kv";
import { KV } from "../runtime/kv";

const SINA_SAMPLE =
  'var hq_str_sz002724="海洋王,11.000,11.210,12.330,12.330,10.500,' +
  "12.330,0.000,12345678,145678901.000,100000,12.330,80000,12.320," +
  "60000,12.310,40000,12.300,20000,12.290,0,0.000,0,0.000,0,0.000," +
  '0,0.000,0,0.000,2026-10-23,15:00:00,00";';

describe("原 collector.py --selftest 全部断言", () => {
  it("新浪行情解析与封板判定", () => {
    const q = parseSinaText(SINA_SAMPLE)["002724"]!;
    expect(q).toBeTruthy();
    expect(q.price).toBe(12.33);
    expect(q.prev_close).toBe(11.21);
    expect(q.ask1_vol).toBe(0);
    expect(q.bid1_vol).toBe(100000);
    expect(q.limit_up).toBe(12.33); // 11.21 × 1.10 half-up
    expect(q.is_sealed_up).toBe(true);
    expect(Math.abs(q.seal_amount - 1233000)).toBeLessThan(0.01);
    expect(q.quote_time).toBe("2026-10-23 15:00:00");
  });
  it("东财池子归一化", () => {
    const it = normalizePoolItem("zt", {
      c: "603278", m: 1, n: "大业股份", p: 13280, zdp: 10.01, amount: 123456789, hs: 5.6,
      lbc: 6, fbt: 92500, lbt: 103000, fund: 98765432, zbc: 2, hybk: "通用设备",
      zttj: { days: 6, ct: 5 },
    });
    expect(it.price).toBe(13.28);
    expect(it.first_seal).toBe("09:25:00");
    expect(it.last_seal).toBe("10:30:00");
    expect(it.lbc).toBe(6);
    expect(it.seal_fund).toBe(98765432);
    expect(it.zt_stat).toBe("6天5板");
  });
  it("涨跌停价规则", () => {
    expect(limitPrices(10, "600000")).toEqual([11, 9]);
    expect(limitPrices(10, "600400")[0]).toBe(11); // 主板 ST 10%
    expect(limitPrices(10, "300001")[0]).toBe(12); // 创业板 ST 20%
    expect(limitPrices(10, "300750")[0]).toBe(12);
    expect(limitPrices(10, "688981")[0]).toBe(12);
    expect(limitPrices(10, "920001")[0]).toBe(13);
    expect(limitPrices(10.05, "600000")[0]).toBe(11.06); // 11.055 half-up
    expect(limitPrices(11.21, "002724")[0]).toBe(12.33);
    expect(limitPrices(0, "600000")).toEqual([0, 0]);
  });
  it("监控范围过滤", () => {
    expect(exclusionCategory("600400", "*ST红豆")).toBe("st");
    expect(exclusionCategory("688981", "中芯国际")).toBe("star");
    expect(exclusionCategory("920001", "纬达光电")).toBe("bse");
    expect(exclusionCategory("832982", "锦波生物")).toBe("bse");
    expect(exclusionCategory("300750", "宁德时代")).toBeNull();
    expect(exclusionCategory("002724", "海洋王")).toBeNull();
    expect(exclusionCategory("603278", "大业股份")).toBeNull();
  });
  it("交易时段与新浪代码", () => {
    const at = (s: string) => Date.parse(s + "+08:00");
    expect(isActiveWindow(at("2026-10-26T09:20:00"))).toBe(true); // 周一
    expect(isActiveWindow(at("2026-10-26T12:00:00"))).toBe(false);
    expect(isActiveWindow(at("2026-10-26T15:05:00"))).toBe(true);
    expect(isActiveWindow(at("2026-10-26T15:06:00"))).toBe(false);
    expect(isActiveWindow(at("2026-10-25T10:00:00"))).toBe(false); // 周日
    expect(isoSh(at("2026-10-26T15:05:49"))).toBe("2026-10-26T15:05:49+08:00");
    expect(sinaSymbol("832982", 0)).toBe("bj832982");
    expect(sinaSymbol("600000", 1)).toBe("sh600000");
    expect(sinaSymbol("002724", 0)).toBe("sz002724");
  });
});

// ---------- 假服务器 ----------
function sinaLine(code: string, name: string, prev: number, price: number, bidVol: number, askVol: number, time: string) {
  const sym = (code.startsWith("6") ? "sh" : "sz") + code;
  const f = [name, String(prev), String(prev), String(price), String(price), String(prev), String(price), "0",
    "1000000", "50000000", String(bidVol), String(price), "0", "0", "0", "0", "0", "0", "0", "0",
    String(askVol), String(price + 0.01), "0", "0", "0", "0", "0", "0", "0", "0", "2026-10-26", time, "00"];
  return `var hq_str_${sym}="${f.join(",")}";\n`;
}
const emPool = (c: string, n: string, extra: object = {}) => ({ c, m: c.startsWith("6") ? 1 : 0, n, p: 10000, zdp: 10, amount: 1e8, hs: 5, hybk: "测试", zttj: { days: 3, ct: 3 }, ...extra });

function makeEnv(opts: { emStatus?: () => number }) {
  let clock = Date.parse("2026-10-26T09:30:00+08:00");
  const sinaScript: string[] = []; // 每次新浪请求依次返回
  const calls: string[] = [];
  const http: HttpGet = async (url) => {
    calls.push(url);
    if (url.startsWith("https://push2ex.eastmoney.com/")) {
      const status = opts.emStatus?.() ?? 200;
      if (status !== 200) return { status, bytes: new Uint8Array() };
      const ep = url.split("?")[0]!.split("/").pop()!;
      const pools: Record<string, object[]> = {
        getTopicZTPool: [emPool("600001", "测试甲", { lbc: 4, fbt: 93000, fund: 5e7, zbc: 0 }), emPool("688001", "科创乙", { lbc: 2 }), emPool("600002", "*ST丙", { lbc: 1 })],
        getTopicZBPool: [emPool("000001", "测试丁", { lbc: 1, ztp: 11000, zf: 8, zs: 1 })],
        getTopicDTPool: [],
        getYesterdayZTPool: [emPool("000002", "测试戊", { ylbc: 2, yfbt: 92500, zf: 5, zs: 1 })],
      };
      const list = pools[ep] ?? [];
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: { tc: list.length, pool: list } })) };
    }
    if (url.startsWith("https://data.10jqka.com.cn/")) {
      const ft = Math.floor(Date.parse("2026-10-26T09:31:07+08:00") / 1000);
      const info = [
        { code: "600001", name: "测试甲", reason_type: "机器人概念+减速器", limit_up_type: "换手板", limit_up_suc_rate: 0.8, open_num: 0, high_days: "4天4板", first_limit_up_time: String(ft) },
        { code: "688001", name: "科创乙", reason_type: "机器人概念", limit_up_type: "一字板", high_days: "首板", first_limit_up_time: String(ft) },
      ];
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: { info } })) };
    }
    if (url.startsWith("https://www.szse.cn/")) {
      const days: { jyrq: string; jybz: string }[] = [];
      for (let d = 1; d <= 31; d++) {
        const wd = new Date(Date.UTC(2026, 9, d)).getUTCDay();
        const holiday = d <= 7; // 国庆休市
        days.push({ jyrq: `2026-10-${String(d).padStart(2, "0")}`, jybz: !holiday && wd !== 0 && wd !== 6 ? "1" : "0" });
      }
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ data: days })) };
    }
    if (url.startsWith("https://hq.sinajs.cn/")) {
      const body = sinaScript.shift();
      if (body === undefined) return { status: 500, bytes: new Uint8Array() };
      return { status: 200, bytes: new Uint8Array(iconv.encode(body, "gbk")) };
    }
    return { status: 404, bytes: new Uint8Array() };
  };
  return {
    http, calls, sinaScript,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    sleep: async (ms: number) => { clock += ms; },
  };
}

async function makeCollector(env: ReturnType<typeof makeEnv>) {
  const sql = await initSqlJs();
  const rt = await createRuntime({ storage: { load: async () => null, save: async () => {} }, sql, actions: { ...Actions, ...ExtraActions }, persistDelayMs: 99999 });
  const kv = createKv(rt.db);
  const c = new Collector({ kv, http: env.http, now: env.now, sleep: env.sleep, random: () => 0.5 });
  return { rt, kv, c };
}

describe("完整流程（假行情服务器）", () => {
  it("池子过滤、监控列表、封板→炸板→回封事件、写入决策台数据库", async () => {
    const env = makeEnv({});
    const { rt, kv, c } = await makeCollector(env);
    expect(await c.poolsRound()).toBe(true);
    expect(c.poolDate).toBe("20261026");
    // 688001 科创、*ST丙 被剔除
    expect(c.pools.zt!.map((x) => x.code)).toEqual(["600001"]);
    expect(c.watchlist.map((w) => w.symbol)).toEqual(["sh600001", "sz000001", "sz000002"]);
    expect(c.lbcMap.get("600001")).toBe(4);
    const health = JSON.parse(kv.get(KV.health)!);
    expect(health.excluded_counts).toEqual({ st: 1, star: 1, bse: 0 });
    expect(health.eastmoney.pool_route).toBe("direct");

    // 600001：先未封（卖一有量）→ 封板 → 炸板 → 回封；其余两只不动
    const round = (p: number, bid: number, ask: number, t: string) =>
      sinaLine("600001", "测试甲", 10, p, bid, ask, t) +
      sinaLine("000001", "测试丁", 10, 10.2, 1000, 1000, t) +
      sinaLine("000002", "测试戊", 10, 10.1, 1000, 1000, t);
    env.sinaScript.push(
      round(10.8, 100, 5000, "09:30:05"), // 首次见到：静默
      round(11.0, 800000, 0, "09:30:10"), // 封板 → first_seal
      round(10.7, 100, 90000, "09:30:15"), // 炸板 → broken
      round(11.0, 900000, 0, "09:30:20"), // 回封 → reseal
    );
    for (let i = 0; i < 4; i++) {
      env.advance(5000);
      expect(await c.quotesRound()).toBe(true);
    }
    const events = kv.get(KV.events)!.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["first_seal", "broken", "reseal"]);
    expect(events.every((e) => e.code === "600001")).toBe(true);
    expect(events[0].ts).toMatch(/^2026-10-26T09:30:\d\d\+08:00$/);
    expect(events[0].detail.lbc).toBe(4);
    expect(c.quotesSource).toBe("sina");

    // 经本地特权处理器读回：快照可用、带实时价
    const snap: any = await rt.run("getIntradaySnapshot", { date: "2026-10-26" });
    expect(snap.available).toBe(true);
    expect(snap.error).toBe("");
    expect(snap.quotes.length).toBe(3);
    // 同步事件进数据库（决策台界面的「刷新」按钮走这里）
    const sync: any = await rt.run("syncintradayevents", {});
    expect(sync.inserted).toBe(3);
    expect(sync.error).toBe("");
    const again: any = await rt.run("syncintradayevents", {});
    expect(again.inserted).toBe(0); // 水位线生效，不重复
    const list: any = await rt.run("listintradayevents", { date: "2026-10-26" });
    expect(list.events.filter((e: any) => e.code === "600001").length).toBe(3);
  });

  it("东财 403：进入冷却，并用最近快照降级运行", async () => {
    let status = 200;
    const env = makeEnv({ emStatus: () => status });
    const { kv, c } = await makeCollector(env);
    expect(await c.poolsRound()).toBe(true);
    status = 403;
    const c2 = new Collector({ kv, http: env.http, now: env.now, sleep: env.sleep, random: () => 0.5 });
    expect(await c2.poolsRound()).toBe(true); // 无监控列表 → 从快照恢复
    expect(c2.watchlistSource).toBe("snapshot");
    expect(c2.watchlist.length).toBe(3);
    expect(c2.em.cooling()).toBe(true);
    // 冷却期内不再请求东财
    const before = env.calls.filter((u) => u.includes("eastmoney")).length;
    await c2.poolsRound();
    expect(env.calls.filter((u) => u.includes("eastmoney")).length).toBe(before);
  });

  it("新浪全失败时腾讯热备接手", async () => {
    const env = makeEnv({});
    const { c } = await makeCollector(env);
    await c.poolsRound();
    const orig = env.http;
    const http: HttpGet = async (url, h, t) => {
      if (url.startsWith("https://qt.gtimg.cn/")) {
        const f = new Array(40).fill("0");
        f[1] = "测试甲"; f[3] = "11.00"; f[4] = "10.00"; f[5] = "10.1"; f[9] = "11.00";
        f[10] = "8000"; f[20] = "0"; f[30] = "20261026093010"; f[33] = "11.00"; f[34] = "10.0"; f[37] = "5000";
        return { status: 200, bytes: new Uint8Array(iconv.encode(`v_sh600001="${f.join("~")}";\n`, "gbk")) };
      }
      return orig(url, h, t);
    };
    const c2 = new Collector({ kv: (c as any).kv, http, now: env.now, sleep: env.sleep, random: () => 0.5 });
    await c2.poolsRound();
    expect(await c2.quotesRound()).toBe(true);
    expect(c2.quotesSource).toBe("tencent");
    expect(c2.prevQuotes["600001"]!.is_sealed_up).toBe(true);
    expect(c2.prevQuotes["600001"]!.bid1_vol).toBe(800000);
  });

  it("交易日历：节假日休市、同花顺题材、一键填充市场日", async () => {
    const env = makeEnv({});
    const { rt, kv, c } = await makeCollector(env);
    const at = (x: string) => Date.parse(x + "+08:00");
    // 日历拉取前按周一到周五；拉取后国庆周工作日判为休市
    expect(c.cal.isTradingDay(at("2026-10-02T10:00:00"))).toBe(true);
    await c.cal.ensure(at("2026-10-26T09:00:00"));
    expect(c.cal.isTradingDay(at("2026-10-02T10:00:00"))).toBe(false);
    expect(c.cal.isTradingDay(at("2026-10-26T10:00:00"))).toBe(true);
    expect(c.cal.isTradingDay(at("2026-10-24T10:00:00"))).toBe(false); // 周六
    expect(c.isActive()).toBe(true); // 2026-10-26 09:30

    await c.poolsRound();
    expect(await c.thsRound()).toBe(true);
    const th: any = JSON.parse(kv.get(KV.ths("20261026"))!);
    expect(th.rows[0].first_time).toBe("09:31:07");
    expect(th.rows[0].reason).toBe("机器人概念+减速器");

    const r: any = await rt.run("fillMarketDayFromPools", { date: "2026-10-26" });
    expect(r.available).toBe(true);
    expect(r.values.limitUpCount).toBe(1); // 688001 科创被过滤
    expect(r.values.limitDownCount).toBe(0);
    expect(r.values.maxBoard).toBe(4);
    expect(r.values.brokenRate).toBe(50); // 炸板1 / (涨停1+炸板1)
    expect(r.values.sealRatePct).toBe(50);
    expect(r.values.prevPremiumPct).toBe(10); // 昨涨停 000002 今日涨幅
    expect(r.values.promotionRatePct).toBe(0); // 昨涨停不在今日涨停池
    expect(r.values.mainThemes).toBe("机器人概念、减速器");
    expect(r.themeSource).toBe("ths");
    expect(r.ladder).toEqual([{ boards: 4, count: 1 }]);
    expect(r.partial).toBe(true); // 09:30 抓的，盘中

    // 没有同花顺数据：退回东财行业
    kv.delete(KV.ths("20261026"));
    const r2: any = await rt.run("fillMarketDayFromPools", { date: "2026-10-26" });
    expect(r2.themeSource).toBe("industry");
    expect(r2.values.mainThemes).toBe("测试");
    // 没有采集器数据的日期：明确告知，不瞎填
    const r3: any = await rt.run("fillMarketDayFromPools", { date: "2026-10-23" });
    expect(r3.available).toBe(false);
    expect(r3.values.limitUpCount).toBeNull();
  });
});
