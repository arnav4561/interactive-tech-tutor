import dotenv from "dotenv";
dotenv.config({ override: false });
import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { authMiddleware, AuthenticatedRequest, createToken, hashPassword } from "./auth.js";
import { LEVELS, PROBLEM_SETS, TOPICS } from "./seed.js";
import { readStore, updateStore } from "./store.js";
import {
  DifficultyLevel,
  InteractionRecord,
  ProblemSet,
  ProgressRecord,
  Topic,
  UserPreferences,
  VoiceSettings
} from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() ?? "";
const GEMINI_BASE_URL = (
  process.env.GEMINI_BASE_URL?.trim() ?? "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/$/, "");
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 30000);
const configuredOrigins = (process.env.FRONTEND_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  ...configuredOrigins
]);
const CACHE_VERSION = process.env.CACHE_VERSION?.trim() || "2";
const SIMULATION_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const SIMULATION_CACHE_SCHEMA_VERSION = `canvas-json-v3::v${CACHE_VERSION}`;
const bedrockRegion = process.env.AWS_BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || "us-west-2";
const bedrockClient = new BedrockRuntimeClient({
  region: bedrockRegion,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  },
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 60000,
    requestTimeout: 60000
  })
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});

const S3_BUCKET = process.env.AWS_S3_BUCKET || "interactive-tech-tutor-cache";
const DYNAMODB_TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX?.trim() || "itt";
const DYNAMODB_USERS_TABLE = `${DYNAMODB_TABLE_PREFIX}-users`;
const DYNAMODB_SESSIONS_TABLE = `${DYNAMODB_TABLE_PREFIX}-sessions`;
const DYNAMODB_SIM_HISTORY_TABLE = `${DYNAMODB_TABLE_PREFIX}-simulation-history`;
const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION?.trim() || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});
const simulationResponseCache = new Map<
  string,
  {
    cachedAt: number;
    payload: {
      topic: Topic;
      problemSets: ProblemSet[];
      openingMessage: string;
      generationSource: "template" | "bedrock";
      explanation_script: string;
      simulation_steps: unknown[];
    };
  }
>();

function normalizeTopicCacheSlug(topicKey: string): string {
  const slug = topicKey
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled-topic";
}

function getSimulationS3CacheKey(topicKey: string): string {
  return `simulations/v${CACHE_VERSION}/${normalizeTopicCacheSlug(topicKey)}.json`;
}

async function clearS3CacheBucket(): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        ContinuationToken: continuationToken
      })
    );
    const keys =
      listed.Contents?.map((item) => item.Key)
        .filter((item): item is string => Boolean(item))
        .map((key) => ({ Key: key })) ?? [];
    if (keys.length > 0) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: S3_BUCKET,
          Delete: {
            Objects: keys,
            Quiet: true
          }
        })
      );
      console.log(`[Cache] Deleted ${keys.length} S3 objects from ${S3_BUCKET}.`);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function initializeCacheState(): Promise<void> {
  simulationResponseCache.clear();
  console.log(`[Cache] Cleared in-memory simulation cache. CACHE_VERSION=${CACHE_VERSION}`);
  try {
    await clearS3CacheBucket();
    console.log(`[Cache] Cleared S3 cache bucket ${S3_BUCKET}. CACHE_VERSION=${CACHE_VERSION}`);
  } catch (error) {
    console.error(`[Cache] Failed to clear S3 cache bucket ${S3_BUCKET}. Continuing startup.`, error);
  }
}

