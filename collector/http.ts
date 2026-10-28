// 各平台的网络出口：
//   Windows(Electron)：主进程发请求（能自由设置 Referer，不受跨域限制）
//   安卓(Capacitor)：原生 HTTP（同上）
//   浏览器调试：fetch（会被跨域拦住，仅用于看界面，行情拉不到）
import { CapacitorHttp } from "@capacitor/core";
import type { HttpGet } from "./core";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createHttp(platform: "electron" | "android" | "web"): HttpGet {
  if (platform === "electron") {
    return async (url, headers, timeoutMs) => {
      const r = await window.lianbanElectron!.httpGet(url, headers, timeoutMs);
      return { status: r.status, bytes: new Uint8Array(r.bytes) };
    };
  }
  if (platform === "android") {
    return async (url, headers, timeoutMs) => {
      const r = await CapacitorHttp.get({
        url,
        headers,
        responseType: "arraybuffer",
        connectTimeout: Math.min(timeoutMs, 15000),
        readTimeout: timeoutMs,
      });
      const data: unknown = r.data;
      if (typeof data === "string") return { status: r.status, bytes: b64ToBytes(data) };
      return { status: r.status, bytes: new TextEncoder().encode(JSON.stringify(data ?? "")) };
    };
  }
  return async (url, headers, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!/^(referer|user-agent)$/i.test(k)) safe[k] = v; // 浏览器不允许设置这两个头
      }
      const res = await fetch(url, { headers: safe, signal: ctrl.signal });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    } finally {
      clearTimeout(t);
    }
  };
}
