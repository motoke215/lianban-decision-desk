// 后台调度：相当于原版 collector.py 的 run_daemon + 每日定时任务，放进应用里自动跑。
//   交易时段（交易日历为准）：池子每 60s、行情每 5s、同花顺题材每 5 分钟
//   收盘后：补一轮收盘快照；15:10 后抓板块大钱流向；盘后包发布后（约 17:00 起）补小黑板
//   非交易时段打开应用：若本机一份池子数据都没有，先抓一轮最近交易日，免得界面是空的
// 全程串行（东财风控纪律），任何一步失败都只记录、稍后重试，不会影响其他步骤。
import type { Runtime } from "../runtime/core";
import { KV } from "../runtime/kv";
import { appendBreadthDay } from "./breadth";
import { Collector, POOL_INTERVAL, QUOTE_INTERVAL, type HttpGet } from "./core";
import { fetchFundflowDay } from "./fundflow";
import { isoSh, shParts } from "./rules";

export interface RunnerStatus {
  running: boolean;
  active: boolean;
  tradingDay: boolean;
  lastPoolsAt: string | null;
  lastQuotesAt: string | null;
  poolDate: string | null;
  watchlistSize: number;
  quotesSource: string | null;
  poolRoute: string | null;
  cooling: boolean;
  fundflowDays: number;
  breadthLatest: string | null;
  lastError: string;
  logs: string[];
}

const p2 = (n: number) => String(n).padStart(2, "0");
const dateStr = (ms: number) => {
  const t = shParts(ms);
  return `${t.y}-${p2(t.m)}-${p2(t.d)}`;
};
const minutesOf = (ms: number) => {
  const t = shParts(ms);
  return t.hh * 60 + t.mm;
};

export class CollectorRunner {
  readonly collector: Collector;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private lastPools = 0;
  private lastQuotes = 0;
  private lastThs = 0;
  private lastEod = 0;
  private lastFlowTry = 0;
  private lastBreadthTry = 0;
  private lastCalendarDay = "";
  private bootstrapped = false;
  private logs: string[] = [];
  private lastError = "";
  private listeners = new Set<() => void>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(
    private rt: Runtime,
    private http: HttpGet,
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.collector = new Collector({
      kv: rt.kv,
      http: this.http,
      now: this.now,
      sleep: this.sleep,
      log: (m) => this.log(m),
    });
  }