async function initializeDynamoDBTables(): Promise<void> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("DynamoDB is not configured. Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY.");
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ensureTable = async (
    tableName: string,
    keySchema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }>,
    attributeDefinitions: Array<{ AttributeName: string; AttributeType: "S" | "N" | "B" }>
  ) => {
    try {
      await dynamoDbClient.send(new DescribeTableCommand({ TableName: tableName }));
      return;
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name !== "ResourceNotFoundException") {
        throw error;
      }
    }

    await dynamoDbClient.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions
      })
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1500);
      try {
        const description = await dynamoDbClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        if (description.Table?.TableStatus === "ACTIVE") {
          return;
        }
      } catch (_error) {
        // keep polling
      }
    }
    throw new Error(`Timed out waiting for DynamoDB table ${tableName} to become ACTIVE.`);
  };

  await ensureTable(
    DYNAMODB_USERS_TABLE,
    [{ AttributeName: "userId", KeyType: "HASH" }],
    [{ AttributeName: "userId", AttributeType: "S" }]
  );
  await ensureTable(
    DYNAMODB_SESSIONS_TABLE,
    [{ AttributeName: "sessionToken", KeyType: "HASH" }],
    [{ AttributeName: "sessionToken", AttributeType: "S" }]
  );
  await ensureTable(
    DYNAMODB_SIM_HISTORY_TABLE,
    [
      { AttributeName: "userId", KeyType: "HASH" },
      { AttributeName: "timestamp", KeyType: "RANGE" }
    ],
    [
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "timestamp", AttributeType: "S" }
    ]
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS.`));
    }
  })
);
app.use(express.json({ limit: "4mb" }));

function asyncHandler(
  handler: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

async function appendHistorySafely(interaction: InteractionRecord): Promise<void> {
  try {
    await updateStore((store) => {
      store.history.push(interaction);
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "";
    const isMissingUserFk =
      code === "23503" ||
      message.includes("history_user_id_fkey") ||
      message.includes("violates foreign key constraint");
    if (isMissingUserFk) {
      console.warn("[History] Skipping write because user no longer exists in database.");
      return;
    }
    throw error;
  }
}

type BedrockJsonRequestOptions = {
  topicKey?: string;
  useCache?: boolean;
  saveCache?: boolean;
  maxTokens?: number;
  temperature?: number;
};

async function saveSimulationS3Cache(topicKey: string, payload: unknown): Promise<void> {
  const cacheKey = getSimulationS3CacheKey(topicKey);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: cacheKey,
      Body: JSON.stringify(payload),
      ContentType: "application/json"
    })
  );
  console.log(`Cached simulation for topic: ${topicKey}`);
}

async function requestBedrockJson(prompt: string, options: BedrockJsonRequestOptions = {}) {
  const {
    topicKey,
    useCache = true,
    saveCache = true,
    maxTokens = 8000,
    temperature = 0
  } = options;
  const canUseCache = Boolean(topicKey) && useCache;
  const canSaveCache = Boolean(topicKey) && saveCache;

  // Check S3 cache first if topic key provided
  if (canUseCache && topicKey) {
    try {
      const cacheKey = getSimulationS3CacheKey(topicKey);
      const s3Response = await s3Client.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: cacheKey
        })
      );
      const cached = await s3Response.Body?.transformToString();
      if (cached) {
        console.log(`Cache hit for topic: ${topicKey}`);
        return JSON.parse(cached);
      }
    } catch (_error) {
      console.log("No cache found, calling Bedrock...");
    }
  }

  // Call Bedrock
  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens,
      temperature
    }
  });
  const command = new InvokeModelCommand({
    modelId: "us.amazon.nova-pro-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body
  });

  let response;
  try {
    response = await bedrockClient.send(command);
  } catch (error) {
    console.error("[Bedrock invoke failed]", {
      region: bedrockRegion,
      modelId: "us.amazon.nova-pro-v1:0",
      error
    });
    throw error;
  }
  const responseBody = JSON.parse(new TextDecoder().decode(response.body as Uint8Array));
  const text = responseBody.output?.message?.content?.[0]?.text ?? "";
  const clean = String(text).replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  // Save to S3 cache if topic key provided
  if (canSaveCache && topicKey) {
    try {
      await saveSimulationS3Cache(topicKey, parsed);
    } catch (e) {
      console.log("S3 cache save failed, continuing anyway:", e);
    }
  }

  return parsed;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const progressUpdateSchema = z.object({
  topicId: z.string().min(1),
  level: z.enum(["beginner", "intermediate", "advanced"]),
  status: z.enum(["not-started", "in-progress", "completed"]),
  score: z.number().min(0).max(100).default(0),
  timeSpent: z.number().min(0).default(0)
});

const interactionSchema = z.object({
  topicId: z.string().min(1),
  type: z.enum(["voice", "text", "action", "visual"]),
  input: z.string().min(1),
  output: z.string().min(1),
  meta: z.record(z.unknown()).default({})
});

const voiceSettingsSchema = z.object({
  narrationEnabled: z.boolean(),
  interactionEnabled: z.boolean(),
  navigationEnabled: z.boolean(),
  rate: z.number().min(0.5).max(2),
  voiceName: z.string().default("")
});

const preferenceSchema = z.object({
  interactionMode: z.enum(["voice", "click", "both"]),
  voiceSettings: voiceSettingsSchema
});

const simulationGenerateSchema = z.object({
  topic: z.string().min(2).max(120),
  level: z.enum(["beginner", "intermediate", "advanced"]).default("beginner")
});

const vec3Schema = z.object({
  x: z.number().min(-30).max(30),
  y: z.number().min(-30).max(30),
  z: z.number().min(-30).max(30)
});

const simObjectSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(["box", "sphere", "cylinder", "cone", "torus", "plane", "line", "arrow", "text"]),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
  size: vec3Schema,
  position: vec3Schema,
  rotation: vec3Schema.optional(),
  label: z.string().max(80).optional()
});

const simMovementSchema = z.object({
  objectId: z.string().min(1).max(40),
  type: z.enum(["translate", "rotate", "scale", "pulse"]),
  to: vec3Schema.optional(),
  axis: vec3Schema.optional(),
  durationMs: z.number().positive().max(30000).default(2200),
  repeat: z.number().int().min(0).max(20).default(0)
});

const simLabelSchema = z.object({
  text: z.string().min(1).max(180),
  objectId: z.string().min(1).max(40).optional(),
  position: vec3Schema.optional(),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional()
});

const simConnectionSchema = z.object({
  fromId: z.string().min(1).max(40),
  toId: z.string().min(1).max(40),
  type: z.enum(["line", "arrow", "dashed"]).default("line"),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  label: z.string().min(1).max(120).optional()
});

const simMathExpressionSchema = z.object({
  expression: z.string().min(1).max(180),
  variables: z.record(z.number()).default({})
});

const simGraphSchema = z.object({
  type: z.enum(["line", "scatter", "bar"]),
  title: z.string().min(1).max(120),
  x: z.array(z.number()).min(2).max(120),
  y: z.array(z.number()).min(2).max(120)
});

const simStepSchema = z.object({
  step: z.number().int().min(1).max(20),
  concept: z.string().min(3).max(180).optional(),
  objects: z.array(simObjectSchema).min(1).max(24),
  movements: z.array(simMovementSchema).max(40).default([]),
  labels: z.array(simLabelSchema).max(24).default([]),
  connections: z.array(simConnectionSchema).max(40).default([]),
  annotation: z.string().min(8).max(300),
  mathExpressions: z.array(simMathExpressionSchema).max(10).optional(),
  graph: simGraphSchema.optional()
});

const generatedProblemSchema = z.object({
  question: z.string().min(10).max(700),
  choices: z.array(z.string().min(1).max(260)).min(2).max(10),
  answer: z.string().min(1).max(260),
  explanation: z.string().min(10).max(700)
});

const generatedProblemSetSchema = z.object({
  level: z.enum(["beginner", "intermediate", "advanced"]),
  passingScore: z.number().min(60).max(95),
  problems: z.array(generatedProblemSchema).min(1).max(12)
});

const generatedProblemSetsSchema = z.array(generatedProblemSetSchema).min(3).max(12);

const simCanvasAnimationTypeSchema = z.enum([
  "fade_in",
  "fade_out",
  "move",
  "swap",
  "draw",
  "pulse",
  "rotate",
  "scale_up",
  "scale_down",
  "scale",
  "highlight",
  "bounce",
  "follow_path",
  "typewriter",
  "none"
]);

const simCanvasAnimationSchema = z.object({
  type: simCanvasAnimationTypeSchema,
  duration: z.number().int().min(100).max(10000).default(900),
  delay: z.number().int().min(0).max(60000).optional(),
  direction: z.string().min(1).max(80).default("none"),
  represents: z.string().min(3).max(240).default("animation step")
}).passthrough();

const simCanvasElementTypeSchema = z.enum([
  "rectangle",
  "circle",
  "ellipse",
  "triangle",
  "arrow",
  "curved_arrow",
  "curved arrow",
  "line",
  "dashed_line",
  "dashed line",
  "text",
  "path",
  "polygon",
  "grid",
  "axis",
  "plot_point",
  "plot point",
  "wave",
  "pulse",
  "highlight_box",
  "highlight box"
  ,
  "bar",
  "matrix",
  "number_line",
  "table",
  "stack",
  "queue",
  "flowchart_diamond",
  "neural_layer",
  "neural_network",
  "neural network",
  "tree_node"
]);

const simCanvasElementSchema = z.object({
  type: simCanvasElementTypeSchema,
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  x1: z.number().min(0).max(100).optional(),
  y1: z.number().min(0).max(100).optional(),
  x2: z.number().min(0).max(100).optional(),
  y2: z.number().min(0).max(100).optional(),
  cx: z.number().min(0).max(100).optional(),
  cy: z.number().min(0).max(100).optional(),
  width: z.number().min(0).max(100).optional(),
  height: z.number().min(0).max(100).optional(),
  color: z.string().regex(/^#([0-9a-fA-F]{6})$/).optional(),
  label: z.string().min(1).max(180).optional(),
  label_position: z.enum(["above", "below", "left", "right"]).optional(),
  animation: simCanvasAnimationSchema.optional()
}).passthrough();

const simCanvasStepSchema = z.object({
  step: z.number().int().min(1).max(120),
  concept: z.string().min(1).max(220),
  subtitle: z.string().min(1).max(1200),
  duration_ms: z.number().int().min(12000).max(35000).optional(),
  canvas_instructions: z.object({
    elements: z.array(simCanvasElementSchema).min(1).max(240)
  })
});

const llmSimulationSchema = z.object({
  steps: z.array(simCanvasStepSchema).min(1).max(120)
});

type GeminiSimulationPayload = {
  steps: z.infer<typeof simCanvasStepSchema>[];
};

type SimStep = z.infer<typeof simStepSchema>;
type GeminiCanvasStep = z.infer<typeof simCanvasStepSchema>;
type GeminiCanvasElement = z.infer<typeof simCanvasElementSchema>;
type CanvasElementType = z.infer<typeof simCanvasElementTypeSchema>;
type CanvasAnimationType = z.infer<typeof simCanvasAnimationTypeSchema>;
type SimObject = z.infer<typeof simObjectSchema>;
type SimConnection = z.infer<typeof simConnectionSchema>;
type SceneLayout = "pipeline" | "tree" | "layered" | "hub" | "timeline";
type TechDomain =
  | "web"
  | "data"
  | "ml"
  | "network"
  | "systems"
  | "security"
  | "cloud"
  | "algorithms"
  | "hardware"
  | "general";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function detectVisualTheme(input: string): string {
  const topic = input.toLowerCase();
  if (topic.includes("sql") || topic.includes("database") || topic.includes("data")) {
    return "database";
  }
  if (topic.includes("react") || topic.includes("ui") || topic.includes("frontend")) {
    return "ui";
  }
  if (topic.includes("http") || topic.includes("network") || topic.includes("api")) {
    return "network";
  }
  if (topic.includes("ai") || topic.includes("model") || topic.includes("ml")) {
    return "ai";
  }
  return "systems";
}

function narrationDepth(level: DifficultyLevel): string {
  if (level === "beginner") {
    return "fundamental flow";
  }
  if (level === "intermediate") {
    return "key internal mechanisms";
  }
  return "tradeoffs, edge cases, and optimization strategy";
}

function buildGeneratedTopic(rawTopic: string, level: DifficultyLevel): Topic {
  const cleanedTopic = rawTopic.trim();
  const description = `Model-generated simulation for ${cleanedTopic}, focused on ${narrationDepth(level)}.`;
  const narration = [
    `We are simulating ${cleanedTopic} as a step-by-step system.`,
    `First, identify the input and starting state for ${cleanedTopic}.`,
    `Next, observe each transition and how decisions change outcomes in real time.`,
    `Now verify the output, then compare this run against an alternative approach.`,
    `As you drag and scroll, the tutor evaluates your operations and gives corrective feedback.`
  ];
  return {
    id: `custom-${Date.now()}-${slugify(cleanedTopic) || "topic"}`,
    title: cleanedTopic,
    description,
    narration,
    visualTheme: detectVisualTheme(cleanedTopic)
  };
}

function buildGeneratedProblemSets(topic: Topic): ProblemSet[] {
  const title = topic.title;
  return [
    {
      topicId: topic.id,
      level: "beginner",
      passingScore: 70,
      problems: [
        {
          id: `${topic.id}-b-1`,
          question: `Which statement best describes the first step when learning ${title}?`,
          choices: [
            "Define inputs and the initial state",
            "Tune low-level optimizations immediately",
            "Skip system flow and focus only on syntax",
            "Start with final output and ignore transitions"
          ],
          answer: "Define inputs and the initial state",
          explanation: "A clear starting state is required before meaningful simulation analysis."
        }
      ]
    },
    {
      topicId: topic.id,
      level: "intermediate",
      passingScore: 75,
      problems: [
        {
          id: `${topic.id}-i-1`,
          question: `During a simulation of ${title}, what should be tracked at each step?`,
          choices: [
            "Only visual colors",
            "State transitions and decision points",
            "Only execution end time",
            "Unrelated external tools"
          ],
          answer: "State transitions and decision points",
          explanation: "Intermediate understanding depends on seeing why each transition happened."
        }
      ]
    },
    {
      topicId: topic.id,
      level: "advanced",
      passingScore: 80,
      problems: [
        {
          id: `${topic.id}-a-1`,
          question: `What is the best advanced review pattern for ${title}?`,
          choices: [
            "Memorize one path only",
            "Ignore tradeoffs for speed",
            "Compare multiple strategies and justify tradeoffs",
            "Avoid validating outcomes"
          ],
          answer: "Compare multiple strategies and justify tradeoffs",
          explanation: "Advanced mastery requires explicit tradeoff reasoning under different conditions."
        }
      ]
    }
  ];
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (_error) {
    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
    const firstBrace = fenced.indexOf("{");
    const lastBrace = fenced.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Model did not return valid JSON.");
    }
    return JSON.parse(fenced.slice(firstBrace, lastBrace + 1)) as unknown;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toPercent(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(value, 0, 100);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace("%", "").trim());
    if (Number.isFinite(parsed)) {
      return clamp(parsed, 0, 100);
    }
  }
  return clamp(fallback, 0, 100);
}

function toDurationMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(Math.round(value), 100, 10000);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return clamp(Math.round(parsed), 100, 10000);
    }
  }
  return clamp(Math.round(fallback), 100, 10000);
}

const NAMED_COLOR_MAP: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  purple: "#8b5cf6",
  pink: "#ec4899",
  cyan: "#06b6d4",
  white: "#ffffff",
  black: "#111827",
  gray: "#9ca3af",
  grey: "#9ca3af"
};

function normalizeHexColor(value: unknown, fallback: string): string {
  const text = asText(value).toLowerCase();
  if (!text) {
    return fallback;
  }
  if (/^#[0-9a-f]{6}$/.test(text)) {
    return text;
  }
  if (/^#[0-9a-f]{3}$/.test(text)) {
    const expanded = text
      .slice(1)
      .split("")
      .map((char) => `${char}${char}`)
      .join("");
    return `#${expanded}`;
  }
  if (text in NAMED_COLOR_MAP) {
    return NAMED_COLOR_MAP[text];
  }
  return fallback;
}

function normalizeLabelPosition(value: unknown): "above" | "below" | "left" | "right" {
  const normalized = asText(value).toLowerCase();
  if (normalized === "below" || normalized === "left" || normalized === "right") {
    return normalized;
  }
  return "above";
}

const ELEMENT_TYPE_ALIASES: Record<string, CanvasElementType> = {
  rectangle: "rectangle",
  rect: "rectangle",
  box: "rectangle",
  square: "rectangle",
  circle: "circle",
  node: "circle",
  ellipse: "ellipse",
  oval: "ellipse",
  triangle: "triangle",
  arrow: "arrow",
  "curved arrow": "curved_arrow",
  "curved-arrow": "curved_arrow",
  curved_arrow: "curved_arrow",
  line: "line",
  "dashed line": "dashed_line",
  "dashed-line": "dashed_line",
  dashed_line: "dashed_line",
  text: "text",
  label: "text",
  path: "path",
  polygon: "polygon",
  grid: "grid",
  axis: "axis",
  axes: "axis",
  "plot point": "plot_point",
  "plot-point": "plot_point",
  plot_point: "plot_point",
  point: "plot_point",
  wave: "wave",
  pulse: "pulse",
  "highlight box": "highlight_box",
  "highlight-box": "highlight_box",
  highlight_box: "highlight_box",
  bar: "bar",
  matrix: "matrix",
  number_line: "number_line",
  "number line": "number_line",
  table: "table",
  stack: "stack",
  queue: "queue",
  flowchart_diamond: "flowchart_diamond",
  "flowchart diamond": "flowchart_diamond",
  neural_layer: "neural_layer",
  "neural layer": "neural_layer",
  tree_node: "tree_node",
  "tree node": "tree_node"
};

function normalizeElementType(value: unknown): CanvasElementType {
  const normalized = asText(value).toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized in ELEMENT_TYPE_ALIASES) {
    return ELEMENT_TYPE_ALIASES[normalized];
  }
  return "rectangle";
}

const ANIMATION_TYPE_ALIASES: Record<string, CanvasAnimationType> = {
  fade_in: "fade_in",
  fade_out: "fade_out",
  fadein: "fade_in",
  move: "move",
  draw: "draw",
  pulse: "pulse",
  rotate: "rotate",
  spin: "rotate",
  scale_up: "scale_up",
  scale_down: "scale_down",
  scale: "scale",
  highlight: "highlight",
  bounce: "bounce",
  follow_path: "follow_path",
  typewriter: "typewriter",
  none: "none"
};

function normalizeAnimationType(value: unknown): CanvasAnimationType {
  const normalized = asText(value).toLowerCase().replace(/\s+/g, "_");
  if (normalized in ANIMATION_TYPE_ALIASES) {
    return ANIMATION_TYPE_ALIASES[normalized];
  }
  return "none";
}

function defaultElementSize(type: CanvasElementType): { width: number; height: number } {
  if (type === "line" || type === "dashed_line" || type === "arrow" || type === "curved_arrow") {
    return { width: 18, height: 2 };
  }
  if (type === "text") {
    return { width: 24, height: 4 };
  }
  if (type === "axis" || type === "path" || type === "wave") {
    return { width: 26, height: 8 };
  }
  if (type === "grid") {
    return { width: 38, height: 28 };
  }
  if (type === "plot point" || type === "pulse") {
    return { width: 4, height: 4 };
  }
  return { width: 12, height: 10 };
}

