// 行情采集状态：交易时段自动在后台采集涨停池、五档行情和盘中事件；收盘后补抓大钱流向与小黑板。
import { useEffect, useState } from "react";
import { detectPlatform, getRunner, getRuntime } from "../runtime/boot";
import type { RunnerStatus } from "../collector/runner";

const hhmm = (iso: string | null) => (iso ? iso.slice(11, 19) : "—");

export function CollectorStatus() {
  const [st, setSt] = useState<RunnerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const web = detectPlatform() === "web";

  useEffect(() => {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let dead = false;
    void getRuntime().then(() => {
      const r = getRunner();
      if (!r || dead) return;
      const refresh = () => setSt(r.status());
      refresh();
      off = r.subscribe(refresh);
      timer = setInterval(refresh, 3000);
    });
    return () => {
      dead = true;
      off?.();
      if (timer) clearInterval(timer);
    };
  }, []);

  const refreshNow = async () => {
    const r = getRunner();
    if (!r) return;
    setBusy(true);
    try {
      await r.runNow();
    } finally {
      setBusy(false);
      setSt(r.status());
    }
  };

  const state = !st
    ? "启动中…"
    : web
      ? "浏览器调试环境：不采集行情"
      : st.active
        ? "交易时段 · 采集中"
        : st.tradingDay
          ? "今天是交易日 · 当前非交易时段（待机）"
          : "今天休市 · 待机";

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-lg font-bold tracking-tight">行情采集</h2>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-sm font-semibold">{state}</p>
        {st && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-[var(--dim)]">涨停池最近刷新</dt>
            <dd className="text-right">{hhmm(st.lastPoolsAt)}</dd>
            <dt className="text-[var(--dim)]">五档行情最近刷新</dt>
            <dd className="text-right">
              {hhmm(st.lastQuotesAt)}
              {st.quotesSource ? `（${st.quotesSource === "sina" ? "新浪" : "腾讯备用"}）` : ""}
            </dd>
            <dt className="text-[var(--dim)]">盯盘名单</dt>
            <dd className="text-right">
              {st.watchlistSize} 只{st.poolDate ? ` · ${st.poolDate}` : ""}
            </dd>
            <dt className="text-[var(--dim)]">东财池子</dt>
            <dd className="text-right">{st.cooling ? "冷却中（被限流，30 分钟后自动恢复）" : "正常"}</dd>
            <dt className="text-[var(--dim)]">大钱流向存档</dt>
            <dd className="text-right">{st.fundflowDays} 天</dd>
            <dt className="text-[var(--dim)]">小黑板最新</dt>
            <dd className="text-right">{st.breadthLatest ?? "—"}</dd>
          </dl>
        )}
        {st?.lastError && (
          <p className="mt-3 break-all text-xs text-[var(--amber)]">最近一次问题：{st.lastError}</p>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy || web}
            onClick={() => void refreshNow()}
            className="rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-40"
          >
            {busy ? "采集中…" : "立即刷新一次"}
          </button>
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm text-[var(--dim)]"
          >
            {showLog ? "收起日志" : "运行日志"}
          </button>
        </div>
        {showLog && st && (
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-[var(--dim)]">
            {st.logs.length ? st.logs.join("\n") : "暂无日志"}
          </pre>
        )}
        <p className="mt-3 text-xs text-[var(--dim)]">
          手机需要保持应用在前台才会持续采集；电脑版只要开着就会在交易时段自动采集。
        </p>
      </div>
    </section>
  );
}
