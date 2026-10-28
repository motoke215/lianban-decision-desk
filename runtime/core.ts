// action 执行器：相当于原平台的服务端。
// 请求校验 → 调 handler（带 ctx）→ 响应校验 → 若数据库有改动则安排落盘。
import { privileged } from "./contracts";
import { createKv, type Kv } from "./kv";
import { openDb, type DbStorage, type LocalDb } from "./db";
import { createPrivilegedHandlers } from "./privileged-local";
import type { ActionsModule, Ctx, PrivilegedContract } from "./sdk";
import type { SqlJsStatic } from "sql.js";

export interface Runtime {
  db: LocalDb;
  kv: Kv;
  run(name: string, args: unknown): Promise<unknown>;
}

export async function createRuntime(opts: {
  storage: DbStorage;
  sql: SqlJsStatic;
  actions: ActionsModule;
  onInvalidate?: () => void;
  persistDelayMs?: number;
}): Promise<Runtime> {
  const db = await openDb({
    storage: opts.storage,
    sql: opts.sql,
    persistDelayMs: opts.persistDelayMs,
  });
  const kv = createKv(db);
  const handlers = createPrivilegedHandlers(kv);
  const contractName = new Map<PrivilegedContract, string>(
    Object.entries(privileged).map(([k, v]) => [v as PrivilegedContract, k]),
  );

  const ctx: Ctx = {
    db: () => db.orm as never,
    invalidateQueries: () => opts.onInvalidate?.(),
    async executePrivileged(contract, args) {
      const name = contractName.get(contract);
      const handler = name ? handlers[name as keyof typeof handlers] : undefined;
      if (!handler) throw new Error("未知的采集器契约");
      const parsed = contract.request.parse(args);
      const out = await (handler as (a: unknown) => unknown)(parsed);
      return contract.response.parse(out) as never;
    },
  };

  return {
    db,
    kv,
    async run(name, args) {
      const def = Object.prototype.hasOwnProperty.call(opts.actions, name)
        ? opts.actions[name]
        : undefined;
      if (!def) throw new Error(`未知操作：${name}`);
      const before = db.totalChanges();
      const parsed = def.request.parse(args ?? {});
      const out = await def.handler(ctx, parsed);
      const res = def.response.parse(out);
      if (db.totalChanges() !== before) db.schedulePersist();
      return res;
    },
  };
}
