// 同花顺涨停揭秘（思路与接口来自 a-stock-data §8.2）：每只涨停股的"涨停原因题材"、板型、封板成功率。
// 作用：决策台的「主流题材」不用再手填，按涨停原因词频自动给出。
import type { Kv } from "../runtime/kv";
import { KV } from "../runtime/kv";
import type { HttpGet } from "./core";
import { isoSh, shParts } from "./rules";

const URL_BASE = "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool";
const FIELDS = "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004";
const p2 = (n: number) => String(n).padStart(2, "0");

export interface ThsRow {
  code: string;
  name: string;
  reason: string;
  board_type: string;
  seal_rate: number | null;
  break_times: number | null;
  high_days: string;
  first_time: string;
}

export async function fetchThsLimitUpPool(http: HttpGet, ymd: string): Promise<ThsRow[]> {
  const qs = new URLSearchParams({
    page: "1",
    limit: "200",
    field: FIELDS,
    filter: "HS,GEM2STAR",
    order_field: "330324",
    order_type: "0",
    date: ymd,
  });
  const res = await http(`${URL_BASE}?${qs.toString()}`, { "User-Agent": "Mozilla/5.0" }, 10000);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const doc = JSON.parse(new TextDecoder("utf-8").decode(res.bytes)) as {
    data?: { info?: Record<string, unknown>[] } | null;
  };
  const info = doc.data?.info ?? [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return info
    .map((it) => {
      const ft = Number(it.first_limit_up_time);
      let first = "";
      if (Number.isFinite(ft) && ft > 0) {
        const t = shParts(ft * 1000); // Unix 秒；按上海时区显示
        first = `${p2(t.hh)}:${p2(t.mm)}:${p2(t.ss)}`;
      }
      return {
        code: String(it.code ?? ""),
        name: String(it.name ?? ""),
        reason: typeof it.reason_type === "string" ? it.reason_type : "",
        board_type: typeof it.limit_up_type === "string" ? it.limit_up_type : "",
        seal_rate: num(it.limit_up_suc_rate),
        break_times: num(it.open_num) ?? 0,
        high_days: typeof it.high_days === "string" ? it.high_days : "",
        first_time: first,
      };
    })
    .filter((r) => r.code);
}

export async function thsRound(kv: Kv, http: HttpGet, ymd: string, nowMs: number): Promise<number> {
  const rows = await fetchThsLimitUpPool(http, ymd);
  if (rows.length === 0) return 0; // 空结果不覆盖已有存档（非交易日/接口抽风）
  kv.set(KV.ths(ymd), JSON.stringify({ date: ymd, fetched_at: isoSh(nowMs), rows }));
  return rows.length;
}
