// 键值存储：采集器的 events.jsonl / health.json / pools-*.json 等"文件"存在这里。
// 就是同一个 SQLite 库里的一张 kv 表，所以备份/迁移只有一份数据。
import type { LocalDb } from "./db";

// 采集器每几秒写一次行情，最晚 20 秒落一次盘即可（退出/切后台时会立即落盘）
const KV_PERSIST_MS = 20000;

export interface Kv {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(prefix: string): string[];
}

export function createKv(db: LocalDb): Kv {
  return {
    get(key) {
      const r = db.sqlite.exec("SELECT value FROM kv WHERE key = ?", [key]);
      const v = r[0]?.values[0]?.[0];
      return typeof v === "string" ? v : null;
    },
    set(key, value) {
      db.sqlite.run(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [key, value, Date.now()],
      );
      db.schedulePersist(KV_PERSIST_MS);
    },
    delete(key) {
      db.sqlite.run("DELETE FROM kv WHERE key = ?", [key]);
      db.schedulePersist(KV_PERSIST_MS);
    },
    keys(prefix) {
      const r = db.sqlite.exec(
        "SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key",
        [prefix.length, prefix],
      );
      return (r[0]?.values ?? []).map((row) => String(row[0]));
    },
  };
}

// 约定的键名（与原采集器的文件一一对应）
export const KV = {
  events: "collector/events.jsonl",
  health: "collector/health.json",
  state: "collector/state.json",
  pools: (ymd: string) => `collector/pools-${ymd}.json`,
  ths: (ymd: string) => `collector/ths-${ymd}.json`,
  calendar: (ym: string) => `calendar/${ym}.json`,
  breadthSeries: "breadth/series.json",
  fundflow: (date: string) => `fundflow/${date}`,
  fundflowPrefix: "fundflow/",
  fundflowSummary: "breadth/fundflow_summary.json",
} as const;
