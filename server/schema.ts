// 连板决策台 schema — five modules: market days (梯队板), candidates (评分+红灯),
// plans (盘前计划卡), trades (交易日志), settings (本金/风控参数).
//
// All rows are user-entered records. No external market data is stored here.

import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const marketDays = sqliteTable("market_days", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  maxBoard: integer("max_board"), // 最高连板
  limitUpCount: integer("limit_up_count"), // 涨停家数
  limitDownCount: integer("limit_down_count"), // 跌停家数（第一档新增，可空）
  brokenRate: real("broken_rate"), // 炸板率 %
  prevPremiumPct: real("prev_premium_pct"), // 昨涨溢价 %（第一档新增，可空）
  promotionRatePct: real("promotion_rate_pct"), // 连板晋级率 %（第一档新增，可空）
  sealRatePct: real("seal_rate_pct"), // 封板率 %（第一档新增，可空；与炸板率并存，互不换算）
  // 官方阶段定调（第一档新增）：冰点/混沌/发酵/主升/分歧/退潮，空 = 未由统一基准写入
  cycleStage: text("cycle_stage").notNull().default(""),
  maxDrop: integer("max_drop"), // 昨日高标今日跌幅档位编码: -1=红盘/小跌 -2=跌停
  ladderGap: integer("ladder_gap").notNull().default(0), // 1 = 梯队断层
  ebbSignal: integer("ebb_signal").notNull().default(0), // 1 = 退潮信号
  mainThemes: text("main_themes").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const candidates = sqliteTable("candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // 评估日期 YYYY-MM-DD
  name: text("name").notNull(),
  code: text("code").notNull().default(""),
  theme: text("theme").notNull().default(""),
  // 红灯 flags (1 = triggered). Any flag = 一票否决.
  flagClarify: integer("flag_clarify").notNull().default(0), // 澄清/异动公告
  flagTopBreak: integer("flag_top_break").notNull().default(0), // 高标断板+梯队断层
  flagThemeEbb: integer("flag_theme_ebb").notNull().default(0), // 题材集体退潮
  flagExternal: integer("flag_external").notNull().default(0), // 外围大跌传导
  // 五维评分 0-5 each; total = sum * 4 → 0-100
  sTheme: integer("s_theme").notNull().default(0),
  sPosition: integer("s_position").notNull().default(0),
  sSeal: integer("s_seal").notNull().default(0),
  sTurnover: integer("s_turnover").notNull().default(0),
  sFollow: integer("s_follow").notNull().default(0),
  // 竞价字段预留（第一档新增，均可空；本档只进数据模型）
  auctionGainPct: real("auction_gain_pct"), // 竞价涨幅 %
  auctionAmountWan: real("auction_amount_wan"), // 竞价金额（万元）
  auctionVolRatio: real("auction_vol_ratio"), // 竞价量比
  // 竞价验证字段（第二档新增，均可选）：昨日连板天数 + 昨日形态，
  // 与竞价三项一起对照手册预期基线判定 符合/超/不及预期。
  boardDays: integer("board_days"), // 昨日连板天数
  ydayState: text("yday_state").notNull().default(""), // shrink/strong/voldiff/weaklate/broken/spatial，空 = 未标注
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  themes: text("themes").notNull().default(""), // 今日主攻题材
  watchlist: text("watchlist").notNull().default(""), // 只看哪 2-3 只，一行一只
  trigger: text("trigger").notNull().default(""), // 触发条件
  giveUp: text("give_up").notNull().default(""), // 放弃条件
  positionCap: real("position_cap"), // 今日仓位上限 % （可空，默认用裁决值）
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 盘中改计划留痕
export const planChanges = sqliteTable("plan_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // 买入日期 YYYY-MM-DD
  sellDate: text("sell_date"), // 卖出日期，空 = 持仓中
  name: text("name").notNull(),
  code: text("code").notNull().default(""),
  buyPrice: real("buy_price").notNull(),
  sellPrice: real("sell_price"), // 空 = 持仓中
  shares: integer("shares").notNull(),
  buyReason: text("buy_reason").notNull().default(""),
  followedPlan: integer("followed_plan").notNull().default(1), // 1 按计划 / 0 计划外
  // 纪律闭环（第三档新增，均可选）：交易模式 + 计划偏离手动改判。
  // mode: '' 未标注 / 打板 / 半路 / 低吸 / 其他；
  // plannedOverride: '' 自动判定 / 'in' 计划内 / 'out' 计划外（改判优先）。
  mode: text("mode").notNull().default(""),
  plannedOverride: text("planned_override").notNull().default(""),
  sellReason: text("sell_reason").notNull().default(""),
  emotion: text("emotion").notNull().default(""), // 平静/兴奋/焦虑/恐慌/上头
  errorTags: text("error_tags").notNull().default(""), // comma-separated
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 确认推演器状态（第一档新增）：按日期保存三条件判定 + 附加项 + 危险开关。
// cond* 取值：'pass' 通过 / 'fail' 未过 / 'unknown' 未验证。
export const confirmStates = sqliteTable("confirm_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  condPremium: text("cond_premium").notNull().default("unknown"), // 昨涨溢价守 +2%
  condSeal: text("cond_seal").notNull().default("unknown"), // 封板率守 80%
  condLeader: text("cond_leader").notNull().default("unknown"), // 双龙竞价不落入不及预期档
  gapFilled: integer("gap_filled").notNull().default(0), // 4–5 板断层被中位补涨填上
  danger: integer("danger").notNull().default(0), // 任一空间板竞价不及预期（低开）
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 异动临界（第二档新增）：按日期归属的异动观察记录。stockChg / indexChg /
// turnover 存 JSON 数字数组（旧→新，最多 30 日）；dev*/events10/level 等
// 计算指标由服务端在保存时按 price-abnormal-rules 计算并存储，界面只读。
export const abnormalWatches = sqliteTable("abnormal_watches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  code: text("code").notNull().default(""),
  name: text("name").notNull(),
  boardType: text("board_type").notNull().default("main"), // main/chinext/star/st
  stockChg: text("stock_chg").notNull().default("[]"), // JSON number[]
  indexChg: text("index_chg").notNull().default("[]"), // JSON number[]
  turnover: text("turnover"), // JSON number[] | null
  dev3: real("dev3"),
  dev10: real("dev10"),
  dev30: real("dev30"),
  events10: integer("events10"),
  turnoverState: text("turnover_state").notNull().default("nodata"), // triggered/no/nodata
  level: text("level").notNull().default("calm"), // severe/triggered/severeNear/near/calm
  gapPoints: real("gap_points"), // 距普通线点数：正 = 还差，负 = 已越线；null = 数据不足
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 梯队结构（第三档新增）：按日期录入的梯队成员。role 枚举：
// spatial 空间板 / leader1 板块龙一 / leader2 龙二 / supplement 补涨龙 /
// follower 跟风 / middle 中位股 / other 其他。isSpatial = 当日全市场最高板。
// 五个见顶信号（手册第二节）均为布尔，命中数由服务端计算展示。
export const ladderEntries = sqliteTable(
  "ladder_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD
    code: text("code").notNull().default(""),
    name: text("name").notNull(),
    theme: text("theme").notNull().default(""),
    boardDays: integer("board_days").notNull().default(1), // 连板数
    role: text("role").notNull().default("other"),
    isSpatial: integer("is_spatial").notNull().default(0),
    sigBreakVolumeDown: integer("sig_break_volume_down").notNull().default(0), // 断板放量收跌 ≥−5%
    sigMultiOpenLateSeal: integer("sig_multi_open_late_seal").notNull().default(0), // 开板 ≥3 次且终封晚于 14:00
    sigSecondCollapse: integer("sig_second_collapse").notNull().default(0), // 龙二/中位股先跌停、梯队先崩
    sigClarifyDeny: integer("sig_clarify_deny").notNull().default(0), // 澄清/异动公告否认题材
    sigDriveLoss: integer("sig_drive_loss").notNull().default(0), // 龙头封板而板块涨停不增反减
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("ladder_date_code").on(t.date, t.code)],
);

// 盘中异动事件（采集器事件流接入）：只存六类事件的市场事实，由
// syncintradayevents 从采集器 events.jsonl 增量同步或外部整批推送写入；
// (event_ts, code, type) 唯一，重复同步靠唯一键跳过。界面只读。
export const intradayEvents = sqliteTable(
  "intraday_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD，取事件时间戳的日期
    eventTs: text("event_ts").notNull(), // ISO 时间戳字符串（采集器本地时区）
    code: text("code").notNull().default(""),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["first_seal", "broken", "reseal", "seal_drop", "dive", "limit_down_seal"],
    }).notNull(),
    detailJson: text("detail_json").notNull().default("{}"), // 原始 detail 对象 JSON
    factText: text("fact_text").notNull().default(""), // 由 detail 渲染的一句事实描述
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("intraday_ts_code_type").on(t.eventTs, t.code, t.type)],
);

// 大盘冷热小黑板（宽度×TRIN 旁证）：按日期一行，数据来自
// ~/workspace/breadth-trin/series.json 经 syncBreadthFundflow 同步。
// 只读旁证，不进裁决。suction（涨股吸金力）= 1 / trinAmt，服务端计算不落库。
export const breadthRecords = sqliteTable("breadth_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD
  up: integer("up"),
  down: integer("down"),
  flat: integer("flat"),
  redPct: real("red_pct"), // 红盘率 %（100 家里涨了几家）
  trinAmt: real("trin_amt"), // TRIN 成交额版（主口径）
  trinVol: real("trin_vol"), // TRIN 成交量版（并列）
  stage: text("stage").notNull().default(""), // 阶段定调，只抄统一基准
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 大钱去哪了（板块资金流）：按 (日期, 类别, 板块名) 一行，netYuan 为
// 东财主力净流入（大单估算，单位元）。数据来自 breadth-trin 的
// data/fundflow/<日期>.json 每日存档，经 syncBreadthFundflow 同步；
// 窗口汇总一律由自有存档滚动求和，不借东财自带窗口口径。
export const fundflowRecords = sqliteTable(
  "fundflow_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD
    kind: text("kind").notNull(), // industry / concept
    name: text("name").notNull(), // 板块名
    netYuan: real("net_yuan"), // 主力净流入（元），可空
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("fundflow_date_kind_name").on(t.date, t.kind, t.name)],
);

// 盘后对账记录（数据源重规划阶段1新增）：每晚 21:30 对账任务用通达信
// 盘后包自算口径与东财池口径、同花顺涨停池、决策台当日采用口径并列对账，
// 经 savereconciliation 按 date upsert 写入；界面只读展示，不可编辑。
// lbcMismatch / lbcTop / diff / notes 存 JSON 文本，服务端解析后返回。
export const reconciliations = sqliteTable("reconciliations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD 交易日
  status: text("status", { enum: ["一致", "差异已注", "未查得"] })
    .notNull()
    .default("未查得"),
  selfZtAll: integer("self_zt_all"), // 自算涨停·全口径
  selfZtNoSt: integer("self_zt_no_st"), // 自算涨停·不含 ST
  selfZtDesk: integer("self_zt_desk"), // 自算涨停·决策台宇宙
  selfDtDesk: integer("self_dt_desk"), // 自算跌停·决策台宇宙·价格口径
  selfTouchedDesk: integer("self_touched_desk"), // 自算摸板未封·决策台宇宙
  selfSealRateDesk: real("self_seal_rate_desk"), // 自算封板率 %（下限口径）
  emZt: integer("em_zt"), // 东财涨停池
  emZb: integer("em_zb"), // 东财炸板池
  emDt: integer("em_dt"), // 东财跌停池
  emSealRate: real("em_seal_rate"), // 东财封板率 %
  thsZt: integer("ths_zt"), // 同花顺涨停池数
  deskLimitUpCount: integer("desk_limit_up_count"), // 决策台当日采用涨停数（回填）
  deskLimitDownCount: integer("desk_limit_down_count"), // 决策台当日采用跌停数（回填）
  lbcMismatch: text("lbc_mismatch").notNull().default("[]"), // JSON: 自算连板链 vs 东财 lbc 不一致名单
  lbcTop: text("lbc_top").notNull().default("[]"), // JSON: 当日自算连板链前5 {code,name,lbc}
  diff: text("diff").notNull().default("{}"), // JSON: 各口径名单差集
  notes: text("notes").notNull().default("[]"), // JSON: string[] 口径说明
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 竞价回测行（第二档新增）：外部任务按 CSV 列名整行同步进来（payload 存
// 原始 JSON），统计字段从行内抽取。两条轨 auction / leader 严格分开，
// (track, date, code) 唯一，重复同步 upsert 不产生重复行。
export const backtestRows = sqliteTable(
  "backtest_rows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    track: text("track").notNull(), // auction / leader
    date: text("date").notNull(),
    code: text("code").notNull().default(""),
    payload: text("payload").notNull().default("{}"),
    recommended: integer("recommended"), // 1/0/null
    vetoHit: integer("veto_hit"),
    successPick: integer("success_pick"),
    auctionGainPct: real("auction_gain_pct"),
    auctionVolRatio: real("auction_vol_ratio"),
    boardDays: integer("board_days"),
    closedLimit: integer("closed_limit"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("backtest_track_date_code").on(t.track, t.date, t.code)],
);
