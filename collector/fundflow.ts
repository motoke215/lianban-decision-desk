// 板块「大钱流向」每日存档（行业 + 概念）。移植自 breadth-trin/fund_flow.py。
// 诚实定义（沿用原文）：这里的"大钱" = 东方财富按单笔成交金额分档估算的"主力净流入"
// （超大单 + 大单的买入减卖出），看不到交易者身份，页面一律称"大钱（大单估算）"。
// 原版经自建 Cloudflare 桥抓取（云端电脑直连东财 push2 恒 502）；本机在国内网络，直连，
// 并保留原桥里的重试与"两趟补抓、按代码去重"。接口与字段口径同 a-stock-data §3.8。
import type { Kv } from "../runtime/kv";
import { KV } from "../runtime/kv";
import type { EmClient } from "./core";

const FS = { industry: "m:90+t:2", concept: "m:90+t:3" } as const;
type Kind = keyof typeof FS;

interface Page {
  diff: Record<string, unknown>[];
  total: number;
}

async function fetchPage(
  em: EmClient,
  sleep: (ms: number) => Promise<void>,
  kind: Kind,
  pn: number,
): Promise<Page> {
  const qs = new URLSearchParams({
    pn: String(pn),
    pz: "100",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f62",
    fs: FS[kind],
    fields: "f12,f14,f3,f62,f184,f204,f66,f72,f78,f84",
  });
  let last = "";
  // 东财 push2 边缘会间歇性 502 / 空 data（成波次出现），盘后抓取时空一律按失败重试
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await em.rawGet(
        `https://push2.eastmoney.com/api/qt/clist/get?${qs.toString()}`,
        { Referer: "https://quote.eastmoney.com/" },
        15000,
      );
      if (res.status >= 400) last = `eastmoney HTTP ${res.status}`;
      else {
        const j = JSON.parse(new TextDecoder("utf-8").decode(res.bytes)) as {
          data?: { diff?: Record<string, unknown>[] | Record<string, Record<string, unknown>>; total?: number } | null;
        };
        const raw = j.data?.diff;
        const diff = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
        if (diff.length) return { diff, total: j.data?.total ?? 0 };
        last = "eastmoney empty data";
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (/cooldown/.test(last)) throw e;
    }
    await sleep(900 * attempt);
  }
  throw new Error(last || "eastmoney failed after retries");
}

export interface BoardFlow {
  total: number;
  complete: boolean;
  rows: { name: string; main_net: number | null; change_pct: number | null; leader: string }[];
}

async function fetchKind(em: EmClient, sleep: (ms: number) => Promise<void>, kind: Kind): Promise<BoardFlow> {
  const byCode = new Map<string, Record<string, unknown>>();
  let total = 0;
  for (let pass = 1; pass <= 2; pass++) {
    for (let pn = 1; pn <= 8; pn++) {
      if (total && byCode.size >= total) break;
      let page: Page;
      try {
        page = await fetchPage(em, sleep, kind, pn);
      } catch (e) {
        if (e instanceof Error && /cooldown/.test(e.message)) throw e;
        continue;
      }
      total = page.total || total;
      for (const it of page.diff) if (typeof it.f12 === "string") byCode.set(it.f12, it);
      if (!page.diff.length) break;
    }
    if (total && byCode.size >= total) break;
    if (pass === 1) await sleep(4000); // 第一趟有缺页：等一等，第二趟补抓
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const items = [...byCode.values()].sort(
    (a, b) => (num(b.f62) ?? -Infinity) - (num(a.f62) ?? -Infinity),
  );
  if (items.length === 0) throw new Error(`${kind} 抓取失败`);
  return {
    total: total || items.length,
    complete: total > 0 && items.length >= total,
    rows: items.map((it) => ({
      name: typeof it.f14 === "string" ? it.f14 : "",
      main_net: num(it.f62),
      change_pct: num(it.f3),
      leader: typeof it.f204 === "string" ? it.f204 : "",
    })),
  };
}

/** 抓取并存档某天（date = YYYY-MM-DD，必须是"今天"：东财只给当日口径，缺档不可事后补抓） */
export async function fetchFundflowDay(
  kv: Kv,
  em: EmClient,
  sleep: (ms: number) => Promise<void>,
  date: string,
): Promise<{ industry: number; concept: number }> {
  const industry = await fetchKind(em, sleep, "industry");
  const concept = await fetchKind(em, sleep, "concept");
  kv.set(KV.fundflow(date), JSON.stringify({ date, industry, concept }));
  // 汇总：界面只用到存档天数和最新日期
  const dates = kv
    .keys(KV.fundflowPrefix)
    .map((k) => k.slice(KV.fundflowPrefix.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  kv.set(
    KV.fundflowSummary,
    JSON.stringify({ days_available: dates.length, latest_date: dates[dates.length - 1] ?? null }),
  );
  return { industry: industry.rows.length, concept: concept.rows.length };
}
