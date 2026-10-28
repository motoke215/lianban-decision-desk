import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.motoke.lianban",
  appName: "连板决策台",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    backgroundColor: "#101216",
  },
  plugins: {
    // 行情请求走原生 HTTP：可自由设置 Referer，且不受 WebView 跨域限制
    CapacitorHttp: { enabled: true },
  },
};

export default config;