function normalizeCanvasElement(
  candidate: unknown,
  index: number,
  fallbackText: string
): GeminiCanvasElement | null {
  if (typeof candidate === "string") {
    const label = candidate.trim().slice(0, 180);
    if (!label) {
      return null;
    }
    return {
      type: "text",
      x: 50,
      y: clamp(20 + index * 8, 8, 92),
      width: 30,
      height: 4,
      color: "#00d4ff",
      label,
      label_position: "above",
      animation: {
        type: "fade_in",
        duration: 800,
        direction: "none",
        represents: fallbackText.slice(0, 240)
      }
    };
  }

  const raw = asObject(candidate);
  if (!raw) {
    return null;
  }

  const type = normalizeElementType(raw.type);
  const sizeDefaults = defaultElementSize(type);
  const label = (
    asText(raw.label) ||
    asText(raw.text) ||
    asText(raw.name) ||
    `${type.replace(/\s+/g, " ")} ${index + 1}`
  )
    .trim()
    .slice(0, 180);
  const rawAnimation = asObject(raw.animation) ?? {};
  const animationType = normalizeAnimationType(rawAnimation.type);
  const animationDirection = asText(rawAnimation.direction) || "none";
  const animationRepresents =
    asText(rawAnimation.represents) ||
    asText(rawAnimation.description) ||
    `${label} appearing to explain ${fallbackText}`.slice(0, 240);
  const passthrough = { ...raw };
  delete passthrough.type;
  delete passthrough.x;
  delete passthrough.y;
  delete passthrough.width;
  delete passthrough.height;
  delete passthrough.color;
  delete passthrough.label;
  delete passthrough.label_position;
  delete passthrough.animation;

  return {
    ...passthrough,
    type,
    x: toPercent(raw.x ?? raw.cx ?? raw.left, 50),
    y: toPercent(raw.y ?? raw.cy ?? raw.top, 50),
    x1: raw.x1 !== undefined ? toPercent(raw.x1, 50) : undefined,
    y1: raw.y1 !== undefined ? toPercent(raw.y1, 50) : undefined,
    x2: raw.x2 !== undefined ? toPercent(raw.x2, 50) : undefined,
    y2: raw.y2 !== undefined ? toPercent(raw.y2, 50) : undefined,
    cx: raw.cx !== undefined ? toPercent(raw.cx, 50) : undefined,
    cy: raw.cy !== undefined ? toPercent(raw.cy, 50) : undefined,
    width: toPercent(raw.width ?? raw.w, sizeDefaults.width),
    height: toPercent(raw.height ?? raw.h, sizeDefaults.height),
    color: normalizeHexColor(raw.color, "#00d4ff"),
    label: label || `Element ${index + 1}`,
    label_position: normalizeLabelPosition(raw.label_position ?? raw.labelPosition),
    animation: {
      ...rawAnimation,
      type: animationType,
      duration: toDurationMs(rawAnimation.duration, 1000),
      direction: animationDirection.slice(0, 80),
      represents: animationRepresents.slice(0, 240)
    }
  };
}

function extractStepCandidates(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const root = asObject(payload);
  if (!root) {
    return [];
  }
  const direct = root.steps ?? root.simulation_steps ?? root.simulationSteps ?? root.data;
  if (Array.isArray(direct)) {
    return direct;
  }
  const directObject = asObject(direct);
  if (directObject && Array.isArray(directObject.steps)) {
    return directObject.steps;
  }
  if (Array.isArray(root.plan)) {
    return root.plan;
  }
  const planObject = asObject(root.plan);
  if (planObject && Array.isArray(planObject.steps)) {
    return planObject.steps;
  }
  if (typeof root.step === "number") {
    return [root];
  }
  return [];
}

function normalizeCanvasStep(candidate: unknown, index: number): GeminiCanvasStep | null {
  const raw = asObject(candidate);
  if (!raw) {
    return null;
  }

  const stepValue = Number.parseInt(asText(raw.step), 10);
  const step = Number.isFinite(stepValue) ? clamp(stepValue, 1, 120) : clamp(index + 1, 1, 120);
  const concept = (asText(raw.concept) || asText(raw.title) || `Step ${step}`).slice(0, 220);
  const subtitle = (
    asText(raw.subtitle) ||
    asText(raw.annotation) ||
    asText(raw.explanation) ||
    `Explaining ${concept}.`
  ).slice(0, 1200);
  const durationRaw = Number(raw.duration_ms ?? raw.durationMs);
  const duration_ms =
    Number.isFinite(durationRaw) && durationRaw >= 12000 && durationRaw <= 35000
      ? Math.round(durationRaw)
      : undefined;

  const canvasInstructions = asObject(raw.canvas_instructions) ?? asObject(raw.canvasInstructions);
  const elementsSource =
    (canvasInstructions && Array.isArray(canvasInstructions.elements) ? canvasInstructions.elements : null) ??
    (Array.isArray(raw.elements) ? raw.elements : null) ??
    (Array.isArray(raw.objects) ? raw.objects : null) ??
    [];

  const elements = elementsSource
    .map((item, itemIndex) => normalizeCanvasElement(item, itemIndex, subtitle))
    .filter((item): item is GeminiCanvasElement => Boolean(item));

  if (elements.length === 0) {
    const fallback = normalizeCanvasElement(
      {
        type: "text",
        x: 50,
        y: 50,
        width: 34,
        height: 6,
        color: "#8b5cf6",
        label: subtitle.slice(0, 120),
        label_position: "above",
        animation: {
          type: "fade_in",
          duration: 900,
          direction: "none",
          represents: subtitle
        }
      },
      0,
      subtitle
    );
    if (fallback) {
      elements.push(fallback);
    }
  }

  return {
    step,
    concept,
    subtitle,
    ...(duration_ms ? { duration_ms } : {}),
    canvas_instructions: {
      elements
    }
  };
}

