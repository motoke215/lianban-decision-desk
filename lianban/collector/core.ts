// 采集器主体：移植自 collector.py 的 EmClient + Collector。
// 与原版的区别只有两处（都不改变口径）：
//   1. 数据写入本机 kv 表（对应原来的 data/*.json、events.jsonl），而不是磁盘文件
//   2. 网络请求经 HttpGet 注入：Windows 走主进程，安卓走原生 HTTP；去掉了为云端
//      电脑海外出口准备的 Cloudflare 转发路线（国内网络直连东财）
import type { Kv } from "../runtime/kv";
import { KV } from "../runtime/kv";
import {
  normalizePoolItem,
  parseSinaText,
  parseTencentText,
  type PoolItem,
  type PoolKey,
  type Quote,
} from "./parse";
import { TradingCalendar } from "./calendar";
import { exclusionCategory, isActiveWindow, isoSh, sinaSymbol, ymdSh } from "./rules";
import { thsRound } from "./ths";

export type HttpGet = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<{ status: number; bytes: Uint8Array }>;

export interface Deps {
  kv: Kv;
  http: HttpGet;
  now?: () => number; // 毫秒
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SINA_URL = "https://hq.sinajs.cn/list=";
const SINA_REFERER = "https://finance.sina.com.cn";
const SINA_BATCH = 50;
const TENCENT_URL = "https://qt.gtimg.cn/q=";
const TENCENT_REFERER = "https://gu.qq.com/";
const TENCENT_BATCH = 50;
const EM_BASE = "https://push2ex.eastmoney.com/";
const EM_UT = "7eea3edcaed734bea9cbfc24409ed989";
const EM_DPT = "wz.ztzt";
const EM_PAGE_SIZE = 200;
const EM_MIN_INTERVAL = 1.0;
const EM_COOLDOWN_SEC = 1800;
const EM_POOLS: Record<PoolKey, [string, string]> = {
  zt: ["getTopicZTPool", "fbt:asc"],
  zb: ["getTopicZBPool", "fbt:asc"],
  dt: ["getTopicDTPool", "fund:asc"],
  yzt: ["getYesterdayZTPool", "zs:desc"],
};
export const POOL_INTERVAL = 60;
export const QUOTE_INTERVAL = 5;
const WATCHLIST_CAP = 250;
const SEAL_DROP_WINDOW = 60;
const SEAL_DROP_RATIO = 0.5;
const SEAL_DROP_COOLDOWN = 120;
const DIVE_WINDOW = 180;
const DIVE_POINTS = 5.0;
const DIVE_MIN_LBC = 3;
const DIVE_COOLDOWN = 300;

export class SourceError extends Error {}

// ---------- 东财池子客户端：串行 + 限速 + 403/断连后冷却 30 分钟 ----------

export class EmClient {
  cooldownUntil = 0;
  lastSuccess: number | null = null;
  consecutiveFailures = 0;
  lastRoute: "direct" | null = null;
  private lastTs = 0;

  constructor(
    private d: Required<Omit<Deps, "kv">>,
    private isTradingDay: (ms: number) => boolean,
  ) {}

  cooling(): boolean {
    return this.d.now() / 1000 < this.cooldownUntil;
  }

  private async throttle(): Promise<void> {
    const t = this.d.now() / 1000;
    const wait = this.lastTs + EM_MIN_INTERVAL + (0.2 + this.d.random() * 0.4) - t;
    if (wait > 0) await this.d.sleep(wait * 1000);
    this.lastTs = this.d.now() / 1000;
  }

  /** 其他东财接口（板块资金流等）共用同一条限速线；失败由调用方自行重试，不触发池子冷却 */
  async rawGet(url: string, headers: Record<string, string>, timeoutMs: number) {
    if (this.cooling()) throw new SourceError("eastmoney in cooldown");
    await this.throttle();
    return this.d.http(url, { "User-Agent": UA, ...headers }, timeoutMs);
  }

  private fail(why: string): void {
    this.consecutiveFailures += 1;
    this.cooldownUntil = this.d.now() / 1000 + EM_COOLDOWN_SEC;
    this.d.log(`EM failure (${why}); cooling down ${EM_COOLDOWN_SEC / 60} min`);
  }

