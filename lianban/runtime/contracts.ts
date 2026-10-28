// Host-capable helpers for the intraday event stream: the collector writes
// events.jsonl + health.json on the local filesystem, which portable action
// code cannot read. This module runs on the host; actions.ts only carries
// the contract descriptors (via @space/privileged) and calls
// ctx.executePrivileged.

import { definePrivilegedContracts, z } from "./sdk";


// One sync pass never reads more than this many new bytes; a larger backlog
// is picked up by the next pass (watermark only advances past what was read).
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const healthShape = z.object({
  streamUpdatedAt: z.string().nullable(), // health.json updated_at
  sinaLastSuccessAt: z.string().nullable(), // health.json sina.last_success_at
});
export type Health = z.infer<typeof healthShape>;

// 盘中实况：采集器四池快照（pools-YYYYMMDD.json，约 60 秒刷新）里的一行。
// 字段按池子原始 JSON 归一化：zt 有 lbc/first_seal/seal_fund，zb 有
// limit_price/break_times，yzt 有 y_lbc/y_first_seal；缺的字段一律 null。
export const poolRowShape = z.object({
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
export type PoolRow = z.infer<typeof poolRowShape>;

// 盘中实况：采集器盯盘名单实时行情（state.json，约 5 秒刷新）里的一行。
export const quoteRowShape = z.object({
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
export type QuoteRow = z.infer<typeof quoteRowShape>;

export const healthFullShape = z.object({
  updatedAt: z.string().nullable(),
  poolDate: z.string().nullable(), // YYYYMMDD
  watchlistSize: z.number().nullable(),
  watchlistSource: z.string().nullable(), // live / 存档兜底等采集器原值
  quotesSource: z.string().nullable(), // sina / tencent
  poolRoute: z.string().nullable(), // direct / cf
  sinaLastSuccessAt: z.string().nullable(),
});
export type HealthFull = z.infer<typeof healthFullShape>;

export const privileged = definePrivilegedContracts({
  readCollectorStream: {
    request: z.object({ offset: z.number().int().nonnegative() }),
    response: z.object({
      error: z.string(), // "" on success; a readable message otherwise
      size: z.number(), // current events.jsonl size in bytes (0 on error)
      // base64 of the bytes after `offset` ("" when nothing new / on error).
      // base64 because a byte offset can split a multi-byte UTF-8 character.
      chunkBase64: z.string(),
      health: z.object({
        streamUpdatedAt: z.string().nullable(),
        sinaLastSuccessAt: z.string().nullable(),
      }),
    }),
    capabilities: ["fs.read"],
    timeoutMs: 30000,
  },
  // —— 本地版新增（来自 a-stock-data §8.2 同花顺涨停揭秘）：涨停原因题材 + 板型 + 封板成功率 ——
  readThsReasons: {
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({
      fetchedAt: z.string().nullable(),
      rows: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          reason: z.string(),
          boardType: z.string(),
          sealRate: z.number().nullable(),
          breakTimes: z.number().nullable(),
          highDays: z.string(),
        }),
      ),
    }),
    capabilities: ["fs.read"],
    timeoutMs: 10000,
  },
  readCollectorHealth: {
    request: z.object({}),
    response: z.object({
      streamUpdatedAt: z.string().nullable(),
      sinaLastSuccessAt: z.string().nullable(),
    }),
    capabilities: ["fs.read"],
    timeoutMs: 10000,
  },
  readCollectorIntraday: {
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({
      error: z.string(), // "" = 无错误；池子文件不存在不算错误（pools 为 null）
      health: z.object({
        updatedAt: z.string().nullable(),
        poolDate: z.string().nullable(),
        watchlistSize: z.number().nullable(),
        watchlistSource: z.string().nullable(),
        quotesSource: z.string().nullable(),
        poolRoute: z.string().nullable(),
        sinaLastSuccessAt: z.string().nullable(),
      }),
      pools: z
        .object({
          date: z.string(), // YYYYMMDD
          fetchedAt: z.string().nullable(),
          zt: z.array(
            z.object({
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
            }),
          ),
          zb: z.array(
            z.object({
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
            }),
          ),
          dt: z.array(
            z.object({
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
            }),
          ),
          yzt: z.array(
            z.object({
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
            }),
          ),
        })
        .nullable(),
      quotesUpdatedAt: z.string().nullable(),
      quotesDate: z.string().nullable(), // state.json 的 date（YYYYMMDD）
      quotes: z.array(
        z.object({
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
        }),
      ), // 仅当 quotesDate 与请求日期一致时非空
    }),
    capabilities: ["fs.read"],
    timeoutMs: 15000,
  },
  readBreadthFundflow: {
    request: z.object({}),
    response: z.object({
      error: z.string(), // "" = 无错误；部分来源读不到时写明，不抛错
      breadth: z.array(
        z.object({
          date: z.string(),
          up: z.number().nullable(),
          down: z.number().nullable(),
          flat: z.number().nullable(),
          red: z.number().nullable(),
          trinAmt: z.number().nullable(),
          trinVol: z.number().nullable(),
          stage: z.string(),
        }),
      ),
      fundflowRows: z.array(
        z.object({
          date: z.string(),
          kind: z.string(), // industry / concept
          name: z.string(),
          netYuan: z.number().nullable(),
        }),
      ),
      fundflowSummaryDays: z.number(),
      fundflowSummaryLatestDate: z.string().nullable(),
    }),
    capabilities: ["fs.read"],
    timeoutMs: 15000,
  },
});