  private log(m: string): void {
    const line = `${isoSh(this.now()).slice(11, 19)} ${m}`;
    this.logs.push(line);
    if (this.logs.length > 80) this.logs.shift();
    if (/failed|failure|cooldown|error/i.test(m)) this.lastError = line;
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  status(): RunnerStatus {
    const c = this.collector;
    const now = this.now();
    let breadthLatest: string | null = null;
    try {
      const rec = (JSON.parse(this.rt.kv.get(KV.breadthSeries) ?? "{}") as { records?: { date: string }[] }).records;
      breadthLatest = rec?.length ? (rec[rec.length - 1]?.date ?? null) : null;
    } catch {
      breadthLatest = null;
    }
    const health = (() => {
      try {
        return JSON.parse(this.rt.kv.get(KV.health) ?? "{}") as { updated_at?: string };
      } catch {
        return {};
      }
    })();
    return {
      running: this.running,
      active: c.isActive(),
      tradingDay: c.cal.isTradingDay(now),
      lastPoolsAt: this.lastPools ? isoSh(this.lastPools) : (health.updated_at ?? null),
      lastQuotesAt: this.lastQuotes ? isoSh(this.lastQuotes) : null,
      poolDate: c.poolDate,
      watchlistSize: c.watchlist.length,
      quotesSource: c.quotesSource,
      poolRoute: c.em.lastRoute,
      cooling: c.em.cooling(),
      fundflowDays: this.rt.kv.keys(KV.fundflowPrefix).length,
      breadthLatest,
      lastError: this.lastError,
      logs: this.logs.slice(-30),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit();
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (e) {
        this.log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!this.running) return;
      this.timer = setTimeout(() => void loop(), this.collector.isActive() ? 1000 : 15000);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  /** 手动"立即刷新"：不管是否在交易时段，跑一整套 */
  async runNow(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = this.collector;
      await c.cal.ensure(this.now());
      if (await c.poolsRound()) {
        this.lastPools = this.now();
        await c.quotesRound();
        this.lastQuotes = this.now();
        await c.thsRound();
      }
      await this.maybeFundflow(true);
      await this.maybeBreadth(true);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = this.collector;
      const now = this.now();
      const today = dateStr(now);
      if (this.lastCalendarDay !== today) {
        this.lastCalendarDay = today;
        await c.cal.ensure(now);
      }
      if (c.isActive()) {
        if (now - this.lastPools >= POOL_INTERVAL * 1000) {
          await c.poolsRound();
          this.lastPools = this.now();
        }
        if (now - this.lastQuotes >= QUOTE_INTERVAL * 1000) {
          await c.quotesRound();
          this.lastQuotes = this.now();
        }
        if (now - this.lastThs >= 300_000) {
          await c.thsRound();
          this.lastThs = this.now();
        }
        return;
      }
      // ---- 非交易时段 ----
      if (!this.bootstrapped) {
        this.bootstrapped = true;
        // 全新安装、本机没有任何池子数据：抓一轮最近交易日，界面不至于是空的
        if (this.rt.kv.keys("collector/pools-").length === 0) {
          if (await c.poolsRound()) {
            await c.quotesRound();
            await c.thsRound();
            this.lastEod = this.now();
          }
        }
      }
      const trading = c.cal.isTradingDay(now);
      const mins = minutesOf(now);
      // 收盘后补一轮收盘快照（15:05 之后、当日还没有收盘后的快照）
      if (trading && mins > 15 * 60 + 5 && now - this.lastEod > 1_800_000 && !this.hasPostCloseSnapshot(today)) {
        this.lastEod = now;
        if (await c.poolsRound()) {
          await c.quotesRound();
          await c.thsRound();
        }
      }
      await this.maybeFundflow(false);
      await this.maybeBreadth(false);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private hasPostCloseSnapshot(today: string): boolean {
    try {
      const ymd = today.replaceAll("-", "");
      const raw = this.rt.kv.get(KV.pools(ymd));
      if (!raw) return false;
      const at = (JSON.parse(raw) as { fetched_at?: string }).fetched_at ?? "";
      return at.startsWith(today) && at.slice(11, 16) >= "15:05";
    } catch {
      return false;
    }
  }

  /** 15:10 后抓当日板块大钱流向（东财只给当日口径，缺档不可事后补抓） */
  private async maybeFundflow(force: boolean): Promise<void> {
    const now = this.now();
    const today = dateStr(now);
    if (!this.collector.cal.isTradingDay(now)) return;
    if (!force && minutesOf(now) < 15 * 60 + 10) return;
    if (minutesOf(now) < 15 * 60 + 5) return; // 手动刷新也不抓盘中的"当日"口径
    if (this.rt.kv.get(KV.fundflow(today)) != null) return;
    if (!force && now - this.lastFlowTry < 1_800_000) return;
    this.lastFlowTry = now;
    try {
      const r = await fetchFundflowDay(this.rt.kv, this.collector.em, this.sleep, today);
      this.log(`FUNDFLOW ${today} industry=${r.industry} concept=${r.concept}`);
    } catch (e) {
      this.log(`FUNDFLOW failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 补小黑板：回看最近 7 天，缺哪天补哪天（盘后包收盘后数小时才出，当日 17:00 前不试） */
  private async maybeBreadth(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastBreadthTry < 1_800_000) return;
    this.lastBreadthTry = now;
    let have = new Set<string>();
    try {
      have = new Set(((JSON.parse(this.rt.kv.get(KV.breadthSeries) ?? "{}") as { records?: { date: string }[] }).records ?? []).map((r) => r.date));
    } catch {
      have = new Set();
    }
    for (let back = 0; back < 7; back++) {
      const ms = now - back * 86400_000;
      const d = dateStr(ms);
      if (!this.collector.cal.isTradingDay(ms) || have.has(d)) continue;
      if (back === 0 && minutesOf(now) < 17 * 60) continue;
      try {
        const stage = this.stageFor(d);
        const rec = await appendBreadthDay(this.rt.kv, this.http, d, stage);
        this.log(`BREADTH ${d} up=${rec.up} down=${rec.down} trin_amt=${rec.trin_amt}`);
      } catch (e) {
        this.log(`BREADTH ${d} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 阶段定调只抄决策台里已录入的基准，不自创 */
  private stageFor(date: string): string {
    try {
      const r = this.rt.db.sqlite.exec("SELECT cycle_stage FROM market_days WHERE date = ?", [date]);
      const v = r[0]?.values[0]?.[0];
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  }
}
