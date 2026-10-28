// 市场宽度 + TRIN（涨股吸金力）小黑板。移植自 breadth-trin/breadth_trin.py，口径写死不变：
// 通达信官网盘后包 → 沪深 A 股（沪 600/601/603/605/688/689 + 深 000/001/002/003/300/301），
// 涨跌按 close vs prev_close，平盘单列；TRIN = (涨家数/跌家数) ÷ (涨股成交/跌股成交)，
// 主口径用成交额，成交量版并列。只做参考，不进裁决。
import { unzipSync } from "fflate";
import type { Kv } from "../runtime/kv";
import { KV } from "../runtime/kv";
import type { HttpGet } from "./core";

const URL = (ymd: string) => `https://www.tdx.com.cn/products/data/data/g4day/${ymd}.zip`;

export interface DayRow {
  market: "sh" | "sz" | "bj";
  code: string;
  name: string;
  prev_close: number;
  close: number;
  volume: number;
  amount: number;
}

export function parseBreadthPackage(zip: Uint8Array, ymd: string): DayRow[] {
  const files = unzipSync(zip);
  const rows: DayRow[] = [];
  const gbk = new TextDecoder("gbk");
  for (const market of ["sh", "sz", "bj"] as const) {
    const cod = files[`${market}${ymd.slice(2)}.cod`];
    const md1 = files[`${market}${ymd.slice(2)}.md1`];
    if (!cod || !md1) continue;
    const codV = new DataView(cod.buffer, cod.byteOffset, cod.byteLength);
    const mdV = new DataView(md1.buffer, md1.byteOffset, md1.byteLength);
    for (let off = 0; off + 150 <= cod.length; off += 150) {
      let end = 6;
      let code = "";
      for (let i = 0; i < 6; i++) {
        const b = cod[off + i] ?? 0;
        if (b === 0 || b === 0x20) {
          end = i;
          break;
        }
        code += String.fromCharCode(b);
      }
      void end;
      if (!/^[0-9]{6}$/.test(code)) continue;
      const seq = codV.getUint16(off + 32, true);
      const base = seq * 512;
      if (base + 512 > md1.length) continue;
      const prev = mdV.getFloat64(base + 4, true);
      const close = mdV.getFloat64(base + 12 + 24, true); // open, high, low, close
      const amount = mdV.getFloat64(base + 72, true);
      if (!(close > 0) || !Number.isFinite(close)) continue;
      const volume = Number(mdV.getBigUint64(base + 56, true));
      const nameBytes = cod.subarray(off + 40, off + 72);
      const z = nameBytes.indexOf(0);
      let name = "";
      try {
        name = gbk.decode(z >= 0 ? nameBytes.subarray(0, z) : nameBytes).trim();
      } catch {
        name = "";
      }
      rows.push({ market, code, name, prev_close: prev, close, volume, amount });
    }
  }
  return rows;
}

function isAStock(r: DayRow): boolean {
  const c = r.code;
  if (r.market === "sh") return ["600", "601", "603", "605", "688", "689"].some((p) => c.startsWith(p));
  if (r.market === "sz") return ["000", "001", "002", "003", "300", "301"].some((p) => c.startsWith(p));
  return false; // 北交所不进主口径
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export interface BreadthRecord {
  date: string;
  up: number;
  down: number;
  flat: number;
  red: number | null;
  trin_amt: number | null;
  trin_vol: number | null;
  stage: string;
}

export function computeBreadth(rows: DayRow[], date: string): Omit<BreadthRecord, "stage"> {
  const a = rows.filter(isAStock);
  const up = a.filter((r) => r.close > r.prev_close + 1e-9);
  const down = a.filter((r) => r.close < r.prev_close - 1e-9);
  const flat = a.filter((r) => Math.abs(r.close - r.prev_close) <= 1e-9);
  const sum = (l: DayRow[], k: "volume" | "amount") => l.reduce((n, r) => n + r[k], 0);
  const trin = (k: "volume" | "amount") =>
    down.length && sum(down, k) ? round(up.length / down.length / (sum(up, k) / sum(down, k)), 3) : null;
  return {
    date,
    up: up.length,
    down: down.length,
    flat: flat.length,
    red: a.length ? round((up.length / a.length) * 100, 1) : null,
    trin_amt: trin("amount"),
    trin_vol: trin("volume"),
  };
}

/** 下载某日盘后包并幂等写入 series.json。包未发布（收盘后数小时才出）时抛错，调用方不得伪造数据。 */
export async function appendBreadthDay(
  kv: Kv,
  http: HttpGet,
  date: string,
  stage: string,
): Promise<BreadthRecord> {
  const ymd = date.replaceAll("-", "");
  let res;
  try {
    res = await http(URL(ymd), { "User-Agent": "Mozilla/5.0" }, 90000);
  } catch (e) {
    throw new Error(`${ymd} 无盘后包或下载失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 400 || res.bytes.length < 1000) throw new Error(`${ymd} 盘后包未发布（HTTP ${res.status}）`);
  const rows = parseBreadthPackage(res.bytes, ymd);
  if (rows.length < 1000) throw new Error(`${ymd} 盘后包内容异常（仅 ${rows.length} 行）`);
  const rec: BreadthRecord = { ...computeBreadth(rows, date), stage };
  let data: { records?: BreadthRecord[]; caliber?: string } = {};
  try {
    data = JSON.parse(kv.get(KV.breadthSeries) ?? "{}");
  } catch {
    data = {};
  }
  const byDate = new Map((data.records ?? []).map((r) => [r.date, r]));
  const old = byDate.get(date);
  if (old && !stage) rec.stage = old.stage ?? "";
  byDate.set(date, rec);
  data.records = [...byDate.keys()].sort().map((d) => byDate.get(d)!);
  data.caliber ??=
    "沪深A股（沪600/601/603/605/688/689 + 深000/001/002/003/300/301），通达信盘后包，close vs prev_close，平盘单列；TRIN主口径=成交额版，成交量版并列";
  kv.set(KV.breadthSeries, JSON.stringify(data));
  return rec;
}
