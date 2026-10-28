// 连板决策台 actions — pure user-record CRUD + deterministic scoring/stats.
// No external market data: ladder/news figures are entered by the user from
// their monitoring briefs; all scoring, verdicts, sizing and stats are
// computed here from those records.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared shapes ----------

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const marketDayShape = z.object({
  id: z.number(),
  date: z.string(),
  maxBoard: z.number().nullable(),
  limitUpCount: z.number().nullable(),
  limitDownCount: z.number().nullable(),
  brokenRate: z.number().nullable(),
  prevPremiumPct: z.number().nullable(),
  promotionRatePct: z.number().nullable(),
  sealRatePct: z.number().nullable(),
  cycleStage: z.string(),
  maxDrop: z.number().nullable(),
  ladderGap: z.boolean(),
  ebbSignal: z.boolean(),
  mainThemes: z.string(),
  note: z.string(),
});

const CYCLE_STAGES = ["冰点", "混沌", "发酵", "主升", "分歧", "退潮"] as const;
const cycleStageInput = z
  .string()
  .refine((s) => s === "" || (CYCLE_STAGES as readonly string[]).includes(s), {
    message: "cycleStage must be empty or one of the six stages",
  });

const candidateShape = z.object({
  id: z.number(),
  date: z.string(),
  name: z.string(),
  code: z.string(),
  theme: z.string(),
  flagClarify: z.boolean(),
  flagTopBreak: z.boolean(),
  flagThemeEbb: z.boolean(),
  flagExternal: z.boolean(),
  vetoed: z.boolean(),
  vetoReasons: z.array(z.string()),
  sTheme: z.number(),
  sPosition: z.number(),
  sSeal: z.number(),
  sTurnover: z.number(),
  sFollow: z.number(),
  total: z.number(),
  auctionGainPct: z.number().nullable(),
  auctionAmountWan: z.number().nullable(),
  auctionVolRatio: z.number().nullable(),
  boardDays: z.number().nullable(),
  ydayState: z.string(),
  note: z.string(),
});

const triState = z.enum(["pass", "fail", "unknown"]);

const confirmStateShape = z.object({
  id: z.number(),
  date: z.string(),
  condPremium: triState,
  condSeal: triState,
  condLeader: triState,
  gapFilled: z.boolean(),
  danger: z.boolean(),
});

const planShape = z.object({
  id: z.number(),
  date: z.string(),
  themes: z.string(),
  watchlist: z.string(),
  trigger: z.string(),
  giveUp: z.string(),
  positionCap: z.number().nullable(),
  note: z.string(),
});

const planChangeShape = z.object({
  id: z.number(),
  date: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

const tradeShape = z.object({
  id: z.number(),
  date: z.string(),
  sellDate: z.string().nullable(),
  name: z.string(),
  code: z.string(),
  buyPrice: z.number(),
  sellPrice: z.number().nullable(),
  shares: z.number(),
  buyReason: z.string(),
  followedPlan: z.boolean(),
  mode: z.string(), // 第三档：交易模式 ''/打板/半路/低吸/其他
  plannedOverride: z.string(), // 第三档：'' 自动 / in 计划内 / out 计划外
  planDeviation: z.enum(["in", "out", "none"]), // 第三档：偏离判定（改判优先）
  deviationManual: z.boolean(), // 第三档：是否为手动改判
  sellReason: z.string(),
  emotion: z.string(),
  errorTags: z.array(z.string()),
  note: z.string(),
  pnl: z.number().nullable(), // 已实现盈亏（元），持仓中为 null
  pnlPct: z.number().nullable(), // 已实现盈亏率 %
});

const settingsShape = z.object({
  capital: z.number(),
  riskPct: z.number(),
  scoreThreshold: z.number(),
  meltLosses: z.number(),
});

// ----- 盘后对账（阶段1新增，只读展示；写入只经 savereconciliation） -----

const reconStatus = z.enum(["一致", "差异已注", "未查得"]);

const lbcTopItemShape = z.object({
  code: z.string(),
  name: z.string(),
  lbc: z.number(),
});

const lbcMismatchItemShape = z.object({
  code: z.string(),
  name: z.string(),
  selfLbc: z.number().nullable(),
  emLbc: z.number().nullable(),
});

const diffEntryShape = z.object({
  code: z.string(),
  name: z.string(),
});

const reconDiffShape = z.object({
  selfOnly: z.array(diffEntryShape), // 自算有、东财池无
  emOnly: z.array(diffEntryShape), // 东财池有、自算无
  thsOnly: z.array(diffEntryShape), // 同花顺有、自算无
  extra: z.record(z.string(), z.array(diffEntryShape)), // 其余差集键原样透出
});

const reconciliationShape = z.object({
  id: z.number(),
  date: z.string(),
  status: reconStatus,
  selfZtAll: z.number().nullable(),
  selfZtNoSt: z.number().nullable(),
  selfZtDesk: z.number().nullable(),
  selfDtDesk: z.number().nullable(),
  selfTouchedDesk: z.number().nullable(),
  selfSealRateDesk: z.number().nullable(),
  emZt: z.number().nullable(),
  emZb: z.number().nullable(),
  emDt: z.number().nullable(),
  emSealRate: z.number().nullable(),
  thsZt: z.number().nullable(),
  deskLimitUpCount: z.number().nullable(),
  deskLimitDownCount: z.number().nullable(),
  lbcMismatch: z.array(lbcMismatchItemShape),
  lbcTop: z.array(lbcTopItemShape),
  diff: reconDiffShape,
  diffTotal: z.number(), // 差集名单总条数（不含 lbcMismatch）
  notes: z.array(z.string()),
});

// ---------- scoring helpers ----------

const VETO_LABELS: Record<string, string> = {
  flagClarify: "澄清/异动公告（概念不实、未量产等）",
  flagTopBreak: "高标断板 + 梯队断层",
  flagThemeEbb: "题材集体退潮",
  flagExternal: "外围大跌传导",
};

function candidateView(row: typeof schema.candidates.$inferSelect) {
  const vetoKeys = (["flagClarify", "flagTopBreak", "flagThemeEbb", "flagExternal"] as const).filter(
    (k) => row[k] === 1,
  );
  const total = (row.sTheme + row.sPosition + row.sSeal + row.sTurnover + row.sFollow) * 4;
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    code: row.code,
    theme: row.theme,
    flagClarify: row.flagClarify === 1,
    flagTopBreak: row.flagTopBreak === 1,
    flagThemeEbb: row.flagThemeEbb === 1,
    flagExternal: row.flagExternal === 1,
    vetoed: vetoKeys.length > 0,
    vetoReasons: vetoKeys.map((k) => VETO_LABELS[k] ?? k),
    sTheme: row.sTheme,
    sPosition: row.sPosition,
    sSeal: row.sSeal,
    sTurnover: row.sTurnover,
    sFollow: row.sFollow,
    total,
    auctionGainPct: row.auctionGainPct,
    auctionAmountWan: row.auctionAmountWan,
    auctionVolRatio: row.auctionVolRatio,
    boardDays: row.boardDays,
    ydayState: row.ydayState,
    note: row.note,
  };
}

function marketDayView(row: typeof schema.marketDays.$inferSelect) {
  return {
    id: row.id,
    date: row.date,
    maxBoard: row.maxBoard,
    limitUpCount: row.limitUpCount,
    limitDownCount: row.limitDownCount,
    brokenRate: row.brokenRate,
    prevPremiumPct: row.prevPremiumPct,
    promotionRatePct: row.promotionRatePct,
    sealRatePct: row.sealRatePct,
    cycleStage: row.cycleStage,
    maxDrop: row.maxDrop,
    ladderGap: row.ladderGap === 1,
    ebbSignal: row.ebbSignal === 1,
    mainThemes: row.mainThemes,
    note: row.note,
  };
}

function parseJsonArray(json: string): unknown[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function asDiffEntry(v: unknown): { code: string; name: string } | null {
  if (typeof v === "string") return { code: "", name: v };
  if (v != null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : "";
    const name = typeof o.name === "string" ? o.name : "";
    if (code || name) return { code, name };
  }
  return null;
}

function diffEntries(v: unknown): { code: string; name: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { code: string; name: string }[] = [];
  for (const item of v) {
    const e = asDiffEntry(item);
    if (e) out.push(e);
  }
  return out;
}

function reconciliationView(row: typeof schema.reconciliations.$inferSelect) {
  const lbcTop = parseJsonArray(row.lbcTop).flatMap((v) => {
    if (v != null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.lbc === "number") {
        return [
          {
            code: typeof o.code === "string" ? o.code : "",
            name: typeof o.name === "string" ? o.name : "",
            lbc: o.lbc,
          },
        ];
      }
    }
    return [];
  });
  const lbcMismatch = parseJsonArray(row.lbcMismatch).flatMap((v) => {
    if (v != null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return [
        {
          code: typeof o.code === "string" ? o.code : "",
          name: typeof o.name === "string" ? o.name : "",
          selfLbc: typeof o.selfLbc === "number" ? o.selfLbc : null,
          emLbc: typeof o.emLbc === "number" ? o.emLbc : null,
        },
      ];
    }
    return [];
  });
  let diffRaw: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(row.diff);
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      diffRaw = v as Record<string, unknown>;
    }
  } catch {
    // diff 不是合法 JSON 时按空差集处理
  }
  const selfOnly = diffEntries(diffRaw.selfOnly);
  const emOnly = diffEntries(diffRaw.emOnly);
  const thsOnly = diffEntries(diffRaw.thsOnly);
  const extra: Record<string, { code: string; name: string }[]> = {};
  let diffTotal = selfOnly.length + emOnly.length + thsOnly.length;
  for (const [k, v] of Object.entries(diffRaw)) {
    if (k === "selfOnly" || k === "emOnly" || k === "thsOnly") continue;
    const entries = diffEntries(v);
    if (entries.length > 0) {
      extra[k] = entries;
      diffTotal += entries.length;
    }
  }
  let notes: string[] = [];
  try {
    const v: unknown = JSON.parse(row.notes);
    if (Array.isArray(v)) {
      notes = v.filter((x): x is string => typeof x === "string");
    } else if (typeof v === "string" && v) {
      notes = [v];
    }
  } catch {
    if (row.notes.trim()) notes = [row.notes];
  }
  return {
    id: row.id,
    date: row.date,
    status: row.status,
    selfZtAll: row.selfZtAll,
    selfZtNoSt: row.selfZtNoSt,
    selfZtDesk: row.selfZtDesk,
    selfDtDesk: row.selfDtDesk,
    selfTouchedDesk: row.selfTouchedDesk,
    selfSealRateDesk: row.selfSealRateDesk,
    emZt: row.emZt,
    emZb: row.emZb,
    emDt: row.emDt,
    emSealRate: row.emSealRate,
    thsZt: row.thsZt,
    deskLimitUpCount: row.deskLimitUpCount,
    deskLimitDownCount: row.deskLimitDownCount,
    lbcMismatch,
    lbcTop,
    diff: { selfOnly, emOnly, thsOnly, extra },
    diffTotal,
    notes,
  };
}

function confirmStateView(row: typeof schema.confirmStates.$inferSelect) {
  const tri = (v: string): "pass" | "fail" | "unknown" =>
    v === "pass" || v === "fail" ? v : "unknown";
  return {
    id: row.id,
    date: row.date,
    condPremium: tri(row.condPremium),
    condSeal: tri(row.condSeal),
    condLeader: tri(row.condLeader),
    gapFilled: row.gapFilled === 1,
    danger: row.danger === 1,
  };
}

// 计划偏离自动判定（第三档）：该日有计划或候选时，个股代码/名称命中
// 当日候选名单或计划文本（题材/只看名单/触发/放弃/备注）任一处 = 计划内，
// 否则 = 计划外；该日无计划也无候选 = 无计划可比。手动改判优先。
export type PlanDeviation = "in" | "out" | "none";

export function computeDeviation(input: {
  override: string;
  hasContext: boolean;
  inCandidates: boolean;
  inPlanText: boolean;
}): { deviation: PlanDeviation; manual: boolean } {
  if (input.override === "in" || input.override === "out") {
    return { deviation: input.override, manual: true };
  }
  if (!input.hasContext) return { deviation: "none", manual: false };
  return {
    deviation: input.inCandidates || input.inPlanText ? "in" : "out",
    manual: false,
  };
}

type TradeRow = typeof schema.trades.$inferSelect;

async function deviationMap(
  ctx: Ctx,
  rows: TradeRow[],
): Promise<Map<number, { deviation: PlanDeviation; manual: boolean }>> {
  const db = ctx.db<typeof schema>();
  const dates = [...new Set(rows.map((r) => r.date))];
  const map = new Map<number, { deviation: PlanDeviation; manual: boolean }>();
  for (const date of dates) {
    const [planRows, candRows] = await Promise.all([
      db.select().from(schema.plans).where(eq(schema.plans.date, date)).limit(1),
      db.select().from(schema.candidates).where(eq(schema.candidates.date, date)),
    ]);
    const plan = planRows[0];
    const planText = plan
      ? [plan.themes, plan.watchlist, plan.trigger, plan.giveUp, plan.note].join("\n")
      : "";
    const hasContext = plan != null || candRows.length > 0;
    for (const r of rows.filter((x) => x.date === date)) {
      const inCandidates = candRows.some(
        (c) =>
          (r.code !== "" && c.code !== "" && c.code === r.code) || c.name === r.name,
      );
      const inPlanText =
        planText !== "" &&
        ((r.code !== "" && planText.includes(r.code)) || planText.includes(r.name));
      map.set(
        r.id,
        computeDeviation({
          override: r.plannedOverride,
          hasContext,
          inCandidates,
          inPlanText,
        }),
      );
    }
  }
  return map;
}

