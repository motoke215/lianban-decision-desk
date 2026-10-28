// Shared constants + deterministic decision logic for 连板决策台.
// The verdict and sizing math live here so every screen shows the same numbers
// the proposal promised: 红灯一票否决、评分门槛、1% 风险仓位、连亏熔断。

export type DayLike = {
  maxBoard: number | null;
  brokenRate: number | null;
  maxDrop: number | null;
  ladderGap: boolean;
  ebbSignal: boolean;
} | null;

export type VerdictLevel = "attack" | "cautious" | "rest";

export type Verdict = {
  level: VerdictLevel;
  label: string;
  position: number; // 建议仓位 %
  positionText: string;
  reasons: string[];
};

export function computeVerdict(day: DayLike): Verdict | null {
  if (!day) return null;
  const reasons: string[] = [];
  let rest = false;
  let attack = true;

  if (day.ebbSignal) {
    rest = true;
    reasons.push("出现退潮信号：高标亏钱效应扩散，今天以保住本金为先");
  }
  if (day.ladderGap && (day.maxBoard ?? 99) <= 3) {
    rest = true;
    reasons.push("梯队断层且最高板只有 3 板以下，接力没有梯队可依");
  }
  if (day.brokenRate != null && day.brokenRate >= 50) {
    rest = true;
    reasons.push(`炸板率 ${day.brokenRate}%，一半的板封不住，追板胜率极低`);
  }
  if (day.maxDrop === -2 && (day.maxBoard ?? 99) <= 4) {
    rest = true;
    reasons.push("昨日高标今日跌停，亏钱效应传导到整个梯队");
  }

  if (day.maxBoard == null || day.maxBoard < 5) {
    attack = false;
    if (day.maxBoard != null) reasons.push(`最高板 ${day.maxBoard} 板，空间还没打开`);
  }
  if (day.brokenRate == null || day.brokenRate >= 30) {
    attack = false;
    if (day.brokenRate != null && day.brokenRate >= 30 && day.brokenRate < 50)
      reasons.push(`炸板率 ${day.brokenRate}%，封板质量一般，只能挑最强的做`);
  }
  if (day.ladderGap) {
    attack = false;
    reasons.push("梯队有断层，高位股缺跟风助攻");
  }
  if (day.maxDrop === -2) {
    attack = false;
    reasons.push("昨日高标吃跌停，高位接力要降仓位");
  }
  if (day.brokenRate != null && day.brokenRate < 30 && (day.maxBoard ?? 0) >= 5 && !day.ladderGap) {
    reasons.push(
      `最高 ${day.maxBoard} 板、炸板率仅 ${day.brokenRate}%，梯队完整，情绪在进攻周期`,
    );
  }

  if (rest) {
    return {
      level: "rest",
      label: "空仓观望",
      position: 0,
      positionText: "空仓",
      reasons: reasons.length ? reasons : ["环境不支持出手"],
    };
  }
  if (attack) {
    return {
      level: "attack",
      label: "可以进攻",
      position: 60,
      positionText: "五到七成",
      reasons,
    };
  }
  return {
    level: "cautious",
    label: "谨慎试仓",
    position: 25,
    positionText: "二到三成",
    reasons: reasons.length ? reasons : ["环境中性，只做评分最高的票，小仓位试错"],
  };
}

// ----- 量化定调（六项指标投票，规则引自龙头战法手册与统一基准） -----

export const CYCLE_STAGES = ["冰点", "混沌", "发酵", "主升", "分歧", "退潮"] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];

// 投票档位（分歧不是投票档，是无档位达 4 票时的计算结果）
export type StageTier = "主升" | "发酵" | "混沌" | "退潮" | "冰点";
export const STAGE_TIERS: StageTier[] = ["主升", "发酵", "混沌", "退潮", "冰点"];

export type CycleDayLike = {
  limitUpCount: number | null;
  limitDownCount: number | null;
  maxBoard: number | null;
  prevPremiumPct: number | null;
  sealRatePct: number | null;
  ladderGap: boolean;
} | null;

