// 落盘适配器：按运行环境选择把 SQLite 文件存在哪。
//   Windows(Electron)：用户目录里的 lianban.db 文件（经主进程读写，用户能看见、能拷贝备份）
//   安卓(Capacitor)：应用私有目录里的 lianban.db
//   浏览器调试：IndexedDB
import type { DbStorage } from "./db";

declare global {
  interface Window {
    lianbanElectron?: {
      dbLoad(): Promise<Uint8Array | null>;
      dbSave(bytes: Uint8Array): Promise<void>;
      httpGet(
        url: string,
        headers: Record<string, string>,
        timeoutMs: number,
      ): Promise<{ status: number; bytes: Uint8Array }>;
      dbPath(): Promise<string>;
      saveFile(name: string, text: string): Promise<string | null>;
      onFlushRequest(cb: () => Promise<void>): void;
    };
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export const electronStorage: DbStorage = {
  async load() {
    const r = await window.lianbanElectron!.dbLoad();
    return r ? new Uint8Array(r) : null;
  },
  async save(bytes) {
    await window.lianbanElectron!.dbSave(bytes);
  },
};

export async function capacitorStorage(): Promise<DbStorage> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const path = "lianban.db";
  return {
    async load() {
      try {
        const r = await Filesystem.readFile({ path, directory: Directory.Data });
        return typeof r.data === "string" ? b64ToBytes(r.data) : null;
      } catch {
        return null; // 首次启动：文件不存在
      }
    },
    async save(bytes) {
      await Filesystem.writeFile({
        path,
        directory: Directory.Data,
        data: bytesToB64(bytes),
      });
    },
  };
}

export function indexedDbStorage(name = "lianban"): DbStorage {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return {
    async load() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const r = db.transaction("files").objectStore("files").get("db");
        r.onsuccess = () => resolve((r.result as Uint8Array | undefined) ?? null);
        r.onerror = () => reject(r.error);
      });
    },
    async save(bytes) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(bytes, "db");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
