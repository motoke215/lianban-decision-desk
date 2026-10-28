// 本地数据库：sql.js（SQLite 编译成 WASM）+ drizzle，整库序列化后落盘。
// 落盘位置由 DbStorage 决定：Windows 版写到用户目录文件，安卓版写到应用私有目录，
// 浏览器调试用 IndexedDB。采集器的原始文件也放在同一个库的 kv 表里，一份文件备份即可。
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import type { Database, SqlJsStatic } from "sql.js";
import * as schema from "../server/schema";
import { MIGRATIONS } from "./migrations";

export interface DbStorage {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

export interface LocalDb {
  sqlite: Database;
  orm: SQLJsDatabase<typeof schema>;
  totalChanges(): number;
  /** delayMs 给定时为「最晚多久后落盘」：已有定时器就不再顺延（采集器高频写入用，避免每几秒重写整个库） */
  schedulePersist(delayMs?: number): void;
  persistNow(): Promise<void>;
  /** 用另一份库字节整体替换当前库（导入备份用） */
  replaceWith(bytes: Uint8Array): Promise<void>;
}

const KV_DDL = `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`;

function migrate(sqlite: Database): void {
  const cur = Number(sqlite.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0);
  for (let i = cur; i < MIGRATIONS.length; i++) {
    sqlite.run("BEGIN");
    try {
      for (const stmt of MIGRATIONS[i] ?? []) sqlite.run(stmt);
      sqlite.run(`PRAGMA user_version = ${i + 1}`);
      sqlite.run("COMMIT");
    } catch (e) {
      sqlite.run("ROLLBACK");
      throw e;
    }
  }
  sqlite.run(KV_DDL);
}

export async function openDb(opts: {
  storage: DbStorage;
  sql: SqlJsStatic;
  persistDelayMs?: number;
}): Promise<LocalDb> {
  const { storage, sql } = opts;
  const delay = opts.persistDelayMs ?? 1500;
  let sqlite = new sql.Database((await storage.load()) ?? undefined);
  migrate(sqlite);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();

  const self: LocalDb = {
    get sqlite() {
      return sqlite;
    },
    get orm() {
      return orm;
    },
    totalChanges() {
      return Number(sqlite.exec("SELECT total_changes()")[0]?.values[0]?.[0] ?? 0);
    },
    schedulePersist(delayMs) {
      if (timer && delayMs !== undefined) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void self.persistNow(), delayMs ?? delay);
    },
    persistNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // 串行落盘，避免并发写同一个文件
      saving = saving
        .catch(() => undefined)
        .then(() => storage.save(sqlite.export()));
      return saving;
    },
    async replaceWith(bytes) {
      const next = new sql.Database(bytes);
      migrate(next);
      const old = sqlite;
      sqlite = next;
      orm = drizzle(sqlite, { schema });
      old.close();
      await self.persistNow();
    },
  };
  let orm = drizzle(sqlite, { schema });
  return self;
}
