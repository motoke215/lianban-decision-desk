const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lianbanElectron", {
  dbLoad: () => ipcRenderer.invoke("lianban:db-load"),
  dbSave: (bytes) => ipcRenderer.invoke("lianban:db-save", bytes),
  dbPath: () => ipcRenderer.invoke("lianban:db-path"),
  saveFile: (name, text) => ipcRenderer.invoke("lianban:save-file", name, text),
  httpGet: (url, headers, timeoutMs) =>
    ipcRenderer.invoke("lianban:http-get", url, headers, timeoutMs),
  // 窗口即将关闭：页面先把数据库写盘，再回执
  onFlushRequest: (cb) => {
    ipcRenderer.on("lianban:flush", async () => {
      try {
        await cb();
      } finally {
        ipcRenderer.send("lianban:flushed");
      }
    });
  },
});
