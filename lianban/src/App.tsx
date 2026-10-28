import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Area,
AreaChart,
Bar,
CartesianGrid,
ComposedChart,
Line,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import { CollectorStatus } from "./CollectorStatus";
import { DataBackup } from "./DataBackup";
import {
ABNORMAL_LEVELS,
assessAuction,
assessCycle,
BOARD_TYPES,
boardTypeLabel,
computeConfirm,
computeSizing,
computeVerdict,
CYCLE_STAGES,
EMOTIONS,
ERROR_TAGS,
fmtMoney,
fmtMoneyPlain,
fmtPct,
ladderRoleLabel,
pnlColor,
SCORE_DIMS,
shiftDate,
STAGE_TIERS,
todayStr,
TOP_SIGNALS,
TRADE_MODES,
weekdayLabel,
ydayStateLabel,
type ConfirmInput,
type ScoreKey,
type TopSignalKey,
type TriState,
} from "./lib";

type ConfirmState = ApiResponse<typeof api, "getOverview">["confirmState"];
type LeaderPick = ApiResponse<typeof api, "getLeaderPicks">["rows"][number];
type AbnormalWatch = ApiResponse<typeof api, "listAbnormalWatches">["watches"][number];
type IntradayEvent = ApiResponse<typeof api, "listintradayevents">["events"][number];
type IntradaySnapshot = ApiResponse<typeof api, "getIntradaySnapshot">;
type LadderEntry = ApiResponse<typeof api, "listLadderEntries">["entries"][number];
type BreadthData = ApiResponse<typeof api, "getBreadth">;
type FundflowData = ApiResponse<typeof api, "getFundflow">;

type Overview = ApiResponse<typeof api, "getOverview">;
type Candidate = Overview["candidates"][number];
type Trade = ApiResponse<typeof api, "listTrades">["trades"][number];
type StatsData = ApiResponse<typeof api, "getStats">;
type MarketDay = ApiResponse<typeof api, "listMarketDays">["days"][number];
type Settings = Overview["settings"];
type Reconciliation = NonNullable<
  ApiResponse<typeof api, "getreconciliation">["record"]
>;

// ---------- small primitives ----------

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelCls = "mb-1 block text-xs font-medium text-[var(--dim)]";

