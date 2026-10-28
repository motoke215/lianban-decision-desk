// 客户端：api.xxx(args) 直接调本地运行时，类型来自 server/actions.ts。
import type { ActionClient, ActionsModule } from "./sdk";
import { getRuntime } from "./boot";

export function createActionClient<A extends ActionsModule>(): ActionClient<A> {
  return new Proxy({} as ActionClient<A>, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return async (args: unknown) => (await getRuntime()).run(prop, args);
    },
  });
}

export type { ApiRequest, ApiResponse } from "./sdk";
export { spaceQueryClient } from "./boot";