export type CycleIndicator = {
  key: string;
  label: string;
  valueText: string; // 缺数据为「未查得」
  missing: boolean;
  vote: StageTier | null; // 缺数据不投票
};

export type CycleAssessment = {
  indicators: CycleIndicator[];
  votes: Record<StageTier, number>;
  computed: string; // 计算定调
  mainWin: boolean; // 是否主升档胜出
};

function voteLimitUp(n: number): StageTier {
  if (n >= 80) return "主升";
  if (n >= 55) return "发酵";
  if (n >= 35) return "混沌";
  if (n >= 20) return "退潮";
  return "冰点";
}

function voteLimitDown(n: number): StageTier {
  if (n <= 9) return "主升";
  if (n <= 14) return "发酵";
  if (n <= 19) return "混沌";
  if (n <= 29) return "退潮";
  return "冰点";
}

function voteMaxBoard(n: number): StageTier {
  if (n >= 6) return "主升";
  if (n === 5) return "发酵";
  if (n >= 3) return "混沌";
  if (n === 2) return "退潮";
  return "冰点"; // ≤1 或高度缺位
}

function votePremium(p: number): StageTier {
  if (p >= 3) return "主升";
  if (p >= 1) return "发酵";
  if (p >= 0) return "混沌";
  if (p >= -2) return "退潮";
  return "冰点";
}

function voteSeal(s: number): StageTier {
  if (s >= 80) return "主升";
  if (s >= 65) return "发酵";
  if (s >= 50) return "混沌";
  if (s >= 35) return "退潮";
  return "冰点";
}

export function assessCycle(day: CycleDayLike): CycleAssessment | null {
  if (!day) return null;
  const votes: Record<StageTier, number> = {
    主升: 0,
    发酵: 0,
    混沌: 0,
    退潮: 0,
    冰点: 0,
  };
  const mk = (
    key: string,
    label: string,
    value: number | null,
    format: (n: number) => string,
    voteFn: (n: number) => StageTier,
  ): CycleIndicator => {
    if (value == null) {
      return { key, label, valueText: "未查得", missing: true, vote: null };
    }
    const vote = voteFn(value);
    votes[vote] += 1;
    return { key, label, valueText: format(value), missing: false, vote };
  };

  const indicators: CycleIndicator[] = [
    mk("limitUp", "涨停家数", day.limitUpCount, (n) => `${n} 家`, voteLimitUp),
    mk("limitDown", "跌停家数", day.limitDownCount, (n) => `${n} 家`, voteLimitDown),
    mk("maxBoard", "最高连板", day.maxBoard, (n) => `${n} 板`, voteMaxBoard),
    mk(
      "premium",
      "昨涨溢价",
      day.prevPremiumPct,
      (n) => `${n > 0 ? "+" : ""}${n}%`,
      votePremium,
    ),
    mk("seal", "封板率", day.sealRatePct, (n) => `${n}%`, voteSeal),
  ];
  // 梯队完整度是逆向校验项：只有两档投票（无断层投主升、断层投混沌）
  const gapVote: StageTier = day.ladderGap ? "混沌" : "主升";
  votes[gapVote] += 1;
  indicators.push({
    key: "ladder",
    label: "梯队完整度",
    valueText: day.ladderGap ? "有断层" : "无断层",
    missing: false,
    vote: gapVote,
  });

  const winner = STAGE_TIERS.find((t) => votes[t] >= 4) ?? null;
  let computed: string;
  let mainWin = false;
  if (winner === "主升") {
    mainWin = true;
    computed =
      day.limitUpCount != null && day.limitUpCount >= 80 ? "主升（高潮）" : "主升";
  } else if (winner) {
    computed = winner;
  } else {
    computed = "分歧（指标分裂）";
  }
  return { indicators, votes, computed, mainWin };
}

// ----- 确认推演器（统一基准确认规则，严格按规格） -----

export type TriState = "pass" | "fail" | "unknown";

