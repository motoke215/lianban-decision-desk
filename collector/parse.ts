// 行情与池子解析：移植自 collector.py，字段顺序与口径逐项对应。
import { fmtEmTime, limitPrices } from "./rules";

export interface Quote {
  code: string;
  symbol: string;
  name: string;
  open: number;
  prev_close: number;
  price: number;
  high: number;
  low: number;
  pct: number;
  limit_up: number;
  limit_down: number;
  bid1_price: number;
  ask1_price: number;
  bid1_vol: number;
  ask1_vol: number;
  bid_vols: number[];
  bid_prices: number[];
  ask_vols: number[];
  ask_prices: number[];
  volume: number;
  amount: number;
  seal_amount: number;
  is_sealed_up: boolean;
  is_sealed_down: boolean;
  quote_time: string;
  lbc?: number | null;
  fetched_at?: string;
  _was_broken?: boolean;
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** Python float()：非法数字抛错，使该只股票被跳过（与原版 except ValueError 一致） */
function num(s: string | undefined): number {
  if (s === undefined) throw new RangeError("missing field");
  if (s === "" || s === "-") return 0;
  const v = Number(s);
  if (Number.isNaN(v) || s.trim() === "") throw new RangeError("bad number");
  return v;
}

export function parseSinaText(text: string): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  for (const m of text.matchAll(/var hq_str_(\w+)="([^"]*)";?/g)) {
    const symbol = m[1] ?? "";
    const f = (m[2] ?? "").split(",");
    if (f.length < 32 || !f[0]) continue; // 停牌/未知/空
    const code = symbol.slice(2);
    try {
      const g = (i: number) => num(f[i]);
      const name = f[0];
      const prevClose = g(2);
      const price = g(3);
      const [up, dn] = limitPrices(prevClose, code);
      const bid1Vol = Math.trunc(g(10));
      const ask1Vol = Math.trunc(g(20));
      const pct = prevClose > 0 ? (price / prevClose - 1) * 100 : 0;
      out[code] = {
        code,
        symbol,
        name,
        open: g(1),
        prev_close: prevClose,
        price,
        high: g(4),
        low: g(5),
        pct: round2(pct),
        limit_up: up,
        limit_down: dn,
        bid1_price: g(6),
        ask1_price: g(7),
        bid1_vol: bid1Vol,
        ask1_vol: ask1Vol,
        bid_vols: [10, 12, 14, 16, 18].map((i) => Math.trunc(g(i))),
        bid_prices: [11, 13, 15, 17, 19].map(g),
        ask_vols: [20, 22, 24, 26, 28].map((i) => Math.trunc(g(i))),
        ask_prices: [21, 23, 25, 27, 29].map(g),
        volume: Math.trunc(g(8)),
        amount: g(9),
        seal_amount: up > 0 ? round2(bid1Vol * up) : 0,
        is_sealed_up: price > 0 && up > 0 && Math.abs(price - up) < 0.005 && ask1Vol === 0,
        is_sealed_down: price > 0 && dn > 0 && Math.abs(price - dn) < 0.005 && bid1Vol === 0,
        quote_time: `${f[30]} ${f[31]}`,
      };
    } catch {
      continue;
    }
  }
  return out;
}

/** 腾讯备用源：盘口量单位是手，换算成股；成交额单位是万元，换算成元 */
export function parseTencentText(text: string): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  for (const m of text.matchAll(/v_(\w+)="([^"]*)";?/g)) {
    const symbol = m[1] ?? "";
    const f = (m[2] ?? "").split("~");
    if (f.length < 38 || !f[1]) continue;
    const code = symbol.slice(2);
    try {
      const g = (i: number) => num(f[i]);
      const gi = (i: number) => Math.trunc(g(i));
      const name = f[1];
      const prevClose = g(4);
      const price = g(3);
      const [up, dn] = limitPrices(prevClose, code);
      const bid1Vol = gi(10) * 100;
      const ask1Vol = gi(20) * 100;
      const pct = prevClose > 0 ? (price / prevClose - 1) * 100 : 0;
      const stamp = f[30] ?? "";
      const quoteTime =
        stamp.length === 14
          ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`
          : "";
      out[code] = {
        code,
        symbol,
        name,
        open: g(5),
        prev_close: prevClose,
        price,
        high: g(33),
        low: g(34),
        pct: round2(pct),
        limit_up: up,
        limit_down: dn,
        bid1_price: g(9),
        ask1_price: g(19),
        bid1_vol: bid1Vol,
        ask1_vol: ask1Vol,
        bid_vols: [10, 12, 14, 16, 18].map((i) => gi(i) * 100),
        bid_prices: [9, 11, 13, 15, 17].map(g),
        ask_vols: [20, 22, 24, 26, 28].map((i) => gi(i) * 100),
        ask_prices: [19, 21, 23, 25, 27].map(g),
        volume: gi(6) * 100,
        amount: g(37) * 10000,
        seal_amount: up > 0 ? round2(bid1Vol * up) : 0,
        is_sealed_up: price > 0 && up > 0 && Math.abs(price - up) < 0.005 && ask1Vol === 0,
        is_sealed_down: price > 0 && dn > 0 && Math.abs(price - dn) < 0.005 && bid1Vol === 0,
        quote_time: quoteTime,
      };
    } catch {
      continue;
    }
  }
  return out;
}

// ---------- 东财池子 ----------

export type PoolKey = "zt" | "zb" | "dt" | "yzt";

export interface PoolItem {
  code: string;
  market: number | null;
  name: string;
  price: number;
  pct: number | null;
  amount: number | null;
  turnover: number | null;
  industry: string;
  [k: string]: unknown;
}

type Raw = Record<string, unknown>;
const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
const orZero = (v: unknown): number => (typeof v === "number" ? v : 0);

export function normalizePoolItem(key: PoolKey, p: Raw): PoolItem {
  const zt = (p.zttj ?? {}) as Raw;
  const stat = `${zt.days ?? "?"}天${zt.ct ?? "?"}板`;
  const base: PoolItem = {
    code: String(p.c ?? ""),
    market: n(p.m),
    name: String(p.n ?? ""),
    price: orZero(p.p) / 1000,
    pct: n(p.zdp),
    amount: n(p.amount),
    turnover: n(p.hs),
    industry: typeof p.hybk === "string" ? p.hybk : "",
  };
  if (key === "zt" || key === "zb") {
    Object.assign(base, {
      lbc: n(p.lbc),
      first_seal: fmtEmTime(n(p.fbt)),
      break_times: n(p.zbc),
      zt_stat: stat,
    });
  }
  if (key === "zt") {
    Object.assign(base, { last_seal: fmtEmTime(n(p.lbt)), seal_fund: n(p.fund) });
  }
  if (key === "zb") {
    Object.assign(base, {
      limit_price: orZero(p.ztp) / 1000,
      amplitude: n(p.zf),
      speed: n(p.zs),
    });
  }
  if (key === "dt") {
    Object.assign(base, {
      seal_fund: n(p.fund),
      last_seal: fmtEmTime(n(p.lbt)),
      dt_days: n(p.days),
      open_times: n(p.oc),
      board_amount: n(p.fba),
    });
  }
  if (key === "yzt") {
    Object.assign(base, {
      y_first_seal: fmtEmTime(n(p.yfbt)),
      y_lbc: n(p.ylbc),
      amplitude: n(p.zf),
      speed: n(p.zs),
      zt_stat: stat,
    });
  }
  return base;
}