function tradeView(
  row: TradeRow,
  deviation: { deviation: PlanDeviation; manual: boolean } = {
    deviation: "none",
    manual: false,
  },
) {
  const closed = row.sellPrice != null;
  const pnl = closed ? (row.sellPrice! - row.buyPrice) * row.shares : null;
  const pnlPct =
    closed && row.buyPrice > 0 ? ((row.sellPrice! - row.buyPrice) / row.buyPrice) * 100 : null;
  return {
    id: row.id,
    date: row.date,
    sellDate: row.sellDate,
    name: row.name,
    code: row.code,
    buyPrice: row.buyPrice,
    sellPrice: row.sellPrice,
    shares: row.shares,
    buyReason: row.buyReason,
    followedPlan: row.followedPlan === 1,
    mode: row.mode,
    plannedOverride: row.plannedOverride,
    planDeviation: deviation.deviation,
    deviationManual: deviation.manual,
    sellReason: row.sellReason,
    emotion: row.emotion,
    errorTags: row.errorTags ? row.errorTags.split(",").filter(Boolean) : [],
    note: row.note,
    pnl,
    pnlPct,
  };
}

// ---------- 异动临界计算（price-abnormal-rules：偏离值 = 个股 − 对应指数，按日累计） ----------

export type BoardType = "main" | "chinext" | "star" | "st";
const BOARD_LINE: Record<BoardType, number> = { main: 20, chinext: 30, star: 30, st: 12 };
const BOARD_LIMIT: Record<BoardType, number> = { main: 10, chinext: 20, star: 20, st: 5 };
const BOARD_SEVERE_EVENTS: Record<BoardType, number> = { main: 4, chinext: 3, star: 3, st: 4 };

export type AbnormalLevel = "severe" | "triggered" | "severeNear" | "near" | "calm";
export type TurnoverState = "triggered" | "no" | "nodata";