export type ConfirmInput = {
  condPremium: TriState; // 昨涨溢价守 +2%
  condSeal: TriState; // 封板率守 80%
  condLeader: TriState; // 双龙竞价不落入不及预期档
  gapFilled: boolean; // 4–5 板断层被中位补涨填上（附加项）
  danger: boolean; // 任一空间板竞价不及预期（低开）
};

export type ConfirmResult = {
  cap: number; // 仓位上限 %
  headline: string; // 结论句主文
  degraded: boolean; // 是否追加降级分歧说明
  pending: boolean; // 是否有未验证项
};

export function computeConfirm(input: ConfirmInput): ConfirmResult {
  const conds = [input.condPremium, input.condSeal, input.condLeader];
  const passes = conds.filter((c) => c === "pass").length;
  const pending = conds.some((c) => c === "unknown");
  if (input.danger) {
    return { cap: 0, headline: "空仓预案", degraded: false, pending };
  }
  if (passes === 3 && input.gapFilled) {
    return { cap: 40, headline: "主升确认，可放宽", degraded: false, pending: false };
  }
  return {
    cap: 30,
    headline: "默认上限",
    degraded: passes < 2,
    pending,
  };
}

// ----- 竞价验证（龙头战法手册第三节预期基线表，第二档） -----

export const YDAY_STATES = [
  { key: "shrink", label: "缩量/一字未开板" },
  { key: "strong", label: "早盘强封" },
  { key: "voldiff", label: "爆量分歧板" },
  { key: "weaklate", label: "烂板/尾盘板" },
  { key: "broken", label: "断板股" },
  { key: "spatial", label: "空间板形态" },
] as const;

export type YdayStateKey = (typeof YDAY_STATES)[number]["key"];

export function ydayStateLabel(key: string): string {
  return YDAY_STATES.find((s) => s.key === key)?.label ?? "";
}

export type AuctionVerdictKind = "over" | "meet" | "under" | "unverified";

export type AuctionAssessment = {
  kind: AuctionVerdictKind;
  label: string;
  tags: string[];
};

// 先判强制修正（优先级最高），再按昨日形态判符合/超预期区间，未落入者一律不及预期。
export function assessAuction(input: {
  g: number | null;
  r: number | null;
  boardDays: number | null;
  ydayState: string;
}): AuctionAssessment {
  const { g, r, boardDays, ydayState } = input;
  if (g == null) return { kind: "unverified", label: "未验证", tags: [] };

  // 强制修正一：高位爆量高开 = 兑现嫌疑
  if (boardDays != null && boardDays >= 4 && g >= 8 && r != null && r >= 5) {
    return { kind: "under", label: "不及预期", tags: ["高位过热（兑现嫌疑）"] };
  }
  // 强制修正二：空间板低开 = 情绪转折
  if (boardDays != null && boardDays >= 5 && g < 0) {
    return { kind: "under", label: "不及预期", tags: [] };
  }
  if (!ydayState) return { kind: "unverified", label: "未验证", tags: [] };

  const over = (tags: string[] = []): AuctionAssessment => ({
    kind: "over",
    label: "超预期",
    tags,
  });
  const meet = (tags: string[] = []): AuctionAssessment => ({
    kind: "meet",
    label: "符合预期",
    tags,
  });
  const under = (tags: string[] = []): AuctionAssessment => ({
    kind: "under",
    label: "不及预期",
    tags,
  });

  switch (ydayState) {
    case "shrink":
      if (g >= 9.9) return meet(["续一字"]);
      return g >= 7 ? meet() : under();
    case "strong":
      if (g >= 7 || (g >= 5 && r != null && r >= 3)) return over();
      return g >= 3 && g <= 6 ? meet() : under();
    case "voldiff":
      if (g >= 4 && r != null && r >= 3) return over(["弱转强"]);
      return g >= 0 && g <= 3 ? meet() : under();
    case "weaklate":
      if (g >= 3) return over(r != null && r >= 3 ? ["待开盘验证", "弱转强"] : ["待开盘验证"]);
      return g >= 0 && g <= 2 ? meet() : under();
    case "broken": {
      const tags = g <= -9 ? ["核按钮"] : [];
      if (g < -5) return under(tags);
      return g > -3 ? over(tags) : meet(tags);
    }
    case "spatial":
      if (g >= 9.9) return over();
      return g >= 2 && g <= 5 ? meet() : under();
    default:
      return { kind: "unverified", label: "未验证", tags: [] };
  }
}

