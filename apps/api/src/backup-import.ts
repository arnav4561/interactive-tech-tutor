import fs from "node:fs/promises";
import path from "node:path";
import { writeStore } from "./store.js";
import { StoreData } from "./types.js";

const INVOCATION_CWD = process.env.INIT_CWD?.trim() || process.cwd();

function assertStoreData(value: unknown): asserts value is StoreData {
  if (typeof value !== "object" || value === null) {
    throw new Error("Snapshot must be a JSON object.");
  }

  const candidate = value as Partial<StoreData>;
  if (!Array.isArray(candidate.users)) {
    throw new Error("Snapshot is missing users array.");
  }
  if (!Array.isArray(candidate.preferences)) {
    throw new Error("Snapshot is missing preferences array.");
  }
  if (!Array.isArray(candidate.progress)) {
    throw new Error("Snapshot is missing progress array.");
  }
  if (!Array.isArray(candidate.history)) {
    throw new Error("Snapshot is missing history array.");
  }
}

function resolveInputPath(argPath?: string): string {
  if (!argPath || argPath.trim().length === 0) {
    throw new Error("Usage: npm run backup:import -- <path-to-snapshot.json>");
  }
  return path.isAbsolute(argPath) ? argPath : path.resolve(INVOCATION_CWD, argPath);
}

async function main(): Promise<void> {
  const inputPath = resolveInputPath(process.argv[2]);
  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  assertStoreData(parsed);
  await writeStore(parsed);
  console.log(`Backup restored from ${inputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
