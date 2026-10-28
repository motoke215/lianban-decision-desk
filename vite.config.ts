import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 相对路径：Electron 的 app:// 协议与 Capacitor 的本地服务都能正确加载
  base: "./",
  resolve: {
    alias: {
      "@hatch/space-sdk/client": r("./runtime/client.ts"),
      "@hatch/space-sdk": r("./runtime/sdk.ts"),
      "@space/privileged": r("./runtime/contracts.ts"),
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