  async fetchPool(key: PoolKey, date: string): Promise<[number | null, PoolItem[] | null]> {
    if (this.cooling()) throw new SourceError("pools unavailable (direct: eastmoney in cooldown)");
    const [endpoint, sort] = EM_POOLS[key];
    const items: PoolItem[] = [];
    let tcTotal: number | null = null;
    for (let page = 0; page < 10; page++) {
      await this.throttle();
      const qs = new URLSearchParams({
        ut: EM_UT,
        dpt: EM_DPT,
        Pageindex: String(page),
        pagesize: String(EM_PAGE_SIZE),
        sort,
        date,
      });
      let doc: { data?: { pool?: Record<string, unknown>[]; tc?: number } | null };
      try {
        const res = await this.d.http(EM_BASE + endpoint + "?" + qs.toString(), {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": UA,
        }, 15000);
        if (res.status >= 400) {
          this.fail(`HTTP ${res.status}`);
          throw new SourceError(`pools unavailable (direct: eastmoney ${endpoint} HTTP ${res.status})`);
        }
        doc = JSON.parse(new TextDecoder("utf-8").decode(res.bytes));
      } catch (e) {
        if (e instanceof SourceError) throw e;
        const nm = e instanceof Error ? e.name : "Error";
        this.fail(nm);
        throw new SourceError(
          `pools unavailable (direct: eastmoney ${endpoint}: ${nm}: ${e instanceof Error ? e.message : String(e)})`,
        );
      }
      const data = doc.data;
      if (data == null) return [null, null];
      const pool = data.pool ?? [];
      tcTotal = data.tc ?? pool.length;
      items.push(...pool.map((p) => normalizePoolItem(key, p)));
      if (items.length >= (tcTotal || 0) || pool.length === 0) break;
    }
    this.consecutiveFailures = 0;
    this.lastSuccess = this.d.now();
    this.lastRoute = "direct";
    return [tcTotal, items];
  }

  /** 交易日用当天；非交易日向前找最近一个有涨停数据的工作日 */
  async resolvePoolDate(maxBack = 10): Promise<[string, number | null, PoolItem[]]> {
    const nowMs = this.d.now();
    const today = ymdSh(nowMs);
    let ms = nowMs;
    let tried = 0;
    while (tried < maxBack) {
      if (this.isTradingDay(ms)) {
        tried += 1;
        const date = ymdSh(ms);
        const [tc, items] = await this.fetchPool("zt", date);
        if (tc !== null && (date === today || (items?.length ?? 0) > 0)) {
          return [date, tc, items ?? []];
        }
      }
      ms -= 86400_000;
    }
    throw new SourceError("no eastmoney pool date resolved");
  }
}

// ---------- 采集器 ----------

type Results = Record<PoolKey, [number | null, PoolItem[] | null]>;

export class Collector {
  readonly em: EmClient;
  readonly cal: TradingCalendar;
  poolDate: string | null = null;
  watchlistSource: "live" | "snapshot" = "live";
  quotesSource: "sina" | "tencent" | null = null;
  pools: Partial<Record<PoolKey, PoolItem[]>> = {};
  watchlist: { code: string; symbol: string; name: string }[] = [];
  lbcMap = new Map<string, number>();
  prevQuotes: Record<string, Quote>;
  sealHist = new Map<string, [number, number][]>();
  pctHist = new Map<string, [number, number][]>();
  cooldowns = new Map<string, number>();
  sinaLastSuccess: number | null = null;
  sinaFailures = 0;
  sinaStale = false;
  lastPoolFilter: {
    kept_counts: Record<string, number>;
    excluded_counts: Record<string, number>;
  } | null = null;
  lastWatchRaw = 0;
  private lastStamp: string | null = null;
  private lastStampChange: number;
  private eventsText: string;
  private d: Required<Omit<Deps, "kv">>;
  private kv: Kv;

  constructor(deps: Deps) {
    this.kv = deps.kv;
    this.d = {
      http: deps.http,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: deps.random ?? Math.random,
      log: deps.log ?? (() => {}),
    };
    this.cal = new TradingCalendar(this.kv, this.d.http);
    this.em = new EmClient(this.d, (ms) => this.cal.isTradingDay(ms));
    this.lastStampChange = this.d.now() / 1000;
    this.eventsText = this.kv.get(KV.events) ?? "";
    if (this.kv.get(KV.events) == null) this.kv.set(KV.events, "");
    this.prevQuotes = this.loadPrevState();
  }

  private t(): number {
    return this.d.now() / 1000;
  }

  private loadPrevState(): Record<string, Quote> {
    try {
      const raw = this.kv.get(KV.state);
      if (!raw) return {};
      const q = (JSON.parse(raw) as { quotes?: Record<string, Quote> }).quotes;
      return q ?? {};
    } catch {
      return {};
    }
  }

  /** 现在是否在交易时段（以交易日历为准） */
  isActive(): boolean {
    const now = this.d.now();
    return isActiveWindow(now, this.cal.isTradingDay(now));
  }

