// 本地版"特权处理器"：原版从云端电脑的 /home/hatch/workspace/... 读采集器写的文件，
// 这里改成读本机 kv 表里同名的数据（由 collector/ 下的采集器写入）。
// 返回结构、容错规则与原版完全一致：读不到 = 没数据，不抛错。
import {
  MAX_CHUNK_BYTES,
  privileged,
  type Health,
  type HealthFull,
  type PoolRow,
  type QuoteRow,
} from "./contracts";
import { KV, type Kv } from "./kv";

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

class NotFound extends Error {
  code = "ENOENT";
}

function readJson(kv: Kv, key: string): unknown {
  const raw = kv.get(key);
  if (raw == null) throw new NotFound(key);
  return JSON.parse(raw) as unknown;
}

function mapPoolRow(raw: unknown): PoolRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  const code = strOrEmpty(r.code);
  if (!code) return null;
  return {
    code,
    name: strOrEmpty(r.name),
    price: numOrNull(r.price),
    pct: numOrNull(r.pct),
    amount: numOrNull(r.amount),
    turnover: numOrNull(r.turnover),
    industry: strOrEmpty(r.industry),
    lbc: numOrNull(r.lbc),
    firstSeal: strOrNull(r.first_seal) ?? strOrNull(r.y_first_seal),
    breakTimes: numOrNull(r.break_times),
    sealFund: numOrNull(r.seal_fund),
    ztStat: strOrEmpty(r.zt_stat),
    yLbc: numOrNull(r.y_lbc),
    limitPrice: numOrNull(r.limit_price),
  };
}

function mapQuoteRow(raw: unknown): QuoteRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  const code = strOrEmpty(r.code);
  if (!code) return null;
  return {
    code,
    name: strOrEmpty(r.name),
    price: numOrNull(r.price),
    pct: numOrNull(r.pct),
    open: numOrNull(r.open),
    high: numOrNull(r.high),
    low: numOrNull(r.low),
    prevClose: numOrNull(r.prev_close),
    limitUp: numOrNull(r.limit_up),
    limitDown: numOrNull(r.limit_down),
    sealAmount: numOrNull(r.seal_amount),
    amount: numOrNull(r.amount),
  };
}

function readHealth(kv: Kv): Health {
  try {
    const rec = asRecord(readJson(kv, KV.health));
    if (!rec) return { streamUpdatedAt: null, sinaLastSuccessAt: null };
    const sina = asRecord(rec.sina) ?? {};
    return {
      streamUpdatedAt: strOrNull(rec.updated_at),
      sinaLastSuccessAt: strOrNull(sina.last_success_at),
    };
  } catch {
    return { streamUpdatedAt: null, sinaLastSuccessAt: null };
  }
}

