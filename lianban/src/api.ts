// 类型化客户端。类型直接来自 server/actions.ts（原有）+ runtime/extra-actions.ts（本地版新增）。
// 本地版：调用不再走网络，而是进入同一页面里的本地运行时（runtime/）。
import type { Actions } from "../server/actions";
import type { ExtraActions } from "../runtime/extra-actions";
import { createActionClient } from "../runtime/client";

export const api = createActionClient<typeof Actions & typeof ExtraActions>();

export type { ApiRequest, ApiResponse } from "../runtime/client";
