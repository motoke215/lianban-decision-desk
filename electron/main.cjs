// Windows 桌面壳：用 app:// 协议加载打包好的网页，数据库文件存在用户目录。
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const DIST = path.join(__dirname, "..", "dist");
const dbFile = () => path.join(app.getPath("userData"), "lianban.db");
let win = null;
let allowClose = false;

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    title: "连板决策台",
    autoHideMenuBar: true,
    backgroundColor: "#101216",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL("app://local/index.html");
  // 外链一律交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // 关闭前先让页面把数据库写盘，最多等 3 秒
  win.on("close", (e) => {
    if (allowClose || !win) return;
    e.preventDefault();
    const w = win;
    const done = () => {
      allowClose = true;
      w.close();
    };
    const t = setTimeout(done, 3000);
    ipcMain.once("lianban:flushed", () => {
      clearTimeout(t);
      done();
    });
    w.webContents.send("lianban:flush");
  });
  win.on("closed", () => {
    win = null;
  });
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".wasm": "application/wasm",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }[path.extname(file).toLowerCase()];
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      if (!mime) return res;
      const headers = new Headers(res.headers);
      headers.set("content-type", mime);
      return new Response(res.body, { status: res.status, headers });
    });
  });

  // ---- 数据库文件读写（原子替换，写到一半断电也不会毁掉旧文件）----
  ipcMain.handle("lianban:db-load", async () => {
    try {
      return new Uint8Array(await fs.promises.readFile(dbFile()));
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  });
  ipcMain.handle("lianban:db-save", async (_e, bytes) => {
    const file = dbFile();
    const tmp = file + ".tmp";
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, Buffer.from(bytes));
    if (fs.existsSync(file)) {
      try {
        await fs.promises.copyFile(file, file + ".bak");
      } catch {
        /* 备份失败不影响主流程 */
      }
    }
    await fs.promises.rename(tmp, file);
  });
  ipcMain.handle("lianban:db-path", () => dbFile());

  // ---- 保存备份文件（系统"另存为"对话框）----
  ipcMain.handle("lianban:save-file", async (_e, name, text) => {
    const r = await dialog.showSaveDialog(win ?? undefined, {
      defaultPath: path.join(app.getPath("documents"), String(name)),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, String(text), "utf8");
    return r.filePath;
  });

  // ---- 行情请求：在主进程发，可自由设置 Referer，且不受浏览器跨域限制 ----
  ipcMain.handle("lianban:http-get", async (_e, url, headers, timeoutMs) => {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) allowed");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs) || 10000);
    try {
      const res = await fetch(u, { headers, signal: ctrl.signal, redirect: "follow" });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf };
    } finally {
      clearTimeout(timer);
    }
  });

  createWindow();
});

app.on("window-all-closed", () => app.quit());