function treeNodeNumericValue(element: Record<string, unknown>): number | null {
  const candidates = [element.value, element.label, element.text];
  for (const candidate of candidates) {
    const parsed = Number.parseFloat(asText(candidate));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseTreeHintsFromSubtitle(subtitle: string): {
  explicitChildren: Map<number, Set<number>>;
  parentsClaimingTwoChildren: Set<number>;
} {
  const explicitChildren = new Map<number, Set<number>>();
  const parentsClaimingTwoChildren = new Set<number>();
  const addChildHint = (parent: number, child: number) => {
    if (!Number.isFinite(parent) || !Number.isFinite(child) || parent === child) {
      return;
    }
    if (!explicitChildren.has(parent)) {
      explicitChildren.set(parent, new Set<number>());
    }
    explicitChildren.get(parent)?.add(child);
  };

  let match: RegExpExecArray | null = null;
  const childrenOfPattern = /children\s+of\s+(-?\d+(?:\.\d+)?)\s+are\s+(-?\d+(?:\.\d+)?)\s*(?:,|and)\s*(-?\d+(?:\.\d+)?)/gi;
  while ((match = childrenOfPattern.exec(subtitle)) !== null) {
    const parent = Number.parseFloat(match[1]);
    const left = Number.parseFloat(match[2]);
    const right = Number.parseFloat(match[3]);
    if (Number.isFinite(parent)) {
      parentsClaimingTwoChildren.add(parent);
    }
    addChildHint(parent, left);
    addChildHint(parent, right);
  }

  const twoChildrenPattern = /(?:node\s+)?(-?\d+(?:\.\d+)?)\s+has\s+two\s+children(?:\s*[:\-]?\s*(-?\d+(?:\.\d+)?)\s*(?:,|and)\s*(-?\d+(?:\.\d+)?))?/gi;
  while ((match = twoChildrenPattern.exec(subtitle)) !== null) {
    const parent = Number.parseFloat(match[1]);
    if (Number.isFinite(parent)) {
      parentsClaimingTwoChildren.add(parent);
    }
    if (match[2] && match[3]) {
      addChildHint(parent, Number.parseFloat(match[2]));
      addChildHint(parent, Number.parseFloat(match[3]));
    }
  }

  const sideChildPattern = /(?:left|right)\s+child\s+of\s+(-?\d+(?:\.\d+)?)\s+is\s+(-?\d+(?:\.\d+)?)/gi;
  while ((match = sideChildPattern.exec(subtitle)) !== null) {
    addChildHint(Number.parseFloat(match[1]), Number.parseFloat(match[2]));
  }

  return { explicitChildren, parentsClaimingTwoChildren };
}

function ensureTreeNodeElement(
  treeElements: Array<Record<string, unknown>>,
  value: number,
  parentValue: number | null
): Record<string, unknown> {
  const existing = treeElements.find((element) => treeNodeNumericValue(element) === value);
  if (existing) {
    if (parentValue !== null && parentValue !== value) {
      existing.parent_value = parentValue;
    }
    if (!asText(existing.label)) {
      existing.label = String(value);
    }
    if (treeNodeNumericValue(existing) === null) {
      existing.value = value;
    }
    return existing;
  }

  const node: Record<string, unknown> = {
    type: "tree_node",
    value,
    label: String(value),
    x: 50,
    y: 50,
    width: 10,
    height: 10,
    color: "#4A90E2",
    label_position: "above",
    parent_value: parentValue
  };
  treeElements.push(node);
  return node;
}

function validateBstByParentLinks(treeElements: Array<Record<string, unknown>>): boolean {
  const nodeByValue = new Map<number, { value: number; left: number | null; right: number | null }>();
  for (const element of treeElements) {
    const value = treeNodeNumericValue(element);
    if (value === null || nodeByValue.has(value)) {
      continue;
    }
    nodeByValue.set(value, { value, left: null, right: null });
  }
  if (nodeByValue.size === 0) {
    return true;
  }

  const hasParent = new Set<number>();
  for (const element of treeElements) {
    const value = treeNodeNumericValue(element);
    if (value === null) {
      continue;
    }
    const parentValueParsed = Number.parseFloat(asText(element.parent_value));
    if (!Number.isFinite(parentValueParsed)) {
      continue;
    }
    const parentValue = parentValueParsed;
    const parent = nodeByValue.get(parentValue);
    const node = nodeByValue.get(value);
    if (!parent || !node || value === parentValue) {
      return false;
    }
    if (value < parentValue) {
      if (parent.left !== null && parent.left !== value) {
        return false;
      }
      parent.left = value;
    } else if (value > parentValue) {
      if (parent.right !== null && parent.right !== value) {
        return false;
      }
      parent.right = value;
    } else {
      return false;
    }
    hasParent.add(value);
  }

  const roots = Array.from(nodeByValue.keys()).filter((value) => !hasParent.has(value));
  if (roots.length === 0) {
    return false;
  }

  const visited = new Set<number>();
  const dfs = (value: number, min: number, max: number): boolean => {
    if (!Number.isFinite(value) || value <= min || value >= max) {
      return false;
    }
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);
    const node = nodeByValue.get(value);
    if (!node) {
      return false;
    }
    if (node.left !== null && !dfs(node.left, min, value)) {
      return false;
    }
    if (node.right !== null && !dfs(node.right, value, max)) {
      return false;
    }
    return true;
  };

  for (const root of roots) {
    if (!dfs(root, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)) {
      return false;
    }
  }
  return true;
}

function rebuildBstParentLinks(treeElements: Array<Record<string, unknown>>): void {
  const orderedValues: number[] = [];
  const elementByValue = new Map<number, Record<string, unknown>>();
  for (const element of treeElements) {
    const value = treeNodeNumericValue(element);
    if (value === null || elementByValue.has(value)) {
      continue;
    }
    orderedValues.push(value);
    elementByValue.set(value, element);
  }
  if (orderedValues.length === 0) {
    return;
  }

  type BstNode = { value: number; left: BstNode | null; right: BstNode | null };
  let root: BstNode | null = null;
  const parentByValue = new Map<number, number | null>();

  for (const value of orderedValues) {
    if (!root) {
      root = { value, left: null, right: null };
      parentByValue.set(value, null);
      continue;
    }

    let current: BstNode | null = root;
    let parent: BstNode | null = null;
    while (current) {
      parent = current;
      if (value < current.value) {
        current = current.left;
      } else if (value > current.value) {
        current = current.right;
      } else {
        parent = null;
        break;
      }
    }

    if (!parent) {
      continue;
    }
    const nextNode: BstNode = { value, left: null, right: null };
    if (value < parent.value) {
      parent.left = nextNode;
    } else {
      parent.right = nextNode;
    }
    parentByValue.set(value, parent.value);
  }

  for (const [value, element] of elementByValue.entries()) {
    element.value = value;
    element.label = asText(element.label) || String(value);
    element.parent_value = parentByValue.get(value) ?? null;
  }
}

function isBstTopic(topic: string): boolean {
  return /(binary search tree|\bbst\b)/i.test(topic);
}

function replaceBstPlaceholderTextWithTreeNodes(step: GeminiCanvasStep): GeminiCanvasStep {
  const elements = step.canvas_instructions.elements.map((element) => ({ ...(element as Record<string, unknown>) }));
  const usedValues = new Set<number>();
  for (const element of elements) {
    const type = asText(element.type).toLowerCase().replace(/\s+/g, "_");
    if (type !== "tree_node") {
      continue;
    }
    const value = treeNodeNumericValue(element);
    if (value !== null) {
      usedValues.add(value);
    }
  }

  let fallbackValue = usedValues.size > 0 ? Math.max(...Array.from(usedValues)) + 1 : 10;
  const nextFallbackValue = (): number => {
    while (usedValues.has(fallbackValue)) {
      fallbackValue += 1;
    }
    const chosen = fallbackValue;
    usedValues.add(chosen);
    fallbackValue += 1;
    return chosen;
  };

  const normalizedElements = elements.map((element) => {
    const type = asText(element.type).toLowerCase().replace(/\s+/g, "_");
    const label = asText(element.label) || asText(element.text);
    if (type !== "text" || !/subtree|left child|right child|root node/i.test(label)) {
      return element;
    }

    const numericMatch = label.match(/-?\d+(?:\.\d+)?/);
    const parsedValue = numericMatch ? Number.parseFloat(numericMatch[0]) : Number.NaN;
    let value = Number.isFinite(parsedValue) ? parsedValue : nextFallbackValue();
    if (!Number.isFinite(value)) {
      value = nextFallbackValue();
    }
    if (usedValues.has(value)) {
      value = nextFallbackValue();
    } else {
      usedValues.add(value);
    }

    const labelLower = label.toLowerCase();
    const xFromElement = Number(element.x);
    const yFromElement = Number(element.y);
    const inferredX = labelLower.includes("left")
      ? 25
      : labelLower.includes("right")
        ? 75
        : labelLower.includes("root")
          ? 50
          : 50;
    const inferredY = labelLower.includes("root") ? 12 : 30;

    return {
      ...element,
      type: "tree_node",
      value,
      label: String(value),
      x: Number.isFinite(xFromElement) ? clamp(xFromElement, 0, 100) : inferredX,
      y: Number.isFinite(yFromElement) ? clamp(yFromElement, 0, 100) : inferredY,
      color: normalizeHexColor(asText(element.color), "#4A90E2"),
      parent_value: labelLower.includes("root") ? null : element.parent_value ?? null
    } as Record<string, unknown>;
  });

  return {
    ...step,
    canvas_instructions: {
      elements: normalizedElements as GeminiCanvasElement[]
    }
  };
}

function repairBstStep(step: GeminiCanvasStep): GeminiCanvasStep {
  const normalizedStep = replaceBstPlaceholderTextWithTreeNodes(step);
  const elements = normalizedStep.canvas_instructions.elements.map((element) => ({ ...(element as Record<string, unknown>) }));
  const treeElements = elements.filter(
    (element) => asText(element.type).toLowerCase().replace(/\s+/g, "_") === "tree_node"
  );
  if (treeElements.length === 0) {
    return step;
  }

  const { explicitChildren, parentsClaimingTwoChildren } = parseTreeHintsFromSubtitle(step.subtitle);
  for (const [parentValue, childValues] of explicitChildren.entries()) {
    ensureTreeNodeElement(treeElements, parentValue, null);
    for (const childValue of childValues) {
      ensureTreeNodeElement(treeElements, childValue, parentValue);
    }
  }

  rebuildBstParentLinks(treeElements);

  for (const [parentValue, childValues] of explicitChildren.entries()) {
    for (const childValue of childValues) {
      const child = treeElements.find((element) => treeNodeNumericValue(element) === childValue);
      if (child) {
        const previousParent = Number.parseFloat(asText(child.parent_value));
        child.parent_value = parentValue;
        if (!validateBstByParentLinks(treeElements)) {
          child.parent_value = Number.isFinite(previousParent) ? previousParent : null;
        }
      }
    }
  }

  for (const parentValue of parentsClaimingTwoChildren.values()) {
    const currentChildren = treeElements.filter(
      (element) => Number.parseFloat(asText(element.parent_value)) === parentValue
    );
    if (currentChildren.length >= 2) {
      continue;
    }
    const candidateValues = treeElements
      .map((element) => treeNodeNumericValue(element))
      .filter((value): value is number => value !== null && value !== parentValue)
      .sort((a, b) => a - b);
    const leftCandidate = [...candidateValues].reverse().find((value) => value < parentValue) ?? null;
    const rightCandidate = candidateValues.find((value) => value > parentValue) ?? null;
    for (const candidate of [leftCandidate, rightCandidate]) {
      if (candidate === null) {
        continue;
      }
      const child = ensureTreeNodeElement(treeElements, candidate, parentValue);
      const previousParent = Number.parseFloat(asText(child.parent_value));
      child.parent_value = parentValue;
      if (!validateBstByParentLinks(treeElements)) {
        child.parent_value = Number.isFinite(previousParent) ? previousParent : null;
      }
    }
  }

  if (!validateBstByParentLinks(treeElements)) {
    rebuildBstParentLinks(treeElements);
  }

  return {
    ...step,
    canvas_instructions: {
      elements: elements as GeminiCanvasElement[]
    }
  };
}

function validateAndRepairBstSteps(steps: GeminiCanvasStep[]): GeminiCanvasStep[] {
  return steps.map((step) => repairBstStep(step));
}

function normalizeNarration(lines: string[]): string[] {
  return lines
    .map((line) => line.trim().slice(0, 260))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

function textHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const DOMAIN_TERMS: Record<TechDomain, string[]> = {
  web: ["browser", "request", "router", "api", "state", "render", "component", "response"],
  data: ["dataset", "table", "query", "index", "join", "transaction", "schema", "warehouse"],
  ml: ["feature", "model", "loss", "gradient", "training", "inference", "evaluation", "prediction"],
  network: ["packet", "latency", "protocol", "tcp", "dns", "gateway", "routing", "bandwidth"],
  systems: ["process", "thread", "memory", "queue", "scheduler", "throughput", "state", "resource"],
  security: ["encryption", "auth", "token", "key", "certificate", "integrity", "threat", "policy"],
  cloud: ["container", "cluster", "deployment", "scaling", "pipeline", "observability", "service", "node"],
  algorithms: ["input", "loop", "branch", "complexity", "optimize", "state", "output", "invariant"],
  hardware: ["cpu", "cache", "register", "bus", "clock", "instruction", "memory", "pipeline"],
  general: ["input", "process", "state", "decision", "feedback", "output", "validation", "result"]
};

function detectTechDomain(topicTitle: string): TechDomain {
  const title = topicTitle.toLowerCase();
  if (/(react|frontend|backend|api|http|javascript|typescript|html|css|web|dom)/.test(title)) {
    return "web";
  }
  if (/(database|sql|nosql|etl|warehouse|analytics|regression|statistics|query|data)/.test(title)) {
    return "data";
  }
  if (/(machine learning|deep learning|neural|llm|model training|classification|clustering|ai)/.test(title)) {
    return "ml";
  }
  if (/(network|tcp|udp|dns|routing|switch|firewall|protocol|latency)/.test(title)) {
    return "network";
  }
  if (/(operating system|os |kernel|process|thread|scheduling|concurrency|distributed)/.test(title)) {
    return "systems";
  }
  if (/(security|encryption|oauth|jwt|authentication|authorization|cryptography|xss|csrf)/.test(title)) {
    return "security";
  }
  if (/(cloud|kubernetes|docker|devops|cicd|deployment|autoscaling|microservice)/.test(title)) {
    return "cloud";
  }
  if (/(algorithm|graph algorithm|sorting|dynamic programming|tree|hash|search|complexity)/.test(title)) {
    return "algorithms";
  }
  if (/(cpu|gpu|computer architecture|cache|assembly|register|instruction|hardware)/.test(title)) {
    return "hardware";
  }
  return "general";
}

function topicKeywords(topic: Topic, domain?: TechDomain): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "along",
    "among",
    "because",
    "between",
    "build",
    "from",
    "into",
    "that",
    "this",
    "with",
    "using",
    "what",
    "where",
    "when",
    "which",
    "while",
    "would",
    "could",
    "should"
  ]);

  const raw = `${topic.title} ${topic.description}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  const unique = Array.from(new Set(raw)).slice(0, 10);
  const domainHints = domain ? DOMAIN_TERMS[domain].slice(0, 4) : [];
  const withHints = Array.from(new Set([...unique, ...domainHints]));
  if (withHints.length >= 4) {
    return withHints.slice(0, 10);
  }
  return [...withHints, "input", "process", "validate", "output"].slice(0, 8);
}

function objectIdFromLabel(label: string, index: number): string {
  const id = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return id || `node-${index + 1}`;
}

function layoutPositions(layout: SceneLayout, count: number): Array<{ x: number; y: number; z: number }> {
  const safeCount = Math.max(2, count);
  if (layout === "pipeline" || layout === "timeline") {
    const startX = -6;
    const endX = 6;
    return Array.from({ length: safeCount }).map((_, index) => ({
      x: Number((startX + ((endX - startX) * index) / Math.max(1, safeCount - 1)).toFixed(2)),
      y: layout === "timeline" ? -0.3 : Number((Math.sin(index * 0.7) * 0.8).toFixed(2)),
      z: Number((((index % 2) - 0.5) * 0.45).toFixed(2))
    }));
  }

  if (layout === "layered") {
    return Array.from({ length: safeCount }).map((_, index) => ({
      x: Number((((index % 2 === 0 ? -1 : 1) * (1.5 + (index % 3) * 0.9))).toFixed(2)),
      y: Number((3.5 - index * 1.2).toFixed(2)),
      z: Number((((index % 3) - 1) * 0.4).toFixed(2))
    }));
  }

  if (layout === "hub") {
    return Array.from({ length: safeCount }).map((_, index) => {
      if (index === 0) {
        return { x: 0, y: 0, z: 0 };
      }
      const angle = ((index - 1) / Math.max(1, safeCount - 1)) * Math.PI * 2;
      return {
        x: Number((Math.cos(angle) * 4.2).toFixed(2)),
        y: Number((Math.sin(angle) * 2.5).toFixed(2)),
        z: Number((((index % 2) - 0.5) * 0.55).toFixed(2))
      };
    });
  }

  const root = [{ x: 0, y: 3.6, z: 0 }];
  const remaining = safeCount - 1;
  const midCount = Math.max(2, Math.ceil(remaining / 2));
  const lastCount = Math.max(1, remaining - midCount);
  const middle = Array.from({ length: midCount }).map((_, index) => ({
    x: Number((-3.8 + (7.6 * index) / Math.max(1, midCount - 1)).toFixed(2)),
    y: 1.1,
    z: Number((((index % 2) - 0.5) * 0.35).toFixed(2))
  }));
  const bottom = Array.from({ length: lastCount }).map((_, index) => ({
    x: Number((-4.8 + (9.6 * index) / Math.max(1, lastCount - 1)).toFixed(2)),
    y: -1.7,
    z: Number((((index % 2) - 0.5) * 0.35).toFixed(2))
  }));
  return [...root, ...middle, ...bottom].slice(0, safeCount);
}

function pickObjectType(label: string, index: number): SimObject["type"] {
  const value = label.toLowerCase();
  if (/(queue|table|cache|database|index|memory|registry|store)/.test(value)) {
    return "box";
  }
  if (/(request|response|packet|token|event|message|signal|sample)/.test(value)) {
    return "sphere";
  }
  if (/(service|server|model|agent|process|node|worker|controller)/.test(value)) {
    return "cylinder";
  }
  if (/(decision|branch|classifier|router)/.test(value)) {
    return "cone";
  }
  if (/(loop|cycle|feedback)/.test(value)) {
    return "torus";
  }
  if (/(rule|policy|equation|formula|constraint)/.test(value)) {
    return "plane";
  }
  const rotation = ["box", "sphere", "cylinder", "cone", "torus"] as const;
  return rotation[index % rotation.length];
}

function buildConnectionsFromLayout(layout: SceneLayout, objects: SimObject[]): SimConnection[] {
  if (objects.length < 2) {
    return [];
  }

  if (layout === "hub") {
    const center = objects[0].id;
    return objects.slice(1).map((item) => ({
      fromId: center,
      toId: item.id,
      type: "line",
      color: "#5ca9ff"
    }));
  }

  if (layout === "tree") {
    const links: SimConnection[] = [];
    for (let index = 0; index < objects.length - 1; index += 1) {
      const parentIndex = Math.floor(index / 2);
      if (parentIndex < index) {
        links.push({
          fromId: objects[parentIndex].id,
          toId: objects[index + 1].id,
          type: "line",
          color: "#7cb8ff"
        });
      }
    }
    return links;
  }

  return objects.slice(0, -1).map((item, index) => ({
    fromId: item.id,
    toId: objects[index + 1].id,
    type: layout === "timeline" ? "arrow" : "line",
    color: "#6fb6ff"
  }));
}

function stageBlueprints(
  domain: TechDomain,
  topicTitle: string,
  keywords: string[],
  mathTopic: boolean,
  graphTopic: boolean
): Array<{
  concept: string;
  annotation: string;
  labels: string[];
  layout: SceneLayout;
  graph?: z.infer<typeof simGraphSchema>;
  mathExpressions?: z.infer<typeof simMathExpressionSchema>[];
}> {
  const key = (index: number, fallback: string) => keywords[index] ?? fallback;
  const topicShort = topicTitle.slice(0, 42);
  const regressionLike = /(regression|forecast|trend|signal|statistics)/i.test(topicTitle);

  if (domain === "ml") {
    return [
      {
        concept: "Problem framing and dataset",
        annotation: `Establish ${topicShort} objective, data source, and target variable.`,
        labels: ["Use Case", "Dataset", "Features", "Target"],
        layout: "pipeline"
      },
      {
        concept: "Data preparation",
        annotation: "Clean, normalize, and split data into training and validation subsets.",
        labels: ["Raw Data", "Cleaning", "Normalization", "Train Split", "Validation Split"],
        layout: "pipeline"
      },
      {
        concept: "Model mapping",
        annotation: "Map features to predictions through the model hypothesis.",
        labels: ["Feature Vector", "Model", "Prediction", "Residual"],
        layout: "hub",
        graph: graphTopic || regressionLike
          ? {
              type: "scatter",
              title: `${topicShort} data fit`,
              x: [1, 2, 3, 4, 5, 6],
              y: [1.2, 2.1, 2.9, 4.2, 5.1, 5.8]
            }
          : undefined
      },
      {
        concept: "Optimization loop",
        annotation: "Reduce loss by updating parameters over iterative optimization steps.",
        labels: ["Prediction", "Loss", "Gradient", "Optimizer", "Updated Weights"],
        layout: "timeline",
        mathExpressions: mathTopic
          ? [
              {
                expression: "y_hat = b0 + b1 * x",
                variables: { b0: 0.8, b1: 1.05, x: 4 } as Record<string, number>
              },
              {
                expression: "loss = (y - y_hat)^2",
                variables: { y: 5.1, y_hat: 5.0 } as Record<string, number>
              }
            ]
          : undefined
      },
      {
        concept: "Evaluation",
        annotation: "Measure quality using validation metrics and error diagnostics.",
        labels: ["Validation Data", "Metric Engine", "Error Analysis", "Model Report"],
        layout: "layered",
        graph: graphTopic
          ? {
              type: "line",
              title: `${topicShort} metric trend`,
              x: [1, 2, 3, 4, 5, 6],
              y: [0.92, 0.89, 0.84, 0.79, 0.75, 0.72]
            }
          : undefined
      },
      {
        concept: "Inference and deployment",
        annotation: "Serve predictions in production with monitoring and feedback loops.",
        labels: ["New Input", "Inference API", "Prediction Output", "Monitoring", "Feedback Store"],
        layout: "pipeline"
      }
    ];
  }

  if (domain === "data") {
    return [
      {
        concept: "Data model and entities",
        annotation: `Define core entities and relations required for ${topicShort}.`,
        labels: ["Source", "Schema", "Entity", "Relation"],
        layout: "tree"
      },
      {
        concept: "Ingestion and transformation",
        annotation: "Ingest data and transform it into analysis-ready structure.",
        labels: ["Extractor", "Transformer", "Validator", "Warehouse"],
        layout: "pipeline"
      },
      {
        concept: "Query execution",
        annotation: "Parse, optimize, and execute queries across data structures.",
        labels: ["Query", "Planner", "Index", "Executor", "Result Set"],
        layout: "timeline",
        mathExpressions: mathTopic
          ? [
              {
                expression: "latency = rows / throughput",
                variables: { rows: 120000, throughput: 6000 } as Record<string, number>
              }
            ]
          : undefined
      },
      {
        concept: "Aggregation and insight",
        annotation: "Aggregate dimensions and metrics to surface actionable signals.",
        labels: ["Dimension", "Metric", "Aggregation", "Insight"],
        layout: "hub",
        graph: graphTopic
          ? {
              type: "bar",
              title: `${topicShort} grouped metric`,
              x: [1, 2, 3, 4],
              y: [16, 22, 19, 31]
            }
          : undefined
      },
      {
        concept: "Quality and consistency",
        annotation: "Validate constraints, null handling, and consistency guarantees.",
        labels: ["Rules", "Quality Checks", "Anomaly Flag", "Approved Output"],
        layout: "layered"
      },
      {
        concept: "Decision support",
        annotation: "Deliver a final data product with interpretation-ready output.",
        labels: ["Dashboard", "Decision Node", "Recommendation", "Action"],
        layout: "pipeline"
      }
    ];
  }

  const common = [
    {
      concept: `Foundations of ${topicShort}`,
      annotation: `Establish the baseline components and assumptions for ${topicShort}.`,
      labels: [key(0, "input"), key(1, "state"), key(2, "component"), key(3, "goal")],
      layout: "tree" as SceneLayout
    },
    {
      concept: "Input and signal flow",
      annotation: "Trace how signals move through the system and trigger transformations.",
      labels: [key(0, "source"), key(4, "router"), key(5, "processor"), key(6, "output")],
      layout: "pipeline" as SceneLayout
    },
    {
      concept: "Core mechanism",
      annotation: "Show the central mechanism that drives behavior in this topic.",
      labels: [key(1, "control"), key(2, "engine"), key(6, "state"), key(7, "feedback")],
      layout: "hub" as SceneLayout,
      graph: graphTopic
        ? {
            type: "line" as const,
            title: `${topicShort} behavior trend`,
            x: [1, 2, 3, 4, 5, 6],
            y: [1.1, 1.8, 2.6, 3.0, 3.9, 4.5]
          }
        : undefined
    },
    {
      concept: "Decision logic",
      annotation: "Represent decision points and branching outcomes explicitly.",
      labels: [key(3, "condition"), "Decision", "Path A", "Path B", "Path C"],
      layout: "tree" as SceneLayout
    },
    {
      concept: "Validation and constraints",
      annotation: "Check constraints, error handling, and stability boundaries.",
      labels: ["Constraint", "Verifier", "Exception Path", "Stable Output"],
      layout: "layered" as SceneLayout,
      mathExpressions: mathTopic
        ? [
            {
              expression: "throughput = work / time",
              variables: { work: 320, time: 8 } as Record<string, number>
            },
            {
              expression: "efficiency = output / input",
              variables: { output: 240, input: 300 } as Record<string, number>
            }
          ]
        : undefined
    },
    {
      concept: "End-to-end synthesis",
      annotation: "Combine all components into an end-to-end execution view.",
      labels: ["User Trigger", "Execution Flow", "Result", "Feedback Loop"],
      layout: "timeline" as SceneLayout
    }
  ];

  return common;
}

function buildTemplateSimulationSteps(topic: Topic): SimStep[] {
  const titleLower = topic.title.toLowerCase();
  const domain = detectTechDomain(topic.title);
  const keywords = topicKeywords(topic, domain);
  const seed = textHash(topic.title.toLowerCase());
  const mathTopic = /(math|calculus|matrix|equation|algebra|physics|signal|probability|statistics|regression)/.test(
    titleLower
  );
  const graphTopic = /(graph|plot|chart|signal|trend|statistics|regression|probability|distribution)/.test(
    titleLower
  );

  const paletteByDomain: Record<TechDomain, string[]> = {
    web: ["#4aa8ff", "#20c997", "#7d8bff", "#f4a261", "#a0c4ff", "#b8f2e6"],
    data: ["#6b8dff", "#36cfc9", "#4dabf7", "#74c0fc", "#4ecdc4", "#91a7ff"],
    ml: ["#58a6ff", "#8b5cf6", "#3ddc97", "#34b1eb", "#9d7dff", "#50c878"],
    network: ["#4ea8de", "#48bfe3", "#5e60ce", "#64dfdf", "#80ffdb", "#72ddf7"],
    systems: ["#6d9dc5", "#80ed99", "#4ea8de", "#b8c0ff", "#90dbf4", "#72efdd"],
    security: ["#00a8e8", "#4f5d75", "#4361ee", "#4cc9f0", "#3a86ff", "#4895ef"],
    cloud: ["#3a86ff", "#4cc9f0", "#4895ef", "#4ea8de", "#56cfe1", "#72efdd"],
    algorithms: ["#4f46e5", "#06b6d4", "#22c55e", "#0ea5e9", "#84cc16", "#38bdf8"],
    hardware: ["#5c7cfa", "#15aabf", "#4dabf7", "#748ffc", "#66d9e8", "#91a7ff"],
    general: ["#4ea8de", "#80ed99", "#5e60ce", "#64dfdf", "#7b9acc", "#4cc9f0"]
  };
  const palette = paletteByDomain[domain];

  const blueprints = stageBlueprints(domain, topic.title, keywords, mathTopic, graphTopic).slice(0, 8);
  while (blueprints.length < 8) {
    const nextIndex = blueprints.length + 1;
    blueprints.push({
      concept: `Advanced insight ${nextIndex}`,
      annotation: `Step ${nextIndex} deepens ${topic.title} with an advanced practical perspective.`,
      labels: [
        keywords[(nextIndex + 1) % keywords.length] ?? "signal",
        keywords[(nextIndex + 2) % keywords.length] ?? "control",
        keywords[(nextIndex + 3) % keywords.length] ?? "output",
        `insight-${nextIndex}`
      ],
      layout: nextIndex % 2 === 0 ? "layered" : "pipeline"
    });
  }

  return blueprints.slice(0, 8).map((stage, stageIndex) => {
    const positions = layoutPositions(stage.layout, stage.labels.length);
    const objects: SimObject[] = stage.labels.map((label, index) => {
      const type = pickObjectType(label, stageIndex + index + seed);
      const thickness = type === "plane" ? 0.25 : 1;
      return {
        id: objectIdFromLabel(label, index),
        type,
        color: palette[(stageIndex + index + seed) % palette.length],
        size: {
          x: type === "plane" ? 1.8 : 1 + ((seed + index + stageIndex) % 3) * 0.22,
          y: type === "plane" ? 1.1 : 1 + ((seed + index * 3) % 3) * 0.24,
          z: thickness
        },
        position: positions[index] ?? { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        label: label.slice(0, 80)
      };
    });

    const connections = buildConnectionsFromLayout(stage.layout, objects);
    const movements = objects
      .slice(0, Math.min(8, objects.length))
      .map((object, index) => {
        const targetIndex = Math.min(objects.length - 1, index + 1);
        const target = objects[targetIndex];
        if ((stage.layout === "pipeline" || stage.layout === "timeline") && index < targetIndex) {
          return {
            objectId: object.id,
            type: "translate" as const,
            to: {
              x: Number((object.position.x + (target.position.x - object.position.x) * 0.28).toFixed(2)),
              y: Number((object.position.y + (target.position.y - object.position.y) * 0.28).toFixed(2)),
              z: object.position.z
            },
            durationMs: 1650 + index * 160,
            repeat: 1
          };
        }
        if (index % 2 === 0) {
          return {
            objectId: object.id,
            type: "pulse" as const,
            durationMs: 1500 + index * 130,
            repeat: 1
          };
        }
        return {
          objectId: object.id,
          type: "rotate" as const,
          axis: { x: 0.2, y: 1, z: 0.15 },
          durationMs: 1700 + index * 120,
          repeat: 0
        };
      });

    return {
      step: stageIndex + 1,
      concept: stage.concept.slice(0, 180),
      objects,
      movements,
      labels: [
        {
          text: `${topic.title}: ${stage.concept}`.slice(0, 180),
          position: { x: 0, y: 4.7, z: 0 },
          color: "#dbeafe"
        }
      ],
      connections,
      annotation: stage.annotation.slice(0, 300),
      graph: stage.graph,
      mathExpressions: stage.mathExpressions
    };
  });
}

function stepSpecificityScore(step: SimStep, topicTerms: string[], domainTerms: string[]): number {
  const objectLabels = step.objects.map((item) => (item.label ?? item.id).toLowerCase());
  const labelTexts = step.labels.map((item) => item.text.toLowerCase());
  const bag = [step.annotation.toLowerCase(), (step.concept ?? "").toLowerCase(), ...objectLabels, ...labelTexts].join(
    " "
  );

  const topicHits = topicTerms.filter((term) => bag.includes(term)).length;
  const domainHits = domainTerms.filter((term) => bag.includes(term)).length;
  const unlabeledObjects = step.objects.filter((item) => !(item.label ?? "").trim()).length;
  const genericIds = step.objects.filter((item) => /^obj[-_ ]?\d+$/i.test(item.id)).length;

  let score = 0;
  score += Math.min(3, topicHits);
  score += Math.min(2, domainHits);
  score += step.connections?.length ? 1 : 0;
  score += step.objects.length >= 4 ? 1 : 0;
  score -= unlabeledObjects >= Math.ceil(step.objects.length * 0.7) ? 2 : 0;
  score -= genericIds >= Math.ceil(step.objects.length * 0.7) ? 1 : 0;
  return score;
}

function normalizeSimulationSteps(rawSteps: SimStep[], fallback: SimStep[], topicTitle: string): SimStep[] {
  const domain = detectTechDomain(topicTitle);
  const topicTerms = topicKeywords(
    {
      id: "tmp",
      title: topicTitle,
      description: topicTitle,
      narration: [],
      visualTheme: "systems"
    },
    domain
  );
  const domainTerms = DOMAIN_TERMS[domain];

  const base = rawSteps.length > 0 ? rawSteps.slice(0, 8) : fallback.slice(0, 8);
  const expanded = [...base];
  while (expanded.length < 8) {
    expanded.push(fallback[expanded.length % fallback.length]);
  }

  return expanded.slice(0, 8).map((step, index) => {
    const fallbackStep = fallback[index % fallback.length];
    const chosen = stepSpecificityScore(step, topicTerms, domainTerms) >= 3 ? step : fallbackStep;
    const objectIds = new Set(chosen.objects.map((item) => item.id));
    const movements = chosen.movements
      .filter((move) => objectIds.has(move.objectId))
      .map((move) => ({
        ...move,
        durationMs: Math.max(300, Math.min(10000, Math.round(move.durationMs))),
        repeat: Math.max(0, Math.min(8, Math.round(move.repeat ?? 0)))
      }))
      .slice(0, 40);
    const labels = chosen.labels.slice(0, 24);
    const connections = (chosen.connections ?? [])
      .filter((link) => objectIds.has(link.fromId) && objectIds.has(link.toId) && link.fromId !== link.toId)
      .slice(0, 40);
    const graph =
      chosen.graph && chosen.graph.x.length === chosen.graph.y.length && chosen.graph.x.length > 1
        ? chosen.graph
        : undefined;
    const safeConnections =
      connections.length > 0
        ? connections
        : Array.from(objectIds)
            .slice(0, -1)
            .map((fromId, linkIndex) => ({
              fromId,
              toId: Array.from(objectIds)[linkIndex + 1],
              type: "line" as const,
              color: "#6fb6ff"
            }));
    return {
      step: index + 1,
      concept: chosen.concept?.trim().slice(0, 180) || fallbackStep.concept,
      objects: chosen.objects.slice(0, 24),
      movements,
      labels,
      connections: safeConnections,
      annotation: chosen.annotation.trim().slice(0, 300) || fallbackStep.annotation,
      mathExpressions: chosen.mathExpressions?.slice(0, 10),
      graph
    };
  });
}

function normalizeProblemSets(
  topic: Topic,
  generatedProblemSets?: z.infer<typeof generatedProblemSetsSchema>
): ProblemSet[] {
  const fallbackByLevel = new Map(buildGeneratedProblemSets(topic).map((set) => [set.level, set]));
  const generatedByLevel = new Map((generatedProblemSets ?? []).map((set) => [set.level, set]));

  return LEVELS.map((level) => {
    const fallback = fallbackByLevel.get(level)!;
    const generated = generatedByLevel.get(level);
    if (!generated) {
      return fallback;
    }

    const problems = generated.problems
      .map((problem, index) => {
        const uniqueChoices = Array.from(
          new Set(problem.choices.map((choice) => choice.trim().slice(0, 140)))
        ).filter(Boolean);
        if (!uniqueChoices.includes(problem.answer.trim())) {
          uniqueChoices.push(problem.answer.trim().slice(0, 140));
        }
        if (uniqueChoices.length < 2) {
          return null;
        }
        return {
          id: `${topic.id}-${level}-${index + 1}`,
          question: problem.question.trim().slice(0, 300),
          choices: uniqueChoices.slice(0, 6),
          answer: problem.answer.trim().slice(0, 140),
          explanation: problem.explanation.trim().slice(0, 320)
        };
      })
      .filter((problem): problem is NonNullable<typeof problem> => Boolean(problem));

    return {
      topicId: topic.id,
      level,
      passingScore: Math.round(generated.passingScore),
      problems: problems.length > 0 ? problems : fallback.problems
    };
  });
}

async function generateSimulationFromGemini(
  topic: string,
  level: DifficultyLevel
): Promise<GeminiSimulationPayload> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      "Bedrock is not configured. Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY."
    );
  }

  void level;
  const simulationFormatPrompt = `