export type AbnormalComputed = {
  dev3: number | null;
  dev10: number | null;
  dev30: number | null;
  events10: number | null;
  turnoverState: TurnoverState;
  level: AbnormalLevel;
  gapPoints: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeAbnormal(input: {
  boardType: BoardType;
  stockChg: number[];
  indexChg: number[];
  turnover: number[] | null;
}): AbnormalComputed {
  const T = BOARD_LINE[input.boardType];
  const limit = BOARD_LIMIT[input.boardType];
  const sevEvents = BOARD_SEVERE_EVENTS[input.boardType];
  const dev = input.stockChg.map((s, i) => s - (input.indexChg[i] ?? 0));
  const sumLast = (n: number): number | null =>
    dev.length < n ? null : round2(dev.slice(-n).reduce((a, b) => a + b, 0));
  const dev3 = sumLast(3);
  const dev10 = sumLast(10);
  const dev30 = sumLast(30);

  // 换手触发：最近 3 日均值 ÷ 此前 5 日均值 ≥30 且最近 3 日累计 ≥20%
  let turnoverState: TurnoverState = "nodata";
  const to = input.turnover;
  if (to != null && to.length >= 8) {
    const last3 = to.slice(-3);
    const prev5 = to.slice(-8, -3);
    const avg3 = last3.reduce((a, b) => a + b, 0) / 3;
    const avg5 = prev5.reduce((a, b) => a + b, 0) / 5;
    const sum3 = last3.reduce((a, b) => a + b, 0);
    turnoverState = avg5 > 0 && avg3 / avg5 >= 30 && sum3 >= 20 ? "triggered" : "no";
  }

  // events10（近似）：最近 10 日内以某日为终点的 3 日滚动窗口中，
  // 与 dev10 同向且累计偏离达到普通线 T 的窗口数。
  let events10: number | null = null;
  if (dev.length >= 10 && dev10 != null && dev10 !== 0) {
    const sign = Math.sign(dev10);
    let count = 0;
    for (let end = dev.length - 8; end < dev.length; end++) {
      const w = dev[end - 2]! + dev[end - 1]! + dev[end]!;
      if (Math.sign(w) === sign && Math.abs(w) >= T) count += 1;
    }
    events10 = count;
  } else if (dev.length >= 10) {
    events10 = 0;
  }

  const devTriggered = dev3 != null && Math.abs(dev3) >= T;
  const severe =
    (events10 != null && events10 >= sevEvents) ||
    (dev10 != null && (dev10 >= 100 || dev10 <= -50)) ||
    (dev30 != null && (dev30 >= 200 || dev30 <= -70));
  const severeNear =
    (events10 != null && events10 >= sevEvents - 1) ||
    (dev10 != null && (dev10 >= 85 || dev10 <= -40)) ||
    (dev30 != null && (dev30 >= 170 || dev30 <= -60));

  let level: AbnormalLevel;
  if (severe) level = "severe";
  else if (devTriggered || turnoverState === "triggered") level = "triggered";
  else if (severeNear) level = "severeNear";
  else if (dev3 != null && T - Math.abs(dev3) <= limit) level = "near";
  else level = "calm";

  const gapPoints = dev3 != null ? round2(T - Math.abs(dev3)) : null;
  return { dev3, dev10, dev30, events10, turnoverState, level, gapPoints };
}

const abnormalWatchShape = z.object({
  id: z.number(),
  date: z.string(),
  code: z.string(),
  name: z.string(),
  boardType: z.string(),
  stockChg: z.array(z.number()),
  indexChg: z.array(z.number()),
  turnover: z.array(z.number()).nullable(),
  dev3: z.number().nullable(),
  dev10: z.number().nullable(),
  dev30: z.number().nullable(),
  events10: z.number().nullable(),
  turnoverState: z.string(),
  level: z.string(),
  gapPoints: z.number().nullable(),
  limitPct: z.number(),
  note: z.string(),
});

function parseNumArray(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function abnormalWatchView(row: typeof schema.abnormalWatches.$inferSelect) {
  const bt = (["main", "chinext", "star", "st"] as const).includes(
    row.boardType as BoardType,
  )
    ? (row.boardType as BoardType)
    : "main";
  return {
    id: row.id,
    date: row.date,
    code: row.code,
    name: row.name,
    boardType: row.boardType,
    stockChg: parseNumArray(row.stockChg),
    indexChg: parseNumArray(row.indexChg),
    turnover: row.turnover == null ? null : parseNumArray(row.turnover),
    dev3: row.dev3,
    dev10: row.dev10,
    dev30: row.dev30,
    events10: row.events10,
    turnoverState: row.turnoverState,
    level: row.level,
    gapPoints: row.gapPoints,
    limitPct: BOARD_LIMIT[bt],
    note: row.note,
  };
}

// ---------- 梯队结构 helpers（第三档） ----------

const ladderEntryShape = z.object({
  id: z.number(),
  date: z.string(),
  code: z.string(),
  name: z.string(),
  theme: z.string(),
  boardDays: z.number(),
  role: z.string(),
  isSpatial: z.boolean(),
  sigBreakVolumeDown: z.boolean(),
  sigMultiOpenLateSeal: z.boolean(),
  sigSecondCollapse: z.boolean(),
  sigClarifyDeny: z.boolean(),
  sigDriveLoss: z.boolean(),
  topHits: z.number(), // 见顶五信号命中数（服务端计算）
  note: z.string(),
});

function ladderEntryView(row: typeof schema.ladderEntries.$inferSelect) {
  const sigs = [
    row.sigBreakVolumeDown,
    row.sigMultiOpenLateSeal,
    row.sigSecondCollapse,
    row.sigClarifyDeny,
    row.sigDriveLoss,
  ];
  return {
    id: row.id,
    date: row.date,
    code: row.code,
    name: row.name,
    theme: row.theme,
    boardDays: row.boardDays,
    role: row.role,
    isSpatial: row.isSpatial === 1,
    sigBreakVolumeDown: row.sigBreakVolumeDown === 1,
    sigMultiOpenLateSeal: row.sigMultiOpenLateSeal === 1,
    sigSecondCollapse: row.sigSecondCollapse === 1,
    sigClarifyDeny: row.sigClarifyDeny === 1,
    sigDriveLoss: row.sigDriveLoss === 1,
    topHits: sigs.filter((v) => v === 1).length,
    note: row.note,
  };
}

// ---------- 回测同步/统计 helpers ----------

function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asFlag(v: unknown): number | null {
  const n = asNum(v);
  if (n == null) return null;
  return n === 0 ? 0 : 1;
}

function asStr(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

// 今日页龙头推荐只读展示：从 backtest_rows 龙头轨的 payload 抽取展示字段。
// 只读，不写任何表；payload 里没有的字段以空/空值返回，界面缺失即不显示。
const leaderPickShape = z.object({
  code: z.string(),
  name: z.string(),
  theme: z.string(),
  boardDays: z.number().nullable(),
  cycleStage: z.string(),
  leaderRole: z.string(),
  expectationVerdict: z.string(),
  entryRefPrice: z.number().nullable(),
  vetoReason: z.string(),
  recommended: z.number().nullable(),
  vetoHit: z.number().nullable(),
  closedLimit: z.number().nullable(),
  nextOpenRetPct: z.number().nullable(),
  successPick: z.number().nullable(),
});

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  capital: 0,
  riskPct: 1,
  scoreThreshold: 60,
  meltLosses: 3,
};

async function loadSettings(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: keyof typeof DEFAULT_SETTINGS) => {
    const raw = map.get(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_SETTINGS[key];
  };
  return {
    capital: num("capital"),
    riskPct: num("riskPct"),
    scoreThreshold: num("scoreThreshold"),
    meltLosses: num("meltLosses"),
  };
}

// ---------- 盘中异动事件流（采集器 events.jsonl 接入，只存市场事实） ----------

const INTRADAY_EVENT_TYPES = [
  "first_seal",
  "broken",
  "reseal",
  "seal_drop",
  "dive",
  "limit_down_seal",
] as const;
type IntradayEventType = (typeof INTRADAY_EVENT_TYPES)[number];

const intradayEventShape = z.object({
  id: z.number(),
  date: z.string(),
  eventTs: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  detailJson: z.string(),
  factText: z.string(),
});

const syncIntradayResponse = z.object({
  inserted: z.number(),
  skipped: z.number(),
  streamUpdatedAt: z.string().nullable(), // 采集器 health.json 的 updated_at
  sinaLastSuccessAt: z.string().nullable(),
  lastEventTs: z.string().nullable(), // 库中最新事件时间
  offset: z.number(), // 当前字节水位线
  error: z.string(), // "" = 无错误；文件读取失败时为明确信息，不抛错
});

// ---------- 盘中实况（采集器四池快照 + 盯盘实时行情，只读直通 + 派生指标） ----------
// 数据来自采集器落盘文件（特权层读取），本动作只做口径明确的派生计算：
// 封板率 = 涨停 /（涨停 + 炸板）；昨涨溢价 = 昨涨停池今日涨幅均值；
// 梯队分布/断层由涨停池连板数统计。全部标注为盘中数据，不写市场日定稿。

const intradayPoolRowShape = z.object({
  code: z.string(),
  name: z.string(),
  price: z.number().nullable(),
  pct: z.number().nullable(),
  amount: z.number().nullable(),
  turnover: z.number().nullable(),
  industry: z.string(),
  lbc: z.number().nullable(),
  firstSeal: z.string().nullable(),
  breakTimes: z.number().nullable(),
  sealFund: z.number().nullable(),
  ztStat: z.string(),
  yLbc: z.number().nullable(),
  limitPrice: z.number().nullable(),
});

const intradayQuoteShape = z.object({
  code: z.string(),
  name: z.string(),
  price: z.number().nullable(),
  pct: z.number().nullable(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  prevClose: z.number().nullable(),
  limitUp: z.number().nullable(),
  limitDown: z.number().nullable(),
  sealAmount: z.number().nullable(),
  amount: z.number().nullable(),
});

const intradaySnapshotResponse = z.object({
  date: z.string(),
  available: z.boolean(), // 该日存在采集器池子快照
  error: z.string(),
  poolsFetchedAt: z.string().nullable(),
  quotesUpdatedAt: z.string().nullable(),
  health: z.object({
    updatedAt: z.string().nullable(),
    poolDate: z.string().nullable(),
    watchlistSize: z.number().nullable(),
    watchlistSource: z.string().nullable(),
    quotesSource: z.string().nullable(),
    poolRoute: z.string().nullable(),
    sinaLastSuccessAt: z.string().nullable(),
  }),
  limitUpCount: z.number().nullable(),
  limitDownCount: z.number().nullable(),
  brokenCount: z.number().nullable(),
  maxBoard: z.number().nullable(),
  sealRatePct: z.number().nullable(),
  brokenRatePct: z.number().nullable(),
  prevPremiumPct: z.number().nullable(), // 昨涨停池今日平均涨幅
  yztCount: z.number().nullable(),
  yztUpCount: z.number().nullable(), // 昨涨停中今日红盘家数
  ladderGap: z.boolean(), // 2..最高板-1 之间存在缺位板数
  tiers: z.array(z.object({ boards: z.number(), count: z.number() })),
  themes: z.array(z.object({ name: z.string(), count: z.number() })),
  zt: z.array(intradayPoolRowShape),
  zb: z.array(intradayPoolRowShape),
  dt: z.array(intradayPoolRowShape),
  yztTop: z.array(intradayPoolRowShape),
  yztBottom: z.array(intradayPoolRowShape),
  quotes: z.array(intradayQuoteShape),
});
type IntradaySnapshot = z.infer<typeof intradaySnapshotResponse>;
type IntradayPoolRow = z.infer<typeof intradayPoolRowShape>;

function emptyIntradaySnapshot(
  date: string,
  error: string,
  health: IntradaySnapshot["health"],
): IntradaySnapshot {
  return {
    date,
    available: false,
    error,
    poolsFetchedAt: null,
    quotesUpdatedAt: null,
    health,
    limitUpCount: null,
    limitDownCount: null,
    brokenCount: null,
    maxBoard: null,
    sealRatePct: null,
    brokenRatePct: null,
    prevPremiumPct: null,
    yztCount: null,
    yztUpCount: null,
    ladderGap: false,
    tiers: [],
    themes: [],
    zt: [],
    zb: [],
    dt: [],
    yztTop: [],
    yztBottom: [],
    quotes: [],
  };
}

const EMPTY_HEALTH: IntradaySnapshot["health"] = {
  updatedAt: null,
  poolDate: null,
  watchlistSize: null,
  watchlistSource: null,
  quotesSource: null,
  poolRoute: null,
  sinaLastSuccessAt: null,
};

const trimNum = (v: number) => String(Math.round(v * 100) / 100);
const fmtPrice = (v: number) => trimNum(v);
const fmtPctVal = (v: number) => `${v > 0 ? "+" : ""}${trimNum(v)}`;

// 金额友好格式化：元 → 万元 / 亿元（保留至多 2 位小数）
function fmtAmountYuan(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${trimNum(v / 1e8)}亿元`;
  if (abs >= 1e4) return `${trimNum(v / 1e4)}万元`;
  return `${trimNum(v)}元`;
}

// 由 detail 渲染一句事实描述：只写 detail 里真实存在的字段，缺字段整段省略，
// 绝不补数字。字段口径与采集器 collector.py 的 emit 一致。
function intradayFactText(
  type: IntradayEventType,
  d: Record<string, unknown>,
): string {
  const price = asNum(d.price);
  const limitUp = asNum(d.limit_up);
  const limitDown = asNum(d.limit_down);
  const sealAmount = asNum(d.seal_amount);
  const pct = asNum(d.pct);
  const lbcRaw = asNum(d.lbc);
  const lbc = lbcRaw != null && lbcRaw > 0 ? Math.round(lbcRaw) : null;
  switch (type) {
    case "first_seal":
    case "reseal": {
      const verb = type === "first_seal" ? "触及涨停价" : "回封涨停价";
      const parts: string[] = [];
      if (price != null && limitUp != null)
        parts.push(`价格 ${fmtPrice(price)} ${verb} ${fmtPrice(limitUp)}`);
      else if (limitUp != null) parts.push(`${verb} ${fmtPrice(limitUp)}`);
      else if (price != null) parts.push(`价格 ${fmtPrice(price)} 封住涨停`);
      if (sealAmount != null) parts.push(`封单约 ${fmtAmountYuan(sealAmount)}`);
      if (lbc != null) parts.push(`${lbc} 连板`);
      return parts.length ? parts.join("，") : "封住涨停";
    }
    case "broken": {
      const parts = ["封板打开"];
      if (price != null) parts.push(`最新价 ${fmtPrice(price)}`);
      if (pct != null) parts.push(`涨幅 ${fmtPctVal(pct)}%`);
      return parts.join("，");
    }
    case "seal_drop": {
      const from = asNum(d.from);
      const to = asNum(d.to);
      const win = asNum(d.window_sec);
      if (from != null && to != null) {
        return win != null
          ? `封单在 ${Math.round(win)} 秒内由 ${fmtAmountYuan(from)} 降至 ${fmtAmountYuan(to)}`
          : `封单由 ${fmtAmountYuan(from)} 降至 ${fmtAmountYuan(to)}`;
      }
      return "封单骤降";
    }
    case "dive": {
      const peak = asNum(d.peak_pct);
      const parts: string[] = [];
      if (lbc != null) parts.push(`${lbc} 连板`);
      if (peak != null && pct != null)
        parts.push(`涨幅由峰值 ${fmtPctVal(peak)}% 回落至 ${fmtPctVal(pct)}%`);
      else if (pct != null) parts.push(`涨幅回落至 ${fmtPctVal(pct)}%`);
      return parts.length ? parts.join("，") : "高标跳水";
    }
    case "limit_down_seal": {
      const parts: string[] = [];
      if (price != null && limitDown != null)
        parts.push(`价格 ${fmtPrice(price)} 封住跌停价 ${fmtPrice(limitDown)}`);
      else if (limitDown != null) parts.push(`封住跌停价 ${fmtPrice(limitDown)}`);
      if (pct != null) parts.push(`涨幅 ${fmtPctVal(pct)}%`);
      return parts.length ? parts.join("，") : "封住跌停";
    }
  }
}

type RawIntradayEvent = {
  ts?: unknown;
  type?: unknown;
  code?: unknown;
  name?: unknown;
  detail?: unknown;
};

// 逐条 upsert：只收六个枚举内的事件，其余（及唯一键冲突）计入 skipped。
async function ingestIntradayEvents(
  ctx: Ctx,
  rawEvents: RawIntradayEvent[],
): Promise<{ inserted: number; skipped: number }> {
  const db = ctx.db<typeof schema>();
  let inserted = 0;
  let skipped = 0;
  for (const raw of rawEvents) {
    const ts = typeof raw.ts === "string" ? raw.ts : "";
    const type = typeof raw.type === "string" ? raw.type : "";
    if (
      !/^\d{4}-\d{2}-\d{2}T/.test(ts) ||
      !(INTRADAY_EVENT_TYPES as readonly string[]).includes(type)
    ) {
      skipped += 1;
      continue;
    }
    const detail =
      raw.detail != null &&
      typeof raw.detail === "object" &&
      !Array.isArray(raw.detail)
        ? (raw.detail as Record<string, unknown>)
        : {};
    const typed = type as IntradayEventType;
    const res = await db
      .insert(schema.intradayEvents)
      .values({
        date: ts.slice(0, 10),
        eventTs: ts,
        code: asStr(raw.code),
        name: asStr(raw.name),
        type: typed,
        detailJson: JSON.stringify(detail),
        factText: intradayFactText(typed, detail),
      })
      .onConflictDoNothing()
      .returning({ id: schema.intradayEvents.id });
    if (res.length > 0) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

const INTRADAY_OFFSET_KEY = "intraday_sync_offset";

async function getIntradayOffset(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, INTRADAY_OFFSET_KEY))
    .limit(1);
  const n = rows[0] ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

async function setIntradayOffset(ctx: Ctx, offset: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.settings)
    .values({ key: INTRADAY_OFFSET_KEY, value: String(offset) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: String(offset) },
    });
}

async function lastIntradayEventTs(ctx: Ctx): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ eventTs: schema.intradayEvents.eventTs })
    .from(schema.intradayEvents)
    .orderBy(desc(schema.intradayEvents.eventTs))
    .limit(1);
  return rows[0]?.eventTs ?? null;
}

export const Actions = {
  // ----- bootstrap: most recent day (<= upTo) that has any recorded data -----
  // Used on open so weekends/holidays land on the latest trading day with
  // data instead of an empty "today".
  getLatestDataDate: defineAction({
    request: z.object({ upTo: dateStr }),
    response: z.object({ date: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const latestOf = async (
        rows: { date: string }[],
      ): Promise<string | null> => rows[0]?.date ?? null;
      const [market, cand, plan, change, ladder] = await Promise.all([
        db
          .select({ date: schema.marketDays.date })
          .from(schema.marketDays)
          .where(lte(schema.marketDays.date, args.upTo))
          .orderBy(desc(schema.marketDays.date))
          .limit(1),
        db
          .select({ date: schema.candidates.date })
          .from(schema.candidates)
          .where(lte(schema.candidates.date, args.upTo))
          .orderBy(desc(schema.candidates.date))
          .limit(1),
        db
          .select({ date: schema.plans.date })
          .from(schema.plans)
          .where(lte(schema.plans.date, args.upTo))
          .orderBy(desc(schema.plans.date))
          .limit(1),
        db
          .select({ date: schema.planChanges.date })
          .from(schema.planChanges)
          .where(lte(schema.planChanges.date, args.upTo))
          .orderBy(desc(schema.planChanges.date))
          .limit(1),
        db
          .select({ date: schema.ladderEntries.date })
          .from(schema.ladderEntries)
          .where(lte(schema.ladderEntries.date, args.upTo))
          .orderBy(desc(schema.ladderEntries.date))
          .limit(1),
      ]);
      const dates = (
        await Promise.all([
          latestOf(market),
          latestOf(cand),
          latestOf(plan),
          latestOf(change),
          latestOf(ladder),
        ])
      ).filter((d): d is string => d != null);
      dates.sort();
      return { date: dates[dates.length - 1] ?? null };
    },
  }),

  // ----- overview: everything the home screen needs in one call -----
  getOverview: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({
      settings: settingsShape,
      day: marketDayShape.nullable(),
      plan: planShape.nullable(),
      planChanges: z.array(planChangeShape),
      candidates: z.array(candidateShape),
      confirmState: confirmStateShape.nullable(),
      openTrades: z.array(tradeShape),
      recentClosed: z.array(tradeShape),
      lossStreak: z.number(), // 当前连亏笔数（按卖出日期倒序）
      melted: z.boolean(), // 是否触发熔断
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const settings = await loadSettings(ctx);

      const dayRows = await db
        .select()
        .from(schema.marketDays)
        .where(eq(schema.marketDays.date, args.date))
        .limit(1);
      const planRows = await db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.date, args.date))
        .limit(1);
      const changeRows = await db
        .select()
        .from(schema.planChanges)
        .where(eq(schema.planChanges.date, args.date))
        .orderBy(asc(schema.planChanges.createdAt));
      const candRows = await db
        .select()
        .from(schema.candidates)
        .where(eq(schema.candidates.date, args.date));
      const confirmRows = await db
        .select()
        .from(schema.confirmStates)
        .where(eq(schema.confirmStates.date, args.date))
        .limit(1);
      const openRows = await db
        .select()
        .from(schema.trades)
        .orderBy(desc(schema.trades.date), desc(schema.trades.id));

      const devMap = await deviationMap(ctx, openRows);
      const allTrades = openRows.map((r) =>
        tradeView(r, devMap.get(r.id) ?? { deviation: "none", manual: false }),
      );
      const openTrades = allTrades.filter((t) => t.sellPrice == null);
      const closed = allTrades
        .filter((t) => t.sellPrice != null)
        .sort((a, b) => (b.sellDate ?? "").localeCompare(a.sellDate ?? "") || b.id - a.id);
      let lossStreak = 0;
      for (const t of closed) {
        if (t.pnl != null && t.pnl < 0) lossStreak += 1;
        else break;
      }

      return {
        settings,
        day: dayRows[0] ? marketDayView(dayRows[0]) : null,
        plan: planRows[0]
          ? {
              id: planRows[0].id,
              date: planRows[0].date,
              themes: planRows[0].themes,
              watchlist: planRows[0].watchlist,
              trigger: planRows[0].trigger,
              giveUp: planRows[0].giveUp,
              positionCap: planRows[0].positionCap,
              note: planRows[0].note,
            }
          : null,
        planChanges: changeRows.map((r) => ({
          id: r.id,
          date: r.date,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
        candidates: candRows.map(candidateView),
        confirmState: confirmRows[0] ? confirmStateView(confirmRows[0]) : null,
        openTrades,
        recentClosed: closed.slice(0, 5),
        lossStreak,
        melted: settings.meltLosses > 0 && lossStreak >= settings.meltLosses,
      };
    },
  }),

  // ----- settings -----
  getSettings: defineAction({
    request: z.object({}),
    response: settingsShape,
    async handler(ctx) {
      return loadSettings(ctx);
    },
  }),

  saveSettings: defineAction({
    request: z.object({
      capital: z.number().min(0).max(1e10),
      riskPct: z.number().min(0.1).max(10),
      scoreThreshold: z.number().int().min(0).max(100),
      meltLosses: z.number().int().min(1).max(20),
    }),
    response: settingsShape,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const entries = [
        { key: "capital", value: String(args.capital) },
        { key: "riskPct", value: String(args.riskPct) },
        { key: "scoreThreshold", value: String(args.scoreThreshold) },
        { key: "meltLosses", value: String(args.meltLosses) },
      ];
      for (const e of entries) {
        await db
          .insert(schema.settings)
          .values(e)
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: e.value } });
      }
      ctx.invalidateQueries();
      return loadSettings(ctx);
    },
  }),

  // ----- market days (梯队板) -----
  listMarketDays: defineAction({
    request: z.object({ limit: z.number().int().positive().max(120).default(30) }),
    response: z.object({ days: z.array(marketDayShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.marketDays)
        .orderBy(desc(schema.marketDays.date))
        .limit(args.limit);
      return { days: rows.map(marketDayView) };
    },
  }),

  saveMarketDay: defineAction({
    request: z.object({
      date: dateStr,
      maxBoard: z.number().int().min(0).max(30).nullable(),
      limitUpCount: z.number().int().min(0).max(1000).nullable(),
      brokenRate: z.number().min(0).max(100).nullable(),
      maxDrop: z.number().int().min(-2).max(0).nullable(),
      ladderGap: z.boolean(),
      ebbSignal: z.boolean(),
      mainThemes: z.string().max(500),
      note: z.string().max(1000),
      // 第一档新增字段：全部可选。省略 = 保留已有值（新行则为空），
      // 显式传 null = 清空，显式传 "" (cycleStage) = 清空。
      limitDownCount: z.number().int().min(0).max(1000).nullable().optional(),
      prevPremiumPct: z.number().min(-100).max(100).nullable().optional(),
      promotionRatePct: z.number().min(0).max(100).nullable().optional(),
      sealRatePct: z.number().min(0).max(100).nullable().optional(),
      cycleStage: cycleStageInput.optional(),
    }),
    response: z.object({ day: marketDayShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.marketDays)
        .where(eq(schema.marketDays.date, args.date))
        .limit(1);
      const prev = existing[0];
      const values = {
        date: args.date,
        maxBoard: args.maxBoard,
        limitUpCount: args.limitUpCount,
        brokenRate: args.brokenRate,
        maxDrop: args.maxDrop,
        ladderGap: args.ladderGap ? 1 : 0,
        ebbSignal: args.ebbSignal ? 1 : 0,
        mainThemes: args.mainThemes,
        note: args.note,
        limitDownCount:
          args.limitDownCount !== undefined
            ? args.limitDownCount
            : (prev?.limitDownCount ?? null),
        prevPremiumPct:
          args.prevPremiumPct !== undefined
            ? args.prevPremiumPct
            : (prev?.prevPremiumPct ?? null),
        promotionRatePct:
          args.promotionRatePct !== undefined
            ? args.promotionRatePct
            : (prev?.promotionRatePct ?? null),
        sealRatePct:
          args.sealRatePct !== undefined ? args.sealRatePct : (prev?.sealRatePct ?? null),
        cycleStage:
          args.cycleStage !== undefined ? args.cycleStage : (prev?.cycleStage ?? ""),
        updatedAt: new Date(),
      };
      let row: typeof schema.marketDays.$inferSelect | undefined;
      if (prev) {
        const updated = await db
          .update(schema.marketDays)
          .set(values)
          .where(eq(schema.marketDays.date, args.date))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.marketDays).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveMarketDay failed");
      ctx.invalidateQueries();
      return { day: marketDayView(row) };
    },
  }),

  deleteMarketDay: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.marketDays).where(eq(schema.marketDays.date, args.date));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ----- candidates (评分 + 红灯) -----
  listCandidates: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ candidates: z.array(candidateShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.candidates)
        .where(eq(schema.candidates.date, args.date))
        .orderBy(asc(schema.candidates.id));
      return { candidates: rows.map(candidateView) };
    },
  }),

  saveCandidate: defineAction({
    request: z.object({
      id: z.number().int().positive().optional(),
      date: dateStr,
      name: z.string().min(1).max(40),
      code: z.string().max(10),
      theme: z.string().max(60),
      flagClarify: z.boolean(),
      flagTopBreak: z.boolean(),
      flagThemeEbb: z.boolean(),
      flagExternal: z.boolean(),
      sTheme: z.number().int().min(0).max(5),
      sPosition: z.number().int().min(0).max(5),
      sSeal: z.number().int().min(0).max(5),
      sTurnover: z.number().int().min(0).max(5),
      sFollow: z.number().int().min(0).max(5),
      note: z.string().max(500),
      // 竞价字段预留：全部可选。省略 = 保留已有值（新行则为空），显式 null = 清空。
      auctionGainPct: z.number().min(-30).max(30).nullable().optional(),
      auctionAmountWan: z.number().min(0).max(1e9).nullable().optional(),
      auctionVolRatio: z.number().min(0).max(10000).nullable().optional(),
      // 竞价验证字段（第二档）：全部可选，同上保留/清空语义。
      boardDays: z.number().int().min(0).max(30).nullable().optional(),
      ydayState: z
        .string()
        .refine(
          (s) => ["", "shrink", "strong", "voldiff", "weaklate", "broken", "spatial"].includes(s),
          { message: "ydayState must be empty or a known state" },
        )
        .optional(),
    }),
    response: z.object({ candidate: candidateShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let prev: typeof schema.candidates.$inferSelect | undefined;
      if (args.id) {
        const rows = await db
          .select()
          .from(schema.candidates)
          .where(eq(schema.candidates.id, args.id))
          .limit(1);
        prev = rows[0];
      }
      const values = {
        date: args.date,
        name: args.name,
        code: args.code,
        theme: args.theme,
        flagClarify: args.flagClarify ? 1 : 0,
        flagTopBreak: args.flagTopBreak ? 1 : 0,
        flagThemeEbb: args.flagThemeEbb ? 1 : 0,
        flagExternal: args.flagExternal ? 1 : 0,
        sTheme: args.sTheme,
        sPosition: args.sPosition,
        sSeal: args.sSeal,
        sTurnover: args.sTurnover,
        sFollow: args.sFollow,
        note: args.note,
        auctionGainPct:
          args.auctionGainPct !== undefined
            ? args.auctionGainPct
            : (prev?.auctionGainPct ?? null),
        auctionAmountWan:
          args.auctionAmountWan !== undefined
            ? args.auctionAmountWan
            : (prev?.auctionAmountWan ?? null),
        auctionVolRatio:
          args.auctionVolRatio !== undefined
            ? args.auctionVolRatio
            : (prev?.auctionVolRatio ?? null),
        boardDays:
          args.boardDays !== undefined ? args.boardDays : (prev?.boardDays ?? null),
        ydayState:
          args.ydayState !== undefined ? args.ydayState : (prev?.ydayState ?? ""),
      };
      let row: typeof schema.candidates.$inferSelect | undefined;
      if (args.id) {
        const updated = await db
          .update(schema.candidates)
          .set(values)
          .where(eq(schema.candidates.id, args.id))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.candidates).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveCandidate failed");
      ctx.invalidateQueries();
      return { candidate: candidateView(row) };
    },
  }),

  deleteCandidate: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.candidates).where(eq(schema.candidates.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ----- plans (盘前计划卡) -----
  savePlan: defineAction({
    request: z.object({
      date: dateStr,
      themes: z.string().max(500),
      watchlist: z.string().max(1000),
      trigger: z.string().max(1000),
      giveUp: z.string().max(1000),
      positionCap: z.number().min(0).max(100).nullable(),
      note: z.string().max(1000),
    }),
    response: z.object({ plan: planShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        date: args.date,
        themes: args.themes,
        watchlist: args.watchlist,
        trigger: args.trigger,
        giveUp: args.giveUp,
        positionCap: args.positionCap,
        note: args.note,
        updatedAt: new Date(),
      };
      const existing = await db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.date, args.date))
        .limit(1);
      let row: typeof schema.plans.$inferSelect | undefined;
      if (existing[0]) {
        const updated = await db
          .update(schema.plans)
          .set(values)
          .where(eq(schema.plans.date, args.date))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.plans).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("savePlan failed");
      ctx.invalidateQueries();
      return {
        plan: {
          id: row.id,
          date: row.date,
          themes: row.themes,
          watchlist: row.watchlist,
          trigger: row.trigger,
          giveUp: row.giveUp,
          positionCap: row.positionCap,
          note: row.note,
        },
      };
    },
  }),

  addPlanChange: defineAction({
    request: z.object({ date: dateStr, content: z.string().min(1).max(500) }),
    response: z.object({ change: planChangeShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.planChanges)
        .values({ date: args.date, content: args.content })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addPlanChange failed");
      ctx.invalidateQueries();
      return {
        change: {
          id: row.id,
          date: row.date,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        },
      };
    },
  }),

  deletePlanChange: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.planChanges).where(eq(schema.planChanges.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ----- 确认推演器（状态按日期保存 + 写入计划卡） -----
  getConfirmState: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ state: confirmStateShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.confirmStates)
        .where(eq(schema.confirmStates.date, args.date))
        .limit(1);
      return { state: rows[0] ? confirmStateView(rows[0]) : null };
    },
  }),

  saveConfirmState: defineAction({
    request: z.object({
      date: dateStr,
      condPremium: triState,
      condSeal: triState,
      condLeader: triState,
      gapFilled: z.boolean(),
      danger: z.boolean(),
    }),
    response: z.object({ state: confirmStateShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        date: args.date,
        condPremium: args.condPremium,
        condSeal: args.condSeal,
        condLeader: args.condLeader,
        gapFilled: args.gapFilled ? 1 : 0,
        danger: args.danger ? 1 : 0,
        updatedAt: new Date(),
      };
      const existing = await db
        .select()
        .from(schema.confirmStates)
        .where(eq(schema.confirmStates.date, args.date))
        .limit(1);
      let row: typeof schema.confirmStates.$inferSelect | undefined;
      if (existing[0]) {
        const updated = await db
          .update(schema.confirmStates)
          .set(values)
          .where(eq(schema.confirmStates.date, args.date))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.confirmStates).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveConfirmState failed");
      ctx.invalidateQueries();
      return { state: confirmStateView(row) };
    },
  }),

  // 把推演结论写入所选日期的计划卡：positionCap = 推演仓位上限，
  // 结论句追加到计划卡备注（已有相同结论不重复追加）。计划卡不存在则新建空卡。
  applyConfirmToPlan: defineAction({
    request: z.object({
      date: dateStr,
      cap: z.number().min(0).max(100),
      conclusion: z.string().min(1).max(300),
    }),
    response: z.object({ plan: planShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.date, args.date))
        .limit(1);
      const prev = existing[0];
      const note = prev
        ? prev.note.includes(args.conclusion)
          ? prev.note
          : [prev.note, args.conclusion].filter(Boolean).join("；")
        : args.conclusion;
      const values = {
        date: args.date,
        themes: prev?.themes ?? "",
        watchlist: prev?.watchlist ?? "",
        trigger: prev?.trigger ?? "",
        giveUp: prev?.giveUp ?? "",
        positionCap: args.cap,
        note,
        updatedAt: new Date(),
      };
      let row: typeof schema.plans.$inferSelect | undefined;
      if (prev) {
        const updated = await db
          .update(schema.plans)
          .set(values)
          .where(eq(schema.plans.date, args.date))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.plans).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("applyConfirmToPlan failed");
      ctx.invalidateQueries();
      return {
        plan: {
          id: row.id,
          date: row.date,
          themes: row.themes,
          watchlist: row.watchlist,
          trigger: row.trigger,
          giveUp: row.giveUp,
          positionCap: row.positionCap,
          note: row.note,
        },
      };
    },
  }),

  // ----- trades (交易日志) -----
  listTrades: defineAction({
    request: z.object({ limit: z.number().int().positive().max(500).default(200) }),
    response: z.object({ trades: z.array(tradeShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.trades)
        .orderBy(desc(schema.trades.date), desc(schema.trades.id))
        .limit(args.limit);
      const devMap = await deviationMap(ctx, rows);
      return {
        trades: rows.map((r) =>
          tradeView(r, devMap.get(r.id) ?? { deviation: "none", manual: false }),
        ),
      };
    },
  }),

  saveTrade: defineAction({
    request: z.object({
      id: z.number().int().positive().optional(),
      date: dateStr,
      sellDate: dateStr.nullable(),
      name: z.string().min(1).max(40),
      code: z.string().max(10),
      buyPrice: z.number().positive().max(100000),
      sellPrice: z.number().positive().max(100000).nullable(),
      shares: z.number().int().positive().max(100000000),
      buyReason: z.string().max(500),
      followedPlan: z.boolean(),
      // 第三档新增：全部可选。省略 = 保留已有值（新行为空），显式传值 = 写入。
      mode: z
        .string()
        .refine((s) => ["", "打板", "半路", "低吸", "其他"].includes(s), {
          message: "mode must be empty or a known trade mode",
        })
        .optional(),
      plannedOverride: z
        .string()
        .refine((s) => ["", "in", "out"].includes(s), {
          message: "plannedOverride must be empty, in or out",
        })
        .optional(),
      sellReason: z.string().max(500),
      emotion: z.string().max(20),
      errorTags: z.array(z.string().max(30)).max(10),
      note: z.string().max(500),
    }),
    response: z.object({ trade: tradeShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let prev: typeof schema.trades.$inferSelect | undefined;
      if (args.id) {
        const rows = await db
          .select()
          .from(schema.trades)
          .where(eq(schema.trades.id, args.id))
          .limit(1);
        prev = rows[0];
      }
      const values = {
        date: args.date,
        sellDate: args.sellDate,
        name: args.name,
        code: args.code,
        buyPrice: args.buyPrice,
        sellPrice: args.sellPrice,
        shares: args.shares,
        buyReason: args.buyReason,
        followedPlan: args.followedPlan ? 1 : 0,
        mode: args.mode !== undefined ? args.mode : (prev?.mode ?? ""),
        plannedOverride:
          args.plannedOverride !== undefined
            ? args.plannedOverride
            : (prev?.plannedOverride ?? ""),
        sellReason: args.sellReason,
        emotion: args.emotion,
        errorTags: args.errorTags.join(","),
        note: args.note,
      };
      let row: typeof schema.trades.$inferSelect | undefined;
      if (args.id) {
        const updated = await db
          .update(schema.trades)
          .set(values)
          .where(eq(schema.trades.id, args.id))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.trades).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveTrade failed");
      const devMap = await deviationMap(ctx, [row]);
      ctx.invalidateQueries();
      return {
        trade: tradeView(row, devMap.get(row.id) ?? { deviation: "none", manual: false }),
      };
    },
  }),

  deleteTrade: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.trades).where(eq(schema.trades.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ----- stats (复盘统计) -----
  getStats: defineAction({
    request: z.object({}),
    response: z.object({
      closedCount: z.number(),
      openCount: z.number(),
      totalPnl: z.number(),
      winRate: z.number().nullable(), // %
      avgWin: z.number().nullable(),
      avgLoss: z.number().nullable(), // negative number
      profitFactor: z.number().nullable(), // 盈亏比 = |avgWin / avgLoss|
      maxDrawdownPct: z.number().nullable(), // 基于逐笔累计盈亏 / 本金
      planRate: z.number().nullable(), // 按计划执行比例 %
      topErrors: z.array(z.object({ tag: z.string(), count: z.number() })),
      // 第三档纪律闭环：计划内 vs 计划外对比 + 分组胜率（口径与总统计一致）
      planCompare: z.object({
        in: z.object({
          count: z.number(),
          winRate: z.number().nullable(),
          totalPnl: z.number(),
        }),
        out: z.object({
          count: z.number(),
          winRate: z.number().nullable(),
          totalPnl: z.number(),
        }),
      }),
      stageGroups: z.array(
        z.object({
          stage: z.string(),
          count: z.number(),
          winRate: z.number().nullable(),
          profitFactor: z.number().nullable(),
          avgPnl: z.number().nullable(),
          totalPnl: z.number(),
        }),
      ),
      modeGroups: z.array(
        z.object({
          mode: z.string(),
          count: z.number(),
          winRate: z.number().nullable(),
          profitFactor: z.number().nullable(),
          avgPnl: z.number().nullable(),
          totalPnl: z.number(),
        }),
      ),
      emotionStats: z.array(
        z.object({ emotion: z.string(), count: z.number(), avgPnlPct: z.number() }),
      ),
      equityCurve: z.array(
        z.object({ date: z.string(), cumPnl: z.number(), label: z.string() }),
      ),
      lossStreak: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const settings = await loadSettings(ctx);
      const rows = await db.select().from(schema.trades);
      const devMap = await deviationMap(ctx, rows);
      const trades = rows.map((r) =>
        tradeView(r, devMap.get(r.id) ?? { deviation: "none", manual: false }),
      );
      const closed = trades
        .filter((t) => t.pnl != null)
        .sort(
          (a, b) =>
            (a.sellDate ?? a.date).localeCompare(b.sellDate ?? b.date) || a.id - b.id,
        );
      const openCount = trades.length - closed.length;
      const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
      const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
      const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
      const avgWin = wins.length
        ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length
        : null;
      const avgLoss = losses.length
        ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length
        : null;
      const profitFactor =
        avgWin != null && avgLoss != null && avgLoss !== 0
          ? Math.abs(avgWin / avgLoss)
          : null;
      const planRate = closed.length
        ? (closed.filter((t) => t.followedPlan).length / closed.length) * 100
        : null;

      // Equity curve + max drawdown (as % of capital when capital is set)
      let cum = 0;
      let peak = 0;
      let maxDd = 0;
      const equityCurve = closed.map((t) => {
        cum += t.pnl ?? 0;
        peak = Math.max(peak, cum);
        maxDd = Math.max(maxDd, peak - cum);
        return {
          date: t.sellDate ?? t.date,
          cumPnl: Math.round(cum * 100) / 100,
          label: t.name,
        };
      });
      const maxDrawdownPct =
        settings.capital > 0 && closed.length
          ? (maxDd / settings.capital) * 100
          : null;

      const errCount = new Map<string, number>();
      for (const t of closed) {
        for (const tag of t.errorTags) errCount.set(tag, (errCount.get(tag) ?? 0) + 1);
      }
      const topErrors = [...errCount.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      const emoMap = new Map<string, { count: number; sumPct: number }>();
      for (const t of closed) {
        if (!t.emotion || t.pnlPct == null) continue;
        const cur = emoMap.get(t.emotion) ?? { count: 0, sumPct: 0 };
        cur.count += 1;
        cur.sumPct += t.pnlPct;
        emoMap.set(t.emotion, cur);
      }
      const emotionStats = [...emoMap.entries()].map(([emotion, v]) => ({
        emotion,
        count: v.count,
        avgPnlPct: Math.round((v.sumPct / v.count) * 100) / 100,
      }));

      const bySellDesc = [...closed].sort(
        (a, b) => (b.sellDate ?? "").localeCompare(a.sellDate ?? "") || b.id - a.id,
      );
      let lossStreak = 0;
      for (const t of bySellDesc) {
        if ((t.pnl ?? 0) < 0) lossStreak += 1;
        else break;
      }

      // 第三档：分组统计（已平仓才计入，与总统计同口径）
      const groupStats = (list: typeof closed) => {
        const w = list.filter((t) => (t.pnl ?? 0) > 0);
        const l = list.filter((t) => (t.pnl ?? 0) < 0);
        const aW = w.length ? w.reduce((s, t) => s + (t.pnl ?? 0), 0) / w.length : null;
        const aL = l.length ? l.reduce((s, t) => s + (t.pnl ?? 0), 0) / l.length : null;
        const tot = list.reduce((s, t) => s + (t.pnl ?? 0), 0);
        return {
          count: list.length,
          winRate: list.length
            ? Math.round((w.length / list.length) * 1000) / 10
            : null,
          profitFactor:
            aW != null && aL != null && aL !== 0
              ? Math.round(Math.abs(aW / aL) * 100) / 100
              : null,
          avgPnl: list.length ? Math.round((tot / list.length) * 100) / 100 : null,
          totalPnl: Math.round(tot * 100) / 100,
        };
      };
      const planCompare = {
        in: groupStats(closed.filter((t) => t.planDeviation === "in")),
        out: groupStats(closed.filter((t) => t.planDeviation === "out")),
      };
      const dayRows = await db.select().from(schema.marketDays);
      const stageByDate = new Map(dayRows.map((d) => [d.date, d.cycleStage]));
      const stageOf = (t: (typeof closed)[number]) => {
        const s = stageByDate.get(t.date);
        return s && s !== "" ? s : "未定调";
      };
      const stageGroups = [...CYCLE_STAGES, "未定调"].map((stage) => ({
        stage,
        ...groupStats(closed.filter((t) => stageOf(t) === stage)),
      }));
      const MODE_ORDER = ["打板", "半路", "低吸", "其他", "未标注"];
      const modeOf = (t: (typeof closed)[number]) =>
        t.mode !== "" ? t.mode : "未标注";
      const modeGroups = MODE_ORDER.map((mode) => ({
        mode,
        ...groupStats(closed.filter((t) => modeOf(t) === mode)),
      }));

      return {
        closedCount: closed.length,
        openCount,
        totalPnl: Math.round(totalPnl * 100) / 100,
        winRate: winRate == null ? null : Math.round(winRate * 10) / 10,
        avgWin: avgWin == null ? null : Math.round(avgWin * 100) / 100,
        avgLoss: avgLoss == null ? null : Math.round(avgLoss * 100) / 100,
        profitFactor: profitFactor == null ? null : Math.round(profitFactor * 100) / 100,
        maxDrawdownPct:
          maxDrawdownPct == null ? null : Math.round(maxDrawdownPct * 100) / 100,
        planRate: planRate == null ? null : Math.round(planRate * 10) / 10,
        topErrors,
        planCompare,
        stageGroups,
        modeGroups,
        emotionStats,
        equityCurve,
        lossStreak,
      };
    },
  }),

  // ----- 异动临界（第二档） -----
  listAbnormalWatches: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ watches: z.array(abnormalWatchShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.abnormalWatches)
        .where(eq(schema.abnormalWatches.date, args.date))
        .orderBy(asc(schema.abnormalWatches.id));
      return { watches: rows.map(abnormalWatchView) };
    },
  }),

  saveAbnormalWatch: defineAction({
    request: z.object({
      id: z.number().int().positive().optional(),
      date: dateStr,
      code: z.string().max(10),
      name: z.string().min(1).max(40),
      boardType: z.enum(["main", "chinext", "star", "st"]),
      stockChg: z.array(z.number().min(-30).max(30)).min(1).max(30),
      indexChg: z.array(z.number().min(-30).max(30)).min(1).max(30),
      turnover: z.array(z.number().min(0).max(100)).max(30).nullable(),
      note: z.string().max(500),
    }),
    response: z.object({ watch: abnormalWatchShape }),
    async handler(ctx, args) {
      if (args.stockChg.length !== args.indexChg.length) {
        throw new Error("stockChg and indexChg must have the same length");
      }
      if (args.turnover != null && args.turnover.length !== args.stockChg.length) {
        throw new Error("turnover must have the same length as stockChg");
      }
      const db = ctx.db<typeof schema>();
      const computed = computeAbnormal({
        boardType: args.boardType,
        stockChg: args.stockChg,
        indexChg: args.indexChg,
        turnover: args.turnover,
      });
      const values = {
        date: args.date,
        code: args.code,
        name: args.name,
        boardType: args.boardType,
        stockChg: JSON.stringify(args.stockChg),
        indexChg: JSON.stringify(args.indexChg),
        turnover: args.turnover == null ? null : JSON.stringify(args.turnover),
        dev3: computed.dev3,
        dev10: computed.dev10,
        dev30: computed.dev30,
        events10: computed.events10,
        turnoverState: computed.turnoverState,
        level: computed.level,
        gapPoints: computed.gapPoints,
        note: args.note,
      };
      // upsert：给了 id 按 id 更新；否则按 (date, code) 查找已有行更新。
      let targetId = args.id;
      if (targetId == null && args.code !== "") {
        const existing = await db
          .select({ id: schema.abnormalWatches.id })
          .from(schema.abnormalWatches)
          .where(
            and(
              eq(schema.abnormalWatches.date, args.date),
              eq(schema.abnormalWatches.code, args.code),
            ),
          )
          .limit(1);
        targetId = existing[0]?.id;
      }
      let row: typeof schema.abnormalWatches.$inferSelect | undefined;
      if (targetId != null) {
        const updated = await db
          .update(schema.abnormalWatches)
          .set(values)
          .where(eq(schema.abnormalWatches.id, targetId))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db
          .insert(schema.abnormalWatches)
          .values(values)
          .returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveAbnormalWatch failed");
      ctx.invalidateQueries();
      return { watch: abnormalWatchView(row) };
    },
  }),

  deleteAbnormalWatch: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.abnormalWatches)
        .where(eq(schema.abnormalWatches.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ----- 梯队结构（第三档）：梯队树 + 见顶五信号 + 空间板谱系 -----
  saveLadderEntry: defineAction({
    request: z.object({
      id: z.number().int().positive().optional(),
      date: dateStr,
      code: z.string().max(10),
      name: z.string().min(1).max(40),
      theme: z.string().max(60),
      boardDays: z.number().int().min(1).max(30),
      role: z
        .string()
        .refine(
          (s) =>
            ["spatial", "leader1", "leader2", "supplement", "follower", "middle", "other"].includes(s),
          { message: "role must be a known ladder role" },
        ),
      isSpatial: z.boolean(),
      sigBreakVolumeDown: z.boolean(),
      sigMultiOpenLateSeal: z.boolean(),
      sigSecondCollapse: z.boolean(),
      sigClarifyDeny: z.boolean(),
      sigDriveLoss: z.boolean(),
      note: z.string().max(500),
    }),
    response: z.object({ entry: ladderEntryShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        date: args.date,
        code: args.code,
        name: args.name,
        theme: args.theme,
        boardDays: args.boardDays,
        role: args.role,
        isSpatial: args.isSpatial ? 1 : 0,
        sigBreakVolumeDown: args.sigBreakVolumeDown ? 1 : 0,
        sigMultiOpenLateSeal: args.sigMultiOpenLateSeal ? 1 : 0,
        sigSecondCollapse: args.sigSecondCollapse ? 1 : 0,
        sigClarifyDeny: args.sigClarifyDeny ? 1 : 0,
        sigDriveLoss: args.sigDriveLoss ? 1 : 0,
        note: args.note,
      };
      // upsert：给了 id 按 id 更新；否则按 (date, code) 查已有行更新（code 为空时按 date+name）。
      let targetId = args.id;
      if (targetId == null) {
        const existing = await db
          .select({ id: schema.ladderEntries.id, code: schema.ladderEntries.code, name: schema.ladderEntries.name })
          .from(schema.ladderEntries)
          .where(eq(schema.ladderEntries.date, args.date));
        const hit = existing.find((e) =>
          args.code !== "" ? e.code === args.code : e.name === args.name,
        );
        targetId = hit?.id;
      }
      let row: typeof schema.ladderEntries.$inferSelect | undefined;
      if (targetId != null) {
        const updated = await db
          .update(schema.ladderEntries)
          .set(values)
          .where(eq(schema.ladderEntries.id, targetId))
          .returning();
        row = updated[0];
      } else {
        const inserted = await db.insert(schema.ladderEntries).values(values).returning();
        row = inserted[0];
      }
      if (!row) throw new Error("saveLadderEntry failed");
      ctx.invalidateQueries();
      return { entry: ladderEntryView(row) };
    },
  }),

  listLadderEntries: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ entries: z.array(ladderEntryShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ladderEntries)
        .where(eq(schema.ladderEntries.date, args.date))
        .orderBy(desc(schema.ladderEntries.boardDays), asc(schema.ladderEntries.id));
      return { entries: rows.map(ladderEntryView) };
    },
  }),

  deleteLadderEntry: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.ladderEntries).where(eq(schema.ladderEntries.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // 空间板谱系：最近 15 个有梯队记录的日期，每日取空间板
  // （isSpatial 优先，无则取 boardDays 最高者），按日期升序串成链条。
  getSpatialLineage: defineAction({
    request: z.object({}),
    response: z.object({
      nodes: z.array(
        z.object({
          date: z.string(),
          name: z.string(),
          code: z.string(),
          boardDays: z.number(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ladderEntries)
        .orderBy(desc(schema.ladderEntries.date));
      const byDate = new Map<string, (typeof rows)[number][]>();
      for (const r of rows) {
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }
      const dates = [...byDate.keys()].slice(0, 15);
      const nodes = dates
        .map((date) => {
          const list = byDate.get(date) ?? [];
          const spatial = list.filter((e) => e.isSpatial === 1);
          const pool = spatial.length > 0 ? spatial : list;
          const top = [...pool].sort((a, b) => b.boardDays - a.boardDays || a.id - b.id)[0];
          return top
            ? { date, name: top.name, code: top.code, boardDays: top.boardDays }
            : null;
        })
        .filter((n): n is NonNullable<typeof n> => n != null)
        .reverse();
      return { nodes };
    },
  }),

  // ----- 竞价回测（第二档）：外部任务同步 CSV 行 + 服务端统计 -----
  syncBacktestRows: defineAction({
    request: z.object({
      track: z.enum(["auction", "leader"]),
      rows: z.array(z.record(z.string(), z.unknown())).max(2000),
    }),
    response: z.object({ synced: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let synced = 0;
      for (const raw of args.rows) {
        const date = asStr(raw.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const code = asStr(raw.code);
        const bd = asNum(raw.board_days);
        const values = {
          track: args.track,
          date,
          code,
          payload: JSON.stringify(raw),
          recommended: asFlag(raw.recommended),
          vetoHit: asFlag(raw.veto_hit),
          successPick: asFlag(raw.success_pick),
          auctionGainPct: asNum(raw.auction_gain_pct),
          auctionVolRatio: asNum(raw.auction_vol_ratio),
          boardDays: bd != null ? Math.round(bd) : null,
          closedLimit: asFlag(raw.closed_limit),
          updatedAt: new Date(),
        };
        await db
          .insert(schema.backtestRows)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.backtestRows.track,
              schema.backtestRows.date,
              schema.backtestRows.code,
            ],
            set: {
              payload: values.payload,
              recommended: values.recommended,
              vetoHit: values.vetoHit,
              successPick: values.successPick,
              auctionGainPct: values.auctionGainPct,
              auctionVolRatio: values.auctionVolRatio,
              boardDays: values.boardDays,
              closedLimit: values.closedLimit,
              updatedAt: values.updatedAt,
            },
          });
        synced += 1;
      }
      ctx.invalidateQueries();
      return { synced };
    },
  }),

  getBacktestSummary: defineAction({
    request: z.object({ track: z.enum(["auction", "leader"]) }),
    response: z.object({
      track: z.string(),
      totalRows: z.number(),
      distinctDates: z.number(),
      recommendedTotal: z.number(),
      filledRecommended: z.number(),
      picksThreshold: z.number(),
      daysThreshold: z.number(),
      thresholdMet: z.boolean(),
      lowSample: z.boolean(),
      stats: z
        .object({
          successRate: z.number().nullable(), // %
          gainBuckets: z.array(
            z.object({
              label: z.string(),
              count: z.number(),
              successRate: z.number().nullable(),
            }),
          ),
          volBuckets: z.array(
            z.object({
              label: z.string(),
              count: z.number(),
              successRate: z.number().nullable(),
            }),
          ),
          boardBuckets: z.array(
            z.object({
              label: z.string(),
              count: z.number(),
              successRate: z.number().nullable(),
            }),
          ),
          vetoCounterfactual: z.object({
            count: z.number(),
            limitRate: z.number().nullable(), // %
          }),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.backtestRows)
        .where(eq(schema.backtestRows.track, args.track));
      const totalRows = rows.length;
      const distinctDates = new Set(rows.map((r) => r.date)).size;
      const rec = rows.filter((r) => r.recommended === 1);
      const filled = rec.filter((r) => r.successPick === 0 || r.successPick === 1);
      const filledRecommended = filled.length;
      const picksThreshold = 20;
      const daysThreshold = 10;
      const thresholdMet = filledRecommended >= picksThreshold && distinctDates >= daysThreshold;
      const lowSample = filledRecommended < 50;

      let stats: {
        successRate: number | null;
        gainBuckets: { label: string; count: number; successRate: number | null }[];
        volBuckets: { label: string; count: number; successRate: number | null }[];
        boardBuckets: { label: string; count: number; successRate: number | null }[];
        vetoCounterfactual: { count: number; limitRate: number | null };
      } | null = null;

      if (thresholdMet) {
        const rate = (list: typeof filled) =>
          list.length
            ? Math.round((list.filter((r) => r.successPick === 1).length / list.length) * 1000) / 10
            : null;
        const bucket = (label: string, list: typeof filled) => ({
          label,
          count: list.length,
          successRate: rate(list),
        });
        const gainOf = (r: (typeof filled)[number]) => r.auctionGainPct;
        const gainBuckets = [
          bucket("< +3%", filled.filter((r) => gainOf(r) != null && gainOf(r)! < 3)),
          bucket("+3 ~ +5%", filled.filter((r) => gainOf(r) != null && gainOf(r)! >= 3 && gainOf(r)! < 5)),
          bucket("+5 ~ +8%", filled.filter((r) => gainOf(r) != null && gainOf(r)! >= 5 && gainOf(r)! < 8)),
          bucket("+8% 以上", filled.filter((r) => gainOf(r) != null && gainOf(r)! >= 8)),
        ];
        const volBuckets = [
          bucket("无量比或 < 3", filled.filter((r) => r.auctionVolRatio == null || r.auctionVolRatio < 3)),
          bucket("量比 ≥ 3", filled.filter((r) => r.auctionVolRatio != null && r.auctionVolRatio >= 3)),
        ];
        const boardBuckets = [
          bucket("1 板", filled.filter((r) => r.boardDays === 1)),
          bucket("2 板", filled.filter((r) => r.boardDays === 2)),
          bucket("3 板以上", filled.filter((r) => r.boardDays != null && r.boardDays >= 3)),
        ];
        const vetoed = rows.filter((r) => r.vetoHit === 1 && r.closedLimit != null);
        stats = {
          successRate: rate(filled),
          gainBuckets,
          volBuckets,
          boardBuckets,
          vetoCounterfactual: {
            count: vetoed.length,
            limitRate: vetoed.length
              ? Math.round((vetoed.filter((r) => r.closedLimit === 1).length / vetoed.length) * 1000) / 10
              : null,
          },
        };
      }

      return {
        track: args.track,
        totalRows,
        distinctDates,
        recommendedTotal: rec.length,
        filledRecommended,
        picksThreshold,
        daysThreshold,
        thresholdMet,
        lowSample,
        stats,
      };
    },
  }),

  // ----- 今日页龙头推荐只读展示（读 backtest_rows 龙头轨，不新增表、不改统计） -----
  getLeaderPicks: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ rows: z.array(leaderPickShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.backtestRows)
        .where(
          and(
            eq(schema.backtestRows.track, "leader"),
            eq(schema.backtestRows.date, args.date),
          ),
        )
        .orderBy(asc(schema.backtestRows.id));
      return {
        rows: rows.map((r) => {
          let p: Record<string, unknown> = {};
          try {
            const v: unknown = JSON.parse(r.payload);
            if (v != null && typeof v === "object" && !Array.isArray(v)) {
              p = v as Record<string, unknown>;
            }
          } catch {
            // payload 损坏时按空字段展示，不编造
          }
          return {
            code: r.code !== "" ? r.code : asStr(p.code),
            name: asStr(p.name),
            theme: asStr(p.theme),
            boardDays: r.boardDays,
            cycleStage: asStr(p.cycle_stage),
            leaderRole: asStr(p.leader_role),
            expectationVerdict: asStr(p.expectation_verdict),
            entryRefPrice: asNum(p.entry_ref_price),
            vetoReason: asStr(p.veto_reason),
            recommended: r.recommended,
            vetoHit: r.vetoHit,
            closedLimit: r.closedLimit,
            nextOpenRetPct: asNum(p.next_open_ret_pct),
            successPick: r.successPick,
          };
        }),
      };
    },
  }),

  // ----- 盘中异动事件流：同步 / 列表 / 清理（界面只读，写入只来自这里） -----
  syncintradayevents: defineAction({
    request: z.object({
      // 带 events = 整批推送模式；不带 = 读采集器 events.jsonl 增量同步
      events: z
        .array(
          z.object({
            ts: z.string(),
            type: z.string(),
            code: z.string().optional(),
            name: z.string().optional(),
            detail: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .max(5000)
        .optional(),
      resetWatermark: z.boolean().optional(),
    }),
    response: syncIntradayResponse,
    privileged: [privileged.readCollectorStream, privileged.readCollectorHealth],
    async handler(ctx, args): Promise<z.infer<typeof syncIntradayResponse>> {
      // 整批推送模式
      if (args.events) {
        const { inserted, skipped } = await ingestIntradayEvents(ctx, args.events);
        let streamUpdatedAt: string | null = null;
        let sinaLastSuccessAt: string | null = null;
        try {
          const health = await ctx.executePrivileged(privileged.readCollectorHealth, {});
          streamUpdatedAt = health.streamUpdatedAt;
          sinaLastSuccessAt = health.sinaLastSuccessAt;
        } catch {
          // 健康信息取不到不影响同步结果
        }
        if (inserted > 0) ctx.invalidateQueries();
        return {
          inserted,
          skipped,
          streamUpdatedAt,
          sinaLastSuccessAt,
          lastEventTs: await lastIntradayEventTs(ctx),
          offset: await getIntradayOffset(ctx),
          error: "",
        };
      }

      // 文件模式：按 settings 里的字节水位线只处理新增行
      if (args.resetWatermark) await setIntradayOffset(ctx, 0);
      let offset = await getIntradayOffset(ctx);
      let stream: Awaited<
        ReturnType<typeof ctx.executePrivileged<typeof privileged.readCollectorStream>>
      >;
      try {
        stream = await ctx.executePrivileged(privileged.readCollectorStream, { offset });
      } catch (e) {
        return {
          inserted: 0,
          skipped: 0,
          streamUpdatedAt: null,
          sinaLastSuccessAt: null,
          lastEventTs: await lastIntradayEventTs(ctx),
          offset,
          error: `事件流读取失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (stream.error) {
        return {
          inserted: 0,
          skipped: 0,
          streamUpdatedAt: stream.health.streamUpdatedAt,
          sinaLastSuccessAt: stream.health.sinaLastSuccessAt,
          lastEventTs: await lastIntradayEventTs(ctx),
          offset,
          error: stream.error,
        };
      }
      // 文件被轮转（当前大小 < 水位线）时特权层已从 0 重读，靠唯一键防重复
      const from = offset > stream.size ? 0 : offset;
      let inserted = 0;
      let skipped = 0;
      let consumed = 0;
      if (stream.chunkBase64) {
        const text = Buffer.from(stream.chunkBase64, "base64").toString("utf8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl >= 0) {
          // 只消费完整行；末尾未写完的半行留给下一次同步
          const completeText = text.slice(0, lastNl + 1);
          const raws: RawIntradayEvent[] = [];
          for (const line of completeText.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const v: unknown = JSON.parse(t);
              if (v != null && typeof v === "object" && !Array.isArray(v)) {
                raws.push(v as RawIntradayEvent);
              } else {
                skipped += 1;
              }
            } catch {
              skipped += 1;
            }
          }
          const r = await ingestIntradayEvents(ctx, raws);
          inserted = r.inserted;
          skipped += r.skipped;
          consumed = Buffer.byteLength(completeText, "utf8");
        }
      }
      offset = from + consumed;
      await setIntradayOffset(ctx, offset);
      if (inserted > 0) ctx.invalidateQueries();
      return {
        inserted,
        skipped,
        streamUpdatedAt: stream.health.streamUpdatedAt,
        sinaLastSuccessAt: stream.health.sinaLastSuccessAt,
        lastEventTs: await lastIntradayEventTs(ctx),
        offset,
        error: "",
      };
    },
  }),

  listintradayevents: defineAction({
    request: z.object({
      date: dateStr.optional(), // 缺省取库中最新日期
      since: z.string().optional(), // 只返回 event_ts 晚于 since 的事件
    }),
    response: z.object({
      date: z.string().nullable(),
      events: z.array(intradayEventShape),
      stream: z.object({
        streamUpdatedAt: z.string().nullable(),
        lastEventTs: z.string().nullable(),
      }),
    }),
    privileged: [privileged.readCollectorHealth],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let date = args.date ?? null;
      if (!date) {
        const rows = await db
          .select({ date: schema.intradayEvents.date })
          .from(schema.intradayEvents)
          .orderBy(desc(schema.intradayEvents.date))
          .limit(1);
        date = rows[0]?.date ?? null;
      }
      let events: z.infer<typeof intradayEventShape>[] = [];
      if (date) {
        const conds = [eq(schema.intradayEvents.date, date)];
        if (args.since) conds.push(gt(schema.intradayEvents.eventTs, args.since));
        const rows = await db
          .select()
          .from(schema.intradayEvents)
          .where(and(...conds))
          .orderBy(desc(schema.intradayEvents.eventTs))
          .limit(1000);
        events = rows.map((r) => ({
          id: r.id,
          date: r.date,
          eventTs: r.eventTs,
          code: r.code,
          name: r.name,
          type: r.type,
          detailJson: r.detailJson,
          factText: r.factText,
        }));
      }
      let streamUpdatedAt: string | null = null;
      try {
        const health = await ctx.executePrivileged(privileged.readCollectorHealth, {});
        streamUpdatedAt = health.streamUpdatedAt;
      } catch {
        // 健康文件读不到时只报库内信息，界面据此显示状态缺失
      }
      return {
        date,
        events,
        stream: { streamUpdatedAt, lastEventTs: await lastIntradayEventTs(ctx) },
      };
    },
  }),

  // ----- 盘中实况快照：采集器四池 + 实时行情直通，派生盘中指标（只读） -----
  getIntradaySnapshot: defineAction({
    request: z.object({ date: dateStr }),
    response: intradaySnapshotResponse,
    privileged: [privileged.readCollectorIntraday],
    async handler(ctx, args): Promise<IntradaySnapshot> {
      let raw: Awaited<
        ReturnType<typeof ctx.executePrivileged<typeof privileged.readCollectorIntraday>>
      >;
      try {
        raw = await ctx.executePrivileged(privileged.readCollectorIntraday, {
          date: args.date,
        });
      } catch (e) {
        return emptyIntradaySnapshot(
          args.date,
          `盘中数据读取失败：${e instanceof Error ? e.message : String(e)}`,
          EMPTY_HEALTH,
        );
      }
      const health: IntradaySnapshot["health"] = {
        updatedAt: raw.health.updatedAt,
        poolDate: raw.health.poolDate,
        watchlistSize: raw.health.watchlistSize,
        watchlistSource: raw.health.watchlistSource,
        quotesSource: raw.health.quotesSource,
        poolRoute: raw.health.poolRoute,
        sinaLastSuccessAt: raw.health.sinaLastSuccessAt,
      };
      if (!raw.pools) {
        const snap = emptyIntradaySnapshot(args.date, raw.error, health);
        // 池子缺失时实时行情仍可单独展示（如开盘前只有行情在跑）
        snap.quotes = raw.quotes;
        snap.quotesUpdatedAt = raw.quotesUpdatedAt;
        return snap;
      }
      const pools = raw.pools;
      const ztAll = pools.zt;
      const zbAll = pools.zb;
      const dtAll = pools.dt;
      const yztAll = pools.yzt;

      const lbcOf = (r: IntradayPoolRow) =>
        r.lbc != null && r.lbc > 0 ? Math.round(r.lbc) : 1;
      const ztSorted = [...ztAll].sort((a, b) => {
        const d = lbcOf(b) - lbcOf(a);
        if (d !== 0) return d;
        return (b.sealFund ?? -1) - (a.sealFund ?? -1);
      });
      const maxBoard =
        ztSorted.length > 0 ? Math.max(...ztSorted.map(lbcOf)) : null;

      const tierMap = new Map<number, number>();
      for (const r of ztSorted) tierMap.set(lbcOf(r), (tierMap.get(lbcOf(r)) ?? 0) + 1);
      const tiers = [...tierMap.entries()]
        .map(([boards, count]) => ({ boards, count }))
        .sort((a, b) => b.boards - a.boards);
      let ladderGap = false;
      if (maxBoard != null && maxBoard >= 3) {
        for (let b = 2; b < maxBoard; b += 1) {
          if (!tierMap.has(b)) {
            ladderGap = true;
            break;
          }
        }
      }

      const denom = ztAll.length + zbAll.length;
      const sealRatePct = denom > 0 ? round2((ztAll.length / denom) * 100) : null;

      const yztPcts = yztAll
        .map((r) => r.pct)
        .filter((p): p is number => p != null);
      const prevPremiumPct =
        yztPcts.length > 0
          ? round2(yztPcts.reduce((s, p) => s + p, 0) / yztPcts.length)
          : null;
      const yztUpCount = yztPcts.filter((p) => p > 0).length;

      const themeMap = new Map<string, number>();
      for (const r of ztAll) {
        if (r.industry) themeMap.set(r.industry, (themeMap.get(r.industry) ?? 0) + 1);
      }
      const themes = [...themeMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 6);

      const yztByPct = [...yztAll].sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));
      const yztTop = yztByPct.slice(0, 5);
      const topCodes = new Set(yztTop.map((r) => r.code));
      const yztBottom = [...yztByPct]
        .reverse()
        .filter((r) => yztAll.length <= 10 ? !topCodes.has(r.code) : true)
        .slice(0, 5);

      return {
        date: args.date,
        available: true,
        error: raw.error,
        poolsFetchedAt: pools.fetchedAt,
        quotesUpdatedAt: raw.quotesUpdatedAt,
        health,
        limitUpCount: ztAll.length,
        limitDownCount: dtAll.length,
        brokenCount: zbAll.length,
        maxBoard,
        sealRatePct,
        brokenRatePct: sealRatePct == null ? null : round2(100 - sealRatePct),
        prevPremiumPct,
        yztCount: yztAll.length,
        yztUpCount,
        ladderGap,
        tiers,
        themes,
        zt: ztSorted.slice(0, 80),
        zb: [...zbAll]
          .sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999))
          .slice(0, 30),
        dt: [...dtAll]
          .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999))
          .slice(0, 30),
        yztTop,
        yztBottom,
        quotes: raw.quotes,
      };
    },
  }),

  // ----- 小黑板（宽度×TRIN 旁证）+ 大钱去哪了（板块资金流） -----
  // 数据只来自 breadth-trin 本地存档文件，经特权层读取后由
  // syncBreadthFundflow 幂等 upsert；getBreadth / getFundflow 只读库内
  // 已同步数据并做口径明确的派生计算（吸金力、四种天气、信号清单、
  // 窗口滚动汇总）。两页均为旁证参考：不进裁决、不改仓位。

  syncBreadthFundflow: defineAction({
    request: z.object({}),
    response: z.object({
      breadthDays: z.number(),
      fundflowDays: z.number(),
      latestBreadthDate: z.string().nullable(),
      latestFundflowDate: z.string().nullable(),
      error: z.string(),
    }),
    privileged: [privileged.readBreadthFundflow],
    async handler(ctx): Promise<{
      breadthDays: number;
      fundflowDays: number;
      latestBreadthDate: string | null;
      latestFundflowDate: string | null;
      error: string;
    }> {
      const db = ctx.db<typeof schema>();
      let raw: Awaited<
        ReturnType<typeof ctx.executePrivileged<typeof privileged.readBreadthFundflow>>
      >;
      try {
        raw = await ctx.executePrivileged(privileged.readBreadthFundflow, {});
      } catch (e) {
        return {
          breadthDays: 0,
          fundflowDays: 0,
          latestBreadthDate: null,
          latestFundflowDate: null,
          error: `同步读取失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const now = new Date();
      for (const b of raw.breadth) {
        await db
          .insert(schema.breadthRecords)
          .values({
            date: b.date,
            up: b.up,
            down: b.down,
            flat: b.flat,
            redPct: b.red,
            trinAmt: b.trinAmt,
            trinVol: b.trinVol,
            stage: b.stage,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.breadthRecords.date,
            set: {
              up: b.up,
              down: b.down,
              flat: b.flat,
              redPct: b.red,
              trinAmt: b.trinAmt,
              trinVol: b.trinVol,
              stage: b.stage,
              updatedAt: now,
            },
          });
      }
      for (const r of raw.fundflowRows) {
        if (r.kind !== "industry" && r.kind !== "concept") continue;
        if (!r.name) continue;
        await db
          .insert(schema.fundflowRecords)
          .values({
            date: r.date,
            kind: r.kind,
            name: r.name,
            netYuan: r.netYuan,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.fundflowRecords.date,
              schema.fundflowRecords.kind,
              schema.fundflowRecords.name,
            ],
            set: { netYuan: r.netYuan, updatedAt: now },
          });
      }
      const breadthDates = await db
        .select({ date: schema.breadthRecords.date })
        .from(schema.breadthRecords)
        .orderBy(desc(schema.breadthRecords.date));
      const fundflowDatesRows = await db
        .select({ date: schema.fundflowRecords.date })
        .from(schema.fundflowRecords)
        .orderBy(desc(schema.fundflowRecords.date));
      const fundflowDays = new Set(fundflowDatesRows.map((r) => r.date)).size;
      if (raw.breadth.length > 0 || raw.fundflowRows.length > 0) {
        ctx.invalidateQueries();
      }
      return {
        breadthDays: breadthDates.length,
        fundflowDays,
        latestBreadthDate: breadthDates[0]?.date ?? null,
        latestFundflowDate: fundflowDatesRows[0]?.date ?? null,
        error: raw.error,
      };
    },
  }),

  getBreadth: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({
      date: z.string(),
      hasData: z.boolean(),
      record: z
        .object({
          date: z.string(),
          up: z.number().nullable(),
          down: z.number().nullable(),
          flat: z.number().nullable(),
          redPct: z.number().nullable(),
          trinAmt: z.number().nullable(),
          trinVol: z.number().nullable(),
          suction: z.number().nullable(),
          stage: z.string(),
        })
        .nullable(),
      series: z.array(
        z.object({
          date: z.string(),
          up: z.number().nullable(),
          down: z.number().nullable(),
          flat: z.number().nullable(),
          redPct: z.number().nullable(),
          trinAmt: z.number().nullable(),
          trinVol: z.number().nullable(),
          suction: z.number().nullable(),
          stage: z.string(),
        }),
      ),
      weather: z.string().nullable(),
      weatherDetail: z.string(),
      bottomSignals: z.array(
        z.object({ key: z.string(), label: z.string(), hit: z.boolean() }),
      ),
      topSignals: z.array(
        z.object({ key: z.string(), label: z.string(), hit: z.boolean() }),
      ),
      bottomHits: z.number(),
      topHits: z.number(),
      latestDate: z.string().nullable(),
      totalDays: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const suctionOf = (trinAmt: number | null): number | null =>
        trinAmt != null && trinAmt !== 0
          ? Math.round((1 / trinAmt) * 1000) / 1000
          : null;
      const view = (row: typeof schema.breadthRecords.$inferSelect) => ({
        date: row.date,
        up: row.up,
        down: row.down,
        flat: row.flat,
        redPct: row.redPct,
        trinAmt: row.trinAmt,
        trinVol: row.trinVol,
        suction: suctionOf(row.trinAmt),
        stage: row.stage,
      });
      const allDates = await db
        .select({ date: schema.breadthRecords.date })
        .from(schema.breadthRecords)
        .orderBy(desc(schema.breadthRecords.date));
      const rowsDesc = await db
        .select()
        .from(schema.breadthRecords)
        .where(lte(schema.breadthRecords.date, args.date))
        .orderBy(desc(schema.breadthRecords.date))
        .limit(40);
      const seriesAsc = [...rowsDesc].reverse();
      const series = seriesAsc.map(view);
      const idx = seriesAsc.findIndex((r) => r.date === args.date);
      const recordRow = idx >= 0 ? seriesAsc[idx] : undefined;
      const record = recordRow ? view(recordRow) : null;

      // 四种天气：涨面 50% 为界、吸金力 1 为界（小黑板口径）
      let weather: string | null = null;
      let weatherDetail = "";
      if (record && record.redPct != null && record.suction != null) {
        const red = record.redPct;
        const s = record.suction;
        if (red >= 50 && s >= 1) {
          weather = "热得实";
          weatherDetail = "涨的人多，钱也追着涨股跑。";
        } else if (red >= 50 && s < 1) {
          weather = "热得虚";
          weatherDetail =
            "涨的人多，但钱追涨的劲一般甚至偏弱——热闹是真的，力气没跟上，出现在高位要多留个心眼。";
        } else if (red < 50 && s >= 1) {
          weather = "冷中有火";
          weatherDetail =
            "跌的人多，但钱在悄悄追少数涨股；也可能只是跌停的股票卖不掉、显得跌股没量，要连看几天才能分清。";
        } else {
          weather = "冷得实";
          weatherDetail = "跌的人多，钱还往跌股上砸，卖的人最凶、最难熬的时候。";
        }
      }

      // 顶/底信号清单（机械计数，口径写死）：
      // B1 红盘率 <10%；B2 前一日 B1 且今日红盘率 ≥50% 且吸金力 ≥1；
      // B3 跌家数连续两日减少（今 < 昨 < 前日）；
      // T1 红盘率 ≥80%；T2 吸金力连续两日下降且今日红盘率 ≥50%；
      // T3 前一日红盘率 ≥65% 且今日较昨日骤降 ≥20 个点。
      const prev = idx >= 1 ? series[idx - 1] : undefined;
      const prev2 = idx >= 2 ? series[idx - 2] : undefined;
      const red = record?.redPct ?? null;
      const suc = record?.suction ?? null;
      const bottomSignals = [
        {
          key: "B1",
          label: "B1 冷到极点：100 家里涨的不到 10 家",
          hit: red != null && red < 10,
        },
        {
          key: "B2",
          label: "B2 冷极回暖：昨天冷到极点，今天涨面回到一半以上、钱开始追涨股",
          hit:
            prev != null &&
            prev.redPct != null &&
            prev.redPct < 10 &&
            red != null &&
            red >= 50 &&
            suc != null &&
            suc >= 1,
        },
        {
          key: "B3",
          label: "B3 跌家数连减：跌的家数连着两天变少，跌势在变弱",
          hit:
            record != null &&
            prev != null &&
            prev2 != null &&
            record.down != null &&
            prev.down != null &&
            prev2.down != null &&
            record.down < prev.down &&
            prev.down < prev2.down,
        },
      ];
      const topSignals = [
        {
          key: "T1",
          label: "T1 热到极点：100 家里 80 家以上在涨",
          hit: red != null && red >= 80,
        },
        {
          key: "T2",
          label: "T2 吸金力连降：涨面还广，但钱追涨的劲连着两天往下掉",
          hit:
            suc != null &&
            prev?.suction != null &&
            prev2?.suction != null &&
            suc < prev.suction &&
            prev.suction < prev2.suction &&
            red != null &&
            red >= 50,
        },
        {
          key: "T3",
          label: "T3 涨面骤缩：涨面比昨天一下少了 20 家以上",
          hit:
            prev?.redPct != null &&
            red != null &&
            prev.redPct >= 65 &&
            prev.redPct - red >= 20,
        },
      ];
      return {
        date: args.date,
        hasData: record != null,
        record,
        series,
        weather,
        weatherDetail,
        bottomSignals,
        topSignals,
        bottomHits: bottomSignals.filter((s) => s.hit).length,
        topHits: topSignals.filter((s) => s.hit).length,
        latestDate: allDates[0]?.date ?? null,
        totalDays: allDates.length,
      };
    },
  }),

  getFundflow: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({
      date: z.string(),
      hasData: z.boolean(),
      isMissing: z.boolean(),
      latestDate: z.string().nullable(),
      daysAvailable: z.number(),
      todayIndustryIn: z.array(
        z.object({ name: z.string(), netYuan: z.number().nullable() }),
      ),
      todayIndustryOut: z.array(
        z.object({ name: z.string(), netYuan: z.number().nullable() }),
      ),
      todayConceptIn: z.array(
        z.object({ name: z.string(), netYuan: z.number().nullable() }),
      ),
      todayConceptOut: z.array(
        z.object({ name: z.string(), netYuan: z.number().nullable() }),
      ),
      windows: z.array(
        z.object({
          label: z.string(),
          daysRequested: z.number(),
          daysActual: z.number(),
          industryTopIn: z.array(
            z.object({ name: z.string(), netYuan: z.number().nullable() }),
          ),
          industryTopOut: z.array(
            z.object({ name: z.string(), netYuan: z.number().nullable() }),
          ),
          conceptTopIn: z.array(
            z.object({ name: z.string(), netYuan: z.number().nullable() }),
          ),
          conceptTopOut: z.array(
            z.object({ name: z.string(), netYuan: z.number().nullable() }),
          ),
        }),
      ),
      streaksIndustry: z.array(
        z.object({ name: z.string(), days: z.number() }),
      ),
      streaksConcept: z.array(
        z.object({ name: z.string(), days: z.number() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      type Item = { name: string; netYuan: number | null };
      const topLists = (
        rows: { name: string; netYuan: number | null }[],
      ): { topIn: Item[]; topOut: Item[] } => {
        const sorted = [...rows]
          .filter((r) => r.netYuan != null)
          .sort((a, b) => (b.netYuan ?? 0) - (a.netYuan ?? 0));
        return {
          topIn: sorted.filter((r) => (r.netYuan ?? 0) > 0).slice(0, 5),
          topOut: sorted
            .filter((r) => (r.netYuan ?? 0) < 0)
            .slice(-5)
            .reverse(),
        };
      };
      const allDateRows = await db
        .select({ date: schema.fundflowRecords.date })
        .from(schema.fundflowRecords)
        .orderBy(desc(schema.fundflowRecords.date));
      const allDates = [...new Set(allDateRows.map((r) => r.date))];
      const rowsLe = await db
        .select()
        .from(schema.fundflowRecords)
        .where(lte(schema.fundflowRecords.date, args.date));
      const datesLe = [...new Set(rowsLe.map((r) => r.date))].sort();
      const todayRows = rowsLe.filter((r) => r.date === args.date);
      const indToday = topLists(
        todayRows.filter((r) => r.kind === "industry"),
      );
      const conToday = topLists(
        todayRows.filter((r) => r.kind === "concept"),
      );
      const windowDefs: { n: number; label: string }[] = [
        { n: 3, label: "近3天" },
        { n: 5, label: "近5天" },
        { n: 10, label: "近10天" },
        { n: 15, label: "近半月" },
      ];
      const windows = windowDefs.map(({ n, label }) => {
        const usedDates = datesLe.slice(-n);
        const used = rowsLe.filter((r) => usedDates.includes(r.date));
        const agg = (kind: string): Item[] => {
          const m = new Map<string, number>();
          for (const r of used) {
            if (r.kind !== kind || r.netYuan == null) continue;
            m.set(r.name, (m.get(r.name) ?? 0) + r.netYuan);
          }
          return [...m.entries()].map(([name, netYuan]) => ({ name, netYuan }));
        };
        const ind = topLists(agg("industry"));
        const con = topLists(agg("concept"));
        return {
          label,
          daysRequested: n,
          daysActual: usedDates.length,
          industryTopIn: ind.topIn.slice(0, 3),
          industryTopOut: ind.topOut.slice(0, 3),
          conceptTopIn: con.topIn.slice(0, 3),
          conceptTopOut: con.topOut.slice(0, 3),
        };
      });
      const streaks = (kind: string): { name: string; days: number }[] => {
        if (datesLe.length === 0) return [];
        const latest = datesLe[datesLe.length - 1]!;
        const names = rowsLe
          .filter((r) => r.date === latest && r.kind === kind)
          .map((r) => r.name);
        const out: { name: string; days: number }[] = [];
        for (const name of names) {
          let s = 0;
          for (let i = datesLe.length - 1; i >= 0; i--) {
            const row = rowsLe.find(
              (r) => r.date === datesLe[i] && r.kind === kind && r.name === name,
            );
            if (row && row.netYuan != null && row.netYuan > 0) s += 1;
            else break;
          }
          if (s >= 3) out.push({ name, days: s });
        }
        return out.sort((a, b) => b.days - a.days).slice(0, 8);
      };
      return {
        date: args.date,
        hasData: todayRows.length > 0,
        isMissing: todayRows.length === 0,
        latestDate: allDates[0] ?? null,
        daysAvailable: allDates.length,
        todayIndustryIn: indToday.topIn,
        todayIndustryOut: indToday.topOut,
        todayConceptIn: conToday.topIn,
        todayConceptOut: conToday.topOut,
        windows,
        streaksIndustry: streaks("industry"),
        streaksConcept: streaks("concept"),
      };
    },
  }),

  clearintradayevents: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ deleted: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const res = await db
        .delete(schema.intradayEvents)
        .where(eq(schema.intradayEvents.date, args.date))
        .returning({ id: schema.intradayEvents.id });
      if (res.length > 0) ctx.invalidateQueries();
      return { deleted: res.length };
    },
  }),

  // ----- 盘后对账（数据源重规划阶段1） -----
  // 每晚 21:30 对账任务经 savereconciliation 按 date upsert 写入一条；
  // getreconciliation / listreconciliations 只读。界面无编辑入口。

  savereconciliation: defineAction({
    request: z.object({
      date: dateStr,
      status: reconStatus,
      selfZtAll: z.number().int().min(0).max(100000).nullable().optional(),
      selfZtNoSt: z.number().int().min(0).max(100000).nullable().optional(),
      selfZtDesk: z.number().int().min(0).max(100000).nullable().optional(),
      selfDtDesk: z.number().int().min(0).max(100000).nullable().optional(),
      selfTouchedDesk: z.number().int().min(0).max(100000).nullable().optional(),
      selfSealRateDesk: z.number().min(0).max(100).nullable().optional(),
      emZt: z.number().int().min(0).max(100000).nullable().optional(),
      emZb: z.number().int().min(0).max(100000).nullable().optional(),
      emDt: z.number().int().min(0).max(100000).nullable().optional(),
      emSealRate: z.number().min(0).max(100).nullable().optional(),
      thsZt: z.number().int().min(0).max(100000).nullable().optional(),
      deskLimitUpCount: z.number().int().min(0).max(100000).nullable().optional(),
      deskLimitDownCount: z.number().int().min(0).max(100000).nullable().optional(),
      lbcMismatch: z
        .array(
          z.object({
            code: z.string().max(12).default(""),
            name: z.string().max(40),
            selfLbc: z.number().int().min(0).max(60).nullable().default(null),
            emLbc: z.number().int().min(0).max(60).nullable().default(null),
          }),
        )
        .max(500)
        .optional(),
      lbcTop: z
        .array(
          z.object({
            code: z.string().max(12).default(""),
            name: z.string().max(40),
            lbc: z.number().int().min(0).max(60),
          }),
        )
        .max(5)
        .optional(),
      diff: z
        .record(
          z.string(),
          z.array(
            z.union([
              z.string().max(60),
              z.object({
                code: z.string().max(12).default(""),
                name: z.string().max(40),
              }),
            ]),
          ),
        )
        .optional(),
      notes: z
        .union([z.string().max(4000), z.array(z.string().max(1000)).max(50)])
        .optional(),
    }),
    response: z.object({ record: reconciliationShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const notesArr =
        args.notes == null
          ? []
          : typeof args.notes === "string"
            ? args.notes
              ? [args.notes]
              : []
            : args.notes;
      const values = {
        date: args.date,
        status: args.status,
        selfZtAll: args.selfZtAll ?? null,
        selfZtNoSt: args.selfZtNoSt ?? null,
        selfZtDesk: args.selfZtDesk ?? null,
        selfDtDesk: args.selfDtDesk ?? null,
        selfTouchedDesk: args.selfTouchedDesk ?? null,
        selfSealRateDesk: args.selfSealRateDesk ?? null,
        emZt: args.emZt ?? null,
        emZb: args.emZb ?? null,
        emDt: args.emDt ?? null,
        emSealRate: args.emSealRate ?? null,
        thsZt: args.thsZt ?? null,
        deskLimitUpCount: args.deskLimitUpCount ?? null,
        deskLimitDownCount: args.deskLimitDownCount ?? null,
        lbcMismatch: JSON.stringify(args.lbcMismatch ?? []),
        lbcTop: JSON.stringify(args.lbcTop ?? []),
        diff: JSON.stringify(args.diff ?? {}),
        notes: JSON.stringify(notesArr),
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(schema.reconciliations)
        .values(values)
        .onConflictDoUpdate({
          target: schema.reconciliations.date,
          set: {
            status: values.status,
            selfZtAll: values.selfZtAll,
            selfZtNoSt: values.selfZtNoSt,
            selfZtDesk: values.selfZtDesk,
            selfDtDesk: values.selfDtDesk,
            selfTouchedDesk: values.selfTouchedDesk,
            selfSealRateDesk: values.selfSealRateDesk,
            emZt: values.emZt,
            emZb: values.emZb,
            emDt: values.emDt,
            emSealRate: values.emSealRate,
            thsZt: values.thsZt,
            deskLimitUpCount: values.deskLimitUpCount,
            deskLimitDownCount: values.deskLimitDownCount,
            lbcMismatch: values.lbcMismatch,
            lbcTop: values.lbcTop,
            diff: values.diff,
            notes: values.notes,
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      if (!row) throw new Error("savereconciliation failed");
      ctx.invalidateQueries();
      return { record: reconciliationView(row) };
    },
  }),

  getreconciliation: defineAction({
    request: z.object({ date: dateStr }),
    response: z.object({ record: reconciliationShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.reconciliations)
        .where(eq(schema.reconciliations.date, args.date))
        .limit(1);
      const row = rows[0];
      return { record: row ? reconciliationView(row) : null };
    },
  }),

  listreconciliations: defineAction({
    request: z.object({
      limit: z.number().int().min(1).max(90).default(30),
    }),
    response: z.object({ records: z.array(reconciliationShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.reconciliations)
        .orderBy(desc(schema.reconciliations.date))
        .limit(args.limit);
      return { records: rows.map(reconciliationView) };
    },
  }),
} satisfies ActionsModule;
