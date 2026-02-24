import fs from "node:fs/promises";
import path from "node:path";
import { Pool, PoolClient } from "pg";
import { StoreData } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";
const DB_LOCK_KEY = 1947001;

const DEFAULT_STORE: StoreData = {
  users: [],
  preferences: [],
  progress: [],
  history: []
};

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL
    })
  : null;

let schemaReady: Promise<void> | null = null;

function useDatabase(): boolean {
  return Boolean(pool);
}

async function ensureStoreExists(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch (_error) {
    await fs.writeFile(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), "utf8");
  }
}

async function ensureSchema(): Promise<void> {
  if (!pool) {
    return;
  }
  if (schemaReady) {
    await schemaReady;
    return;
  }

  schemaReady = (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_login_at TEXT NOT NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS preferences (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          interaction_mode TEXT NOT NULL,
          voice_settings JSONB NOT NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS progress (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL,
          level TEXT NOT NULL,
          status TEXT NOT NULL,
          score DOUBLE PRECISION NOT NULL,
          time_spent DOUBLE PRECISION NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, topic_id, level)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS history (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL,
          type TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          meta JSONB NOT NULL
        );
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS history_user_topic_ts_idx ON history(user_id, topic_id, timestamp);`
      );
    } finally {
      client.release();
    }
  })();

  await schemaReady;
}

async function readStoreFromDbClient(client: PoolClient): Promise<StoreData> {
  const [usersResult, preferencesResult, progressResult, historyResult] = await Promise.all([
    client.query(
      "SELECT id, email, password_hash, created_at, last_login_at FROM users ORDER BY created_at ASC"
    ),
    client.query("SELECT user_id, interaction_mode, voice_settings FROM preferences"),
    client.query(
      "SELECT user_id, topic_id, level, status, score, time_spent, updated_at FROM progress ORDER BY updated_at ASC"
    ),
    client.query(
      "SELECT id, user_id, topic_id, type, input, output, timestamp, meta FROM history ORDER BY timestamp ASC"
    )
  ]);

  return {
    users: usersResult.rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      passwordHash: String(row.password_hash),
      createdAt: String(row.created_at),
      lastLoginAt: String(row.last_login_at)
    })),
    preferences: preferencesResult.rows.map((row) => ({
      userId: String(row.user_id),
      interactionMode: String(row.interaction_mode) as "voice" | "click" | "both",
      voiceSettings: row.voice_settings as {
        narrationEnabled: boolean;
        interactionEnabled: boolean;
        navigationEnabled: boolean;
        rate: number;
        voiceName: string;
      }
    })),
    progress: progressResult.rows.map((row) => ({
      userId: String(row.user_id),
      topicId: String(row.topic_id),
      level: String(row.level) as "beginner" | "intermediate" | "advanced",
      status: String(row.status) as "not-started" | "in-progress" | "completed",
      score: Number(row.score),
      timeSpent: Number(row.time_spent),
      updatedAt: String(row.updated_at)
    })),
    history: historyResult.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      topicId: String(row.topic_id),
      type: String(row.type) as "voice" | "text" | "action" | "visual",
      input: String(row.input),
      output: String(row.output),
      timestamp: String(row.timestamp),
      meta: row.meta as Record<string, unknown>
    }))
  };
}

async function writeStoreToDbClient(client: PoolClient, store: StoreData): Promise<void> {
  await client.query("TRUNCATE TABLE history, progress, preferences, users RESTART IDENTITY CASCADE");

  for (const user of store.users) {
    await client.query(
      `INSERT INTO users (id, email, password_hash, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, user.email, user.passwordHash, user.createdAt, user.lastLoginAt]
    );
  }

  for (const preference of store.preferences) {
    await client.query(
      `INSERT INTO preferences (user_id, interaction_mode, voice_settings) VALUES ($1, $2, $3::jsonb)`,
      [preference.userId, preference.interactionMode, JSON.stringify(preference.voiceSettings)]
    );
  }

  for (const progress of store.progress) {
    await client.query(
      `
        INSERT INTO progress (user_id, topic_id, level, status, score, time_spent, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        progress.userId,
        progress.topicId,
        progress.level,
        progress.status,
        progress.score,
        progress.timeSpent,
        progress.updatedAt
      ]
    );
  }

  for (const history of store.history) {
    await client.query(
      `
        INSERT INTO history (id, user_id, topic_id, type, input, output, timestamp, meta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        history.id,
        history.userId,
        history.topicId,
        history.type,
        history.input,
        history.output,
        history.timestamp,
        JSON.stringify(history.meta ?? {})
      ]
    );
  }
}

async function readStoreFromFile(): Promise<StoreData> {
  await ensureStoreExists();
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return JSON.parse(raw) as StoreData;
}

async function writeStoreToFile(store: StoreData): Promise<void> {
  await ensureStoreExists();
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function readStore(): Promise<StoreData> {
  if (!useDatabase()) {
    return readStoreFromFile();
  }
  await ensureSchema();
  const client = await pool!.connect();
  try {
    return await readStoreFromDbClient(client);
  } finally {
    client.release();
  }
}

export async function writeStore(store: StoreData): Promise<void> {
  if (!useDatabase()) {
    await writeStoreToFile(store);
    return;
  }
  await ensureSchema();
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [DB_LOCK_KEY]);
    await writeStoreToDbClient(client, store);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStore<T>(mutator: (store: StoreData) => T): Promise<T> {
  if (!useDatabase()) {
    const store = await readStoreFromFile();
    const result = mutator(store);
    await writeStoreToFile(store);
    return result;
  }

  await ensureSchema();
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [DB_LOCK_KEY]);
    const store = await readStoreFromDbClient(client);
    const result = mutator(store);
    await writeStoreToDbClient(client, store);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