  /** 同花顺涨停揭秘（涨停原因题材）；失败不影响行情和事件 */
  async thsRound(): Promise<boolean> {
    if (!this.poolDate) return false;
    try {
      const n = await thsRound(this.kv, this.d.http, this.poolDate, this.d.now());
      this.d.log(`THS reasons n=${n}`);
      return n > 0;
    } catch (e) {
      this.d.log(`THS round failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  writeHealth(extra?: Record<string, unknown>): void {
    const h: Record<string, unknown> = {
      updated_at: isoSh(this.d.now()),
      pool_date: this.poolDate,
      watchlist_size: this.watchlist.length,
      watchlist_source: this.watchlistSource,
      quotes_source: this.quotesSource,
      sina: {
        last_success_at: this.sinaLastSuccess ? isoSh(this.sinaLastSuccess) : null,
        consecutive_failures: this.sinaFailures,
        stale: this.sinaStale,
      },
      eastmoney: {
        last_success_at: this.em.lastSuccess ? isoSh(this.em.lastSuccess) : null,
        pool_route: this.em.lastRoute,
        consecutive_failures: this.em.consecutiveFailures,
        cooling: this.em.cooling(),
        cooldown_until: this.em.cooling() ? isoSh(this.em.cooldownUntil * 1000) : null,
      },
    };
    if (this.lastPoolFilter) {
      h.kept_counts = this.lastPoolFilter.kept_counts;
      h.excluded_counts = this.lastPoolFilter.excluded_counts;
    }
    if (extra) Object.assign(h, extra);
    this.kv.set(KV.health, JSON.stringify(h));
  }

  emit(etype: string, q: Quote, detail: Record<string, unknown>): void {
    const ev = { ts: isoSh(this.d.now()), type: etype, code: q.code, name: q.name, detail };
    this.eventsText += JSON.stringify(ev) + "\n";
    this.kv.set(KV.events, this.eventsText);
    this.d.log(`EVENT ${etype} ${q.code} ${q.name}`);
  }

  // ---- 池子轮 ----
  async poolsRound(): Promise<boolean> {
    let results: Results;
    try {
      const [date, ztTc, ztItems] = await this.em.resolvePoolDate();
      this.poolDate = date;
      results = { zt: [ztTc, ztItems], zb: [null, null], dt: [null, null], yzt: [null, null] };
      for (const key of ["zb", "dt", "yzt"] as const) {
        results[key] = await this.em.fetchPool(key, date);
      }
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.d.log(`POOLS round failed: ${e.message}`);
      // 兜底：东财失败/冷却时，用最新的池子快照重建监控列表，行情和事件检测继续（降级运行）
      if (this.watchlist.length === 0 && this.restoreFromSnapshot()) return true;
      this.writeHealth();
      return false;
    }
    this.watchlistSource = "live";
    return this.buildFromResults(results);
  }

  private restoreFromSnapshot(): boolean {
    try {
      const files = this.kv.keys("collector/pools-").sort();
      const last = files[files.length - 1];
      if (!last) return false;
      const snap = JSON.parse(this.kv.get(last) ?? "null") as {
        date?: string;
        counts?: Record<string, number>;
        pools?: Partial<Record<PoolKey, PoolItem[]>>;
      } | null;
      const pools = snap?.pools ?? {};
      if (!(["zt", "zb", "yzt"] as const).some((k) => (pools[k]?.length ?? 0) > 0)) return false;
      const counts = snap?.counts ?? {};
      const results = {} as Results;
      for (const k of ["zt", "zb", "dt", "yzt"] as const) {
        results[k] = [counts[k] ?? null, pools[k] ?? []];
      }
      this.poolDate = snap?.date ?? this.poolDate;
      this.watchlistSource = "snapshot";
      this.d.log(`POOLS fallback: restored snapshot ${last}`);
      return this.buildFromResults(results);
    } catch (e) {
      this.d.log(`POOLS fallback failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private buildFromResults(results: Results): boolean {
    this.pools = {};
    const counts: Record<string, number> = {};
    const keptCounts: Record<string, number> = {};
    const excludedCounts: Record<string, number> = { st: 0, star: 0, bse: 0 };
    const excludedDetail: Record<string, unknown> = {};
    const rawWatch = new Set<string>();
    for (const key of ["zt", "zb", "dt", "yzt"] as const) {
      const [tc, items] = results[key];
      const raw = items ?? [];
      if (key === "zt" || key === "zb" || key === "yzt") {
        for (const it of raw) if (it.code) rawWatch.add(it.code);
      }
      const kept: PoolItem[] = [];
      const perKey: Record<string, number> = { st: 0, star: 0, bse: 0 };
      for (const it of raw) {
        const cat = exclusionCategory(it.code, it.name);
        if (cat) {
          perKey[cat] = (perKey[cat] ?? 0) + 1;
          excludedCounts[cat] = (excludedCounts[cat] ?? 0) + 1;
        } else kept.push(it);
      }
      this.pools[key] = kept;
      counts[key] = tc ?? 0;
      keptCounts[key] = kept.length;
      excludedDetail[key] = { fetched: raw.length, kept: kept.length, excluded: perKey };
    }
    this.lastWatchRaw = rawWatch.size;
    this.lastPoolFilter = { kept_counts: keptCounts, excluded_counts: excludedCounts };
    // 监控列表 = 昨日涨停 ∪ 今日涨停 ∪ 今日炸板（去重、封顶）
    const seen = new Set<string>();
    const watch: { code: string; symbol: string; name: string }[] = [];
    for (const key of ["zt", "zb", "yzt"] as const) {
      for (const it of this.pools[key] ?? []) {
        if (it.code && !seen.has(it.code)) {
          seen.add(it.code);
          watch.push({ code: it.code, symbol: sinaSymbol(it.code, it.market), name: it.name ?? "" });
        }
      }
    }
    this.watchlist = watch.slice(0, WATCHLIST_CAP);
    this.lbcMap = new Map();
    for (const key of ["zt", "zb"] as const) {
      for (const it of this.pools[key] ?? []) {
        const lbc = it.lbc as number | null | undefined;
        if (lbc) this.lbcMap.set(it.code, Math.max(lbc, this.lbcMap.get(it.code) ?? 0));
      }
    }
    const snap = {
      date: this.poolDate,
      fetched_at: isoSh(this.d.now()),
      counts,
      kept_counts: keptCounts,
      excluded: excludedDetail,
      pools: this.pools,
    };
    this.kv.set(KV.pools(this.poolDate ?? "unknown"), JSON.stringify(snap));
    this.d.log(
      `POOLS date=${this.poolDate} zt=${counts.zt} zb=${counts.zb} dt=${counts.dt} yzt=${counts.yzt} watchlist=${this.watchlist.length}`,
    );
    this.writeHealth();
    return true;
  }

  // ---- 行情轮 ----
  private async fetchBatches(
    symbols: string[],
    base: string,
    batch: number,
    referer: string,
    parse: (t: string) => Record<string, Quote>,
    label: string,
  ): Promise<Record<string, Quote>> {
    const merged: Record<string, Quote> = {};
    let failures = 0;
    for (let i = 0; i < symbols.length; i += batch) {
      const part = symbols.slice(i, i + batch);
      try {
        const res = await this.d.http(base + part.join(","), { Referer: referer, "User-Agent": UA }, 12000);
        if (res.status >= 400 || res.bytes.length === 0) throw new Error(`HTTP ${res.status}`);
        Object.assign(merged, parse(new TextDecoder("gbk").decode(res.bytes)));
      } catch (e) {
        failures += 1;
        this.d.log(`${label} batch @${i} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures && Object.keys(merged).length === 0) {
      throw new SourceError(`all ${failures} ${label.toLowerCase()} batches failed`);
    }
    return merged;
  }

  async quotesRound(): Promise<boolean> {
    if (this.watchlist.length === 0) return false;
    const symbols = this.watchlist
      .filter((w) => !exclusionCategory(w.code, w.name))
      .map((w) => w.symbol);
    if (symbols.length === 0) return false;
    let quotes: Record<string, Quote>;
    try {
      quotes = await this.fetchBatches(symbols, SINA_URL, SINA_BATCH, SINA_REFERER, parseSinaText, "SINA");
      this.quotesSource = "sina";
    } catch (e1) {
      if (!(e1 instanceof SourceError)) throw e1;
      // 热备：新浪整轮失败时腾讯接手，保证事件心跳不断
      try {
        quotes = await this.fetchBatches(symbols, TENCENT_URL, TENCENT_BATCH, TENCENT_REFERER, parseTencentText, "TENCENT");
        this.quotesSource = "tencent";
        this.d.log(`QUOTES via tencent spare (sina failed: ${e1.message})`);
      } catch (e2) {
        if (!(e2 instanceof SourceError)) throw e2;
        this.sinaFailures += 1;
        this.sinaStale = this.sinaFailures >= 3;
        this.d.log(`QUOTES round failed: sina: ${e1.message}; tencent: ${e2.message}`);
        this.writeHealth();
        return false;
      }
    }
    // 响应侧再过滤一次，state 里只留范围内的股票
    quotes = Object.fromEntries(
      Object.entries(quotes).filter(([c, q]) => !exclusionCategory(c, q.name)),
    );
    this.sinaFailures = 0;
    this.sinaLastSuccess = this.d.now();
    let stamp: string | null = null;
    for (const q of Object.values(quotes)) if (stamp === null || q.quote_time > stamp) stamp = q.quote_time;
    if (stamp !== this.lastStamp) {
      this.lastStamp = stamp;
      this.lastStampChange = this.t();
    }
    this.sinaStale = this.t() - this.lastStampChange > 60 && this.isActive();
    const fetched = isoSh(this.d.now());
    for (const [code, q] of Object.entries(quotes)) {
      q.lbc = this.lbcMap.get(code) ?? null;
      q.fetched_at = fetched;
      this.detectEvents(q);
    }
    this.kv.set(KV.state, JSON.stringify({ date: this.poolDate, updated_at: fetched, quotes }));
    this.prevQuotes = quotes;
    this.d.log(`QUOTES n=${Object.keys(quotes).length} stamp=${stamp}`);
    this.writeHealth();
    return true;
  }

  // ---- 事件检测（6 类：first_seal / reseal / broken / limit_down_seal / seal_drop / dive）----
  private cool(etype: string, code: string, sec: number): boolean {
    const k = `${etype}|${code}`;
    const last = this.cooldowns.get(k) ?? 0;
    if (this.t() - last < sec) return true;
    this.cooldowns.set(k, this.t());
    return false;
  }

  private detectEvents(q: Quote): void {
    const code = q.code;
    const prev = this.prevQuotes[code];
    const nowTs = this.t();
    let sh = this.sealHist.get(code);
    if (!sh) this.sealHist.set(code, (sh = []));
    sh.push([nowTs, q.seal_amount]);
    while (sh.length && (sh[0] as [number, number])[0] < nowTs - 130) sh.shift();
    let ph = this.pctHist.get(code);
    if (!ph) this.pctHist.set(code, (ph = []));
    ph.push([nowTs, q.pct]);
    while (ph.length && (ph[0] as [number, number])[0] < nowTs - (DIVE_WINDOW + 30)) ph.shift();
    if (!prev) return; // 首次见到：静默初始化，不发事件

    if (q.is_sealed_up && !prev.is_sealed_up) {
      const etype = prev._was_broken ? "reseal" : "first_seal";
      this.emit(etype, q, {
        price: q.price,
        limit_up: q.limit_up,
        seal_amount: q.seal_amount,
        lbc: q.lbc ?? null,
      });
    }
    if (prev.is_sealed_up && !q.is_sealed_up && q.price < q.limit_up) {
      this.emit("broken", q, {
        price: q.price,
        limit_up: q.limit_up,
        pct: q.pct,
        lbc: q.lbc ?? null,
      });
      q._was_broken = true;
    } else if (prev._was_broken) {
      q._was_broken = true;
    }
    if (q.is_sealed_down && !prev.is_sealed_down) {
      this.emit("limit_down_seal", q, { price: q.price, limit_down: q.limit_down, pct: q.pct });
    }
    // 封单额在约 60 秒内腰斩（仍封着）
    if (q.is_sealed_up) {
      let old: [number, number] | null = null;
      for (const [ts, amt] of sh) {
        if (nowTs - ts >= SEAL_DROP_WINDOW - 5) {
          old = [ts, amt];
          break;
        }
      }
      if (old && old[1] > 0 && q.seal_amount <= old[1] * SEAL_DROP_RATIO) {
        if (!this.cool("seal_drop", code, SEAL_DROP_COOLDOWN)) {
          this.emit("seal_drop", q, {
            from: old[1],
            to: q.seal_amount,
            window_sec: Math.round(nowTs - old[0]),
            limit_up: q.limit_up,
          });
        }
      }
    }
    // 高位板跳水：连板数>=3，3 分钟内涨幅回落>=5 个点
    const lbc = q.lbc ?? 0;
    if (lbc >= DIVE_MIN_LBC && ph.length >= 2) {
      let peak = -Infinity;
      for (const [ts, p] of ph) if (nowTs - ts <= DIVE_WINDOW && p > peak) peak = p;
      if (peak - q.pct >= DIVE_POINTS) {
        if (!this.cool("dive", code, DIVE_COOLDOWN)) {
          this.emit("dive", q, { peak_pct: peak, pct: q.pct, lbc, price: q.price });
        }
      }
    }
  }
}
