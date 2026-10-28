// 交易日历：深交所官方整月日历（思路来自 a-stock-data §12.4），按月缓存到 kv。
// 好处：春节、国庆这类"工作日休市"和周末调休都不会被误判；拿不到日历时退回"周一到周五"规则。
import type { Kv } from "../runtime/kv";
import { KV } from "../runtime/kv";
import type { HttpGet } from "./core";
import { shParts } from "./rules";

const URL_BASE = "https://www.szse.cn/api/report/exchange/onepersistenthour/monthList";
const p2 = (n: number) => String(n).padStart(2, "0");

export class TradingCalendar {
  constructor(
    private kv: Kv,
    private http: HttpGet,
  ) {}

  private load(ym: string): Record<string, boolean> | null {
    try {
      const raw = this.kv.get(KV.calendar(ym));
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
    } catch {
      return null;
    }
  }

  /** 缓存里有该月日历就按日历判；没有就按周一到周五。 */
  isTradingDay(ms: number): boolean {
    const t = shParts(ms);
    const cal = this.load(`${t.y}-${p2(t.m)}`);
    const key = `${t.y}-${p2(t.m)}-${p2(t.d)}`;
    if (cal && key in cal) return cal[key] === true;
    return t.weekday < 5;
  }

  /** 拉取当月和下月（已缓存的跳过）。失败不抛错，继续用周一到周五规则。 */
  async ensure(ms: number): Promise<void> {
    const t = shParts(ms);
    const months: [number, number][] = [
      [t.y, t.m],
      t.m === 12 ? [t.y + 1, 1] : [t.y, t.m + 1],
    ];
    for (const [y, m] of months) {
      const ym = `${y}-${p2(m)}`;
      if (this.load(ym)) continue;
      try {
        const res = await this.http(`${URL_BASE}?month=${y}-${m}`, {
          Referer: "https://www.szse.cn/aboutus/calendar/",
          "User-Agent": "Mozilla/5.0",
        }, 10000);
        if (res.status >= 400) continue;
        const doc = JSON.parse(new TextDecoder("utf-8").decode(res.bytes)) as {
          data?: { jyrq?: string; jybz?: string | number }[];
        };
        const data = doc.data;
        if (!Array.isArray(data) || data.length === 0) continue; // 未发布：不能推断全月休市
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const out: Record<string, boolean> = {};
        for (const rec of data) {
          const flag = String(rec.jybz);
          if (!rec.jyrq || (flag !== "0" && flag !== "1")) throw new Error("bad calendar row");
          out[rec.jyrq] = flag === "1";
        }
        // 必须整月齐全才采信，缺日期说明接口异常
        let complete = Object.keys(out).length === last;
        for (let d = 1; complete && d <= last; d++) {
          if (!(`${y}-${p2(m)}-${p2(d)}` in out)) complete = false;
        }
        if (complete) this.kv.set(KV.calendar(ym), JSON.stringify(out));
      } catch {
        // 日历取不到不影响采集，退回工作日规则
      }
    }
  }
}
