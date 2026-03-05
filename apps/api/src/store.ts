import fs from "node:fs/promises";
import path from "node:path";
import { StoreData } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const DEFAULT_STORE: StoreData = {
  users: [],
  preferences: [],
  progress: [],
  history: []
};

function normalizeStore(value: unknown): StoreData {
  const input = value && typeof value === "object" ? (value as Partial<StoreData>) : {};
  return {
    users: Array.isArray(input.users) ? (input.users as StoreData["users"]) : [],
    preferences: Array.isArray(input.preferences) ? (input.preferences as StoreData["preferences"]) : [],
    progress: Array.isArray(input.progress) ? (input.progress as StoreData["progress"]) : [],
    history: Array.isArray(input.history) ? (input.history as StoreData["history"]) : []
  };
}

async function ensureStoreExists(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch (_error) {
    await fs.writeFile(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), "utf8");
  }
}

async function readStoreFromFile(): Promise<StoreData> {
  await ensureStoreExists();
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return normalizeStore(JSON.parse(raw));
}

async function writeStoreToFile(store: StoreData): Promise<void> {
  await ensureStoreExists();
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function readStore(): Promise<StoreData> {
  return readStoreFromFile();
}

export async function writeStore(store: StoreData): Promise<void> {
  await writeStoreToFile(store);
}

export async function updateStore<T>(mutator: (store: StoreData) => T): Promise<T> {
  const store = await readStoreFromFile();
  const result = mutator(store);
  await writeStoreToFile(store);
  return result;
}