// ----- 异动临界（展示用常量，与服务端计算口径一致） -----

export const BOARD_TYPES = [
  { key: "main", label: "主板", line: 20, limit: 10 },
  { key: "chinext", label: "创业板", line: 30, limit: 20 },
  { key: "star", label: "科创板", line: 30, limit: 20 },
  { key: "st", label: "主板 ST", line: 12, limit: 5 },
] as const;

export type BoardTypeKey = (typeof BOARD_TYPES)[number]["key"];

export function boardTypeLabel(key: string): string {
  return BOARD_TYPES.find((b) => b.key === key)?.label ?? key;
}

export const ABNORMAL_LEVELS: Record<
  string,
  { label: string; rank: number }
> = {
  severe: { label: "严重触发", rank: 0 },
  triggered: { label: "已触发", rank: 1 },
  severeNear: { label: "严重临界", rank: 2 },
  near: { label: "临界", rank: 3 },
  calm: { label: "未临界", rank: 4 },
};

// ----- 梯队结构（第三档）：角色与见顶五信号（手册第二节） -----

export const LADDER_ROLES = [
  { key: "spatial", label: "空间板" },
  { key: "leader1", label: "板块龙一" },
  { key: "leader2", label: "龙二" },
  { key: "supplement", label: "补涨龙" },
  { key: "follower", label: "跟风" },
  { key: "middle", label: "中位股" },
  { key: "other", label: "其他" },
] as const;

export function ladderRoleLabel(key: string): string {
  return LADDER_ROLES.find((r) => r.key === key)?.label ?? key;
}

export const TOP_SIGNALS = [
  { key: "sigBreakVolumeDown", label: "断板放量收跌 ≥−5%" },
  { key: "sigMultiOpenLateSeal", label: "开板 ≥3 次且终封晚于 14:00" },
  { key: "sigSecondCollapse", label: "龙二/中位股先跌停、梯队先崩" },
  { key: "sigClarifyDeny", label: "澄清/异动公告否认题材" },
  { key: "sigDriveLoss", label: "龙头封板而板块涨停不增反减（带动性丧失）" },
] as const;

export type TopSignalKey = (typeof TOP_SIGNALS)[number]["key"];

// ----- 纪律闭环（第三档）：交易模式 -----

export const TRADE_MODES = ["打板", "半路", "低吸", "其他"] as const;

export const SCORE_DIMS = [
  { key: "sTheme", label: "题材强度", hint: "是不是当日主流、有没有消息催化" },
  { key: "sPosition", label: "连板位置", hint: "低位首板/二板更安全，高位接力风险大" },
  { key: "sSeal", label: "封板质量", hint: "封单量、开板次数、封板时间早晚" },
  { key: "sTurnover", label: "换手健康", hint: "换手充分但不过热，量能配合" },
  { key: "sFollow", label: "梯队助攻", hint: "同题材有没有跟风涨停助攻" },
] as const;

export type ScoreKey = (typeof SCORE_DIMS)[number]["key"];

export const RED_FLAGS = [
  { key: "flagClarify", label: "澄清 / 异动公告", hint: "未量产、概念不实、蹭热点被点名" },
  { key: "flagTopBreak", label: "高标断板 + 梯队断层", hint: "最高板倒下且中间梯队缺位" },
  { key: "flagThemeEbb", label: "题材集体退潮", hint: "同题材批量炸板、跌停" },
  { key: "flagExternal", label: "外围大跌传导", hint: "外围市场大跌、情绪传导风险" },
] as const;

