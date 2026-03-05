import fs from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { StoreData } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX?.trim() || "itt";
const USERS_TABLE = `${TABLE_PREFIX}-users`;
const GLOBAL_STORE_USER_ID = "__store__";

const DEFAULT_STORE: StoreData = {
  users: [],
  preferences: [],
  progress: [],
  history: []
};

const hasAwsCredentials = Boolean(
  process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()
);

const dynamoClient = hasAwsCredentials
  ? new DynamoDBClient({
      region: process.env.AWS_REGION?.trim() || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    })
  : null;

const docClient = dynamoClient
  ? DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true
      }
    })
  : null;

function useDynamoDb(): boolean {
  return Boolean(docClient);
}

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

async function readStoreFromDynamo(): Promise<StoreData> {
  const response = await docClient!.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId: GLOBAL_STORE_USER_ID }
    })
  );
  return normalizeStore((response.Item as Record<string, unknown> | undefined)?.storeData);
}

async function writeStoreToDynamo(store: StoreData): Promise<void> {
  await docClient!.send(
    new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        userId: GLOBAL_STORE_USER_ID,
        email: "__store__@internal",
        passwordHash: "__internal__",
        createdAt: new Date().toISOString(),
        preferences: {},
        storeData: store
      }
    })
  );
}

export async function readStore(): Promise<StoreData> {
  if (!useDynamoDb()) {
    return readStoreFromFile();
  }
  return readStoreFromDynamo();
}

export async function writeStore(store: StoreData): Promise<void> {
  if (!useDynamoDb()) {
    await writeStoreToFile(store);
    return;
  }
  await writeStoreToDynamo(store);
}

export async function updateStore<T>(mutator: (store: StoreData) => T): Promise<T> {
  if (!useDynamoDb()) {
    const store = await readStoreFromFile();
    const result = mutator(store);
    await writeStoreToFile(store);
    return result;
  }

  const store = await readStoreFromDynamo();
  const result = mutator(store);
  await writeStoreToDynamo(store);
  return result;
}
