// 启动：加载 sql.js → 打开数据库 → 首次启动导入内置种子数据 → 返回运行时。
import { QueryClient } from "@tanstack/react-query";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { Actions } from "../server/actions";
import { createHttp } from "../collector/http";
import { CollectorRunner } from "../collector/runner";
import { ExtraActions } from "./extra-actions";
import seedData from "../seed.json";
import { createRuntime, type Runtime } from "./core";
import { importAll, isEmpty } from "./seed";
import { capacitorStorage, electronStorage, indexedDbStorage } from "./storage";

export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

export type Platform = "electron" | "android" | "web";

export function detectPlatform(): Platform {
  if (typeof window !== "undefined" && window.lianbanElectron) return "electron";
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  if (cap?.isNativePlatform?.()) return "android";
  return "web";
}

let runtimePromise: Promise<Runtime> | null = null;
let runner: CollectorRunner | null = null;

/** 采集器后台调度（界面显示状态/手动刷新用）。运行时启动之前为 null。 */
export function getRunner(): CollectorRunner | null {
  return runner;
}

export function getRuntime(): Promise<Runtime> {
  runtimePromise ??= (async () => {
    const platform = detectPlatform();
    const storage =
      platform === "electron"
        ? electronStorage
        : platform === "android"
          ? await capacitorStorage()
          : indexedDbStorage();
    const sql = await initSqlJs({ locateFile: () => wasmUrl });
    const rt = await createRuntime({
      storage,
      sql,
      actions: { ...Actions, ...ExtraActions },
      onInvalidate: () => void spaceQueryClient.invalidateQueries(),
    });
    if (isEmpty(rt.db)) {
      // 第一次启动：带入内置数据（云端导出的 2 个交易日）
      importAll(rt.db, seedData);
      await rt.db.persistNow();
    }
    // 退出/切后台前立即落盘，避免防抖窗口内的最后几次改动丢失
    const flush = () => void rt.db.persistNow();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
    window.lianbanElectron?.onFlushRequest(() => rt.db.persistNow());
    // 行情采集：Windows 和安卓上自动在后台跑；浏览器调试环境不启动（跨域拉不到行情）
    runner = new CollectorRunner(rt, createHttp(platform));
    if (platform !== "web") runner.start();
    // 请求持久化存储，减少系统清理缓存时误删（浏览器/安卓 WebView）
    void navigator.storage?.persist?.();
    return rt;
  })();
  return runtimePromise;
}
