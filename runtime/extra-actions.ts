// 本地版新增的 action（原云端版没有）。与 server/actions.ts 并列注册，不改动原文件。
//
// fillMarketDayFromPools：用采集器的涨停/炸板/跌停/昨涨停池，直接算出「市场日」表单里要手填的数字。
// 口径沿用 a-stock-data §8.3（打板情绪速算），并按决策台的字段定义对齐：
//   涨停家数 = 涨停池家数                 跌停家数 = 跌停池家数        最高连板 = 涨停池最大连板数
//   炸板率   = 炸板 ÷ (涨停 + 炸板)       封板率   = 涨停 ÷ (涨停 + 炸板)   （两者互补，和界面里"由封板率换算"一致）
//   昨涨溢价 = 昨日涨停股今日平均涨幅      连板晋级率 = 昨日涨停中今日仍在涨停池的比例
//   主流题材 = 涨停股的同花顺「涨停原因」词频前三；同花顺没数据时退回东财行业前三
import { privileged } from "./contracts";
import { defineAction, z } from "./sdk";

const nullableNum = z.number().nullable();

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function topWords(words: string[], n: number): string[] {
  const cnt = new Map<string, number>();
  for (const w of words) cnt.set(w, (cnt.get(w) ?? 0) + 1);
  return [...cnt.entries()]
    .sort((a, b) => b[1] - a[1]) // 稳定排序：同频保持首次出现顺序
    .slice(0, n)
    .map(([w]) => w);
}

export const ExtraActions = {
  fillMarketDayFromPools: defineAction({
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({
      available: z.boolean(),
      message: z.string(),
      /** true = 还是盘中数据（收盘前抓的），收盘后再填更准 */
      partial: z.boolean(),
      fetchedAt: z.string().nullable(),
      values: z.object({
        limitUpCount: nullableNum,
        limitDownCount: nullableNum,
        maxBoard: nullableNum,
        brokenRate: nullableNum,
        sealRatePct: nullableNum,
        prevPremiumPct: nullableNum,
        promotionRatePct: nullableNum,
        mainThemes: z.string(),
      }),
      ladder: z.array(z.object({ boards: z.number(), count: z.number() })),
      themeSource: z.enum(["ths", "industry", "none"]),
    }),
    privileged: [privileged.readCollectorIntraday, privileged.readThsReasons],
    async handler(ctx, args) {
      const empty = {
        limitUpCount: null,
        limitDownCount: null,
        maxBoard: null,
        brokenRate: null,
        sealRatePct: null,
        prevPremiumPct: null,
        promotionRatePct: null,
        mainThemes: "",
      };
      const intraday = await ctx.executePrivileged(privileged.readCollectorIntraday, {
        date: args.date,
      });
      const pools = intraday.pools;
      if (!pools || (pools.zt.length === 0 && pools.zb.length === 0)) {
        return {
          available: false,
          message: `采集器还没有 ${args.date} 的涨停数据。请先在交易时段或收盘后让采集器跑一轮。`,
          partial: false,
          fetchedAt: pools?.fetchedAt ?? null,
          values: empty,
          ladder: [],
          themeSource: "none" as const,
        };
      }
      const zt = pools.zt;
      const ztN = zt.length;
      const zbN = pools.zb.length;
      const lbcs = zt.map((r) => r.lbc ?? 1);
      const ladderMap = new Map<number, number>();
      for (const b of lbcs) ladderMap.set(b, (ladderMap.get(b) ?? 0) + 1);
      const ladder = [...ladderMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([boards, count]) => ({ boards, count }));

      const ztCodes = new Set(zt.map((r) => r.code));
      const yz = pools.yzt;
      const pcts = yz.map((r) => r.pct).filter((x): x is number => x != null);
      const promoted = yz.filter((r) => ztCodes.has(r.code)).length;

      // 题材：优先同花顺涨停原因，没有就用东财行业
      const ths = await ctx.executePrivileged(privileged.readThsReasons, { date: args.date });
      const reasonWords = ths.rows
        .filter((r) => ztCodes.has(r.code))
        .flatMap((r) => r.reason.split(/[+＋、，,;；\s]+/))
        .map((w) => w.trim())
        .filter((w) => w && w !== "其他");
      let themes = topWords(reasonWords, 3);
      let themeSource: "ths" | "industry" | "none" = themes.length ? "ths" : "none";
      if (themes.length === 0) {
        themes = topWords(
          zt.map((r) => r.industry.trim()).filter(Boolean),
          3,
        );
        themeSource = themes.length ? "industry" : "none";
      }

      const fetchedAt = pools.fetchedAt;
      const partial =
        fetchedAt != null && fetchedAt.startsWith(args.date) && fetchedAt.slice(11, 16) < "15:00";
      return {
        available: true,
        message: partial
          ? "这是盘中抓到的数据，收盘后再填一次会更准。"
          : yz.length === 0
            ? "已填入。昨日涨停池为空，昨涨溢价和连板晋级率没有算出来，请手填。"
            : "已按采集器数据填入，请核对后保存。",
        partial,
        fetchedAt,
        values: {
          limitUpCount: ztN,
          limitDownCount: pools.dt.length,
          maxBoard: lbcs.length ? Math.max(...lbcs) : null,
          brokenRate: ztN + zbN > 0 ? r1((zbN / (ztN + zbN)) * 100) : null,
          sealRatePct: ztN + zbN > 0 ? r1((ztN / (ztN + zbN)) * 100) : null,
          prevPremiumPct: pcts.length ? r2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
          promotionRatePct: yz.length ? r1((promoted / yz.length) * 100) : null,
          mainThemes: themes.join("、"),
        },
        ladder,
        themeSource,
      };
    },
  }),
};