function Section({
  title,
  right,
  className,
  children,
}: {
  title: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ?? "mt-8"}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Btn({
  children,
  onClick,
  variant = "ghost",
  disabled,
  ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const cls =
    variant === "primary"
      ? "bg-[var(--accent)] text-white"
      : variant === "danger"
        ? "border border-[var(--accent)] text-[var(--accent)]"
        : "border border-[var(--border)] text-[var(--text)]";
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3.5 py-2 text-sm font-semibold disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

function NumField({
  label,
  value,
  onChange,
  placeholder,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  step?: string;
}) {
  const id = `f-${label}`;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <input
        id={id}
        aria-label={label}
        className={`${inputCls} font-num`}
        inputMode="decimal"
        type="number"
        step={step ?? "any"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = `f-${label}`;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <input
        id={id}
        aria-label={label}
        className={inputCls}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function AreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const id = `f-${label}`;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <textarea
        id={id}
        aria-label={label}
        className={inputCls}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
  danger,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left ${
        on
          ? danger
            ? "border-[var(--accent)] bg-[var(--accent-dim)]"
            : "border-[var(--amber)] bg-[var(--amber-dim)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {hint ? <span className="block text-xs text-[var(--dim)]">{hint}</span> : null}
      </span>
      <span
        className={`font-num text-xs font-bold ${on ? (danger ? "text-[var(--accent)]" : "text-[var(--amber)]") : "text-[var(--dim)]"}`}
      >
        {on ? "是" : "否"}
      </span>
    </button>
  );
}

function parseNum(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------- App shell ----------

type Tab =
  | "today"
  | "calc"
  | "abnormal"
  | "backtest"
  | "trades"
  | "stats"
  | "breadth"
  | "fundflow";

export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [date, setDate] = useState(todayStr());
  // On open, land on the most recent day that actually has data (latest
  // trading day) instead of an empty today on weekends/holidays. Runs once;
  // after that the user navigates freely.
  const [autoPicked, setAutoPicked] = useState(false);
  const latest = useQuery({
    queryKey: ["latestDataDate"],
    queryFn: () => api.getLatestDataDate({ upTo: todayStr() }),
  });
  // 今天若已有采集器盘中数据（交易日盘中/盘后当天），打开就停在今天，
  // 不再被「最近有定稿数据」的日期带回上一个交易日。
  const todaySnap = useQuery({
    queryKey: ["intradaySnapshot", todayStr()],
    queryFn: () => api.getIntradaySnapshot({ date: todayStr() }),
  });

  useEffect(() => {
    if (autoPicked) return;
    if (todaySnap.data?.available) {
      setAutoPicked(true);
      return;
    }
    if (todaySnap.data || todaySnap.isError) {
      if (latest.data) {
        if (latest.data.date) setDate(latest.data.date);
        setAutoPicked(true);
      } else if (latest.isError) {
        setAutoPicked(true);
      }
    }
  }, [autoPicked, latest.data, latest.isError, todaySnap.data, todaySnap.isError]);

  const overview = useQuery({
    queryKey: ["overview", date],
    queryFn: () => api.getOverview({ date }),
    enabled: autoPicked,
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: "today", label: "今日决策" },
    { key: "calc", label: "仓位" },
    { key: "abnormal", label: "异动" },
    { key: "backtest", label: "回测" },
    { key: "trades", label: "交易日志" },
    { key: "stats", label: "复盘" },
    { key: "breadth", label: "小黑板" },
    { key: "fundflow", label: "大钱" },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)] pt-safe">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="前一天"
              onClick={() => setDate((d) => shiftDate(d, -1))}
              className="rounded-lg px-2.5 py-1.5 text-lg leading-none text-[var(--dim)]"
            >
              ‹
            </button>
            <div className="text-center">
              <div className="font-num text-base font-bold leading-tight">
                {date.slice(5)} {weekdayLabel(date)}
              </div>
              <div className="text-[11px] leading-tight text-[var(--dim)]">
                {date === todayStr()
                  ? "今天"
                  : latest.data?.date === date
                    ? "最近有数据"
                    : date.slice(0, 4)}
              </div>
            </div>
            <button
              type="button"
              aria-label="后一天"
              onClick={() => setDate((d) => shiftDate(d, 1))}
              className="rounded-lg px-2.5 py-1.5 text-lg leading-none text-[var(--dim)]"
            >
              ›
            </button>
          </div>
          {date !== todayStr() ? (
            <Btn onClick={() => setDate(todayStr())}>回到今天</Btn>
          ) : null}
          <input
            type="date"
            aria-label="选择日期"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="font-num w-[132px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
          />
        </div>
        {overview.data?.melted ? (
          <div className="bg-[var(--accent)] px-4 py-2 text-center text-sm font-bold text-white">
            触发连败熔断：空仓至少 1 个交易日后复盘再开仓（已连败 {overview.data.lossStreak} 笔）
          </div>
        ) : overview.data?.lossStreak === 2 ? (
          <div className="bg-[var(--amber)] px-4 py-2 text-center text-sm font-bold text-white">
            已连败 2 笔：按纪律仓位降一档
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-28">
        {overview.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : overview.error ? (
          <p className="py-16 text-center text-sm text-[var(--accent)]">
            加载失败，检查网络后重试
          </p>
        ) : overview.data ? (
          <>
            {tab === "today" && (
              <TodayTab date={date} overview={overview.data} />
            )}
            {tab === "calc" && <CalcTab overview={overview.data} date={date} />}
            {tab === "abnormal" && <AbnormalTab date={date} />}
            {tab === "backtest" && <BacktestTab />}
            {tab === "trades" && <TradesTab defaultDate={date} />}
            {tab === "stats" && <StatsTab />}
            {tab === "breadth" && <BreadthTab date={date} />}
            {tab === "fundflow" && <FundflowTab date={date} />}
          </>
        ) : null}
      </main>

      <nav
        aria-label="主导航"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--surface)] pb-safe"
      >
        <div className="mx-auto grid max-w-3xl grid-cols-8">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => setTab(t.key)}
              className={`px-0.5 py-3 text-[11px] font-semibold leading-tight ${
                tab === t.key ? "text-[var(--accent)]" : "text-[var(--dim)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ---------- 今日：裁决横幅 + 梯队录入 ----------

function TodayTab({ date, overview }: { date: string; overview: Overview }) {
  const [editingDay, setEditingDay] = useState(false);
  const verdict = useMemo(() => computeVerdict(overview.day), [overview.day]);
  const day = overview.day;
  // 炸板率显示（仅展示层换算，不写回 brokenRate）：
  // 原值优先；原值为空但封板率有值时显示 100 − 封板率并标注换算；两者皆空显示未查得。
  const brokenFromSeal =
    day && day.brokenRate == null && day.sealRatePct != null
      ? Math.round((100 - day.sealRatePct) * 100) / 100
      : null;
  const brokenValue = !day
    ? "—"
    : day.brokenRate != null
      ? `${day.brokenRate}%`
      : brokenFromSeal != null
        ? `${brokenFromSeal}%`
        : "—（未查得）";

  const vStyle =
    verdict?.level === "attack"
      ? "bg-[var(--accent)] text-white"
      : verdict?.level === "cautious"
        ? "bg-[var(--amber-dim)]"
        : "bg-[var(--surface2)]";

  return (
    <div>
      {/* 置顶推荐区：龙头推荐 + 推荐个股名单（均为只读展示） */}
      <LeaderSection date={date} />
      <PicksSection overview={overview} />

      {/* 裁决横幅 */}
      <div className={`-mx-4 mt-8 px-4 pb-5 pt-4 ${vStyle}`}>
        {day && verdict ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-xs font-semibold opacity-80">
                  今日裁决 · 建议仓位 {verdict.positionText}
                </div>
                <div className="mt-1 text-4xl font-black tracking-tight">
                  {verdict.label}
                </div>
              </div>
              <div className="font-num text-right">
                <div
                  className={`text-3xl font-black ${verdict.level === "cautious" ? "text-[var(--amber)]" : ""}`}
                >
                  {overview.plan?.positionCap != null
                    ? `${overview.plan.positionCap}%`
                    : `${verdict.position}%`}
                </div>
                <div className="text-xs opacity-80">
                  {overview.plan?.positionCap != null ? "计划卡仓位上限" : "仓位上限"}
                </div>
              </div>
            </div>
            <div className="font-num mt-4 grid grid-cols-4 gap-2 text-center">
              <BannerStat label="最高连板" value={day.maxBoard != null ? `${day.maxBoard}板` : "—"} />
              <BannerStat
                label="炸板率"
                value={brokenValue}
                note={brokenFromSeal != null ? "由封板率换算" : undefined}
              />
              <BannerStat label="梯队断层" value={day.ladderGap ? "有" : "无"} />
              <BannerStat label="退潮信号" value={day.ebbSignal ? "有" : "无"} />
            </div>
            {verdict.reasons.length ? (
              <ul className="mt-3 space-y-1 text-sm opacity-90">
                {verdict.reasons.map((r) => (
                  <li key={r}>· {r}</li>
                ))}
              </ul>
            ) : null}
            {day.mainThemes ? (
              <p className="mt-2 text-sm opacity-90">主流题材：{day.mainThemes}</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-xs font-semibold text-[var(--dim)]">今日裁决</div>
            <div className="mt-1 text-3xl font-black tracking-tight">还没录梯队</div>
            <p className="mt-2 text-sm text-[var(--dim)]">
              {date === todayStr()
                ? "今天的裁决定稿由收盘复盘写入；盘中先看下方「盘中实况」的实时数据与暂定定调，随时可查。"
                : "把监控简报里的梯队数据填进来（最高连板、炸板率、断层、退潮信号），这里会直接给出今天能不能做、做几成。"}
            </p>
          </>
        )}
        <div className="mt-4">
          <Btn
            variant={day && verdict ? "ghost" : "primary"}
            onClick={() => setEditingDay((v) => !v)}
          >
            {editingDay ? "收起" : day ? "修改梯队数据" : "录入今日梯队"}
          </Btn>
        </div>
      </div>

      {editingDay && (
        <DayForm
          date={date}
          day={day}
          onDone={() => setEditingDay(false)}
        />
      )}

      <ReconciliationSection date={date} />
      <LivePanel date={date} />
      <CyclePanel day={day} />
      <ConfirmSection
        key={date}
        date={date}
        saved={overview.confirmState}
        planCap={overview.plan?.positionCap ?? null}
      />

      <LadderSection date={date} />
      <AuctionPanel date={date} overview={overview} />
      <CandidatesSection overview={overview} />
      <AbnormalSection date={date} />
      <IntradaySection date={date} />
      <PlanSection date={date} overview={overview} />

      {/* 持仓中 */}
      <Section title="持仓中">
        {overview.openTrades.length === 0 ? (
          <p className="text-sm text-[var(--dim)]">
            没有未平仓记录。在「交易日志」里记下买入，就会显示在这里。
          </p>
        ) : (
          <div className="space-y-2">
            {overview.openTrades.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
              >
                <div>
                  <span className="font-semibold">{t.name}</span>
                  {t.code ? (
                    <span className="font-num ml-2 text-xs text-[var(--dim)]">{t.code}</span>
                  ) : null}
                  <div className="text-xs text-[var(--dim)]">
                    {t.date} 买入 · {deviationText(t)}
                    {t.mode ? ` · ${t.mode}` : ""}
                  </div>
                </div>
                <div className="font-num text-right text-sm">
                  <div>
                    {t.buyPrice} × {t.shares}股
                  </div>
                  <div className="text-xs text-[var(--dim)]">
                    {fmtMoneyPlain(t.buyPrice * t.shares)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 最近平仓 */}
      {overview.recentClosed.length > 0 && (
        <Section title="最近平仓">
          <div className="space-y-2">
            {overview.recentClosed.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
              >
                <div>
                  <span className="font-semibold">{t.name}</span>
                  <div className="text-xs text-[var(--dim)]">
                    {t.date} → {t.sellDate}
                  </div>
                </div>
                <div
                  className="font-num text-right text-sm font-bold"
                  style={{ color: pnlColor(t.pnl) }}
                >
                  {t.pnl != null ? fmtMoney(t.pnl) : "—"}
                  <div className="text-xs font-normal">{fmtPct(t.pnlPct)}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------- 今日龙头推荐（只读展示：读回测集龙头轨，不进候选、不参与统计） ----------

function LeaderSection({ date }: { date: string }) {
  const q = useQuery({
    queryKey: ["leaderPicks", date],
    queryFn: () => api.getLeaderPicks({ date }),
  });
  const rows = q.data?.rows ?? [];
  const pick = rows.find((r) => r.recommended === 1);
  const vetoed = rows.filter((r) => r.recommended !== 1).slice(0, 3);

  return (
    <Section title="今日龙头推荐" className="mt-5">
      {q.isPending ? (
        <p className="text-sm text-[var(--dim)]">加载中…</p>
      ) : q.isError ? (
        <p className="text-sm text-[var(--accent)]">加载失败，请重试</p>
      ) : pick ? (
        <LeaderPickCard pick={pick} />
      ) : rows.length > 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
          <div className="font-bold">今日无龙头推荐</div>
          {vetoed.length > 0 && (
            <ul className="mt-2 space-y-1.5 text-sm text-[var(--dim)]">
              {vetoed.map((r, i) => (
                <li key={`${r.code}-${i}`}>
                  <span className="font-semibold text-[var(--text)]">
                    {r.name || "未命名"}
                  </span>
                  {r.code ? (
                    <span className="font-num ml-2 text-xs">{r.code}</span>
                  ) : null}
                  {r.vetoReason ? <span>：{r.vetoReason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--dim)]">暂无龙头推荐归档数据</p>
      )}
    </Section>
  );
}

function LeaderPickCard({ pick }: { pick: LeaderPick }) {
  const badge =
    pick.expectationVerdict === "超预期"
      ? "bg-[var(--accent)] text-white"
      : pick.expectationVerdict === "符合预期"
        ? "bg-[var(--green)] text-white"
        : pick.expectationVerdict === "不及预期"
          ? "bg-[var(--accent-dim)] text-[var(--accent)]"
          : "bg-[var(--surface2)] text-[var(--dim)]";

  const meta = [
    pick.leaderRole ? `身份 ${pick.leaderRole}` : null,
    pick.theme ? `题材 ${pick.theme}` : null,
    pick.boardDays != null ? `${pick.boardDays} 板` : null,
    pick.cycleStage ? `周期 ${pick.cycleStage}` : null,
    pick.entryRefPrice != null ? `竞价参考价 ${pick.entryRefPrice}` : null,
  ].filter((s): s is string => s != null);

  const result = [
    pick.closedLimit != null
      ? `当日封板：${pick.closedLimit === 1 ? "是" : "否"}`
      : null,
    pick.nextOpenRetPct != null
      ? `次日开盘溢价 ${fmtPct(pick.nextOpenRetPct)}`
      : null,
    pick.successPick != null
      ? `成功口径 v1：${pick.successPick === 1 ? "成功" : "未达成"}`
      : null,
  ].filter((s): s is string => s != null);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-bold">{pick.name || "未命名"}</span>
          {pick.code ? (
            <span className="font-num ml-2 text-xs text-[var(--dim)]">
              {pick.code}
            </span>
          ) : null}
        </div>
        {pick.expectationVerdict ? (
          <span className={`rounded-md px-2 py-1 text-xs font-bold ${badge}`}>
            {pick.expectationVerdict}
          </span>
        ) : null}
      </div>
      {meta.length > 0 && (
        <p className="mt-1.5 text-sm text-[var(--dim)]">{meta.join(" · ")}</p>
      )}
      {result.length > 0 && (
        <p className="font-num mt-2 text-xs text-[var(--dim)]">
          {result.join(" · ")}
        </p>
      )}
    </div>
  );
}

// ---------- 今日推荐个股（只读汇总：与候选区同一判定口径，不进计划、不新增数据） ----------
// 通过筛选 = 未被红灯否决且五维总分 ≥ 候选区门槛（settings.scoreThreshold，默认 60）。

function PicksSection({ overview }: { overview: Overview }) {
  const threshold = overview.settings.scoreThreshold;
  const picks = overview.candidates
    .filter((c) => !c.vetoed && c.total >= threshold)
    .sort((a, b) => b.total - a.total);
  const vetoedCount = overview.candidates.filter((c) => c.vetoed).length;

  return (
    <Section
      title="今日推荐个股"
      right={
        picks.length > 0 ? (
          <span className="text-xs text-[var(--dim)]">{picks.length} 只通过筛选</span>
        ) : undefined
      }
    >
      {picks.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          今日暂无通过筛选的推荐个股
          {overview.candidates.length > 0
            ? `（当日候选 ${overview.candidates.length} 只，其中 ${vetoedCount} 只被红灯否决，其余未达 ${threshold} 分门槛）`
            : ""}
          ，候选明细见下方「候选股评分」。
        </p>
      ) : (
        <div className="space-y-2">
          {picks.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
            >
              <div className="min-w-0">
                <span className="text-base font-bold">{c.name}</span>
                {c.code ? (
                  <span className="font-num ml-2 text-xs text-[var(--dim)]">
                    {c.code}
                  </span>
                ) : null}
                {c.code && c.date === todayStr() ? (
                  <LiveQuoteChip code={c.code} />
                ) : null}
                {c.theme ? (
                  <span className="ml-2 text-xs text-[var(--dim)]">{c.theme}</span>
                ) : null}
                {c.auctionGainPct != null ? (
                  <div className="font-num mt-0.5 text-xs text-[var(--dim)]">
                    竞价涨幅 {fmtPct(c.auctionGainPct)}
                  </div>
                ) : null}
              </div>
              <div className="font-num shrink-0 text-right">
                <span className="text-2xl font-black">{c.total}</span>
                <span className="ml-1 text-xs text-[var(--dim)]">分</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function BannerStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  const long = value.length > 5;
  return (
    <div className="rounded-lg bg-black/10 px-1 py-2 dark:bg-white/10">
      <div className={`font-bold leading-tight ${long ? "text-[13px]" : "text-base"}`}>
        {value}
      </div>
      <div className="text-[11px] opacity-80">{label}</div>
      {note ? (
        <div className="mt-0.5 text-[10px] leading-tight opacity-70">{note}</div>
      ) : null}
    </div>
  );
}

function DayForm({
  date,
  day,
  onDone,
}: {
  date: string;
  day: Overview["day"];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [maxBoard, setMaxBoard] = useState(day?.maxBoard?.toString() ?? "");
  const [limitUp, setLimitUp] = useState(day?.limitUpCount?.toString() ?? "");
  const [limitDown, setLimitDown] = useState(day?.limitDownCount?.toString() ?? "");
  const [broken, setBroken] = useState(day?.brokenRate?.toString() ?? "");
  const [premium, setPremium] = useState(day?.prevPremiumPct?.toString() ?? "");
  const [promotion, setPromotion] = useState(day?.promotionRatePct?.toString() ?? "");
  const [seal, setSeal] = useState(day?.sealRatePct?.toString() ?? "");
  const [stage, setStage] = useState(day?.cycleStage ?? "");
  const [maxDrop, setMaxDrop] = useState<number | null>(day?.maxDrop ?? null);
  const [gap, setGap] = useState(day?.ladderGap ?? false);
  const [ebb, setEbb] = useState(day?.ebbSignal ?? false);
  const [themes, setThemes] = useState(day?.mainThemes ?? "");
  const [note, setNote] = useState(day?.note ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.saveMarketDay({
        date,
        maxBoard: parseNum(maxBoard),
        limitUpCount: parseNum(limitUp),
        brokenRate: parseNum(broken),
        maxDrop,
        ladderGap: gap,
        ebbSignal: ebb,
        mainThemes: themes,
        note,
        limitDownCount: parseNum(limitDown),
        prevPremiumPct: parseNum(premium),
        promotionRatePct: parseNum(promotion),
        sealRatePct: parseNum(seal),
        cycleStage: stage,
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });
  const [fillMsg, setFillMsg] = useState("");
  const fill = useMutation({
    mutationFn: () => api.fillMarketDayFromPools({ date }),
    onSuccess: (r) => {
      setFillMsg(r.message);
      if (!r.available) return;
      const v = r.values;
      const put = (x: number | null, set: (s: string) => void) => {
        if (x != null) set(String(x));
      };
      put(v.maxBoard, setMaxBoard);
      put(v.limitUpCount, setLimitUp);
      put(v.limitDownCount, setLimitDown);
      put(v.brokenRate, setBroken);
      put(v.sealRatePct, setSeal);
      put(v.prevPremiumPct, setPremium);
      put(v.promotionRatePct, setPromotion);
      if (v.mainThemes) setThemes(v.mainThemes);
    },
    onError: (e) => setFillMsg(`填充失败：${e instanceof Error ? e.message : String(e)}`),
  });
  const del = useMutation({
    mutationFn: () => api.deleteMarketDay({ date }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  const dropOptions: { v: number; label: string }[] = [
    { v: 0, label: "红盘/微涨" },
    { v: -1, label: "下跌但没跌停" },
    { v: -2, label: "跌停" },
  ];

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3">
        <button
          type="button"
          disabled={fill.isPending}
          onClick={() => fill.mutate()}
          className="rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-40"
        >
          {fill.isPending ? "读取中…" : "用采集器数据自动填充"}
        </button>
        {fillMsg && <p className="mt-2 text-xs text-[var(--dim)]">{fillMsg}</p>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <NumField label="最高连板" value={maxBoard} onChange={setMaxBoard} placeholder="如 6" />
        <NumField label="涨停家数" value={limitUp} onChange={setLimitUp} placeholder="如 58" />
        <NumField label="炸板率 %" value={broken} onChange={setBroken} placeholder="如 25" />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <NumField label="跌停家数" value={limitDown} onChange={setLimitDown} placeholder="如 7" />
        <NumField label="昨涨溢价 %" value={premium} onChange={setPremium} placeholder="如 3.4" step="0.1" />
        <NumField label="封板率 %" value={seal} onChange={setSeal} placeholder="如 87" step="0.1" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <NumField label="连板晋级率 %" value={promotion} onChange={setPromotion} placeholder="如 33.3" step="0.1" />
        <div>
          <label htmlFor="f-cycle-stage" className={labelCls}>
            官方定调（统一基准）
          </label>
          <select
            id="f-cycle-stage"
            aria-label="官方定调"
            className={inputCls}
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="">未写入（显示计算建议）</option>
            {CYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <span className={labelCls}>昨日高标今日表现</span>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="昨日高标今日表现">
          {dropOptions.map((o) => (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={maxDrop === o.v}
              onClick={() => setMaxDrop(maxDrop === o.v ? null : o.v)}
              className={`rounded-lg border px-2 py-2 text-sm font-medium ${
                maxDrop === o.v
                  ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                  : "border-[var(--border)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        <Toggle label="梯队断层" hint="中间板位缺位、高低两头够不着" on={gap} onChange={setGap} />
        <Toggle label="退潮信号" hint="高标批量跌停、昨日涨停今日亏钱" on={ebb} onChange={setEbb} />
      </div>
      <div className="mt-3 space-y-3">
        <TextField label="主流题材" value={themes} onChange={setThemes} placeholder="如 机器人、固态电池" />
        <AreaField label="备注" value={note} onChange={setNote} placeholder="竞价/盘中观察到的信号" />
      </div>
      <div className="mt-4 flex gap-2">
        <Btn variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          保存梯队
        </Btn>
        {day && (
          <Btn variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            删除这天
          </Btn>
        )}
      </div>
      {save.isError && (
        <p className="mt-2 text-sm text-[var(--accent)]">保存失败，请重试</p>
      )}
    </div>
  );
}

// ---------- 量化定调面板（六项指标投票） ----------

const TIER_DOT: Record<string, string> = {
  主升: "var(--accent)",
  发酵: "var(--amber)",
  混沌: "var(--dim)",
  退潮: "var(--green)",
  冰点: "#7d8ea3",
};

function CyclePanel({ day }: { day: Overview["day"] }) {
  const a = useMemo(() => assessCycle(day), [day]);
  if (!day || !a) {
    return (
      <Section title="量化定调">
        <p className="text-sm text-[var(--dim)]">
          录入梯队数据后，这里会按六项指标逐项投票给出计算定调（涨停/跌停家数、最高连板、昨涨溢价、封板率、梯队完整度），和统一基准的官方定调对照。
        </p>
      </Section>
    );
  }
  const official = day.cycleStage;
  const mismatch =
    official !== "" &&
    official !== a.computed &&
    !(official === "主升" && a.computed === "主升（高潮）");
  const voteText = STAGE_TIERS.filter((t) => a.votes[t] > 0)
    .map((t) => `${t} ${a.votes[t]} 票`)
    .join(" · ");

  return (
    <Section title="量化定调">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="space-y-2">
          {a.indicators.map((ind) => (
            <div key={ind.key} className="flex items-center gap-2.5 text-sm">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  background: ind.missing ? "transparent" : TIER_DOT[ind.vote ?? "混沌"],
                  border: ind.missing
                    ? "1.5px solid var(--dim)"
                    : `1.5px solid ${TIER_DOT[ind.vote ?? "混沌"]}`,
                }}
              />
              <span className="w-20 shrink-0 text-[var(--dim)]">{ind.label}</span>
              <span className="font-num flex-1 font-semibold">
                {ind.missing ? (
                  <span className="font-sans font-normal text-[var(--dim)]">未查得</span>
                ) : (
                  ind.valueText
                )}
              </span>
              {ind.vote ? (
                <span className="text-xs font-semibold" style={{ color: TIER_DOT[ind.vote] }}>
                  投{ind.vote}
                </span>
              ) : (
                <span className="text-xs text-[var(--dim)]">不投票</span>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3">
          <div>
            <div className="text-xs text-[var(--dim)]">
              {official ? "计算定调" : "计算建议（官方定调未写入）"}
            </div>
            <div className="mt-0.5 text-2xl font-black">{a.computed}</div>
            <div className="font-num mt-0.5 text-xs text-[var(--dim)]">{voteText}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--dim)]">官方定调（统一基准）</div>
            <div className="mt-0.5 text-2xl font-black">
              {official || <span className="text-base font-semibold text-[var(--dim)]">未写入</span>}
            </div>
            {day.promotionRatePct != null && (
              <div className="font-num mt-0.5 text-xs text-[var(--dim)]">
                连板晋级率 {day.promotionRatePct}%
              </div>
            )}
          </div>
        </div>

        {mismatch && (
          <p className="mt-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
            计算定调与官方定调不一致，以官方定调为准。
          </p>
        )}
      </div>
    </Section>
  );
}

// ---------- 确认推演器 ----------

function TriPicker({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: TriState;
  onChange: (v: TriState) => void;
}) {
  const opts: { v: TriState; text: string }[] = [
    { v: "pass", text: "通过" },
    { v: "fail", text: "未过" },
    { v: "unknown", text: "未验证" },
  ];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-[var(--dim)]">{hint}</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={label}>
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={`rounded-lg border py-2 text-sm font-semibold ${
              value === o.v
                ? o.v === "pass"
                  ? "border-[var(--green)] bg-[var(--green)] text-white"
                  : o.v === "fail"
                    ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                    : "border-[var(--amber)] bg-[var(--amber-dim)] text-[var(--amber)]"
                : "border-[var(--border)] text-[var(--dim)]"
            }`}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfirmSection({
  date,
  saved,
  planCap,
}: {
  date: string;
  saved: ConfirmState;
  planCap: number | null;
}) {
  const qc = useQueryClient();
  const [condPremium, setCondPremium] = useState<TriState>(saved?.condPremium ?? "unknown");
  const [condSeal, setCondSeal] = useState<TriState>(saved?.condSeal ?? "unknown");
  const [condLeader, setCondLeader] = useState<TriState>(saved?.condLeader ?? "unknown");
  const [gapFilled, setGapFilled] = useState(saved?.gapFilled ?? false);
  const [danger, setDanger] = useState(saved?.danger ?? false);
  const [written, setWritten] = useState(false);

  const input: ConfirmInput = { condPremium, condSeal, condLeader, gapFilled, danger };
  const result = useMemo(() => computeConfirm(input), [condPremium, condSeal, condLeader, gapFilled, danger]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (next: ConfirmInput) => api.saveConfirmState({ date, ...next }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const update = (patch: Partial<ConfirmInput>) => {
    const next = { ...input, ...patch };
    if (patch.condPremium !== undefined) setCondPremium(patch.condPremium);
    if (patch.condSeal !== undefined) setCondSeal(patch.condSeal);
    if (patch.condLeader !== undefined) setCondLeader(patch.condLeader);
    if (patch.gapFilled !== undefined) setGapFilled(patch.gapFilled);
    if (patch.danger !== undefined) setDanger(patch.danger);
    setWritten(false);
    save.mutate(next);
  };

  const conclusion =
    `确认推演（${date.slice(5)}）：仓位上限 ${result.cap}% — ${result.headline}` +
    (result.degraded ? "；已降级分歧：只做最强一只的回封确认" : "") +
    (result.pending ? "；待 9:26 竞价验证" : "");

  const apply = useMutation({
    mutationFn: () => api.applyConfirmToPlan({ date, cap: result.cap, conclusion }),
    onSuccess: () => {
      qc.invalidateQueries();
      setWritten(true);
    },
  });

  return (
    <Section
      title="确认推演器"
      right={<span className="text-xs text-[var(--dim)]">高潮次日 / 盘前确认</span>}
    >
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="space-y-3.5">
          <TriPicker
            label="条件一 · 昨涨溢价守 +2%"
            hint="以前一交易日涨停股当日溢价为准"
            value={condPremium}
            onChange={(v) => update({ condPremium: v })}
          />
          <TriPicker
            label="条件二 · 封板率守 80%"
            hint="封住的板占触板总数"
            value={condSeal}
            onChange={(v) => update({ condSeal: v })}
          />
          <TriPicker
            label="条件三 · 双龙竞价不落入不及预期档"
            hint="空间板竞价达到预期基线"
            value={condLeader}
            onChange={(v) => update({ condLeader: v })}
          />
          <Toggle
            label="附加项 · 4–5 板断层被填上"
            hint="中位补涨填上断层（不计入三条件）"
            on={gapFilled}
            onChange={(v) => update({ gapFilled: v })}
          />
          <Toggle
            label="危险 · 任一空间板竞价不及预期（低开）"
            hint="打开直接空仓预案，仓位上限归零"
            danger
            on={danger}
            onChange={(v) => update({ danger: v })}
          />
        </div>

        <div className="mt-4 flex items-end justify-between border-t border-[var(--border)] pt-3">
          <div>
            <div className="text-xs text-[var(--dim)]">推演仓位上限</div>
            <div className="font-num text-4xl font-black">
              {result.cap}
              <span className="ml-0.5 text-lg font-bold">%</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-black">{result.headline}</div>
            {result.degraded && (
              <div className="mt-0.5 text-xs font-semibold text-[var(--amber)]">
                已降级分歧：只做最强一只的回封确认
              </div>
            )}
            {result.pending && (
              <div className="mt-0.5 text-xs font-semibold text-[var(--amber)]">
                待 9:26 竞价验证（按已验证部分从严）
              </div>
            )}
            {planCap != null && (
              <div className="font-num mt-0.5 text-xs text-[var(--dim)]">
                计划卡当前上限 {planCap}%
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Btn variant="primary" disabled={apply.isPending} onClick={() => apply.mutate()}>
            写入今日计划卡
          </Btn>
          {written && (
            <span className="text-sm font-semibold text-[var(--green)]">
              已写入计划卡（仓位上限 {result.cap}%）
            </span>
          )}
          {apply.isError && <span className="text-sm text-[var(--accent)]">写入失败，请重试</span>}
          {save.isError && <span className="text-sm text-[var(--accent)]">状态保存失败</span>}
        </div>
      </div>
    </Section>
  );
}

// ---------- 梯队结构（第三档：梯队树 + 见顶五信号 + 空间板谱系） ----------
// 只读展示：梯队结论由收盘复盘任务按统一基准写入，页面不提供编辑入口。

function LadderSection({ date }: { date: string }) {
  const list = useQuery({
    queryKey: ["ladder", date],
    queryFn: () => api.listLadderEntries({ date }),
  });
  const lineage = useQuery({
    queryKey: ["lineage"],
    queryFn: () => api.getSpatialLineage({}),
  });
  const entries = list.data?.entries ?? [];
  const levels = [...new Set(entries.map((e) => e.boardDays))].sort((a, b) => b - a);
  const maxLevel = levels[0] ?? 0;
  // 只渲染最高板到最低已录入板数之间的层级：之间的缺失层标「断层」，
  // 最低录入层以下不生成空层（那只是没录入，不是梯队断层）。
  const minLevel = levels[levels.length - 1] ?? 0;

  return (
    <Section title="梯队结构" right={<span className="text-xs text-[var(--dim)]">按连板数分层 · 断层高亮</span>}>
      {list.isPending ? (
        <p className="text-sm text-[var(--dim)]">加载中…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          这一天还没有梯队记录。梯队结构由收盘复盘任务按统一基准写入后在此展示：最高板与次高板之间缺失的层级会以「断层」空层显示。
        </p>
      ) : (
        <div className="space-y-2">
          {Array.from({ length: Math.max(0, maxLevel - minLevel + 1) }, (_, i) => maxLevel - i).map((lvl) => {
            const atLevel = entries.filter((e) => e.boardDays === lvl);
            if (atLevel.length === 0) {
              return (
                <div
                  key={lvl}
                  className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
                >
                  <span className="font-num w-12 shrink-0 font-bold">{lvl} 板</span>
                  <span className="font-semibold">断层</span>
                  <span className="text-xs">这一层没有梯队成员</span>
                </div>
              );
            }
            return (
              <div key={lvl} className="flex gap-3">
                <div className="font-num w-12 shrink-0 pt-3 text-right text-sm font-bold text-[var(--dim)]">
                  {lvl} 板
                </div>
                <div className="flex-1 space-y-2">
                  {atLevel.map((e) => (
                    <LadderCard key={e.id} e={e} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 空间板谱系时间线 */}
      {(lineage.data?.nodes.length ?? 0) > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-sm font-bold">空间板谱系（最近 {lineage.data!.nodes.length} 个有记录的日期）</div>
          <div className="flex flex-wrap items-center gap-y-2">
            {lineage.data!.nodes.map((n, i) => (
              <span key={n.date} className="flex items-center">
                {i > 0 && <span className="mx-1.5 text-[var(--dim)]">→</span>}
                <span
                  className={`rounded-lg border px-2.5 py-1.5 text-sm ${
                    n.date === date
                      ? "border-[var(--accent)] bg-[var(--accent-dim)] font-bold"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  }`}
                >
                  <span className="font-num mr-1.5 text-xs text-[var(--dim)]">{n.date.slice(5)}</span>
                  {n.name}
                  <span className="font-num ml-1.5 text-xs font-bold text-[var(--accent)]">{n.boardDays} 板</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function LadderCard({ e }: { e: LadderEntry }) {
  const warn = e.isSpatial && e.topHits >= 2;

  return (
    <div
      className={`rounded-xl border bg-[var(--surface)] px-3.5 py-3 ${
        warn
          ? "border-[var(--accent)]"
          : e.isSpatial
            ? "border-[var(--amber)]"
            : "border-[var(--border)]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <span className="font-bold">{e.name}</span>
          {e.code && <span className="font-num ml-2 text-xs text-[var(--dim)]">{e.code}</span>}
          {e.theme && <span className="ml-2 text-xs text-[var(--dim)]">{e.theme}</span>}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {e.isSpatial && (
            <span className="rounded-md bg-[var(--amber-dim)] px-2 py-1 text-xs font-bold text-[var(--amber)]">
              空间板
            </span>
          )}
          <span className="rounded-md bg-[var(--surface2)] px-2 py-1 text-xs font-semibold">
            {ladderRoleLabel(e.role)}
          </span>
          {warn && (
            <span className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-bold text-white">
              见顶预警（命中 {e.topHits}/5）
            </span>
          )}
        </div>
      </div>

      {e.isSpatial && (
        <div className="mt-2.5 border-t border-[var(--border)] pt-2.5">
          <div className="mb-1.5 text-xs font-semibold text-[var(--dim)]">
            见顶五信号 · 命中 {e.topHits}/5{warn ? "（≥2 条亮红预警）" : ""}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TOP_SIGNALS.map((s) => {
              const on = e[s.key as TopSignalKey];
              return (
                <span
                  key={s.key}
                  className={`rounded-md px-2 py-1 text-xs font-semibold ${
                    on
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface2)] text-[var(--dim)]"
                  }`}
                >
                  {s.label}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {e.note && <p className="mt-2 text-sm text-[var(--dim)]">{e.note}</p>}
    </div>
  );
}

// ---------- 竞价验证面板（第二档：竞价三项 vs 昨日形态基线） ----------

function AuctionPanel({ overview }: { date: string; overview: Overview }) {
  const cands = overview.candidates;
  const verdicts = cands.map((c) => ({
    c,
    v: assessAuction({
      g: c.auctionGainPct,
      r: c.auctionVolRatio,
      boardDays: c.boardDays,
      ydayState: c.ydayState,
    }),
  }));
  const counts = {
    over: verdicts.filter((x) => x.v.kind === "over").length,
    meet: verdicts.filter((x) => x.v.kind === "meet").length,
    under: verdicts.filter((x) => x.v.kind === "under").length,
    unverified: verdicts.filter((x) => x.v.kind === "unverified").length,
  };
  const banner = verdicts.some(
    (x) => (x.c.boardDays ?? 0) >= 5 && x.v.kind === "under",
  );

  return (
    <Section
      title="竞价验证"
      right={<span className="text-xs text-[var(--dim)]">9:25 竞价 vs 昨日形态基线</span>}
    >
      {banner && (
        <p className="mb-3 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-bold text-white">
          空间板竞价不及预期——今日高位接力信号整体降级
        </p>
      )}
      {cands.length > 0 && (
        <p className="font-num mb-3 text-sm text-[var(--dim)]">
          超预期 <span className="font-bold text-[var(--accent)]">{counts.over}</span>
          {" · "}符合预期 <span className="font-bold text-[var(--green)]">{counts.meet}</span>
          {" · "}不及预期 <span className="font-bold">{counts.under}</span>
          {counts.unverified > 0 && <>{" · "}未验证 {counts.unverified}</>}
        </p>
      )}
      {cands.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          还没有候选。候选由竞价任务写入后，这里会按手册预期基线自动判定符合 / 超 / 不及预期。
        </p>
      ) : (
        <div className="space-y-2">
          {verdicts.map(({ c, v }) => (
            <AuctionRow key={c.id} c={c} verdict={v} />
          ))}
        </div>
      )}
    </Section>
  );
}

function AuctionRow({
  c,
  verdict,
}: {
  c: Candidate;
  verdict: ReturnType<typeof assessAuction>;
}) {
  const badge =
    verdict.kind === "over"
      ? "bg-[var(--accent)] text-white"
      : verdict.kind === "meet"
        ? "bg-[var(--green)] text-white"
        : verdict.kind === "under"
          ? "bg-[var(--accent-dim)] text-[var(--accent)]"
          : "bg-[var(--surface2)] text-[var(--dim)]";

  const missing = (
    <>
      <span className="text-[var(--dim)]">未查得</span>
    </>
  );

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-bold">{c.name}</span>
          {c.code && (
            <span className="font-num ml-2 text-xs text-[var(--dim)]">{c.code}</span>
          )}
        </div>
        <span className={`rounded-md px-2 py-1 text-xs font-bold ${badge}`}>
          {verdict.label}
        </span>
      </div>
      {verdict.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {verdict.tags.map((t) => (
            <span
              key={t}
              className="rounded bg-[var(--amber-dim)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--amber)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <p className="font-num mt-2 text-xs text-[var(--dim)]">
        竞价涨幅 {c.auctionGainPct != null ? fmtPct(c.auctionGainPct) : missing}
        {" · "}金额{" "}
        {c.auctionAmountWan != null
          ? `${c.auctionAmountWan.toLocaleString("zh-CN")} 万`
          : missing}
        {" · "}量比 {c.auctionVolRatio != null ? c.auctionVolRatio : missing}
      </p>
      <p className="mt-2 text-xs text-[var(--dim)]">
        {c.boardDays != null ? `昨日 ${c.boardDays} 板` : "昨日连板天数未标注"}
        {" · "}
        {c.ydayState ? ydayStateLabel(c.ydayState) : "昨日形态未标注"}
      </p>
    </div>
  );
}

// ---------- 候选股：红灯否决 + 五维评分 ----------
// 只读展示：候选、红灯标记与五维评分由竞价 / 收盘任务写入，页面不提供编辑入口。

function CandidatesSection({ overview }: { overview: Overview }) {
  const threshold = overview.settings.scoreThreshold;
  const list = [...overview.candidates].sort((a, b) => {
    if (a.vetoed !== b.vetoed) return a.vetoed ? 1 : -1;
    return b.total - a.total;
  });
  const qualified = list.filter((c) => !c.vetoed && c.total >= threshold).length;

  return (
    <Section
      title="候选股评分"
      right={
        <span className="text-xs text-[var(--dim)]">
          门槛 {threshold} 分 · {qualified} 只可进计划
        </span>
      }
    >
      {list.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          还没有候选。候选由竞价与收盘任务按红灯否决与五维评分写入：命中红灯直接淘汰；总分不到 {threshold}，不进计划，防手痒。
        </p>
      ) : (
        <div className="space-y-2">
          {list.map((c) => (
            <CandidateCard key={c.id} c={c} threshold={threshold} />
          ))}
        </div>
      )}
    </Section>
  );
}

function CandidateCard({
  c,
  threshold,
}: {
  c: Candidate;
  threshold: number;
}) {
  const status = c.vetoed
    ? { text: "红灯否决", cls: "bg-[var(--accent)] text-white" }
    : c.total >= threshold
      ? { text: "可进计划", cls: "bg-[var(--green)] text-white" }
      : { text: "分数不够", cls: "bg-[var(--surface2)] text-[var(--dim)]" };

  return (
    <div
      className={`rounded-xl border bg-[var(--surface)] px-3.5 py-3 ${
        c.vetoed ? "border-[var(--accent)]" : "border-[var(--border)]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-base font-bold">{c.name}</span>
          {c.code && (
            <span className="font-num ml-2 text-xs text-[var(--dim)]">{c.code}</span>
          )}
          {c.code && c.date === todayStr() ? (
            <LiveQuoteChip code={c.code} />
          ) : null}
          {c.theme && <span className="ml-2 text-xs text-[var(--dim)]">{c.theme}</span>}
        </div>
        <span className={`rounded-md px-2 py-1 text-xs font-bold ${status.cls}`}>
          {status.text}
        </span>
      </div>

      {c.vetoed ? (
        <ul className="mt-2 space-y-0.5 text-sm font-medium text-[var(--accent)]">
          {c.vetoReasons.map((r) => (
            <li key={r}>🚫 {r}</li>
          ))}
        </ul>
      ) : (
        <>
          <div className="font-num mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black">{c.total}</span>
            <span className="text-xs text-[var(--dim)]">/ 100 分</span>
          </div>
          <div className="mt-2 space-y-1">
            {SCORE_DIMS.map((d) => {
              const v = c[d.key as ScoreKey];
              return (
                <div key={d.key} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-[var(--dim)]">{d.label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-[var(--surface2)]">
                    <div
                      className="h-full bg-[var(--accent)]"
                      style={{ width: `${(v / 5) * 100}%` }}
                    />
                  </div>
                  <span className="font-num w-4 text-right">{v}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {(c.boardDays != null || c.ydayState) && (
        <p className="mt-1.5 text-xs text-[var(--dim)]">
          昨日{c.boardDays != null ? ` ${c.boardDays} 板` : ""}
          {c.ydayState ? ` · ${ydayStateLabel(c.ydayState)}` : ""}
        </p>
      )}
      {(c.auctionGainPct != null || c.auctionAmountWan != null || c.auctionVolRatio != null) && (
        <p className="font-num mt-2 text-xs text-[var(--dim)]">
          竞价
          {c.auctionGainPct != null && ` 涨幅 ${fmtPct(c.auctionGainPct)}`}
          {c.auctionAmountWan != null &&
            ` · 金额 ${c.auctionAmountWan.toLocaleString("zh-CN")} 万`}
          {c.auctionVolRatio != null && ` · 量比 ${c.auctionVolRatio}`}
        </p>
      )}
      {c.note && <p className="mt-2 text-sm text-[var(--dim)]">{c.note}</p>}
    </div>
  );
}

// ---------- 异动临界（第二档：偏离值距触发线测算） ----------

function parseSeries(text: string): number[] | null {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

function AbnormalList({ date }: { date: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["abnormal", date],
    queryFn: () => api.listAbnormalWatches({ date }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteAbnormalWatch({ id }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const watches = [...(list.data?.watches ?? [])].sort(
    (a, b) =>
      (ABNORMAL_LEVELS[a.level]?.rank ?? 9) - (ABNORMAL_LEVELS[b.level]?.rank ?? 9),
  );

  if (list.isPending) return <p className="text-sm text-[var(--dim)]">加载中…</p>;
  if (watches.length === 0) {
    return (
      <p className="text-sm text-[var(--dim)]">
        这一天还没有异动观察记录。把梯队股最近至多 30 日的个股与对应指数涨跌幅序列录进来，这里会按价格异动规则算偏离值、离普通触发线还差多少、分到哪一档。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {watches.map((w) => (
        <AbnormalCard key={w.id} w={w} onDelete={() => del.mutate(w.id)} deleting={del.isPending} />
      ))}
    </div>
  );
}

function AbnormalCard({
  w,
  onDelete,
  deleting,
}: {
  w: AbnormalWatch;
  onDelete: () => void;
  deleting: boolean;
}) {
  const lvl = ABNORMAL_LEVELS[w.level] ?? { label: w.level, rank: 9 };
  const badge =
    w.level === "severe"
      ? "bg-[var(--accent)] text-white"
      : w.level === "triggered"
        ? "bg-[var(--accent-dim)] text-[var(--accent)]"
        : w.level === "severeNear"
          ? "bg-[var(--amber)] text-white"
          : w.level === "near"
            ? "bg-[var(--amber-dim)] text-[var(--amber)]"
            : "bg-[var(--surface2)] text-[var(--dim)]";
  const devText = (v: number | null) =>
    v == null ? "数据不足" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
  const gapLine =
    w.gapPoints == null
      ? "普通线距离：数据不足（不足 3 日）"
      : w.gapPoints <= 0
        ? `已越线 ${Math.abs(w.gapPoints).toFixed(2)} 点`
        : `距普通线还差 ${w.gapPoints.toFixed(2)} 点（约 ${Math.ceil(w.gapPoints / w.limitPct)} 个涨停）`;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-bold">{w.name}</span>
          {w.code && <span className="font-num ml-2 text-xs text-[var(--dim)]">{w.code}</span>}
          <span className="ml-2 text-xs text-[var(--dim)]">{boardTypeLabel(w.boardType)}</span>
        </div>
        <span className={`rounded-md px-2 py-1 text-xs font-bold ${badge}`}>{lvl.label}</span>
      </div>
      <div className="font-num mt-2 grid grid-cols-4 gap-2 text-center text-sm">
        <div className="rounded-lg bg-[var(--surface2)] px-1 py-2">
          <div className="font-bold">{devText(w.dev3)}</div>
          <div className="text-[11px] text-[var(--dim)]">3 日偏离</div>
        </div>
        <div className="rounded-lg bg-[var(--surface2)] px-1 py-2">
          <div className="font-bold">{devText(w.dev10)}</div>
          <div className="text-[11px] text-[var(--dim)]">10 日偏离</div>
        </div>
        <div className="rounded-lg bg-[var(--surface2)] px-1 py-2">
          <div className="font-bold">{devText(w.dev30)}</div>
          <div className="text-[11px] text-[var(--dim)]">30 日偏离</div>
        </div>
        <div className="rounded-lg bg-[var(--surface2)] px-1 py-2">
          <div className="font-bold">{w.events10 == null ? "数据不足" : w.events10}</div>
          <div className="text-[11px] text-[var(--dim)]">10 日事件（近似）</div>
        </div>
      </div>
      <p className="mt-2 text-sm">
        <span className="font-semibold">{gapLine}</span>
        <span className="text-[var(--dim)]">
          {" · "}换手判定：
          {w.turnoverState === "triggered"
            ? "已触发换手异动"
            : w.turnoverState === "no"
              ? "未触发"
              : "未提供"}
          {" · "}序列 {w.stockChg.length} 日
        </span>
      </p>
      {w.note && <p className="mt-1 text-sm text-[var(--dim)]">{w.note}</p>}
      <div className="mt-2">
        <Btn variant="danger" disabled={deleting} onClick={onDelete} ariaLabel={`删除异动观察 ${w.name}`}>
          删除
        </Btn>
      </div>
    </div>
  );
}

function AbnormalForm({ date, onDone }: { date: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [boardType, setBoardType] = useState<string>("main");
  const [stockText, setStockText] = useState("");
  const [indexText, setIndexText] = useState("");
  const [turnoverText, setTurnoverText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: (args: {
      stockChg: number[];
      indexChg: number[];
      turnover: number[] | null;
    }) =>
      api.saveAbnormalWatch({
        date,
        name: name.trim(),
        code: code.trim(),
        boardType: boardType as "main" | "chinext" | "star" | "st",
        ...args,
        note: note.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  const submit = () => {
    const stock = parseSeries(stockText);
    const index = parseSeries(indexText);
    if (!stock || !index) {
      setError("个股 / 指数序列必须是数字（逗号或空格分隔）");
      return;
    }
    if (stock.length !== index.length) {
      setError(`个股序列 ${stock.length} 日与指数序列 ${index.length} 日长度不一致`);
      return;
    }
    if (stock.length > 30) {
      setError("序列最多 30 个交易日");
      return;
    }
    let turnover: number[] | null = null;
    if (turnoverText.trim()) {
      turnover = parseSeries(turnoverText);
      if (!turnover) {
        setError("换手率序列必须是数字");
        return;
      }
      if (turnover.length !== stock.length) {
        setError("换手率序列长度须与个股序列一致");
        return;
      }
    }
    setError("");
    save.mutate({ stockChg: stock, indexChg: index, turnover });
  };

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="grid grid-cols-2 gap-3">
        <TextField label="股票名称" value={name} onChange={setName} placeholder="如 襄阳轴承" />
        <TextField label="代码（可选）" value={code} onChange={setCode} placeholder="如 000678" />
      </div>
      <div className="mt-3">
        <label htmlFor="f-board-type" className={labelCls}>
          板块类型
        </label>
        <select
          id="f-board-type"
          aria-label="板块类型"
          className={inputCls}
          value={boardType}
          onChange={(e) => setBoardType(e.target.value)}
        >
          {BOARD_TYPES.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}（普通线 ±{b.line}% · 涨停 {b.limit}%）
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 space-y-3">
        <AreaField
          label="个股日涨跌幅序列 %（旧→新，逗号或空格分隔）"
          value={stockText}
          onChange={setStockText}
          placeholder="如 10.00, 10.10, 1.90"
          rows={2}
        />
        <AreaField
          label="对应指数日涨跌幅序列 %（与个股等长同序）"
          value={indexText}
          onChange={setIndexText}
          placeholder="如 0.20, 0.15, 0.16"
          rows={2}
        />
        <AreaField
          label="换手率序列 %（可选，与上面同序）"
          value={turnoverText}
          onChange={setTurnoverText}
          placeholder="可空；满 8 日才参与换手异动判定"
          rows={2}
        />
        <AreaField label="备注" value={note} onChange={setNote} placeholder="可选" />
      </div>
      {error && (
        <p className="mt-2 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-medium text-[var(--amber)]">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Btn
          variant="primary"
          disabled={!name.trim() || save.isPending}
          onClick={submit}
        >
          保存并计算
        </Btn>
        <Btn onClick={onDone}>取消</Btn>
      </div>
      {save.isError && <p className="mt-2 text-sm text-[var(--accent)]">保存失败，请重试</p>}
    </div>
  );
}

function AbnormalSection({ date }: { date: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <Section title="异动临界">
      <AbnormalList date={date} />
      {adding ? (
        <AbnormalForm date={date} onDone={() => setAdding(false)} />
      ) : (
        <div className="mt-3">
          <Btn variant="primary" onClick={() => setAdding(true)}>
            + 添加异动观察
          </Btn>
        </div>
      )}
    </Section>
  );
}

function AbnormalTab({ date }: { date: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <Section
        title="异动临界"
        right={<span className="text-xs text-[var(--dim)]">{date.slice(5)} 的观察记录</span>}
      >
        <p className="mb-3 text-sm text-[var(--dim)]">
          偏离值 = 个股涨跌幅 − 对应指数涨跌幅，按日累计。普通触发线：主板 ±20% / 创业板·科创板 ±30% / 主板 ST ±12%；10 日事件数为近似口径。
        </p>
        <AbnormalList date={date} />
        {adding ? (
          <AbnormalForm date={date} onDone={() => setAdding(false)} />
        ) : (
          <div className="mt-3">
            <Btn variant="primary" onClick={() => setAdding(true)}>
              + 添加异动观察
            </Btn>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------- 竞价回测（第二档：两条轨严格分开，只报进度，未达门槛不下结论） ----------

function BacktestTab() {
  const [track, setTrack] = useState<"auction" | "leader">("auction");
  const summary = useQuery({
    queryKey: ["backtest", track],
    queryFn: () => api.getBacktestSummary({ track }),
  });
  const s = summary.data;

  return (
    <div>
      <Section title="竞价回测">
        <div className="mb-4 grid grid-cols-2 gap-2" role="tablist" aria-label="回测轨道">
          {(
            [
              { key: "auction", label: "竞价推荐" },
              { key: "leader", label: "龙头推荐" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={track === t.key}
              onClick={() => setTrack(t.key)}
              className={`rounded-lg border py-2.5 text-sm font-bold ${
                track === t.key
                  ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                  : "border-[var(--border)] text-[var(--dim)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {summary.isPending ? (
          <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : !s ? (
          <p className="text-sm text-[var(--accent)]">加载失败，请重试</p>
        ) : s.totalRows === 0 ? (
          <p className="text-sm text-[var(--dim)]">
            尚无归档数据，首个交易日 09:26 起开始归档
          </p>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <ProgressRow
              label="已回填推荐"
              value={s.filledRecommended}
              target={s.picksThreshold}
              unit="只"
            />
            <ProgressRow
              label="已归档交易日"
              value={s.distinctDates}
              target={s.daysThreshold}
              unit="天"
            />
            <p className="font-num mt-2 text-xs text-[var(--dim)]">
              已同步 {s.totalRows} 行 · 推荐总数 {s.recommendedTotal} 只 · 已回填{" "}
              {s.filledRecommended} 只
            </p>

            {!s.thresholdMet ? (
              <p className="mt-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
                未达门槛：只报累积进度，不下结论、不提改参
              </p>
            ) : s.stats ? (
              <div className="mt-4">
                {s.lowSample && (
                  <p className="mb-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
                    样本不足，仅供参考（已回填推荐不足 50 只）
                  </p>
                )}
                <div className="flex items-end justify-between border-t border-[var(--border)] pt-3">
                  <div>
                    <div className="text-xs text-[var(--dim)]">
                      推荐成功率（成功口径 v1：当日封住涨停，或次日开盘溢价 ≥ +3%）
                    </div>
                    <div className="font-num mt-0.5 text-3xl font-black">
                      {s.stats.successRate != null ? `${s.stats.successRate}%` : "—"}
                    </div>
                  </div>
                  <div className="font-num text-right text-sm text-[var(--dim)]">
                    被否决股反事实：{s.stats.vetoCounterfactual.count} 只中有{" "}
                    {s.stats.vetoCounterfactual.limitRate != null
                      ? `${s.stats.vetoCounterfactual.limitRate}%`
                      : "—"}{" "}
                    当日封住涨停
                  </div>
                </div>
                <BucketGroup title="竞价涨幅分桶" buckets={s.stats.gainBuckets} />
                <BucketGroup title="竞价量比分桶" buckets={s.stats.volBuckets} />
                <BucketGroup title="连板高度分桶" buckets={s.stats.boardBuckets} />
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  target,
  unit,
}: {
  label: string;
  value: number;
  target: number;
  unit: string;
}) {
  const pct = Math.min(100, (value / target) * 100);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-num text-[var(--dim)]">
          {value} / {target} {unit}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-[var(--surface2)]">
        <div className="h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BucketGroup({
  title,
  buckets,
}: {
  title: string;
  buckets: { label: string; count: number; successRate: number | null }[];
}) {
  const list = buckets;
  if (list.every((b) => b.count === 0)) return null;
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-sm font-bold">{title}</div>
      <div className="space-y-1">
        {list.map((b) => (
          <div key={b.label} className="font-num flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0">{b.label}</span>
            <span className="flex-1 text-[var(--dim)]">{b.count} 只</span>
            <span className="font-bold">
              {b.successRate != null ? `${b.successRate}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 盘中实况（采集器四池快照 + 盯盘实时行情，只读） ----------

function fmtSealAmount(v: number | null): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${Math.round(v / 1e4)}万`;
  return `${Math.round(v)}`;
}

const POOL_ROUTE_LABEL: Record<string, string> = {
  direct: "直连东财",
  cf: "Cloudflare 绕行",
};
const QUOTES_SOURCE_LABEL: Record<string, string> = {
  sina: "新浪",
  tencent: "腾讯",
};

// 候选/推荐行上的实时价小标签：只在采集器盯盘名单内（或四池）有行情时出现，
// 与盘中实况共用同一查询，30 秒自动刷新。
function LiveQuoteChip({ code }: { code: string }) {
  const today = todayStr();
  const q = useQuery({
    queryKey: ["intradaySnapshot", today],
    queryFn: () => api.getIntradaySnapshot({ date: today }),
    refetchInterval: 30000,
  });
  const quote = q.data?.quotes.find((x) => x.code === code);
  if (!quote || quote.price == null) return null;
  return (
    <span
      className="font-num ml-2 text-xs font-bold"
      style={{ color: pnlColor(quote.pct) }}
    >
      现价 {quote.price}
      {quote.pct != null ? ` ${fmtPct(quote.pct)}` : ""}
    </span>
  );
}

function LiveStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--surface2)] px-1 py-2 text-center">
      <div className="font-num text-base font-bold leading-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--dim)]">{label}</div>
      {note ? (
        <div className="mt-0.5 text-[10px] leading-tight text-[var(--dim)]">{note}</div>
      ) : null}
    </div>
  );
}

type PoolRowT = IntradaySnapshot["zt"][number];

function ZtRow({ r }: { r: PoolRowT }) {
  const boards = r.lbc != null && r.lbc > 0 ? Math.round(r.lbc) : 1;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-semibold">{r.name}</span>
          {r.code ? (
            <span className="font-num ml-2 text-xs text-[var(--dim)]">{r.code}</span>
          ) : null}
          {r.industry ? (
            <span className="ml-2 text-xs text-[var(--dim)]">{r.industry}</span>
          ) : null}
        </div>
        <span className="shrink-0 rounded-md bg-[var(--accent-dim)] px-2 py-1 text-xs font-bold text-[var(--accent)]">
          {boards} 板
        </span>
      </div>
      <div className="font-num mt-1 text-xs text-[var(--dim)]">
        {r.firstSeal ? `首封 ${r.firstSeal}` : ""}
        {r.sealFund != null ? ` · 封单 ${fmtSealAmount(r.sealFund)}元` : ""}
        {r.breakTimes != null && r.breakTimes > 0
          ? ` · 开板 ${r.breakTimes} 次`
          : ""}
        {r.turnover != null ? ` · 换手 ${r.turnover.toFixed(1)}%` : ""}
        {r.ztStat ? ` · ${r.ztStat}` : ""}
      </div>
    </div>
  );
}

function PoolMiniRow({ r, extra }: { r: PoolRowT; extra?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="min-w-0">
        <span className="text-sm font-semibold">{r.name}</span>
        {r.code ? (
          <span className="font-num ml-2 text-xs text-[var(--dim)]">{r.code}</span>
        ) : null}
        {extra ? (
          <span className="ml-2 text-xs text-[var(--dim)]">{extra}</span>
        ) : null}
      </div>
      <span
        className="font-num shrink-0 text-sm font-bold"
        style={{ color: pnlColor(r.pct) }}
      >
        {fmtPct(r.pct)}
      </span>
    </div>
  );
}

function LivePanel({ date }: { date: string }) {
  const qc = useQueryClient();
  const isToday = date === todayStr();
  const [expanded, setExpanded] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const snap = useQuery({
    queryKey: ["intradaySnapshot", date],
    queryFn: () => api.getIntradaySnapshot({ date }),
    refetchInterval: isToday ? 30000 : false,
  });

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = useCallback(() => {
    void snap.refetch();
    if (isToday) {
      api
        .syncintradayevents({})
        .then(() => {
          void qc.invalidateQueries({ queryKey: ["intraday", date] });
        })
        .catch(() => {});
    }
  }, [snap, isToday, qc, date]);

  const data = snap.data;
  const live = data?.available
    ? assessCycle({
        limitUpCount: data.limitUpCount,
        limitDownCount: data.limitDownCount,
        maxBoard: data.maxBoard,
        prevPremiumPct: data.prevPremiumPct,
        sealRatePct: data.sealRatePct,
        ladderGap: data.ladderGap,
      })
    : null;
  const voteText = live
    ? STAGE_TIERS.filter((t) => live.votes[t] > 0)
        .map((t) => `${t} ${live.votes[t]} 票`)
        .join(" · ")
    : "";
  const poolsAge =
    data?.poolsFetchedAt != null
      ? nowTick - new Date(data.poolsFetchedAt).getTime()
      : null;
  const stale =
    isToday &&
    inTradingWindow(new Date(nowTick)) &&
    data?.available &&
    (poolsAge == null || poolsAge > 3 * 60 * 1000);
  const ztShown = data ? (expanded ? data.zt : data.zt.slice(0, 12)) : [];

  return (
    <Section
      title="盘中实况"
      right={
        <span className="flex items-center gap-2">
          {isToday && data?.available ? (
            <span className="text-xs font-semibold text-[var(--accent)]">实时</span>
          ) : null}
          <Btn ariaLabel="刷新盘中实况" onClick={refreshAll}>
            刷新
          </Btn>
        </span>
      }
    >
      {snap.isPending ? (
        <p className="text-sm text-[var(--dim)]">加载中…</p>
      ) : snap.isError ? (
        <p className="text-sm text-[var(--accent)]">盘中数据加载失败，检查网络后重试</p>
      ) : !data?.available ? (
        <div>
          {data?.error ? (
            <p className="mb-2 text-sm text-[var(--accent)]">{data.error}</p>
          ) : null}
          <p className="text-sm text-[var(--dim)]">
            该日暂无采集器盘中快照。采集器只在交易时段（工作日
            09:15–15:05）落盘涨停/炸板/跌停/昨涨停四池数据；非交易日或采集器未运行时为空属正常情形。
          </p>
        </div>
      ) : (
        <div>
          {stale ? (
            <div className="mb-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
              盘中数据可能中断，以下为最后记录（池数据{" "}
              {fmtTsFull(data.poolsFetchedAt)}）
            </div>
          ) : null}

          <div className="font-num grid grid-cols-3 gap-2">
            <LiveStat label="涨停家数" value={`${data.limitUpCount ?? "—"} 家`} />
            <LiveStat label="跌停家数" value={`${data.limitDownCount ?? "—"} 家`} />
            <LiveStat label="炸板家数" value={`${data.brokenCount ?? "—"} 家`} />
            <LiveStat
              label="最高连板"
              value={data.maxBoard != null ? `${data.maxBoard} 板` : "—"}
            />
            <LiveStat
              label="封板率"
              value={data.sealRatePct != null ? `${data.sealRatePct}%` : "—"}
              note={
                data.brokenRatePct != null ? `炸板率 ${data.brokenRatePct}%` : undefined
              }
            />
            <LiveStat
              label="昨涨溢价"
              value={fmtPct(data.prevPremiumPct)}
              note={
                data.yztCount != null
                  ? `昨涨停 ${data.yztCount} 只 · 红盘 ${data.yztUpCount ?? "—"}`
                  : undefined
              }
            />
          </div>

          {live ? (
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <div className="text-xs text-[var(--dim)]">
                    {isToday
                      ? "盘中暂定定调（六指标按当前数据计算）"
                      : "当日盘中定调（采集器快照回算）"}
                  </div>
                  <div className="mt-0.5 text-2xl font-black">{live.computed}</div>
                </div>
                <div className="font-num text-xs text-[var(--dim)]">{voteText}</div>
              </div>
              <div className="mt-3 space-y-1.5">
                {live.indicators.map((ind) => (
                  <div key={ind.key} className="flex items-center gap-2.5 text-sm">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        background: ind.missing
                          ? "transparent"
                          : TIER_DOT[ind.vote ?? "混沌"],
                        border: ind.missing
                          ? "1.5px solid var(--dim)"
                          : `1.5px solid ${TIER_DOT[ind.vote ?? "混沌"]}`,
                      }}
                    />
                    <span className="w-20 shrink-0 text-[var(--dim)]">{ind.label}</span>
                    <span className="font-num flex-1 font-semibold">
                      {ind.missing ? (
                        <span className="font-sans font-normal text-[var(--dim)]">
                          未查得
                        </span>
                      ) : (
                        ind.valueText
                      )}
                    </span>
                    {ind.vote ? (
                      <span
                        className="text-xs font-semibold"
                        style={{ color: TIER_DOT[ind.vote] }}
                      >
                        投{ind.vote}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--dim)]">不投票</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-[var(--dim)]">
                盘中数据未定稿，定调仅供盘中观察；收盘复盘写入官方定调后以其为准。
              </p>
            </div>
          ) : null}

          {data.tiers.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.tiers.map((t) => (
                <span
                  key={t.boards}
                  className="font-num rounded-md bg-[var(--surface2)] px-2 py-1 text-xs font-semibold"
                >
                  {t.boards}板 ×{t.count}
                </span>
              ))}
              {data.ladderGap ? (
                <span className="rounded-md bg-[var(--amber-dim)] px-2 py-1 text-xs font-bold text-[var(--amber)]">
                  梯队有断层
                </span>
              ) : null}
            </div>
          ) : null}

          {data.themes.length > 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              涨停行业分布：
              {data.themes.map((t) => `${t.name} ${t.count} 家`).join(" · ")}
            </p>
          ) : null}

          {data.zt.length > 0 ? (
            <div className="mt-4">
              <div className="mb-2 text-sm font-bold">
                涨停梯队（{data.zt.length} 只，按连板与封单排序）
              </div>
              <div className="space-y-2">
                {ztShown.map((r) => (
                  <ZtRow key={r.code} r={r} />
                ))}
              </div>
              {data.zt.length > 12 ? (
                <div className="mt-2">
                  <Btn
                    ariaLabel={expanded ? "收起涨停梯队" : "展开全部涨停梯队"}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? "收起" : `展开全部 ${data.zt.length} 只`}
                  </Btn>
                </div>
              ) : null}
            </div>
          ) : null}

          {data.zb.length > 0 ? (
            <div className="mt-4">
              <div className="mb-2 text-sm font-bold">炸板（{data.zb.length} 只）</div>
              <div className="space-y-2">
                {data.zb.map((r) => (
                  <PoolMiniRow
                    key={r.code}
                    r={r}
                    extra={
                      r.breakTimes != null && r.breakTimes > 0
                        ? `开板 ${r.breakTimes} 次`
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}

          {data.dt.length > 0 ? (
            <div className="mt-4">
              <div className="mb-2 text-sm font-bold">跌停（{data.dt.length} 只）</div>
              <div className="space-y-2">
                {data.dt.map((r) => (
                  <PoolMiniRow key={r.code} r={r} />
                ))}
              </div>
            </div>
          ) : null}

          {data.yztTop.length > 0 || data.yztBottom.length > 0 ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-sm font-bold">昨涨停 · 今日最强</div>
                <div className="space-y-2">
                  {data.yztTop.map((r) => (
                    <PoolMiniRow
                      key={r.code}
                      r={r}
                      extra={r.yLbc != null ? `昨 ${Math.round(r.yLbc)} 板` : undefined}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm font-bold">昨涨停 · 今日最弱</div>
                <div className="space-y-2">
                  {data.yztBottom.map((r) => (
                    <PoolMiniRow
                      key={r.code}
                      r={r}
                      extra={r.yLbc != null ? `昨 ${Math.round(r.yLbc)} 板` : undefined}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <p className="font-num mt-4 text-xs leading-relaxed text-[var(--dim)]">
            池数据 {fmtTsFull(data.poolsFetchedAt)}
            {data.health.poolRoute
              ? `（${POOL_ROUTE_LABEL[data.health.poolRoute] ?? data.health.poolRoute}）`
              : ""}
            {" · "}行情 {fmtTsFull(data.quotesUpdatedAt)}
            {data.health.quotesSource
              ? `（${QUOTES_SOURCE_LABEL[data.health.quotesSource] ?? data.health.quotesSource}）`
              : ""}
            {data.health.watchlistSize != null
              ? ` · 盯盘 ${data.health.watchlistSize} 只${data.health.watchlistSource === "live" ? "（实时名单）" : data.health.watchlistSource ? `（名单：${data.health.watchlistSource}）` : ""}`
              : ""}
          </p>
        </div>
      )}
    </Section>
  );
}

// ---------- 盘中异动（采集器事件流，只读：只陈述市场事实） ----------

const INTRADAY_TYPE_META: Record<string, { label: string; badge: string }> = {
  first_seal: { label: "首封", badge: "bg-[var(--green-dim)] text-[var(--green)]" },
  reseal: { label: "回封", badge: "bg-[var(--green-dim)] text-[var(--green)]" },
  broken: { label: "炸板", badge: "bg-[var(--accent-dim)] text-[var(--accent)]" },
  dive: { label: "高标跳水", badge: "bg-[var(--accent-dim)] text-[var(--accent)]" },
  seal_drop: { label: "封单骤降", badge: "bg-[var(--amber-dim)] text-[var(--amber)]" },
  limit_down_seal: { label: "跌停封板", badge: "bg-[var(--info-dim)] text-[var(--info)]" },
};

// 与采集器口径一致的交易时段：周一至周五 09:15–11:35、12:55–15:05
function inTradingWindow(now: Date): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return (
    (mins >= 9 * 60 + 15 && mins <= 11 * 60 + 35) ||
    (mins >= 12 * 60 + 55 && mins <= 15 * 60 + 5)
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function fmtTsTime(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtTsFull(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.getMonth() + 1}-${pad2(d.getDate())} ${fmtTsTime(ts)}`;
}

function IntradaySection({ date }: { date: string }) {
  const qc = useQueryClient();
  const [syncError, setSyncError] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());

  // 增量同步采集器事件文件；打开时先同步一次，停留期间每分钟再同步，
  // 盘中打开着就能持续看到新事件，不必等下一次进页面。
  const doSync = useCallback(() => {
    api
      .syncintradayevents({})
      .then((r) => {
        setSyncError(r.error);
        if (r.inserted > 0) {
          void qc.invalidateQueries({ queryKey: ["intraday", date] });
        }
      })
      .catch(() => setSyncError("事件流同步失败，请稍后重试"));
  }, [date, qc]);

  useEffect(() => {
    doSync();
  }, [doSync]);

  useEffect(() => {
    const t = setInterval(doSync, 60000);
    return () => clearInterval(t);
  }, [doSync]);

  const list = useQuery({
    queryKey: ["intraday", date],
    queryFn: () => api.listintradayevents({ date }),
  });

  // 每分钟重算一次过时判定
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const stream = list.data?.stream;
  const healthAge =
    stream?.streamUpdatedAt != null
      ? nowTick - new Date(stream.streamUpdatedAt).getTime()
      : null;
  const stale =
    stream != null &&
    inTradingWindow(new Date(nowTick)) &&
    (healthAge == null || healthAge > 3 * 60 * 1000);
  const events = list.data?.events ?? [];

  return (
    <Section title="盘中异动">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
        <span>
          最后事件：
          <span className="font-num">{fmtTsFull(stream?.lastEventTs ?? null)}</span>
        </span>
        <span>
          采集器更新：
          <span className="font-num">{fmtTsFull(stream?.streamUpdatedAt ?? null)}</span>
        </span>
      </div>
      {stale ? (
        <div className="mb-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
          事件流可能中断，以下为最后记录
        </div>
      ) : null}
      {syncError ? (
        <p className="mb-3 text-sm text-[var(--accent)]">{syncError}</p>
      ) : null}
      {list.isPending ? (
        <p className="text-sm text-[var(--dim)]">加载中…</p>
      ) : list.isError ? (
        <p className="text-sm text-[var(--accent)]">事件加载失败，检查网络后重试</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          暂无盘中异动事件。采集器仅在交易时段（工作日
          09:15–15:05）记录首封、炸板、回封等事件，非交易时段或当日尚无异动时事件流为空属正常情形。
        </p>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => (
            <IntradayEventRow key={ev.id} ev={ev} />
          ))}
        </div>
      )}
    </Section>
  );
}

function IntradayEventRow({ ev }: { ev: IntradayEvent }) {
  const meta = INTRADAY_TYPE_META[ev.type] ?? {
    label: ev.type,
    badge: "bg-[var(--surface2)] text-[var(--dim)]",
  };
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
      <span className="font-num pt-0.5 text-sm text-[var(--dim)]">
        {fmtTsTime(ev.eventTs)}
      </span>
      <span
        className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold ${meta.badge}`}
      >
        {meta.label}
      </span>
      <div className="min-w-0">
        <div>
          <span className="font-semibold">{ev.name}</span>
          {ev.code ? (
            <span className="font-num ml-2 text-xs text-[var(--dim)]">{ev.code}</span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm text-[var(--dim)]">{ev.factText}</p>
      </div>
    </div>
  );
}

// ---------- 盘后对账（只读；记录只由每晚对账任务写入） ----------

function ReconSubRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="text-[var(--dim)]">{label}</span>
      <span className="font-num font-semibold text-[var(--text)]">{value}</span>
    </div>
  );
}

function ReconciliationSection({ date }: { date: string }) {
  const q = useQuery({
    queryKey: ["reconciliation", date],
    queryFn: () => api.getreconciliation({ date }),
  });
  const rec: Reconciliation | null = q.data?.record ?? null;

  const num = (v: number | null) => (v != null ? `${v}` : "—");
  const pct = (v: number | null) => (v != null ? `${v}%` : "—");

  const badge =
    rec?.status === "一致"
      ? "bg-[var(--green-dim)] text-[var(--green)]"
      : rec?.status === "差异已注"
        ? "bg-[var(--amber-dim)] text-[var(--amber)]"
        : "bg-[var(--surface2)] text-[var(--dim)]";

  const diffGroups: { label: string; entries: { code: string; name: string }[] }[] =
    rec != null
      ? [
          { label: "自算有 / 东财无", entries: rec.diff.selfOnly },
          { label: "东财有 / 自算无", entries: rec.diff.emOnly },
          { label: "同花顺有 / 自算无", entries: rec.diff.thsOnly },
          ...Object.entries(rec.diff.extra).map(([k, entries]) => ({
            label: k,
            entries,
          })),
        ].filter((g) => g.entries.length > 0)
      : [];

  return (
    <Section
      title="盘后对账"
      right={
        rec ? (
          <span className={`rounded-md px-2 py-1 text-xs font-bold ${badge}`}>
            {rec.status}
          </span>
        ) : undefined
      }
    >
      {q.isPending ? (
        <p className="text-sm text-[var(--dim)]">加载中…</p>
      ) : q.isError ? (
        <p className="text-sm text-[var(--accent)]">对账记录加载失败，检查网络后重试</p>
      ) : !rec ? (
        <p className="text-sm text-[var(--dim)]">暂无对账记录。</p>
      ) : (
        <div className="space-y-4">
          {/* 三组涨停数并排：自算 / 东财池 / 决策台采用 */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
              <div className="text-xs font-semibold text-[var(--dim)]">自算 · 盘后包</div>
              <div className="font-num mt-1 text-2xl font-black leading-none">
                {num(rec.selfZtDesk)}
                <span className="ml-1 text-xs font-semibold text-[var(--dim)]">只涨停</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">决策台宇宙</div>
              <div className="mt-2 space-y-1 text-xs">
                <ReconSubRow label="全口径" value={num(rec.selfZtAll)} />
                <ReconSubRow label="不含 ST" value={num(rec.selfZtNoSt)} />
                <ReconSubRow label="跌停（价格口径）" value={num(rec.selfDtDesk)} />
                <ReconSubRow label="摸板未封" value={num(rec.selfTouchedDesk)} />
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
              <div className="text-xs font-semibold text-[var(--dim)]">东财池口径</div>
              <div className="font-num mt-1 text-2xl font-black leading-none">
                {num(rec.emZt)}
                <span className="ml-1 text-xs font-semibold text-[var(--dim)]">只涨停</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">涨停池</div>
              <div className="mt-2 space-y-1 text-xs">
                <ReconSubRow label="炸板池" value={num(rec.emZb)} />
                <ReconSubRow label="跌停池" value={num(rec.emDt)} />
                <ReconSubRow label="同花顺涨停池" value={num(rec.thsZt)} />
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
              <div className="text-xs font-semibold text-[var(--dim)]">决策台采用</div>
              <div className="font-num mt-1 text-2xl font-black leading-none">
                {num(rec.deskLimitUpCount)}
                <span className="ml-1 text-xs font-semibold text-[var(--dim)]">只涨停</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">当日回填口径</div>
              <div className="mt-2 space-y-1 text-xs">
                <ReconSubRow label="跌停" value={num(rec.deskLimitDownCount)} />
              </div>
            </div>
          </div>

          {/* 封板率并列：自算必须带下限口径标签 */}
          <div className="font-num grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[var(--surface2)] px-3 py-2">
              <div className="text-lg font-bold leading-tight">{pct(rec.selfSealRateDesk)}</div>
              <div className="text-xs text-[var(--dim)]">自算封板率 · 自算口径（下限）</div>
            </div>
            <div className="rounded-lg bg-[var(--surface2)] px-3 py-2">
              <div className="text-lg font-bold leading-tight">{pct(rec.emSealRate)}</div>
              <div className="text-xs text-[var(--dim)]">东财封板率</div>
            </div>
          </div>

          {/* 自算连板链前 5 */}
          {rec.lbcTop.length > 0 ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold text-[var(--dim)]">
                自算连板链前 5
              </div>
              <ol className="space-y-1">
                {rec.lbcTop.map((s, i) => (
                  <li
                    key={`${s.code || s.name}-${i}`}
                    className="flex items-baseline gap-2 text-sm"
                  >
                    <span className="font-num w-4 text-[var(--dim)]">{i + 1}</span>
                    <span className="font-semibold">{s.name || "—"}</span>
                    {s.code ? (
                      <span className="font-num text-xs text-[var(--dim)]">{s.code}</span>
                    ) : null}
                    <span className="font-num ml-auto font-bold text-[var(--accent)]">
                      {s.lbc} 板
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {/* 连板链一致性 */}
          {rec.lbcMismatch.length > 0 ? (
            <p className="text-sm">
              连板链与东财 lbc 不一致 {rec.lbcMismatch.length} 只：
              {rec.lbcMismatch
                .map(
                  (m) =>
                    `${m.name || m.code}（自算 ${m.selfLbc ?? "—"} / 东财 ${m.emLbc ?? "—"}）`,
                )
                .join("、")}
            </p>
          ) : rec.lbcTop.length > 0 ? (
            <p className="text-sm text-[var(--dim)]">连板链与东财 lbc 全部一致。</p>
          ) : null}

          {/* 名单差集摘要 */}
          {rec.diffTotal > 0 ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold text-[var(--dim)]">
                名单差集 · 共 {rec.diffTotal} 条
              </div>
              <ul className="space-y-1 text-sm">
                {diffGroups.map((g) => (
                  <li key={g.label}>
                    <span className="font-semibold">
                      {g.label} {g.entries.length} 只
                    </span>
                    <span className="text-[var(--dim)]">
                      ：{g.entries.map((e) => e.name || e.code).join("、")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 口径说明 */}
          {rec.notes.length > 0 ? (
            <ul className="space-y-1 text-sm text-[var(--dim)]">
              {rec.notes.map((n, i) => (
                <li key={i}>· {n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Section>
  );
}

// ---------- 盘前计划卡 ----------

function PlanSection({ date, overview }: { date: string; overview: Overview }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [changeText, setChangeText] = useState("");
  const plan = overview.plan;

  const addChange = useMutation({
    mutationFn: () => api.addPlanChange({ date, content: changeText.trim() }),
    onSuccess: () => {
      qc.invalidateQueries();
      setChangeText("");
    },
  });
  const delChange = useMutation({
    mutationFn: (id: number) => api.deletePlanChange({ id }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const complete =
    plan && plan.themes.trim() && plan.watchlist.trim() && plan.trigger.trim() && plan.giveUp.trim();

  return (
    <Section
      title="盘前计划卡"
      right={
        plan ? (
          <span
            className={`text-xs font-semibold ${complete ? "text-[var(--green)]" : "text-[var(--amber)]"}`}
          >
            {complete ? "已写完，可以开盘" : "还没写完"}
          </span>
        ) : undefined
      }
    >
      {!plan && !editing ? (
        <>
          <p className="text-sm text-[var(--dim)]">
            开盘前写完才算数：今天主攻什么题材、只看哪 2–3 只、什么条件买、什么情况直接放弃。
          </p>
          <div className="mt-3">
            <Btn variant="primary" onClick={() => setEditing(true)}>
              写今日计划
            </Btn>
          </div>
        </>
      ) : editing ? (
        <PlanForm date={date} overview={overview} onDone={() => setEditing(false)} />
      ) : plan ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <dl className="space-y-3 text-sm">
            <PlanRow label="主攻题材" value={plan.themes} />
            <PlanRow label="只看这几只" value={plan.watchlist} pre />
            <PlanRow label="触发条件（满足才买）" value={plan.trigger} />
            <PlanRow label="放弃条件（出现就不做）" value={plan.giveUp} />
            {plan.positionCap != null && (
              <div>
                <dt className="text-xs font-medium text-[var(--dim)]">今日仓位上限</dt>
                <dd className="font-num mt-0.5 text-base font-bold">{plan.positionCap}%</dd>
              </div>
            )}
            {plan.note && <PlanRow label="备注" value={plan.note} />}
          </dl>
          <div className="mt-3">
            <Btn onClick={() => setEditing(true)}>修改计划</Btn>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-3">
            <div className="mb-2 text-sm font-bold">盘中变更留痕</div>
            {overview.planChanges.length === 0 ? (
              <p className="text-xs text-[var(--dim)]">
                盘中改了计划（换票、加仓、改条件）必须在这里留痕，复盘时对账。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {overview.planChanges.map((ch) => (
                  <li key={ch.id} className="flex items-start justify-between gap-2 text-sm">
                    <span>
                      <span className="font-num mr-2 text-xs text-[var(--dim)]">
                        {new Date(ch.createdAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {ch.content}
                    </span>
                    <button
                      type="button"
                      aria-label="删除这条留痕"
                      onClick={() => delChange.mutate(ch.id)}
                      className="shrink-0 px-1 text-[var(--dim)]"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2.5 flex gap-2">
              <input
                aria-label="盘中变更内容"
                className={`${inputCls} flex-1`}
                value={changeText}
                placeholder="如 10:12 某票炸板，放弃今日计划"
                onChange={(e) => setChangeText(e.target.value)}
              />
              <Btn
                variant="primary"
                disabled={!changeText.trim() || addChange.isPending}
                onClick={() => addChange.mutate()}
              >
                记下
              </Btn>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function PlanRow({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--dim)]">{label}</dt>
      <dd className={`mt-0.5 ${pre ? "whitespace-pre-line" : ""}`}>
        {value.trim() ? value : <span className="text-[var(--amber)]">未填写</span>}
      </dd>
    </div>
  );
}

function PlanForm({
  date,
  overview,
  onDone,
}: {
  date: string;
  overview: Overview;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const plan = overview.plan;
  const verdict = useMemo(() => computeVerdict(overview.day), [overview.day]);
  const [themes, setThemes] = useState(plan?.themes ?? "");
  const [watchlist, setWatchlist] = useState(plan?.watchlist ?? "");
  const [trigger, setTrigger] = useState(plan?.trigger ?? "");
  const [giveUp, setGiveUp] = useState(plan?.giveUp ?? "");
  const [cap, setCap] = useState(
    plan?.positionCap != null
      ? String(plan.positionCap)
      : verdict
        ? String(verdict.position)
        : "",
  );
  const [note, setNote] = useState(plan?.note ?? "");

  // 合格候选一键填入只看名单
  const qualified = overview.candidates.filter(
    (c) => !c.vetoed && c.total >= overview.settings.scoreThreshold,
  );

  const save = useMutation({
    mutationFn: () =>
      api.savePlan({
        date,
        themes: themes.trim(),
        watchlist: watchlist.trim(),
        trigger: trigger.trim(),
        giveUp: giveUp.trim(),
        positionCap: parseNum(cap),
        note: note.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="space-y-3">
        <TextField label="今日主攻题材" value={themes} onChange={setThemes} placeholder="如 机器人（只做主线，不碰杂毛）" />
        <div>
          <AreaField
            label="只看这 2–3 只（一行一只）"
            value={watchlist}
            onChange={setWatchlist}
            placeholder={"大业股份\n襄阳轴承"}
            rows={3}
          />
          {qualified.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setWatchlist(qualified.slice(0, 3).map((c) => c.name).join("\n"))
              }
              className="mt-1.5 text-xs font-semibold text-[var(--accent)]"
            >
              填入今日合格候选（{qualified.map((c) => c.name).join("、")}）
            </button>
          )}
        </div>
        <AreaField label="触发条件（满足才买）" value={trigger} onChange={setTrigger} placeholder="如 竞价高开 3% 以内、开盘 5 分钟内封板且封单 > 1 亿" />
        <AreaField label="放弃条件（出现就不做）" value={giveUp} onChange={setGiveUp} placeholder="如 高标断板、题材炸板率过半、竞价不及预期" />
        <div className="grid grid-cols-2 gap-3">
          <NumField
            label="今日仓位上限 %"
            value={cap}
            onChange={setCap}
            placeholder={verdict ? `裁决建议 ${verdict.position}` : "如 25"}
          />
          <TextField label="备注" value={note} onChange={setNote} placeholder="可选" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Btn variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          保存计划
        </Btn>
        <Btn onClick={onDone}>取消</Btn>
      </div>
      {save.isError && <p className="mt-2 text-sm text-[var(--accent)]">保存失败，请重试</p>}
    </div>
  );
}

// ---------- 仓位计算器 + 设置 ----------

function CalcTab({ overview, date }: { overview: Overview; date: string }) {
  const settings = overview.settings;
  const verdict = useMemo(() => computeVerdict(overview.day), [overview.day]);
  const defaultCap =
    overview.plan?.positionCap ?? verdict?.position ?? 100;

  const [buy, setBuy] = useState("");
  const [stop, setStop] = useState("");
  const [capPct, setCapPct] = useState(String(defaultCap));
  const [riskPct, setRiskPctLocal] = useState(String(settings.riskPct));

  const result = useMemo(
    () =>
      computeSizing({
        capital: settings.capital,
        riskPct: Number(riskPct) || settings.riskPct,
        buyPrice: Number(buy) || 0,
        stopPrice: Number(stop) || 0,
        capPct: Number(capPct) || 0,
        meltLosses: settings.meltLosses,
      }),
    [settings, buy, stop, capPct, riskPct],
  );

  return (
    <div>
      <Section title="仓位计算器">
        <p className="mb-3 text-sm text-[var(--dim)]">
          先定止损，再定仓位：单笔最多亏本金的 {settings.riskPct}%，倒推出能买多少股。
          A 股一手 100 股，向下取整。
        </p>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="grid grid-cols-2 gap-3">
            <NumField label="买入价（元）" value={buy} onChange={setBuy} placeholder="如 12.50" step="0.01" />
            <NumField label="止损价（元）" value={stop} onChange={setStop} placeholder="跌破就走" step="0.01" />
            <NumField label="仓位上限 %（今日）" value={capPct} onChange={setCapPct} />
            <NumField label="单笔风险 %（本金）" value={riskPct} onChange={setRiskPctLocal} step="0.1" />
          </div>

          {result.error ? (
            <p className="mt-4 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-medium text-[var(--amber)]">
              {result.error}
            </p>
          ) : result.valid ? (
            <div className="mt-4">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-xs text-[var(--dim)]">能买</div>
                  <div className="font-num text-4xl font-black">
                    {result.shares.toLocaleString()}
                    <span className="ml-1 text-base font-bold">股</span>
                  </div>
                </div>
                <div className="font-num text-right">
                  <div className="text-sm">
                    占用资金 <span className="font-bold">{fmtMoneyPlain(result.cost)}</span>
                  </div>
                  <div className="text-sm">
                    仓位 <span className="font-bold">{result.positionPct.toFixed(1)}%</span>
                  </div>
                </div>
              </div>
              <dl className="font-num mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--border)] pt-3 text-sm">
                <CalcRow label="单笔风险额度" value={fmtMoneyPlain(result.riskAmount)} />
                <CalcRow label="每股风险（买入-止损）" value={`${result.perShareRisk.toFixed(2)} 元`} />
                <CalcRow
                  label="触发止损最坏亏"
                  value={`${fmtMoneyPlain(result.maxLoss)}（本金 ${result.lossIfStopPct.toFixed(2)}%）`}
                />
                <CalcRow
                  label="被什么卡住"
                  value={
                    result.cappedBy === "risk"
                      ? "风险额度"
                      : result.cappedBy === "cap"
                        ? "今日仓位上限"
                        : "两者接近"
                  }
                />
              </dl>
              <p className="mt-3 text-xs text-[var(--dim)]">{result.meltNote}</p>
              {overview.lossStreak > 0 && (
                <p className="mt-1 text-xs font-semibold text-[var(--amber)]">
                  当前已连亏 {overview.lossStreak} 笔，距熔断（{settings.meltLosses} 笔）还剩{" "}
                  {Math.max(0, settings.meltLosses - overview.lossStreak)} 笔额度
                </p>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--dim)]">
              填入买入价和止损价，这里会算出股数、最坏亏损和熔断距离。
              {settings.capital <= 0 && "（本金还没设置，在下方填）"}
            </p>
          )}
          <p className="mt-3 text-xs text-[var(--dim)]">
            今日（{date.slice(5)}）裁决仓位上限：
            {overview.plan?.positionCap != null
              ? `计划卡 ${overview.plan.positionCap}%`
              : verdict
                ? `${verdict.label} ${verdict.position}%`
                : "未录梯队，暂按 100%"}
          </p>
        </div>
      </Section>

      <SettingsForm settings={settings} />

      <CollectorStatus />

      <DataBackup />
    </div>
  );
}

function CalcRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--dim)]">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [capital, setCapital] = useState(String(settings.capital || ""));
  const [riskPct, setRiskPct] = useState(String(settings.riskPct));
  const [threshold, setThreshold] = useState(String(settings.scoreThreshold));
  const [melt, setMelt] = useState(String(settings.meltLosses));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        capital: Number(capital) || 0,
        riskPct: Number(riskPct) || 1,
        scoreThreshold: Math.round(Number(threshold) || 60),
        meltLosses: Math.round(Number(melt) || 3),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <Section title="风控参数">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="grid grid-cols-2 gap-3">
          <NumField label="总本金（元）" value={capital} onChange={setCapital} placeholder="如 50000" />
          <NumField label="单笔最大风险 %" value={riskPct} onChange={setRiskPct} step="0.1" />
          <NumField label="候选评分门槛（分）" value={threshold} onChange={setThreshold} />
          <NumField label="连亏几笔熔断停手" value={melt} onChange={setMelt} />
        </div>
        <p className="mt-3 text-xs text-[var(--dim)]">
          默认单笔风险 1%、门槛 60 分、连亏 3 笔熔断。本金少的时候，保住本金比抓住机会重要。
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Btn variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            保存参数
          </Btn>
          {saved && <span className="text-sm font-semibold text-[var(--green)]">已保存</span>}
          {save.isError && <span className="text-sm text-[var(--accent)]">保存失败</span>}
        </div>
      </div>
    </Section>
  );
}

// ---------- 交易日志 ----------

function deviationText(t: Trade): string {
  const base =
    t.planDeviation === "in"
      ? "计划内"
      : t.planDeviation === "out"
        ? "计划外"
        : "无计划可比";
  return t.deviationManual && t.planDeviation !== "none" ? `${base}（改判）` : base;
}

function deviationBadgeCls(t: Trade): string {
  return t.planDeviation === "in"
    ? "bg-[var(--green-dim)] text-[var(--green)]"
    : t.planDeviation === "out"
      ? "bg-[var(--accent-dim)] text-[var(--accent)]"
      : "bg-[var(--surface2)] text-[var(--dim)]";
}


function TradesTab({ defaultDate }: { defaultDate: string }) {
  const trades = useQuery({
    queryKey: ["trades"],
    queryFn: () => api.listTrades({ limit: 200 }),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Trade | null>(null);
  const list = trades.data?.trades ?? [];
  const open = list.filter((t) => t.sellPrice == null);
  const closed = list.filter((t) => t.sellPrice != null);

  return (
    <div>
      <Section
        title="交易日志"
        right={
          <Btn
            variant="primary"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
          >
            + 记一笔
          </Btn>
        }
      >
        {(adding || editing) && (
          <TradeForm
            key={editing?.id ?? "new"}
            defaultDate={defaultDate}
            existing={editing}
            onDone={() => {
              setAdding(false);
              setEditing(null);
            }}
          />
        )}
        {trades.isPending ? (
          <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : list.length === 0 && !adding ? (
          <p className="text-sm text-[var(--dim)]">
            还没有交易记录。每笔都记下买入理由、是否按计划、情绪和错误标签——几周后复盘统计会告诉你钱到底亏在哪。
          </p>
        ) : (
          <>
            {open.length > 0 && (
              <>
                <h3 className="mb-2 text-sm font-bold text-[var(--dim)]">持仓中（{open.length}）</h3>
                <div className="mb-5 space-y-2">
                  {open.map((t) => (
                    <TradeCard key={t.id} t={t} onEdit={() => { setEditing(t); setAdding(false); }} />
                  ))}
                </div>
              </>
            )}
            {closed.length > 0 && (
              <>
                <h3 className="mb-2 text-sm font-bold text-[var(--dim)]">已平仓（{closed.length}）</h3>
                <div className="space-y-2">
                  {closed.map((t) => (
                    <TradeCard key={t.id} t={t} onEdit={() => { setEditing(t); setAdding(false); }} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

function TradeCard({ t, onEdit }: { t: Trade; onEdit: () => void }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteTrade({ id: t.id }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const closed = t.sellPrice != null;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-bold">{t.name}</span>
          {t.code && <span className="font-num ml-2 text-xs text-[var(--dim)]">{t.code}</span>}
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold ${deviationBadgeCls(t)}`}
          >
            {deviationText(t)}
          </span>
          {t.mode && (
            <span className="ml-1.5 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[11px] font-semibold">
              {t.mode}
            </span>
          )}
        </div>
        {closed ? (
          <div className="font-num text-right" style={{ color: pnlColor(t.pnl) }}>
            <div className="font-black">{t.pnl != null ? fmtMoney(t.pnl) : "—"}</div>
            <div className="text-xs">{fmtPct(t.pnlPct)}</div>
          </div>
        ) : (
          <span className="rounded bg-[var(--amber-dim)] px-2 py-1 text-xs font-bold text-[var(--amber)]">
            持仓中
          </span>
        )}
      </div>
      <div className="font-num mt-1.5 text-sm text-[var(--dim)]">
        {t.date} 买 {t.buyPrice} × {t.shares}股
        {closed && (
          <>
            {" → "}
            {t.sellDate} 卖 {t.sellPrice}
          </>
        )}
      </div>
      {t.buyReason && <p className="mt-1 text-sm">买入：{t.buyReason}</p>}
      {closed && t.sellReason && <p className="mt-0.5 text-sm">卖出：{t.sellReason}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {t.emotion && (
          <span className="rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[11px]">情绪：{t.emotion}</span>
        )}
        {t.errorTags.map((tag) => (
          <span key={tag} className="rounded bg-[var(--accent-dim)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
            {tag}
          </span>
        ))}
      </div>
      {t.note && <p className="mt-1 text-sm text-[var(--dim)]">{t.note}</p>}
      <div className="mt-2.5 flex gap-2">
        <Btn onClick={onEdit}>{closed ? "编辑" : "平仓 / 编辑"}</Btn>
        <Btn variant="danger" disabled={del.isPending} onClick={() => del.mutate()} ariaLabel={`删除交易 ${t.name}`}>
          删除
        </Btn>
      </div>
    </div>
  );
}

function TradeForm({
  defaultDate,
  existing,
  onDone,
}: {
  defaultDate: string;
  existing: Trade | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(existing?.date ?? defaultDate);
  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.code ?? "");
  const [buyPrice, setBuyPrice] = useState(existing?.buyPrice?.toString() ?? "");
  const [shares, setShares] = useState(existing?.shares?.toString() ?? "");
  const [buyReason, setBuyReason] = useState(existing?.buyReason ?? "");
  const [followed, setFollowed] = useState(existing?.followedPlan ?? true);
  const [mode, setMode] = useState(existing?.mode ?? "");
  const [plannedOverride, setPlannedOverride] = useState(existing?.plannedOverride ?? "");
  const [closed, setClosed] = useState(existing?.sellPrice != null);
  const [sellDate, setSellDate] = useState(existing?.sellDate ?? defaultDate);
  const [sellPrice, setSellPrice] = useState(existing?.sellPrice?.toString() ?? "");
  const [sellReason, setSellReason] = useState(existing?.sellReason ?? "");
  const [emotion, setEmotion] = useState(existing?.emotion ?? "");
  const [tags, setTags] = useState<string[]>(existing?.errorTags ?? []);
  const [note, setNote] = useState(existing?.note ?? "");

  const toggleTag = (tag: string) =>
    setTags((s) => (s.includes(tag) ? s.filter((x) => x !== tag) : [...s, tag]));

  const valid =
    name.trim() &&
    Number(buyPrice) > 0 &&
    Number(shares) > 0 &&
    (!closed || Number(sellPrice) > 0);

  const save = useMutation({
    mutationFn: () =>
      api.saveTrade({
        ...(existing ? { id: existing.id } : {}),
        date,
        sellDate: closed ? sellDate : null,
        name: name.trim(),
        code: code.trim(),
        buyPrice: Number(buyPrice),
        sellPrice: closed ? Number(sellPrice) : null,
        shares: Math.round(Number(shares)),
        buyReason: buyReason.trim(),
        followedPlan: followed,
        mode,
        plannedOverride,
        sellReason: closed ? sellReason.trim() : "",
        emotion,
        errorTags: tags,
        note: note.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  return (
    <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="trade-date" className={labelCls}>买入日期</label>
          <input id="trade-date" aria-label="买入日期" type="date" className={`${inputCls} font-num`} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextField label="股票名称" value={name} onChange={setName} placeholder="如 大业股份" />
        <TextField label="代码（可选）" value={code} onChange={setCode} placeholder="如 603278" />
        <NumField label="买入价（元）" value={buyPrice} onChange={setBuyPrice} step="0.01" />
        <NumField label="股数" value={shares} onChange={setShares} placeholder="100 的倍数" />
      </div>
      <div className="mt-3 space-y-3">
        <AreaField label="买入理由" value={buyReason} onChange={setBuyReason} placeholder="按计划卡的触发条件买的，还是盘中临时起意？" />
        <div>
          <span className={labelCls}>交易模式</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="交易模式">
            {TRADE_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(mode === m ? "" : m)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  mode === m
                    ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="trade-override" className={labelCls}>
            计划偏离改判（默认自动判定：对照当日候选与计划文本）
          </label>
          <select
            id="trade-override"
            aria-label="计划偏离改判"
            className={inputCls}
            value={plannedOverride}
            onChange={(e) => setPlannedOverride(e.target.value)}
          >
            <option value="">自动判定</option>
            <option value="in">改判为计划内</option>
            <option value="out">改判为计划外</option>
          </select>
        </div>
        <Toggle label="按计划执行" hint="对照盘前计划卡：标的、条件、仓位都对得上才算" on={followed} onChange={setFollowed} />
        <Toggle label="已经卖出（平仓）" on={closed} onChange={setClosed} />
      </div>
      {closed && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="trade-sell-date" className={labelCls}>卖出日期</label>
              <input id="trade-sell-date" aria-label="卖出日期" type="date" className={`${inputCls} font-num`} value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
            </div>
            <NumField label="卖出价（元）" value={sellPrice} onChange={setSellPrice} step="0.01" />
          </div>
          <AreaField label="卖出理由" value={sellReason} onChange={setSellReason} placeholder="触发止损 / 止盈 / 炸板走人 / 情绪卖出…" />
        </div>
      )}
      <div className="mt-3">
        <span className={labelCls}>当时情绪</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="当时情绪">
          {EMOTIONS.map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={emotion === e}
              onClick={() => setEmotion(emotion === e ? "" : e)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                emotion === e
                  ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                  : "border-[var(--border)]"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <span className={labelCls}>错误标签（这笔犯了哪些错，可多选）</span>
        <div className="flex flex-wrap gap-1.5">
          {ERROR_TAGS.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={tags.includes(tag)}
              onClick={() => toggleTag(tag)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                tags.includes(tag)
                  ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                  : "border-[var(--border)]"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <AreaField label="备注" value={note} onChange={setNote} placeholder="可选" />
      </div>
      <div className="mt-4 flex gap-2">
        <Btn variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {existing ? "保存修改" : "保存这笔"}
        </Btn>
        <Btn onClick={onDone}>取消</Btn>
      </div>
      {save.isError && <p className="mt-2 text-sm text-[var(--accent)]">保存失败，请重试</p>}
    </div>
  );
}

// ---------- 复盘统计 ----------

function StatsTab() {
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: (): Promise<StatsData> => api.getStats({}),
  });
  const days = useQuery({
    queryKey: ["marketDays"],
    queryFn: () => api.listMarketDays({ limit: 30 }),
  });
  const s = stats.data;

  return (
    <div>
      <Section title="复盘统计">
        {stats.isPending ? (
          <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : !s || s.closedCount === 0 ? (
          <p className="text-sm text-[var(--dim)]">
            还没有已平仓的交易。平仓后这里会自动算胜率、盈亏比、最大回撤和你最常犯的错。
            {s && s.openCount > 0 ? `（当前持仓中 ${s.openCount} 笔）` : ""}
          </p>
        ) : (
          <>
            <div
              className="rounded-xl px-4 py-4"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="text-xs text-[var(--dim)]">
                累计盈亏 · 已平仓 {s.closedCount} 笔
                {s.openCount > 0 ? ` · 持仓中 ${s.openCount} 笔` : ""}
              </div>
              <div
                className="font-num mt-1 text-4xl font-black"
                style={{ color: pnlColor(s.totalPnl) }}
              >
                {fmtMoney(s.totalPnl)}
              </div>
              <div className="font-num mt-4 grid grid-cols-3 gap-3 text-center">
                <StatCell label="胜率" value={s.winRate != null ? `${s.winRate}%` : "—"} />
                <StatCell label="盈亏比" value={s.profitFactor != null ? s.profitFactor.toFixed(2) : "—"} />
                <StatCell
                  label="最大回撤"
                  value={s.maxDrawdownPct != null ? `${s.maxDrawdownPct.toFixed(1)}%` : "未设本金"}
                />
                <StatCell label="平均盈利" value={s.avgWin != null ? fmtMoney(s.avgWin) : "—"} />
                <StatCell label="平均亏损" value={s.avgLoss != null ? fmtMoney(s.avgLoss) : "—"} />
                <StatCell label="按计划执行" value={s.planRate != null ? `${s.planRate}%` : "—"} />
              </div>
              {s.lossStreak > 0 && (
                <p className="mt-3 text-sm font-semibold text-[var(--amber)]">
                  当前连亏 {s.lossStreak} 笔
                </p>
              )}
            </div>

            <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="mb-2 text-sm font-bold">计划内 vs 计划外（按偏离判定，改判优先）</div>
              <div className="grid grid-cols-2 gap-3">
                <PlanCompareCell
                  label="计划内"
                  count={s.planCompare.in.count}
                  winRate={s.planCompare.in.winRate}
                  totalPnl={s.planCompare.in.totalPnl}
                />
                <PlanCompareCell
                  label="计划外"
                  count={s.planCompare.out.count}
                  winRate={s.planCompare.out.winRate}
                  totalPnl={s.planCompare.out.totalPnl}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                「无计划可比」的交易（当日没有计划也没有候选）不计入这两组。
              </p>
            </div>

            <GroupStatsBlock title="按周期阶段分组（交易日官方定调）" rows={s.stageGroups} keyLabel="阶段" />
            <GroupStatsBlock title="按交易模式分组" rows={s.modeGroups} keyLabel="模式" />

            {s.equityCurve.length >= 2 && (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="mb-1 text-sm font-bold">累计盈亏曲线（元）</div>
                <div className="h-44" role="img" aria-label="累计盈亏曲线图">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={s.equityCurve} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} stroke="var(--dim)" />
                      <YAxis tick={{ fontSize: 10 }} width={52} stroke="var(--dim)" />
                      <Tooltip
                        formatter={(value) => [fmtMoneyPlain(Number(value ?? 0)), "累计盈亏"]}
                        labelFormatter={(d) => String(d)}
                        contentStyle={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="cumPnl"
                        stroke="var(--accent)"
                        fill="var(--accent)"
                        fillOpacity={0.15}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {s.topErrors.length > 0 && (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="mb-2 text-sm font-bold">你最常犯的错</div>
                <div className="space-y-1.5">
                  {s.topErrors.map((e, i) => (
                    <div key={e.tag} className="flex items-center gap-2 text-sm">
                      <span className="font-num w-5 text-[var(--dim)]">{i + 1}</span>
                      <span className="flex-1 font-medium">{e.tag}</span>
                      <span className="font-num text-[var(--dim)]">{e.count} 笔</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[var(--dim)]">
                  先改排第一的那个毛病，比学任何新战法都值钱。
                </p>
              </div>
            )}

            {s.emotionStats.length > 0 && (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="mb-2 text-sm font-bold">情绪 vs 收益</div>
                <div className="space-y-1.5">
                  {s.emotionStats.map((e) => (
                    <div key={e.emotion} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 font-medium">{e.emotion}</span>
                      <span className="font-num text-[var(--dim)]">{e.count} 笔</span>
                      <span
                        className="font-num font-bold"
                        style={{ color: pnlColor(e.avgPnlPct) }}
                      >
                        平均 {fmtPct(e.avgPnlPct)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="梯队历史">
        {days.isPending ? (
          <p className="text-sm text-[var(--dim)]">加载中…</p>
        ) : (days.data?.days.length ?? 0) === 0 ? (
          <p className="text-sm text-[var(--dim)]">还没有录入过梯队数据。</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm" aria-label="梯队历史">
              <thead>
                <tr className="bg-[var(--surface2)] text-left text-xs text-[var(--dim)]">
                  <th className="px-3 py-2 font-medium">日期</th>
                  <th className="px-3 py-2 font-medium">最高板</th>
                  <th className="px-3 py-2 font-medium">炸板率</th>
                  <th className="px-3 py-2 font-medium">定调</th>
                  <th className="px-3 py-2 font-medium">裁决</th>
                </tr>
              </thead>
              <tbody>
                {(days.data?.days ?? []).map((d: MarketDay) => {
                  const v = computeVerdict(d);
                  const cyc = assessCycle(d);
                  return (
                    <tr key={d.id} className="border-t border-[var(--border)] bg-[var(--surface)]">
                      <td className="font-num px-3 py-2">{d.date.slice(5)}</td>
                      <td className="font-num px-3 py-2">{d.maxBoard != null ? `${d.maxBoard}板` : "—"}</td>
                      <td className="font-num px-3 py-2">{d.brokenRate != null ? `${d.brokenRate}%` : "—"}</td>
                      <td className="px-3 py-2">
                        {d.cycleStage ? (
                          <span className="font-semibold">{d.cycleStage}</span>
                        ) : cyc ? (
                          <span className="text-[var(--dim)]">建议：{cyc.computed}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {v ? (
                          <span
                            className="font-semibold"
                            style={{
                              color:
                                v.level === "attack"
                                  ? "var(--accent)"
                                  : v.level === "cautious"
                                    ? "var(--amber)"
                                    : "var(--dim)",
                            }}
                          >
                            {v.label}
                            {d.ladderGap ? " · 断层" : ""}
                            {d.ebbSignal ? " · 退潮" : ""}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function PlanCompareCell({
  label,
  count,
  winRate,
  totalPnl,
}: {
  label: string;
  count: number;
  winRate: number | null;
  totalPnl: number;
}) {
  return (
    <div className="rounded-lg bg-[var(--surface2)] px-3 py-3">
      <div className="text-xs text-[var(--dim)]">{label}</div>
      <div className="font-num mt-1 text-xl font-black" style={{ color: pnlColor(totalPnl) }}>
        {count > 0 ? fmtMoney(totalPnl) : "—"}
      </div>
      <div className="font-num mt-0.5 text-xs text-[var(--dim)]">
        {count} 笔{winRate != null ? ` · 胜率 ${winRate}%` : ""}
      </div>
    </div>
  );
}

function GroupStatsBlock({
  title,
  rows,
  keyLabel,
}: {
  title: string;
  rows: {
    count: number;
    winRate: number | null;
    profitFactor: number | null;
    avgPnl: number | null;
    totalPnl: number;
  }[];
  keyLabel: string;
}) {
  const named = rows as ({ stage?: string; mode?: string } & (typeof rows)[number])[];
  const shown = named.filter((r) => r.count > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 text-sm font-bold">{title}</div>
      <div className="space-y-1.5">
        {shown.map((r) => {
          const name = r.stage ?? r.mode ?? "";
          return (
            <div key={name} className="flex items-center gap-2 text-sm">
              <span className="w-16 shrink-0 font-medium">{name || keyLabel}</span>
              <span className="font-num text-[var(--dim)]">{r.count} 笔</span>
              <span className="font-num flex-1 text-right">
                胜率 {r.winRate != null ? `${r.winRate}%` : "—"}
                {" · "}盈亏比 {r.profitFactor != null ? r.profitFactor.toFixed(2) : "—"}
                {" · "}平均 {r.avgPnl != null ? fmtMoney(r.avgPnl) : "—"}
              </span>
              <span className="font-num w-24 text-right font-bold" style={{ color: pnlColor(r.totalPnl) }}>
                {fmtMoney(r.totalPnl)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        平均盈亏 = 总盈亏 ÷ 笔数；只统计已平仓交易，与上方总统计同口径。
      </p>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface2)] px-1 py-2.5">
      <div className="text-base font-black">{value}</div>
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
    </div>
  );
}

// ---------- 小黑板（大盘冷热：宽度 × 涨股吸金力，旁证参考，不进裁决） ----------
// 口径与独立参考盘一致：涨面 = 100 家里涨了几家；涨股吸金力 = 1 ÷ TRIN(成交额版)。
// 天气与信号清单由服务端按同一口径计算，页面只展示。

function breadthWeatherOf(
  redPct: number | null,
  suction: number | null,
): string {
  if (redPct == null || suction == null) return "—";
  if (redPct >= 50) return suction >= 1 ? "热得实" : "热得虚";
  return suction >= 1 ? "冷中有火" : "冷得实";
}

function useBreadthFundflowSync() {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    api
      .syncBreadthFundflow({})
      .then(() => {
        if (!cancelled) {
          void qc.invalidateQueries({ queryKey: ["breadth"] });
          void qc.invalidateQueries({ queryKey: ["fundflow"] });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [qc]);
}

function BreadthTab({ date }: { date: string }) {
  useBreadthFundflowSync();
  const q = useQuery({
    queryKey: ["breadth", date],
    queryFn: () => api.getBreadth({ date }),
  });
  const d = q.data;
  const rec = d?.record ?? null;
  const chartData = (d?.series ?? []).map((s) => ({
    date: s.date.slice(5),
    涨面: s.redPct,
    吸金力: s.suction,
  }));

  return (
    <div>
      <Section
        title="大盘冷热小黑板"
        right={<span className="text-xs text-[var(--dim)]">旁证参考 · 不进裁决</span>}
      >
        <p className="mb-3 text-sm text-[var(--dim)]">
          只帮你多一个角度看市场：现在会不会已经涨得差不多了，或者跌得差不多了。它只是个温度计，不是预言机，更不是买卖信号——真正下决定的，还是原来那套连板规矩。
        </p>
        {d && d.latestDate ? (
          <p className="font-num mb-3 text-xs text-[var(--dim)]">
            数据截至 {d.latestDate} · 共 {d.totalDays} 天
          </p>
        ) : null}

        {q.isPending ? (
          <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : q.isError || !d ? (
          <p className="text-sm text-[var(--accent)]">加载失败，检查网络后重试</p>
        ) : (
          <>
            {!d.hasData ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="font-bold">这一天还没有小黑板记录</div>
                <p className="mt-1.5 text-sm text-[var(--dim)]">
                  {d.latestDate
                    ? `小黑板每天收盘后用通达信盘后包算（晚上 19:30 落库），目前最新只到 ${d.latestDate}。选这一天看不到，是因为当天的数据还没落库，不是用旧数据冒充。`
                    : "目前还没有任何记录。观察期自 2026-10-26 起逐日积累，当天数据要等收盘后的盘后包发布才能算。"}
                </p>
              </div>
            ) : rec ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-[var(--dim)]">
                      {date}
                      {rec.stage ? ` · 那天市场状态：${rec.stage}` : ""}
                    </div>
                    <div className="mt-0.5 text-3xl font-black">
                      {d.weather ?? "—"}
                    </div>
                    {d.weatherDetail ? (
                      <p className="mt-1 max-w-md text-sm text-[var(--dim)]">
                        {d.weatherDetail}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-5 text-right">
                    <div>
                      <div className="font-num text-3xl font-black">
                        {rec.redPct != null ? rec.redPct : "—"}
                        <span className="ml-0.5 text-sm font-bold text-[var(--dim)]">家</span>
                      </div>
                      <div className="text-xs text-[var(--dim)]">100 家里涨了几家</div>
                    </div>
                    <div>
                      <div className="font-num text-3xl font-black">
                        {rec.suction != null ? rec.suction : "—"}
                      </div>
                      <div className="text-xs text-[var(--dim)]">涨股吸金力</div>
                    </div>
                  </div>
                </div>
                <div className="font-num mt-4 grid grid-cols-3 gap-2 text-center">
                  <LiveStat label="上涨家数" value={rec.up != null ? `${rec.up} 家` : "—"} />
                  <LiveStat label="下跌家数" value={rec.down != null ? `${rec.down} 家` : "—"} />
                  <LiveStat label="平盘家数" value={rec.flat != null ? `${rec.flat} 家` : "—"} />
                  <LiveStat label="TRIN（成交额版）" value={rec.trinAmt != null ? `${rec.trinAmt}` : "—"} />
                  <LiveStat label="TRIN（成交量版）" value={rec.trinVol != null ? `${rec.trinVol}` : "—"} />
                  <LiveStat label="阶段定调" value={rec.stage || "—"} />
                </div>
                <p className="mt-3 text-xs text-[var(--dim)]">
                  涨股吸金力 = 平均每只涨股的成交额 ÷ 平均每只跌股的成交额，也就是 1 ÷
                  TRIN（成交额版）：大于 1，钱更爱追涨的股票；小于 1，钱更多砸在跌的股票上。
                </p>
              </div>
            ) : null}

            {chartData.length >= 2 ? (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="mb-1 text-sm font-bold">这段日子一路走过来</div>
                <p className="mb-2 text-xs text-[var(--dim)]">
                  红柱 = 100 家里涨了几家（越高越热）；绿线 = 涨股吸金力（在 1 上面，钱在追涨股；下面，钱在砸跌股）。
                </p>
                <div className="h-[240px] w-full" role="img" aria-label="涨面与涨股吸金力走势图">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                      <YAxis yAxisId="red" domain={[0, 100]} tick={{ fontSize: 10 }} />
                      <YAxis yAxisId="suc" orientation="right" domain={[0, 3.5]} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar yAxisId="red" dataKey="涨面" name="100家里涨了几家" fill="var(--accent)" opacity={0.6} radius={[3, 3, 0, 0]} />
                      <Line yAxisId="suc" type="monotone" dataKey="吸金力" name="涨股吸金力" stroke="var(--green)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}

            {d.hasData ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <SignalCard
                  title="可能接近底的样子"
                  signals={d.bottomSignals}
                  hits={d.bottomHits}
                  alert={
                    d.bottomHits >= 2
                      ? `底的信号凑齐了 ${d.bottomHits} 条——只是提醒多看一眼，不等于底到了，更不是买入信号。`
                      : null
                  }
                />
                <SignalCard
                  title="可能接近顶的样子"
                  signals={d.topSignals}
                  hits={d.topHits}
                  alert={
                    d.topHits >= 2
                      ? `顶的信号凑齐了 ${d.topHits} 条——热闹可能快到头了，按原有规矩留个心眼。`
                      : null
                  }
                />
              </div>
            ) : null}

            <div className="mt-4">
              <div className="mb-2 text-sm font-bold">四种常见天气</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <WeatherCard name="热得实" hot text="涨面广，钱也追着涨股跑。像今年 7 月 21 日那次大反弹，是比较像样的底。" />
                <WeatherCard name="热得虚" hot text="涨面广，但钱追涨的劲一般甚至偏弱。热闹是真的，力气没跟上；出现在高位要多留个心眼。" />
                <WeatherCard name="冷中有火" text="跌面广，但钱在悄悄追少数涨股。可能是有人逆势买，也可能只是跌停卖不掉的假象，要连看几天。" />
                <WeatherCard name="冷得实" text="跌面广，钱还往跌股上砸。卖的人最凶、最绝望时往往离底更近，但也最难熬，不能凭一天下结论。" />
              </div>
            </div>

            {d.series.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-sm font-bold">最近记录（新到旧）</div>
                <div className="space-y-1.5">
                  {[...d.series].reverse().map((s) => (
                    <div
                      key={s.date}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 text-sm ${
                        s.date === date
                          ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                          : "border-[var(--border)] bg-[var(--surface)]"
                      }`}
                    >
                      <span className="font-num font-bold">{s.date.slice(5)}</span>
                      <span className="text-[var(--dim)]">{s.stage || "—"}</span>
                      <span className="font-num">
                        涨面 {s.redPct != null ? `${s.redPct} 家` : "—"}
                      </span>
                      <span className="font-num">
                        吸金力 {s.suction != null ? s.suction : "—"}
                      </span>
                      <span className="font-semibold">
                        {breadthWeatherOf(s.redPct, s.suction)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-4 rounded-xl border border-[var(--amber)] bg-[var(--amber-dim)] px-4 py-3 text-sm">
              <span className="font-bold">使用边界（说人话版）</span>
              <br />
              1. 这个盘只能告诉你「钱分布在涨股多还是跌股多」，看不出钱是谁的。
              <br />
              2. 跌停的股票像被锁住的门，想卖也卖不掉，成交的钱会显得特别少——最冷那几天吸金力会虚高，要打个问号。
              <br />
              3. 它不进裁决、不改任何买卖规矩，只在旁边当温度计。观察期到 11 月 20
              日，11 月 23 日会认真检验一次到底靠不靠谱。
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

function SignalCard({
  title,
  signals,
  hits,
  alert,
}: {
  title: string;
  signals: BreadthData["bottomSignals"];
  hits: number;
  alert: string | null;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold">{title}</span>
        <span className="font-num text-xs text-[var(--dim)]">命中 {hits}/3</span>
      </div>
      <div className="space-y-2">
        {signals.map((s) => (
          <div key={s.key} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                s.hit ? "bg-[var(--accent)]" : "border border-[var(--dim)]"
              }`}
            />
            <span className={s.hit ? "font-semibold" : "text-[var(--dim)]"}>
              {s.label}
              {s.hit ? <span className="ml-1.5 text-xs font-bold text-[var(--accent)]">命中</span> : null}
            </span>
          </div>
        ))}
      </div>
      {alert ? (
        <p className="mt-3 rounded-lg bg-[var(--amber-dim)] px-3 py-2 text-sm font-semibold text-[var(--amber)]">
          {alert}
        </p>
      ) : (
        <p className="mt-3 text-xs text-[var(--dim)]">
          单独一条经常骗人，同一方向凑齐 2 条以上才多提醒一句。
        </p>
      )}
    </div>
  );
}

function WeatherCard({
  name,
  text,
  hot,
}: {
  name: string;
  text: string;
  hot?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className={`font-bold ${hot ? "text-[var(--accent)]" : "text-[var(--info)]"}`}>
        {name}
      </div>
      <p className="mt-0.5 text-sm text-[var(--dim)]">{text}</p>
    </div>
  );
}

// ---------- 大钱去哪了（板块资金流：大单估算，旁证参考） ----------
// 诚实口径：所谓「大钱」= 东财主力净流入（超大单+大单按单笔金额分档估算），
// 看不到买家身份；窗口一律由自有每日存档滚动求和，缺档如实标注、从不补造。

function fmtYi(v: number | null): string {
  if (v == null) return "—";
  const yi = v / 1e8;
  return `${yi > 0 ? "+" : ""}${yi.toFixed(1)}亿`;
}

function FundList({
  title,
  items,
  inflow,
}: {
  title: string;
  items: { name: string; netYuan: number | null }[];
  inflow: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="mb-1.5 text-sm font-bold">{title}</div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无</p>
      ) : (
        <ul className="space-y-1">
          {items.map((x) => (
            <li key={x.name} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0">{x.name}</span>
              <span
                className="font-num shrink-0 font-bold"
                style={{ color: inflow ? "var(--accent)" : "var(--green)" }}
              >
                {fmtYi(x.netYuan)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FundflowTab({ date }: { date: string }) {
  useBreadthFundflowSync();
  const q = useQuery({
    queryKey: ["fundflow", date],
    queryFn: () => api.getFundflow({ date }),
  });
  const d: FundflowData | undefined = q.data;
  const joinTop = (items: { name: string; netYuan: number | null }[]) =>
    items.length === 0
      ? "暂无"
      : items.map((x) => `${x.name} ${fmtYi(x.netYuan)}`).join("；");

  return (
    <div>
      <Section
        title="大钱去哪了"
        right={<span className="text-xs text-[var(--dim)]">大钱（大单估算）</span>}
      >
        <p className="mb-3 text-sm text-[var(--dim)]">
          看一件事：大单的钱，今天往哪些行业、哪些概念里跑，又从哪里跑出来。先说清：没人能从成交里看出买家到底是谁——这里的「大钱」是软件按单笔金额大小估算的大单买入减大单卖出（行话叫主力净流入），当大致方向看，别当谁的底牌看。
        </p>
        {d && d.daysAvailable > 0 && d.latestDate ? (
          <p className="font-num mb-3 text-xs text-[var(--dim)]">
            数据截至 {d.latestDate} · 已攒 {d.daysAvailable} 天
          </p>
        ) : null}

        {q.isPending ? (
          <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : q.isError || !d ? (
          <p className="text-sm text-[var(--accent)]">加载失败，检查网络后重试</p>
        ) : d.daysAvailable === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="font-bold">资金流存档还没开始</div>
            <p className="mt-1.5 text-sm text-[var(--dim)]">
              资金流存档从 2026-10-26 起、每个交易日收盘后逐日积累，目前还没有存档，所以这里是空的——不会拿别的数据来凑。等第一个交易日的存档落库后，这里会列出当天钱跑进、跑出最多的行业和概念，并滚动算出近3天、近5天、近10天和近半月（15
              个交易日）的合计方向；哪天抓不到就标缺档，绝不补造。
            </p>
          </div>
        ) : (
          <>
            {d.isMissing ? (
              <div className="mb-3 rounded-xl border border-[var(--amber)] bg-[var(--amber-dim)] px-4 py-3 text-sm font-semibold text-[var(--amber)]">
                {date} 这一天缺档（当天没有抓到存档）。下面一段时间的合计，用的是截至这一天已有的存档算的，不拿别的天冒充这一天。
              </div>
            ) : (
              <>
                <div className="mb-2 text-sm font-bold">行业：这一天</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <FundList title="钱跑进去最多的" items={d.todayIndustryIn} inflow />
                  <FundList title="钱跑出来最多的" items={d.todayIndustryOut} inflow={false} />
                </div>
                <div className="mb-2 mt-4 text-sm font-bold">概念：这一天</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <FundList title="钱跑进去最多的" items={d.todayConceptIn} inflow />
                  <FundList title="钱跑出来最多的" items={d.todayConceptOut} inflow={false} />
                </div>
              </>
            )}

            {d.streaksIndustry.length > 0 || d.streaksConcept.length > 0 ? (
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm">
                <span className="font-bold">连着买了好几天的</span>
                <span className="text-[var(--dim)]">
                  （一天的钱可能是偶然，连着几天往同一个地方去，才值得多看一眼）
                </span>
                {d.streaksIndustry.length > 0 ? (
                  <p className="mt-1.5">
                    行业：
                    {d.streaksIndustry.map((s) => `${s.name}（连买${s.days}天）`).join("、")}
                  </p>
                ) : null}
                {d.streaksConcept.length > 0 ? (
                  <p className="mt-1">
                    概念：
                    {d.streaksConcept.map((s) => `${s.name}（连买${s.days}天）`).join("、")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mb-2 mt-5 text-sm font-bold">一段时间合起来看</div>
            <div className="space-y-2">
              {d.windows.map((w) => (
                <div
                  key={w.label}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
                >
                  <div className="font-num mb-1.5 font-bold">
                    {w.label}
                    <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                      实际 {w.daysActual} 天
                    </span>
                  </div>
                  <div className="space-y-1">
                    <p>
                      <span className="text-[var(--dim)]">行业进：</span>
                      {joinTop(w.industryTopIn)}
                    </p>
                    <p>
                      <span className="text-[var(--dim)]">行业出：</span>
                      {joinTop(w.industryTopOut)}
                    </p>
                    <p>
                      <span className="text-[var(--dim)]">概念进：</span>
                      {joinTop(w.conceptTopIn)}
                    </p>
                    <p>
                      <span className="text-[var(--dim)]">概念出：</span>
                      {joinTop(w.conceptTopOut)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--dim)]">
              数据来自东方财富板块资金流（经自建数据桥抓取）；窗口全部由自有存档滚动求和，按交易日计，近半月 =
              15 个交易日，天数不够就如实写实际天数。
            </p>
          </>
        )}
      </Section>
    </div>
  );
}
