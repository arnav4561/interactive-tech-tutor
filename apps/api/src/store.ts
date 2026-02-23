import fs from "node:fs";
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

function ensureStoreExists(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), "utf8");
  }
}

export function readStore(): StoreData {
  ensureStoreExists();
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  return JSON.parse(raw) as StoreData;
}

export function writeStore(store: StoreData): void {
  ensureStoreExists();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export function updateStore<T>(mutator: (store: StoreData) => T): T {
  const store = readStore();
  const result = mutator(store);
  writeStore(store);
  return result;
}
