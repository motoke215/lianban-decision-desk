// 本地运行时 SDK：替换原平台的 @hatch/space-sdk。
// 只实现 actions.ts / 契约 / 客户端用到的那一小部分接口，行为与原版一致：
//   defineAction      —— 定义一个带 zod 校验的 action
//   definePrivilegedContracts —— 采集器数据读取契约（本地版由 privileged-local.ts 实现）
//   Ctx               —— ctx.db() / ctx.invalidateQueries() / ctx.executePrivileged()
import type { SQLJsDatabase } from "drizzle-orm/sql-js";
import { z } from "zod";

export { z };

// ---------- privileged contracts ----------

export interface PrivilegedContract<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  request: Req;
  response: Res;
  capabilities?: readonly string[];
  timeoutMs?: number;
}

export function definePrivilegedContracts<
  T extends Record<string, PrivilegedContract>,
>(contracts: T): T {
  return contracts;
}

// ---------- ctx ----------

export interface Ctx {
  // 与原版用法一致：ctx.db<typeof schema>()
  db<TSchema extends Record<string, unknown>>(): SQLJsDatabase<TSchema>;
  invalidateQueries(): void;
  executePrivileged<C extends PrivilegedContract>(
    contract: C,
    args: z.input<C["request"]>,
  ): Promise<z.output<C["response"]>>;
}

// ---------- actions ----------

export interface ActionDef<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  request: Req;
  response: Res;
  /** 该 action 会用到的采集器契约（原平台用它做授权；本地版仅作声明） */
  privileged?: readonly PrivilegedContract[];
  handler: (
    ctx: Ctx,
    args: z.output<Req>,
  ) => Promise<z.input<Res>> | z.input<Res>;
}

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(
  def: ActionDef<Req, Res>,
): ActionDef<Req, Res> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionsModule = Record<string, ActionDef<any, any>>;

// ---------- client-side typing helpers (替代 @hatch/space-sdk/client) ----------

export type ActionClient<A extends ActionsModule> = {
  [K in keyof A]: (
    args: z.input<A[K]["request"]>,
  ) => Promise<z.output<A[K]["response"]>>;
};

export type ApiRequest<
  C extends Record<string, (...a: never[]) => unknown>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (...a: never[]) => unknown>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;