You are a world class technical educator creating a visual simulation for the topic: ${topic}.

Return ONLY a JSON object with a steps array.
Each step must include:
- step (number)
- concept (string)
- subtitle (3-4 sentence explanation)
- duration_ms (word_count * 400, minimum 12000, maximum 35000)
- canvas_instructions with an elements array

STRICT RULES:
- CRITICAL RULE — BINARY SEARCH TREE: If the topic is binary search tree or BST, you MUST generate tree_node elements for every node in the tree.
  A tree_node element looks exactly like this:
  {"type": "tree_node", "value": 50, "x": 50, "y": 12, "color": "#4A90E2", "parent_value": null}
  {"type": "tree_node", "value": 30, "x": 25, "y": 30, "color": "#4A90E2", "parent_value": 50}
  {"type": "tree_node", "value": 70, "x": 75, "y": 30, "color": "#4A90E2", "parent_value": 50}
  NEVER generate type text with label Left Subtree or Right Subtree.
  NEVER generate placeholder text elements for tree parts.
  Every node in the tree must be its own tree_node element with a numeric value, x position, y position, color, and parent_value.
  The root node has parent_value null.
  All other nodes have parent_value set to their parent node value.
  For a BST with values [50,30,70,20,40,60,80]:
  50 is root at (50,12),
  30 is left child of 50 at (25,30),
  70 is right child of 50 at (75,30),
  20 is left child of 30 at (12,50),
  40 is right child of 30 at (38,50),
  60 is left child of 70 at (62,50),
  80 is right child of 70 at (88,50).
  Use this exact pattern for every BST simulation step.