function readHealthFull(kv: Kv): HealthFull {
  const empty: HealthFull = {
    updatedAt: null,
    poolDate: null,
    watchlistSize: null,
    watchlistSource: null,
    quotesSource: null,
    poolRoute: null,
    sinaLastSuccessAt: null,
  };
  try {
    const rec = asRecord(readJson(kv, KV.health));
    if (!rec) return empty;
    const sina = asRecord(rec.sina) ?? {};
    const em = asRecord(rec.eastmoney) ?? {};
    const size = numOrNull(rec.watchlist_size);
    return {
      updatedAt: strOrNull(rec.updated_at),
      poolDate: strOrNull(rec.pool_date),
      watchlistSize: size == null ? null : Math.round(size),
      watchlistSource: strOrNull(rec.watchlist_source),
      quotesSource: strOrNull(rec.quotes_source),
      poolRoute: strOrNull(em.pool_route),
      sinaLastSuccessAt: strOrNull(sina.last_success_at),
    };
  } catch {
    return empty;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

type Handlers = {
  [K in keyof typeof privileged]: (
    args: never,
  ) => Promise<unknown> | unknown;
};

export function createPrivilegedHandlers(kv: Kv): Handlers {
  const enc = new TextEncoder();
  return {
    readCollectorStream: ((args: { offset: number }) => {
      const health = readHealth(kv);
      const text = kv.get(KV.events);
      if (text == null) {
        return { error: "", size: 0, chunkBase64: "", health };
      }
      const bytes = enc.encode(text);
      const size = bytes.length;
      // 文件被轮转/截断：从 0 重读，库里的唯一键 (event_ts, code, type) 会去重
      const from = args.offset > size ? 0 : args.offset;
      if (size === from) return { error: "", size, chunkBase64: "", health };
      const len = Math.min(size - from, MAX_CHUNK_BYTES);
      return {
        error: "",
        size,
        chunkBase64: toBase64(bytes.subarray(from, from + len)),
        health,
      };
    }) as never,

    readCollectorHealth: (() => readHealth(kv)) as never,

    readThsReasons: ((args: { date: string }) => {
      try {
        const rec = asRecord(readJson(kv, KV.ths(args.date.replaceAll("-", ""))));
        const list = rec && Array.isArray(rec.rows) ? rec.rows : [];
        const rows = list
          .map((item) => {
            const r = asRecord(item);
            if (!r) return null;
            const code = strOrEmpty(r.code);
            if (!code) return null;
            return {
              code,
              name: strOrEmpty(r.name),
              reason: strOrEmpty(r.reason),
              boardType: strOrEmpty(r.board_type),
              sealRate: numOrNull(r.seal_rate),
              breakTimes: numOrNull(r.break_times),
              highDays: strOrEmpty(r.high_days),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);
        return { fetchedAt: rec ? strOrNull(rec.fetched_at) : null, rows };
      } catch {
        return { fetchedAt: null, rows: [] };
      }
    }) as never,

    readCollectorIntraday: ((args: { date: string }) => {
      const health = readHealthFull(kv);
      const ymd = args.date.replaceAll("-", "");
      let pools: {
        date: string;
        fetchedAt: string | null;
        zt: PoolRow[];
        zb: PoolRow[];
        dt: PoolRow[];
        yzt: PoolRow[];
      } | null = null;
      let error = "";
      try {
        const rec = asRecord(readJson(kv, KV.pools(ymd)));
        if (rec) {
          const poolsRec = asRecord(rec.pools) ?? {};
          const mapArr = (v: unknown): PoolRow[] =>
            Array.isArray(v)
              ? v.map(mapPoolRow).filter((x): x is PoolRow => x != null)
              : [];
          pools = {
            date: strOrEmpty(rec.date),
            fetchedAt: strOrNull(rec.fetched_at),
            zt: mapArr(poolsRec.zt),
            zb: mapArr(poolsRec.zb),
            dt: mapArr(poolsRec.dt),
            yzt: mapArr(poolsRec.yzt),
          };
        }
      } catch (e) {
        if ((e as { code?: unknown })?.code !== "ENOENT") {
          error = `读取采集器池子数据失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      let quotes: QuoteRow[] = [];
      let quotesUpdatedAt: string | null = null;
      let quotesDate: string | null = null;
      try {
        const rec = asRecord(readJson(kv, KV.state));
        if (rec) {
          quotesDate = strOrNull(rec.date);
          quotesUpdatedAt = strOrNull(rec.updated_at);
          const q = asRecord(rec.quotes);
          if (quotesDate === ymd && q) {
            quotes = Object.values(q)
              .map(mapQuoteRow)
              .filter((x): x is QuoteRow => x != null);
          }
        }
      } catch {
        // 行情状态读不到时只缺实时价，不影响池子数据
      }
      return { error, health, pools, quotesUpdatedAt, quotesDate, quotes };
    }) as never,

    readBreadthFundflow: (() => {
      const errors: string[] = [];
      const intOrNull = (v: unknown): number | null => {
        const n = numOrNull(v);
        return n == null ? null : Math.round(n);
      };
      let breadth: {
        date: string;
        up: number | null;
        down: number | null;
        flat: number | null;
        red: number | null;
        trinAmt: number | null;
        trinVol: number | null;
        stage: string;
      }[] = [];
      try {
        const rec = asRecord(readJson(kv, KV.breadthSeries));
        const list = rec && Array.isArray(rec.records) ? rec.records : [];
        breadth = list
          .map((item) => {
            const r = asRecord(item);
            if (!r) return null;
            const date = strOrEmpty(r.date);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
            return {
              date,
              up: intOrNull(r.up),
              down: intOrNull(r.down),
              flat: intOrNull(r.flat),
              red: numOrNull(r.red),
              trinAmt: numOrNull(r.trin_amt),
              trinVol: numOrNull(r.trin_vol),
              stage: strOrEmpty(r.stage),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);
      } catch (e) {
        if ((e as { code?: unknown })?.code !== "ENOENT") {
          errors.push(
            `读取小黑板数据失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const fundflowRows: {
        date: string;
        kind: string;
        name: string;
        netYuan: number | null;
      }[] = [];
      for (const key of kv.keys(KV.fundflowPrefix)) {
        const f = key.slice(KV.fundflowPrefix.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) continue;
        try {
          const rec = asRecord(readJson(kv, key));
          if (!rec) continue;
          const date =
            typeof rec.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rec.date)
              ? rec.date
              : f;
          for (const kind of ["industry", "concept"] as const) {
            const kindRec = asRecord(rec[kind]);
            const rows = kindRec && Array.isArray(kindRec.rows) ? kindRec.rows : [];
            for (const item of rows) {
              const row = asRecord(item);
              if (!row) continue;
              const name = strOrEmpty(row.name);
              if (!name) continue;
              fundflowRows.push({ date, kind, name, netYuan: numOrNull(row.main_net) });
            }
          }
        } catch {
          // 单日存档损坏只跳过该日
        }
      }
      let fundflowSummaryDays = 0;
      let fundflowSummaryLatestDate: string | null = null;
      try {
        const rec = asRecord(readJson(kv, KV.fundflowSummary));
        if (rec) {
          const d = numOrNull(rec.days_available);
          fundflowSummaryDays = d == null ? 0 : Math.max(0, Math.round(d));
          fundflowSummaryLatestDate = strOrNull(rec.latest_date);
        }
      } catch {
        // 汇总读不到不影响存档同步
      }
      return {
        error: errors.join("；"),
        breadth,
        fundflowRows,
        fundflowSummaryDays,
        fundflowSummaryLatestDate,
      };
    }) as never,
  };
}
