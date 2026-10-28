// @vitest-environment jsdom
// 界面冒烟测试：用真实导出数据渲染整个 App，逐个切换标签页，确认不崩溃、不报 React 错误。
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import initSqlJs from "sql.js";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

vi.mock("../runtime/boot", async () => {
  const { createRuntime } = await import("../runtime/core");
  const { importAll } = await import("../runtime/seed");
  const { Actions } = await import("../server/actions");
  const sql = await initSqlJs();
  const rt = await createRuntime({
    storage: { load: async () => null, save: async () => {} },
    sql,
    actions: Actions,
  });
  importAll(rt.db, JSON.parse(readFileSync("seed.json", "utf8")));
  return { getRuntime: async () => rt, spaceQueryClient: qc, detectPlatform: () => "web", getRunner: () => null };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("App 冒烟", () => {
  it("渲染并切换所有标签页", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" ").slice(0, 300));
    };
    const { App } = await import("../src/App");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <App />
        </QueryClientProvider>,
      );
    });
    // 等首屏数据
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await sleep(100);
      });
    }
    expect(el.textContent).toContain("今日决策");
    const seen: string[] = [];
    for (const label of ["仓位", "异动", "回测", "交易日志", "复盘", "小黑板", "大钱", "今日决策"]) {
      const btn = Array.from(el.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      );
      expect(btn, `找不到标签 ${label}`).toBeTruthy();
      await act(async () => {
        btn!.click();
        await sleep(400);
      });
      seen.push(`${label}:${el.textContent?.length}`);
    }
    console.error = origError;
    console.log("标签页文本长度", seen.join(" "));
    const real = errors.filter(
      (e) => !/not wrapped in act|ResizeObserver|width\(0\)|The width\(/.test(e),
    );
    expect(real, real.join("\n")).toEqual([]);
    root.unmount();
  }, 60000);
});
