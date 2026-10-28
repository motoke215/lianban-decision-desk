// 种子/备份：整库 JSON 导出与导入。
// 格式与 space-data.json 完全相同（表名 → 行数组，列名为数据库列名），
// 所以原云端导出的 space-data.json 和本应用导出的备份可以互相导入。
import type { LocalDb } from "./db";

const SKIP = new Set(["__drizzle_migrations", "kv", "sqlite_sequence"]);

function tables(db: LocalDb): string[] {
  const r = db.sqlite.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return (r[0]?.values ?? []).map((v) => String(v[0])).filter((n) => !SKIP.has(n));
}

export function exportAll(db: LocalDb): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables(db)) {
    const stmt = db.sqlite.prepare(`SELECT * FROM "${t}"`);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    out[t] = rows;
  }
  return out;
}

export interface ImportResult {
  tables: number;
  rows: number;
  skippedTables: string[];
}

/** 整库替换：先清空所有业务表，再按 JSON 写入。要么全成功，要么回滚。 */
export function importAll(db: LocalDb, data: unknown): ImportResult {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("备份文件格式不对：顶层应是 {表名: 行数组}");
  }
  const known = new Set(tables(db));
  const entries = Object.entries(data as Record<string, unknown>);
  const useful = entries.filter(([k, v]) => known.has(k) && Array.isArray(v));
  if (useful.length === 0) throw new Error("备份文件里没有可识别的表");
  const skipped = entries.map(([k]) => k).filter((k) => !known.has(k));
  let rows = 0;
  db.sqlite.run("BEGIN");
  try {
    for (const t of known) db.sqlite.run(`DELETE FROM "${t}"`);
    for (const [t, list] of useful) {
      const cols = new Set(
        (db.sqlite.exec(`PRAGMA table_info("${t}")`)[0]?.values ?? []).map((v) =>
          String(v[1]),
        ),
      );
      for (const row of list as Record<string, unknown>[]) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (keys.length === 0) continue;
        const sql = `INSERT INTO "${t}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
        db.sqlite.run(
          sql,
          keys.map((k) => {
            const v = row[k];
            if (v === undefined) return null;
            if (typeof v === "boolean") return v ? 1 : 0;
            if (v !== null && typeof v === "object") return JSON.stringify(v);
            return v as string | number | null;
          }),
        );
        rows++;
      }
    }
    db.sqlite.run("COMMIT");
  } catch (e) {
    db.sqlite.run("ROLLBACK");
    throw e;
  }
  db.schedulePersist();
  return { tables: useful.length, rows, skippedTables: skipped };
}

export function isEmpty(db: LocalDb): boolean {
  return tables(db).every((t) => {
    const r = db.sqlite.exec(`SELECT 1 FROM "${t}" LIMIT 1`);
    return (r[0]?.values.length ?? 0) === 0;
  });
}