export type FlagKey = (typeof RED_FLAGS)[number]["key"];

export const ERROR_TAGS = [
  "追高",
  "退潮还进",
  "没止损",
  "计划外下单",
  "重仓",
  "卖飞后追回",
  "其他",
];

export const EMOTIONS = ["平静", "兴奋", "焦虑", "恐慌", "上头"];

// ----- date helpers (local timezone) -----

export function todayStr(): string {
  const d = new Date();
  return toStr(d);
}

export function toStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toStr(d);
}

export function weekdayLabel(date: string): string {
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const d = new Date(`${date}T00:00:00`);
  return names[d.getDay()] ?? "";
}

// ----- formatting -----

export function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
  return `${sign}¥${abs.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

export function fmtMoneyPlain(n: number): string {
  return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

export function fmtPct(n: number | null, digits = 1): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function pnlColor(n: number | null): string {
  if (n == null || n === 0) return "var(--dim)";
  // A 股语义：红涨绿跌
  return n > 0 ? "var(--accent)" : "var(--green)";
}

// ----- position sizing -----

export type SizingResult = {
  riskAmount: number;
  perShareRisk: number;
  sharesByRisk: number;
  sharesByCap: number;
  shares: number;
  cost: number;
  positionPct: number;
  maxLoss: number;
  lossIfStopPct: number; // 占本金 %
  meltNote: string;
  cappedBy: "risk" | "cap" | "both" | null;
  valid: boolean;
  error: string | null;
};

export function computeSizing(input: {
  capital: number;
  riskPct: number;
  buyPrice: number;
  stopPrice: number;
  capPct: number; // 今日仓位上限 %
  meltLosses: number;
}): SizingResult {
  const { capital, riskPct, buyPrice, stopPrice, capPct, meltLosses } = input;
  const empty: SizingResult = {
    riskAmount: 0,
    perShareRisk: 0,
    sharesByRisk: 0,
    sharesByCap: 0,
    shares: 0,
    cost: 0,
    positionPct: 0,
    maxLoss: 0,
    lossIfStopPct: 0,
    meltNote: "",
    cappedBy: null,
    valid: false,
    error: null,
  };
  if (capital <= 0) return { ...empty, error: "先在下方设置总本金" };
  if (buyPrice <= 0) return { ...empty, error: "填入买入价" };
  if (stopPrice <= 0) return { ...empty, error: "填入止损价" };
  if (stopPrice >= buyPrice)
    return { ...empty, error: "止损价必须低于买入价，否则这笔没有风险边界" };

  const riskAmount = (capital * riskPct) / 100;
  const perShareRisk = buyPrice - stopPrice;
  const lot = (shares: number) => Math.floor(shares / 100) * 100;
  const sharesByRisk = lot(riskAmount / perShareRisk);
  const sharesByCap = capPct > 0 ? lot(((capital * capPct) / 100) / buyPrice) : sharesByRisk;
  const shares = Math.min(sharesByRisk, sharesByCap);
  const cappedBy =
    sharesByRisk === sharesByCap ? "both" : shares === sharesByRisk ? "risk" : "cap";
  const cost = shares * buyPrice;
  const maxLoss = shares * perShareRisk;
  return {
    riskAmount,
    perShareRisk,
    sharesByRisk,
    sharesByCap,
    shares,
    cost,
    positionPct: capital > 0 ? (cost / capital) * 100 : 0,
    maxLoss,
    lossIfStopPct: capital > 0 ? (maxLoss / capital) * 100 : 0,
    meltNote: `按单笔风险 ${riskPct}% 算，连亏 ${meltLosses} 笔触发熔断停手，累计约亏 ${((riskAmount * meltLosses) / capital * 100).toFixed(1)}% 本金`,
    cappedBy: shares > 0 ? cappedBy : null,
    valid: shares >= 100,
    error: shares < 100 ? "按这个风险额度连 100 股都买不起：要么减小止损距离，要么放弃这笔" : null,
  };
}
