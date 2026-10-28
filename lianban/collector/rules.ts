// 采集器规则：移植自 a-share-collector/collector.py（口径保持一致）。
// 范围：只监控主板 + 创业板；剔除 ST、科创板(688/689)、北交所。

export type ExclusionCategory = "st" | "star" | "bse";

export function exclusionCategory(
  code: string | null | undefined,
  name: string | null | undefined,
): ExclusionCategory | null {
  if (!code) return null;
  if ((name ?? "").toUpperCase().includes("ST")) return "st";
  if (code.startsWith("688") || code.startsWith("689")) return "star";
  if (code[0] === "4" || code[0] === "8" || code.startsWith("920")) return "bse";
  return null;
}

/** 各板块涨跌幅（整数百分比）。2026-07-06 起主板 ST 也是 10%，创业板 ST 仍是 20%。 */
export function limitPctInt(code: string): number {
  if (code.startsWith("30") || code.startsWith("68")) return 20;
  if (["43", "83", "87", "92"].some((p) => code.startsWith(p))) return 30;
  return 10;
}

/**
 * 涨跌停价：四舍五入（half-up）到分。
 * 用 BigInt 十进制精确运算，和 Python Decimal 的结果逐位一致，
 * 避免 11.21*1.1 这类浮点误差导致差一分钱。
 */
function roundedLimit(prevClose: number, pctInt: number, sign: 1 | -1): number {
  const s = String(prevClose);
  if (/e/i.test(s)) return Math.round(prevClose * (1 + (sign * pctInt) / 100) * 100) / 100;
  const [ip = "0", fp = ""] = s.split(".");
  const d = fp.length;
  const scaled = BigInt(ip + fp); // prevClose × 10^d
  const num = scaled * BigInt(100 + sign * pctInt); // ×100 → 值 = num / 10^(d+2)
  const ten = 10n ** BigInt(d);
  const cents = (num * 2n + ten) / (2n * ten); // half-up 到分
  return Number(cents) / 100;
}

export function limitPrices(prevClose: number, code: string): [number, number] {
  if (!prevClose || prevClose <= 0) return [0, 0];
  const p = limitPctInt(code);
  return [roundedLimit(prevClose, p, 1), roundedLimit(prevClose, p, -1)];
}

export function sinaSymbol(code: string, market?: number | null): string {
  // 北交所代码前缀优先于东财的 market 标记（东财把北交所标成 m=0，和深圳一样）
  if (["43", "83", "87", "92"].some((p) => code.startsWith(p))) return "bj" + code;
  if (market != null) return (Number(market) === 1 ? "sh" : "sz") + code;
  if (code.startsWith("6") || code.startsWith("9")) return "sh" + code;
  return "sz" + code;
}

export function fmtEmTime(t: number | null | undefined): string {
  if (t == null) return "";
  const s = String(Math.trunc(Number(t))).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

// ---------- 上海时区时间（不依赖设备所在时区）----------

export interface ShParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  /** 与 Python 的 date.weekday() 相同：周一=0 … 周日=6 */
  weekday: number;
}

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

export function shParts(ms: number): ShParts {
  const o: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(o.weekday ?? "");
  return {
    y: Number(o.year),
    m: Number(o.month),
    d: Number(o.day),
    hh: Number(o.hour),
    mm: Number(o.minute),
    ss: Number(o.second),
    weekday: wd,
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function isoSh(ms: number): string {
  const t = shParts(ms);
  return `${t.y}-${p2(t.m)}-${p2(t.d)}T${p2(t.hh)}:${p2(t.mm)}:${p2(t.ss)}+08:00`;
}

export function ymdSh(ms: number): string {
  const t = shParts(ms);
  return `${t.y}${p2(t.m)}${p2(t.d)}`;
}

/** 交易时段：工作日 9:15–11:35、12:55–15:05（含集合竞价和收盘余量） */
export function isActiveWindow(ms: number, tradingDay?: boolean): boolean {
  const t = shParts(ms);
  // 传入交易日历结果时以日历为准（节假日休市、周末调休上班都能判对）
  if (!(tradingDay ?? t.weekday < 5)) return false;
  const m = t.hh * 60 + t.mm;
  return (m >= 9 * 60 + 15 && m <= 11 * 60 + 35) || (m >= 12 * 60 + 55 && m <= 15 * 60 + 5);
}
