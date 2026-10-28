// 把 drizzle/*.sql 打包成 runtime/migrations.ts（浏览器里没有文件系统）。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
const migrations = files.map((f) =>
  readFileSync(`drizzle/${f}`, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean),
);
writeFileSync(
  "runtime/migrations.ts",
  `// 自动生成：npm run gen:migrations（来源 drizzle/*.sql），请勿手改\nexport const MIGRATIONS: string[][] = ${JSON.stringify(migrations, null, 2)};\n`,
);
console.log("migrations:", files.length);
