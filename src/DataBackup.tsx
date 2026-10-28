// 数据备份：把本机全部记录导出成 JSON，或从备份文件恢复。
// 手机和电脑各有一份独立数据库，靠这里的「导出 / 导入」手动同步。
// 格式与云端导出的 space-data.json 相同，旧数据也能直接导入。
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { detectPlatform, getRuntime } from "../runtime/boot";
import { exportAll, importAll } from "../runtime/seed";

type Pending = { name: string; text: string; tables: number; rows: number };

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function saveBackup(name: string, text: string): Promise<string> {
  const platform = detectPlatform();
  if (platform === "electron") {
    const p = await window.lianbanElectron!.saveFile(name, text);
    return p ? `已保存到 ${p}` : "已取消";
  }
  if (platform === "android") {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const w = await Filesystem.writeFile({
      path: name,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: name, url: w.uri, dialogTitle: "保存或发送备份文件" });
    return "已生成备份文件，请在弹出的菜单里选择保存位置或发送给自己";
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return "已开始下载";
}

export function DataBackup() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const rt = await getRuntime();
      const data = exportAll(rt.db);
      const rows = Object.values(data).reduce((n, r) => n + r.length, 0);
      const out = await saveBackup(`连板决策台备份-${stamp()}.json`, JSON.stringify(data));
      setMsg(`${out}（${Object.keys(data).length} 张表 / ${rows} 条记录）`);
    } catch (e) {
      setErr(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (file: File | undefined) => {
    setErr("");
    setMsg("");
    setPending(null);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("不是有效的备份文件");
      }
      const tables = Object.entries(parsed as Record<string, unknown>).filter(([, v]) =>
        Array.isArray(v),
      );
      if (tables.length === 0) throw new Error("文件里没有可识别的数据表");
      const rows = tables.reduce((n, [, v]) => n + (v as unknown[]).length, 0);
      setPending({ name: file.name, text, tables: tables.length, rows });
    } catch (e) {
      setErr(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const doImport = async () => {
    if (!pending) return;
    setBusy(true);
    setErr("");
    try {
      const rt = await getRuntime();
      const r = importAll(rt.db, JSON.parse(pending.text));
      await rt.db.persistNow();
      await qc.invalidateQueries();
      setMsg(`导入完成：${r.tables} 张表 / ${r.rows} 条记录，已覆盖本机原有数据`);
      setPending(null);
    } catch (e) {
      setErr(`导入失败，本机数据未改动：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const btn =
    "rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-40";
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-lg font-bold tracking-tight">数据备份与同步</h2>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="mb-3 text-sm text-[var(--dim)]">
          数据只存在这台设备上。想在手机和电脑之间同步，或换设备、防丢失：在一端导出备份文件，到另一端导入。导入会覆盖本机现有数据。
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={busy} onClick={doExport}>
            导出备份
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            导入备份
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void onPick(e.target.files?.[0])}
          />
        </div>
        {pending && (
          <div className="mt-3 rounded-lg bg-[var(--amber-dim)] p-3 text-sm">
            <p className="mb-2 text-[var(--amber)]">
              将用「{pending.name}」（{pending.tables} 张表 / {pending.rows} 条记录）覆盖本机全部数据，无法撤销。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void doImport()}
                className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                确认覆盖
              </button>
              <button type="button" className={btn} onClick={() => setPending(null)}>
                取消
              </button>
            </div>
          </div>
        )}
        {msg && <p className="mt-3 text-sm text-[var(--green)]">{msg}</p>}
        {err && <p className="mt-3 text-sm text-[var(--accent)]">{err}</p>}
      </div>
    </section>
  );
}