- For binary search tree topics: use ONLY tree_node elements (never line, never rectangle).
  Each tree_node must have: type='tree_node', value (number), x (0-100), y (0-100), color, parent_value (number or null for root).
  The renderer will draw connection lines automatically.
- For sorting topics: use ONLY bar elements with numeric labels.
- Every step MUST have at least 5 canvas elements. Never generate a step with fewer than 4 elements.
- For binary search tree topics, each step must show the full tree with all nodes inserted so far, and the current operation node must be highlighted in orange (#FF6B35).
- For sorting topics, each step must show all bars and explicit comparison indicators so compared values are visually obvious.
- For bar elements, always set label to the numeric value being represented (example: label: "5").
- For bar elements, always set y to 85 so all bars share the same baseline.
- For bar elements, set height proportionally using: height = (value / max_value) * 60.
- Never place bars at y values less than 50.
- For concept topics, each step must show a central diagram with labeled components connected by arrows.
- Before generating each step's elements, reason about what the subtitle says and make the visual match it exactly.
- If a subtitle mentions a specific node value being inserted or highlighted, that exact node must be highlighted in orange (#FF6B35).
- If a subtitle mentions comparing two values, those two elements must use a distinct highlight color so the comparison is visually clear.
- The visual for each step must be a faithful diagram of exactly what the subtitle describes.
- NEVER invent new element types.
- Only use these exact types: tree_node, bar, text, arrow, circle, matrix, axis, plot_point, flowchart_diamond.
- Every step must visually match its subtitle.
- Never return markdown or prose outside JSON.
`.trim();

  const payload = await requestBedrockJson(simulationFormatPrompt, {
    topicKey: topic,
    useCache: true,
    saveCache: false,
    maxTokens: 8000,
    temperature: 0
  });

  const strict = llmSimulationSchema.safeParse(payload);
  const candidates = strict.success ? strict.data.steps : extractStepCandidates(payload);
  const generatedSteps: GeminiCanvasStep[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const parsed = simCanvasStepSchema.safeParse(normalizeCanvasStep(candidates[index], index));
    if (parsed.success) {
      generatedSteps.push(parsed.data);
    }
  }

  if (generatedSteps.length === 0) {
    throw new Error("Simulation generation failed: Bedrock did not return valid steps.");
  }

  const validatedSteps = isBstTopic(topic)
    ? validateAndRepairBstSteps(generatedSteps)
    : generatedSteps;

  try {
    await saveSimulationS3Cache(topic, { steps: validatedSteps });
  } catch (error) {
    console.warn("[Simulation] Unable to cache generated steps to S3. Continuing without cache.", error);
  }

  return { steps: validatedSteps };
}

function toCanvasPercentX(x: number): number {
  return clamp(((x + 8) / 16) * 100, 6, 94);
}

function toCanvasPercentY(y: number): number {
  return clamp(((5 - y) / 10) * 100, 8, 92);
}

function mapObjectTypeToCanvasType(type: SimObject["type"]): CanvasElementType {
  if (type === "box" || type === "plane") {
    return "rectangle";
  }
  if (type === "sphere") {
    return "circle";
  }
  if (type === "cylinder") {
    return "ellipse";
  }
  if (type === "cone") {
    return "triangle";
  }
  if (type === "line") {
    return "line";
  }
  if (type === "arrow") {
    return "arrow";
  }
  if (type === "text") {
    return "text";
  }
  return "pulse";
}

function mapMovementToAnimation(movement: SimStep["movements"][number] | undefined): GeminiCanvasElement["animation"] {
  if (!movement) {
    return {
      type: "fade_in",
      duration: 900,
      direction: "none",
      represents: "introduces this concept element"
    };
  }
  if (movement.type === "translate") {
    return {
      type: "move",
      duration: clamp(Math.round(movement.durationMs ?? 1100), 200, 10000),
      direction: "left_to_right",
      represents: "shows state progression through the process"
    };
  }
  if (movement.type === "rotate") {
    return {
      type: "rotate",
      duration: clamp(Math.round(movement.durationMs ?? 1300), 200, 10000),
      direction: "clockwise",
      represents: "shows iterative transformation"
    };
  }
  if (movement.type === "scale") {
    return {
      type: "scale",
      duration: clamp(Math.round(movement.durationMs ?? 1000), 200, 10000),
      direction: "outward",
      represents: "shows magnitude change"
    };
  }
  if (movement.type === "pulse") {
    return {
      type: "pulse",
      duration: clamp(Math.round(movement.durationMs ?? 900), 200, 10000),
      direction: "none",
      represents: "highlights an active step"
    };
  }
  return {
    type: "fade_in",
    duration: 900,
    direction: "none",
    represents: "introduces this concept element"
  };
}

function convertTemplateToCanvasSteps(topic: Topic): GeminiCanvasStep[] {
  const templateBase = buildTemplateSimulationSteps(topic);
  const templateSteps = normalizeSimulationSteps(templateBase, templateBase, topic.title);

  return templateSteps.map((step, stepIndex) => {
    const movementByObject = new Map(step.movements.map((movement) => [movement.objectId, movement]));
    const objectById = new Map(step.objects.map((item) => [item.id, item]));

    const elements: GeminiCanvasElement[] = step.objects.map((object, objectIndex) => {
      const movement = movementByObject.get(object.id);
      return {
        type: mapObjectTypeToCanvasType(object.type),
        x: toCanvasPercentX(object.position.x),
        y: toCanvasPercentY(object.position.y),
        width: clamp(Math.round(object.size.x * 8), 4, 24),
        height: clamp(Math.round(object.size.y * 8), 3, 24),
        color: normalizeHexColor(object.color, "#00d4ff"),
        label: (object.label || object.id || `Element ${objectIndex + 1}`).slice(0, 180),
        label_position: "above",
        animation: mapMovementToAnimation(movement)
      };
    });

    step.connections.forEach((connection, connectionIndex) => {
      const from = objectById.get(connection.fromId);
      const to = objectById.get(connection.toId);
      if (!from || !to) {
        return;
      }
      const x1 = toCanvasPercentX(from.position.x);
      const y1 = toCanvasPercentY(from.position.y);
      const x2 = toCanvasPercentX(to.position.x);
      const y2 = toCanvasPercentY(to.position.y);
      elements.push({
        type: connection.type === "dashed" ? "dashed line" : connection.type === "arrow" ? "arrow" : "line",
        x: Number(((x1 + x2) / 2).toFixed(2)),
        y: Number(((y1 + y2) / 2).toFixed(2)),
        width: clamp(Math.abs(x2 - x1), 4, 50),
        height: clamp(Math.abs(y2 - y1) || 1.4, 1, 24),
        color: normalizeHexColor(connection.color, "#93c5fd"),
        label: (connection.label || `Flow ${connectionIndex + 1}`).slice(0, 180),
        label_position: "above",
        animation: {
          type: "draw",
          duration: 900 + connectionIndex * 110,
          direction: "left_to_right",
          represents: "shows relation between connected elements"
        }
      });
    });

    const normalizedStep = simCanvasStepSchema.safeParse({
      step: stepIndex + 1,
      concept: step.concept || `Step ${stepIndex + 1}`,
      subtitle: step.annotation,
      canvas_instructions: {
        elements: elements.slice(0, 220)
      }
    });

    if (normalizedStep.success) {
      return normalizedStep.data;
    }

    return {
      step: stepIndex + 1,
      concept: (step.concept || `Step ${stepIndex + 1}`).slice(0, 220),
      subtitle: step.annotation.slice(0, 1200),
      canvas_instructions: {
        elements: [
          {
            type: "text",
            x: 50,
            y: 50,
            width: 30,
            height: 6,
            color: "#00d4ff",
            label: step.annotation.slice(0, 160),
            label_position: "above",
            animation: {
              type: "fade_in",
              duration: 900,
              direction: "none",
              represents: "fallback annotation display"
            }
          }
        ]
      }
    };
  });
}

async function generateChatReplyFromGemini(
  topicTitle: string,
  message: string,
  mode: "voice" | "text"
): Promise<string | null> {
  void GEMINI_API_KEY;
  void GEMINI_MODEL;

  const prompt = `
You are a precise technical tutor helping with topic "${topicTitle}".
User mode: ${mode}.
User message: "${message}".

Reply with:
- 2 to 4 short sentences
- practical, accurate explanation
- one immediate next action the learner should take
- no markdown
`.trim();

  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: 1200,
      temperature: 0.3
    }
  });
  const command = new InvokeModelCommand({
    modelId: "us.amazon.nova-pro-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body as Uint8Array)) as {
    output?: {
      message?: {
        content?: Array<{ text?: string }>;
      };
    };
  };
  const text = responseBody.output?.message?.content?.map((part) => part.text ?? "").join(" ").trim();
  if (!text) {
    return null;
  }
  return text.slice(0, 900);
}

async function analyzeVoiceActionWithNova(
  topicTitle: string,
  userSpeech: string,
  stepConcept: string,
  stepNumber: number
): Promise<{
  action_type: string;
  action_params: Record<string, unknown>;
  spoken_response: string;
  feedback: string;
  requires_animation: boolean;
}> {
  const prompt = `
You are an intelligent assistant controlling an interactive technical simulation. The user said: ${userSpeech}. The current topic is ${topicTitle}. The current simulation step is ${stepConcept}. The current step number is ${stepNumber}.
Map natural language reliably using these examples:
- next / forward / continue => next_step
- back / previous / go back => previous_step
- stop / pause / wait => pause
- play / resume / start => play
- what is this / explain / tell me => answer_question
- move X to Y => move_element
- go to step N / jump to step N / show step N / take me to step N => jump_to_step with step_number N
Respond with ONLY valid JSON containing:
- action_type (exactly one of: answer_question, move_element, modify_element, play, pause, next_step, previous_step, jump_to_step, restart, open_menu, close_menu, toggle_subtitles, toggle_voice, not_possible, general_answer)
- action_params (object; for move_element include element_label, target_x, target_y as canvas percentages; for modify_element include element_label, property, new_value; for jump_to_step include step_number as integer)
- spoken_response (brief natural response for the user)
- feedback (required only for move_element and modify_element; otherwise empty string)
- requires_animation (boolean)
Output only valid JSON with no extra text.
`.trim();

  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: 200,
      temperature: 0.1
    }
  });
  const command = new InvokeModelCommand({
    modelId: "us.amazon.nova-pro-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body as Uint8Array));
  const text = responseBody.output?.message?.content?.[0]?.text ?? "";
  const clean = String(text).replace(/```json|```/g, "").trim();
  const parsed = extractJsonObject(clean) as Record<string, unknown>;

  return {
    action_type: typeof parsed.action_type === "string" ? parsed.action_type : "general_answer",
    action_params:
      parsed.action_params && typeof parsed.action_params === "object" && !Array.isArray(parsed.action_params)
        ? (parsed.action_params as Record<string, unknown>)
        : {},
    spoken_response:
      typeof parsed.spoken_response === "string" && parsed.spoken_response.trim().length > 0
        ? parsed.spoken_response.trim()
        : "I heard you. I will adjust the simulation accordingly.",
    feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    requires_animation: Boolean(parsed.requires_animation)
  };
}

function defaultVoiceSettings(): VoiceSettings {
  return {
    narrationEnabled: true,
    interactionEnabled: true,
    navigationEnabled: true,
    rate: 1,
    voiceName: ""
  };
}

function getNextLevel(level: DifficultyLevel): DifficultyLevel | null {
  const index = LEVELS.indexOf(level);
  if (index === -1 || index === LEVELS.length - 1) {
    return null;
  }
  return LEVELS[index + 1];
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "interactive-tech-tutor-api" });
});

app.post(
  "/api/auth/register",
  asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration payload." });
    return;
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  const result = await updateStore((store) => {
    const existing = store.users.find((user) => user.email === normalizedEmail);
    if (existing) {
      return { error: "User already exists." as const };
    }

    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      createdAt: now,
      lastLoginAt: now
    };

    const preferences: UserPreferences = {
      userId: user.id,
      interactionMode: "both",
      voiceSettings: defaultVoiceSettings()
    };

    store.users.push(user);
    store.preferences.push(preferences);

    return {
      user: { id: user.id, email: user.email, lastLoginAt: user.lastLoginAt }
    };
  });

  if ("error" in result) {
    res.status(409).json(result);
    return;
  }

  const token = createToken({ userId: result.user.id, email: result.user.email });
  res.status(201).json({ token, user: result.user });
  })
);

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload." });
    return;
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();

  const result = await updateStore((store) => {
    const user = store.users.find((candidate) => candidate.email === normalizedEmail);
    if (!user || user.passwordHash !== passwordHash) {
      return { error: "Invalid email or password." as const };
    }
    user.lastLoginAt = now;
    return {
      user: { id: user.id, email: user.email, lastLoginAt: user.lastLoginAt }
    };
  });

  if ("error" in result) {
    res.status(401).json(result);
    return;
  }

  const token = createToken({ userId: result.user.id, email: result.user.email });
  res.json({ token, user: result.user });
  })
);

app.get("/api/topics", authMiddleware, (_req, res) => {
  res.json({ topics: TOPICS });
});

app.get("/api/topics/:topicId/problem-sets", authMiddleware, (req, res) => {
  const topicId = req.params.topicId;
  const sets = PROBLEM_SETS.filter((set) => set.topicId === topicId);
  if (!sets.length) {
    res.status(404).json({ error: "No problem sets found for topic." });
    return;
  }
  res.json({ problemSets: sets });
});

app.get(
  "/api/progress",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.userId;
  const store = await readStore();
  const progress = store.progress.filter((record) => record.userId === userId);
  res.json({ progress });
  })
);

app.post(
  "/api/progress/update",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const parsed = progressUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid progress payload." });
    return;
  }

  const userId = req.auth!.userId;
  const payload = parsed.data;
  const now = new Date().toISOString();

  const result = await updateStore((store) => {
    const existing = store.progress.find(
      (record) =>
        record.userId === userId && record.topicId === payload.topicId && record.level === payload.level
    );

    let updatedRecord: ProgressRecord;
    if (existing) {
      existing.status = payload.status;
      existing.score = payload.score;
      existing.timeSpent = payload.timeSpent;
      existing.updatedAt = now;
      updatedRecord = existing;
    } else {
      updatedRecord = {
        userId,
        topicId: payload.topicId,
        level: payload.level,
        status: payload.status,
        score: payload.score,
        timeSpent: payload.timeSpent,
        updatedAt: now
      };
      store.progress.push(updatedRecord);
    }

    const matchingProblemSet = PROBLEM_SETS.find(
      (problemSet) => problemSet.topicId === payload.topicId && problemSet.level === payload.level
    );
    const passingScore = matchingProblemSet?.passingScore ?? 70;
    const unlockedLevel =
      payload.status === "completed" && payload.score >= passingScore ? getNextLevel(payload.level) : null;

    if (unlockedLevel) {
      const nextExists = store.progress.some(
        (record) => record.userId === userId && record.topicId === payload.topicId && record.level === unlockedLevel
      );
      if (!nextExists) {
        store.progress.push({
          userId,
          topicId: payload.topicId,
          level: unlockedLevel,
          status: "not-started",
          score: 0,
          timeSpent: 0,
          updatedAt: now
        });
      }
    }

    return { progress: updatedRecord, unlockedLevel };
  });

  res.json(result);
  })
);

app.get(
  "/api/preferences",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.userId;
  const store = await readStore();
  const preferences = store.preferences.find((item) => item.userId === userId);
  if (!preferences) {
    res.status(404).json({ error: "Preferences not found." });
    return;
  }
  res.json({ preferences });
  })
);

app.put(
  "/api/preferences",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid preference payload." });
    return;
  }

  const userId = req.auth!.userId;
  const body = parsed.data;

  const updated = await updateStore((store) => {
    const current = store.preferences.find((item) => item.userId === userId);
    if (!current) {
      const created: UserPreferences = {
        userId,
        interactionMode: body.interactionMode,
        voiceSettings: body.voiceSettings
      };
      store.preferences.push(created);
      return created;
    }
    current.interactionMode = body.interactionMode;
    current.voiceSettings = body.voiceSettings;
    return current;
  });

  res.json({ preferences: updated });
  })
);

app.get(
  "/api/history",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.userId;
  const topicId = typeof req.query.topicId === "string" ? req.query.topicId : undefined;
  const store = await readStore();
  const history = store.history
    .filter((item) => item.userId === userId && (!topicId || item.topicId === topicId))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  res.json({ history });
  })
);

app.delete(
  "/api/history/topic/:topicId",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.userId;
  const topicId = req.params.topicId;

  const removedCount = await updateStore((store) => {
    const before = store.history.length;
    store.history = store.history.filter((item) => !(item.userId === userId && item.topicId === topicId));
    return before - store.history.length;
  });

  res.json({ removedCount, topicId });
  })
);

app.post(
  "/api/interactions",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const parsed = interactionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid interaction payload." });
    return;
  }

  const userId = req.auth!.userId;
  const payload = parsed.data;
  const interaction: InteractionRecord = {
    id: randomUUID(),
    userId,
    topicId: payload.topicId,
    type: payload.type,
    input: payload.input,
    output: payload.output,
    timestamp: new Date().toISOString(),
    meta: payload.meta
  };

  await appendHistorySafely(interaction);

  res.status(201).json({ interaction });
  })
);

app.post(
  "/api/ai/simulation",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const parsed = simulationGenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid simulation generation payload." });
    return;
  }

  const { topic: requestedTopic, level } = parsed.data;
  const cacheKey = `${SIMULATION_CACHE_SCHEMA_VERSION}::${level}::${requestedTopic.trim().toLowerCase()}`;
  const cached = simulationResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= SIMULATION_CACHE_TTL_MS) {
    const cachedPayload = JSON.parse(JSON.stringify(cached.payload)) as typeof cached.payload;
    res.json(cachedPayload);
    return;
  }

  const topic = buildGeneratedTopic(requestedTopic, level);
  let problemSets = buildGeneratedProblemSets(topic);
  let explanationScript = "";
  let simulationSteps: GeminiCanvasStep[] = [];
  let openingMessage = `Generated a live simulation plan for ${topic.title}.`;
  let generationSource: "template" | "bedrock" = "bedrock";
  let geminiError = "";
  try {
    const llmGenerated = await generateSimulationFromGemini(requestedTopic, level);
    simulationSteps = llmGenerated.steps;
  } catch (error) {
    geminiError = (error as Error).message;
    console.error("[Simulation] Gemini generation failed, falling back to template:", geminiError);
  }
  if (simulationSteps.length === 0) {
    generationSource = "template";
    simulationSteps = convertTemplateToCanvasSteps(topic);
    openingMessage = geminiError
      ? `Generated with template fallback because Gemini failed: ${geminiError.slice(0, 120)}`
      : `Generated with template fallback for ${topic.title}.`;
  }
  const narration = normalizeNarration(simulationSteps.map((step) => step.subtitle));
  if (narration.length > 0) {
    topic.narration = narration;
  }
  if (simulationSteps[0]?.subtitle) {
    openingMessage = simulationSteps[0].subtitle.slice(0, 700);
  }
  explanationScript = simulationSteps
    .map((step, index) => `Step ${index + 1} (${step.concept}): ${step.subtitle}`)
    .join(" ")
    .slice(0, 2800);
  topic.description = explanationScript.slice(0, 1400);
  problemSets = normalizeProblemSets(topic);

  const interaction: InteractionRecord = {
    id: randomUUID(),
    userId: req.auth!.userId,
    topicId: topic.id,
    type: "text",
    input: requestedTopic,
    output: openingMessage,
    timestamp: new Date().toISOString(),
    meta: { source: "simulation-generator", level, generationSource }
  };

  await appendHistorySafely(interaction);

  const responsePayload = {
    topic,
    problemSets,
    openingMessage,
    generationSource,
    explanation_script: explanationScript,
    simulation_steps: simulationSteps
  };

  simulationResponseCache.set(cacheKey, {
    cachedAt: Date.now(),
    payload: JSON.parse(JSON.stringify(responsePayload)) as typeof responsePayload
  });

  res.json(responsePayload);
  })
);

app.post(
  "/api/ai/chat",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    topicId: z.string().min(1),
    message: z.string().min(1),
    mode: z.enum(["voice", "text"]).default("text")
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid chat payload." });
    return;
  }

  const { topicId, message, mode } = parsed.data;
  const topic = TOPICS.find((item) => item.id === topicId);
  const topicTitle = topic?.title ?? topicId;
  let responseText = topic
    ? `In ${topic.title}, focus on this next: ${message.slice(0, 120)}. Try the current ${mode} prompt, then validate with the active problem set.`
    : `I can help with that question. Start by clarifying the current topic and desired difficulty level.`;

  try {
    const geminiReply = await generateChatReplyFromGemini(topicTitle, message, mode);
    if (geminiReply) {
      responseText = geminiReply;
    }
  } catch (error) {
    console.error("Gemini chat fallback to template:", error);
  }

  const interaction: InteractionRecord = {
    id: randomUUID(),
    userId: req.auth!.userId,
    topicId,
    type: mode,
    input: message,
    output: responseText,
    timestamp: new Date().toISOString(),
    meta: { source: "chat" }
  };

  await appendHistorySafely(interaction);

  res.json({ response: responseText });
  })
);

app.post(
  "/api/ai/voice-action",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    topicId: z.string().min(1),
    userSpeech: z.string().min(1),
    stepConcept: z.string().min(1).default("Current step"),
    stepNumber: z.number().int().min(1).default(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid voice action payload." });
    return;
  }

  const { topicId, userSpeech, stepConcept, stepNumber } = parsed.data;
  const topic = TOPICS.find((item) => item.id === topicId);
  const topicTitle = topic?.title ?? topicId;

  try {
    const action = await analyzeVoiceActionWithNova(topicTitle, userSpeech, stepConcept, stepNumber);
    res.json(action);
  } catch (error) {
    console.error("Voice action fallback:", error);
    res.json({
      action_type: "general_answer",
      action_params: {},
      spoken_response: "I heard you. Please try again in a moment.",
      feedback: "",
      requires_animation: false
    });
  }
  })
);

app.post(
  "/api/ai/feedback/action",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    topicId: z.string().min(1),
    actionType: z.enum(["drag", "scroll", "back", "voice-command", "navigation"]),
    detail: z.string().min(1)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid action payload." });
    return;
  }

  const { topicId, actionType, detail } = parsed.data;
  const actionMap: Record<string, string> = {
    drag: "Drag action analyzed. Keep aligning moving elements with the highlighted zone.",
    scroll: "Scroll pattern captured. Pace your review so each concept is fully processed.",
    back: "Backward navigation detected. Revisiting this step reinforces retention.",
    "voice-command":
      "Voice command processed. Your instruction was interpreted and applied to the active learning flow.",
    navigation:
      "Navigation action evaluated. Maintain clear step sequencing so the simulation context stays coherent."
  };
  const responseText = `${actionMap[actionType]} Detail: ${detail.slice(0, 120)}`;

  const interaction: InteractionRecord = {
    id: randomUUID(),
    userId: req.auth!.userId,
    topicId,
    type: "action",
    input: `${actionType}:${detail}`,
    output: responseText,
    timestamp: new Date().toISOString(),
    meta: { source: "feedback" }
  };

  await appendHistorySafely(interaction);

  res.json({ response: responseText });
  })
);

app.post(
  "/api/ai/visual",
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    topicId: z.string().min(1),
    fileName: z.string().min(1),
    fileType: z.string().min(1),
    size: z.number().min(0)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid visual payload." });
    return;
  }

  const { topicId, fileName, fileType, size } = parsed.data;
  const summary = `Visual input received: ${fileName} (${fileType}, ${Math.round(size / 1024)} KB). Analysis suggests mapping this material to the active topic workflow before solving advanced problems.`;

  const interaction: InteractionRecord = {
    id: randomUUID(),
    userId: req.auth!.userId,
    topicId,
    type: "visual",
    input: fileName,
    output: summary,
    timestamp: new Date().toISOString(),
    meta: { fileType, size }
  };

  await appendHistorySafely(interaction);

  res.json({ response: summary });
  })
);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error.";
  const status = message.includes("not allowed by CORS") ? 403 : 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message });
});

async function startServer(): Promise<void> {
  await initializeDynamoDBTables();
  await initializeCacheState();
  app.listen(port, () => {
    console.log(`Interactive Tech Tutor API running on http://localhost:${port}`);
  });
}

void startServer().catch((error) => {
  console.error("Failed to start Interactive Tech Tutor API:", error);
  process.exit(1);
});
