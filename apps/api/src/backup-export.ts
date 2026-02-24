import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStore } from "./store.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVOCATION_CWD = process.env.INIT_CWD?.trim() || process.cwd();

function nowStamp(): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}Z`;
}

function resolveOutputPath(argPath?: string): string {
  if (argPath && argPath.trim().length > 0) {
    return path.isAbsolute(argPath) ? argPath : path.resolve(INVOCATION_CWD, argPath);
  }
  return path.join(API_ROOT, "backups", `store-${nowStamp()}.json`);
}

async function main(): Promise<void> {
  const outputPath = resolveOutputPath(process.argv[2]);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const store = await readStore();
  await fs.writeFile(outputPath, JSON.stringify(store, null, 2), "utf8");
  console.log(`Backup written to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
