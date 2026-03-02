import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
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
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 14000);
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
const SIMULATION_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const SIMULATION_CACHE_SCHEMA_VERSION = "canvas-json-v2";
const simulationResponseCache = new Map<
  string,
  {
    cachedAt: number;
    payload: {
      topic: Topic;
      problemSets: ProblemSet[];
      openingMessage: string;
      generationSource: "template" | "gemini";
      explanation_script: string;
      simulation_steps: unknown[];
    };
  }
>();

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
  "move",
  "draw",
  "pulse",
  "rotate",
  "scale",
  "highlight",
  "none"
]);

const simCanvasAnimationSchema = z.object({
  type: simCanvasAnimationTypeSchema,
  duration: z.number().int().min(100).max(10000),
  direction: z.string().min(1).max(80),
  represents: z.string().min(3).max(240)
});

const simCanvasElementTypeSchema = z.enum([
  "rectangle",
  "circle",
  "ellipse",
  "triangle",
  "arrow",
  "curved arrow",
  "line",
  "dashed line",
  "text",
  "path",
  "polygon",
  "grid",
  "axis",
  "plot point",
  "wave",
  "pulse",
  "highlight box"
]);

const simCanvasElementSchema = z.object({
  type: simCanvasElementTypeSchema,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
  color: z.string().regex(/^#([0-9a-fA-F]{6})$/),
  label: z.string().min(1).max(180),
  label_position: z.enum(["above", "below", "left", "right"]),
  animation: simCanvasAnimationSchema
});

const simCanvasStepSchema = z.object({
  step: z.number().int().min(1).max(120),
  concept: z.string().min(1).max(220),
  subtitle: z.string().min(1).max(400),
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
): Promise<GeminiSimulationPayload | null> {
  if (!GEMINI_API_KEY || !GEMINI_MODEL) {
    return null;
  }

  void level;

  const simulationFormatPrompt = `
You are a world class educator and visualization expert with complete knowledge of every technical field - computer science, software engineering, artificial intelligence, machine learning, data science, networking, cybersecurity, electronics, electrical engineering, mechanical engineering, robotics, mathematics, physics, chemistry, biotechnology, aerospace, and all other technical domains. A student wants to learn about: ${topic}. Design a complete visual simulation explaining this topic from absolute basics to thorough understanding. Decide yourself how many steps are needed - use as few or as many as the topic genuinely requires. A simple topic might need 3 steps, a complex one might need 12. Let the topic decide. For each step design a visual specifically suited to that concept - never use a generic layout of floating boxes and diagonal lines. Think about what visual representation makes this specific concept clearest. Output only valid JSON in this format:

{  "steps": [
    {
      "step": 1,
      "concept": "Name of the concept being taught in this step",
      "subtitle": "One sentence explaining what this step shows to the user",
      "canvas_instructions": {
        "elements": [
          {
            "type": "rectangle",
            "x": 50,
            "y": 30,
            "width": 20,
            "height": 10,
            "color": "#00d4ff",
            "label": "Label text shown next to this element",
            "label_position": "above",
            "animation": {
              "type": "fade_in",
              "duration": 800,
              "direction": "none",
              "represents": "what this animation is showing the user"
            }
          },
          {
            "type": "circle",
            "x": 30,
            "y": 60,
            "width": 8,
            "height": 8,
            "color": "#8b5cf6",
            "label": "Node A",
            "label_position": "below",
            "animation": {
              "type": "move",
              "duration": 1200,
              "direction": "right",
              "represents": "data moving from one node to another"
            }
          },
          {
            "type": "arrow",
            "x": 40,
            "y": 50,
            "width": 15,
            "height": 2,
            "color": "#ffffff",
            "label": "pointer",
            "label_position": "above",
            "animation": {
              "type": "draw",
              "duration": 1000,
              "direction": "left_to_right",
              "represents": "showing the direction of data flow"
            }
          }
        ]
      }
    },
    {
      "step": 2,
      "concept": "Next concept name",
      "subtitle": "One sentence explaining step 2",
      "canvas_instructions": {
        "elements": []
      }
    }
  ]
}
x and y are always a number between 0 and 100 representing percentage of canvas size - never pixels
width and height are also percentages of canvas size - never pixels
color is always a hex code - never a color name like "red" or "blue"
label_position is always exactly one of: above, below, left, right
animation.type is always exactly one of the listed types - never a custom value
animation.direction describes the actual direction like left_to_right, top_to_bottom, clockwise, none etc
animation.represents is a plain English sentence explaining what this animation is teaching - this is important for the renderer to know context
Every element must have all fields present - no field should ever be null or missing
Steps array must always have at least 1 step and elements array must always have at least 1 element per step
Make colors bright and distinct. Make every animation meaningful and directly illustrative of the concept. Every step must look visually different from the previous one. Never repeat the same layout. Output only valid JSON with no extra text.
`.trim();

  const systemPrompt = "Return only valid JSON with no markdown and no prose.";

  const requestGeminiJson = async (prompt: string): Promise<unknown> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 6000,
              responseMimeType: "application/json"
            }
          })
        }
      );
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      promptFeedback?: {
        blockReason?: string;
      };
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n");
    if (!content) {
      if (payload.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked output: ${payload.promptFeedback.blockReason}`);
      }
      throw new Error("Gemini response was empty.");
    }
    console.log("[Gemini simulation] raw response:", content);
    return extractJsonObject(content);
  };

  const pickRetryStepPayload = (payload: unknown, stepNumber: number): unknown => {
    if (!payload || typeof payload !== "object") {
      return payload;
    }
    const maybeStep = payload as { step?: unknown; steps?: unknown };
    if (typeof maybeStep.step === "number") {
      return payload;
    }
    if (Array.isArray(maybeStep.steps)) {
      const match = maybeStep.steps.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "step" in item &&
          typeof (item as { step?: unknown }).step === "number" &&
          (item as { step: number }).step === stepNumber
      );
      return match ?? maybeStep.steps[0];
    }
    return payload;
  };

  let rawSteps: unknown[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const initialPayload = await requestGeminiJson(simulationFormatPrompt);
      if (!initialPayload) {
        return null;
      }

      const strict = llmSimulationSchema.safeParse(initialPayload);
      console.log(
        `[Gemini simulation] top-level JSON parse ${strict.success ? "succeeded" : "failed"} on attempt ${attempt}`
      );
      if (!strict.success) {
        console.log(
          `[Gemini simulation] top-level parse issue: ${strict.error.issues[0]?.message ?? "Unknown issue"}`
        );
      }

      rawSteps = strict.success
        ? strict.data.steps
        : Array.isArray((initialPayload as { steps?: unknown[] }).steps)
          ? (initialPayload as { steps: unknown[] }).steps
          : [];

      if (rawSteps.length === 0) {
        throw new Error(
          `Gemini JSON validation failed: ${strict.success ? "Missing steps" : strict.error.issues[0]?.message}`
        );
      }
      break;
    } catch (error) {
      const message = (error as Error).message;
      if (attempt >= 2) {
        throw error;
      }
      console.warn(
        `[Gemini simulation] invalid or unparsable JSON on attempt ${attempt}. Retrying once. Reason: ${message}`
      );
    }
  }

  if (rawSteps.length === 0) {
    throw new Error("Gemini JSON validation failed: Missing steps");
  }

  const validSteps: GeminiCanvasStep[] = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    let stepCandidate: unknown = rawSteps[index];
    let parsedStep = simCanvasStepSchema.safeParse(stepCandidate);
    console.log(
      `[Gemini simulation] step ${index + 1} parse ${parsedStep.success ? "succeeded" : "failed"}`
    );

    let retryCount = 0;
    while (!parsedStep.success && retryCount < 2) {
      retryCount += 1;
      const retryPrompt = `Your previous response for step [${index + 1}] was incomplete. Please regenerate only that step with complete valid JSON following the same format.`;
      const retryPayload = await requestGeminiJson(retryPrompt);
      if (!retryPayload) {
        break;
      }
      stepCandidate = pickRetryStepPayload(retryPayload, index + 1);
      parsedStep = simCanvasStepSchema.safeParse(stepCandidate);
      console.log(
        `[Gemini simulation] step ${index + 1} parse retry ${retryCount} ${parsedStep.success ? "succeeded" : "failed"}`
      );
    }

    if (parsedStep.success) {
      validSteps.push(parsedStep.data);
    }
  }

  if (validSteps.length === 0) {
    throw new Error("Gemini JSON validation failed: Required");
  }

  return { steps: validSteps };
}

async function generateChatReplyFromGemini(
  topicTitle: string,
  message: string,
  mode: "voice" | "text"
): Promise<string | null> {
  if (!GEMINI_API_KEY || !GEMINI_MODEL) {
    return null;
  }

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

  const response = await fetch(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.5
        }
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini chat failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join(" ").trim();
  if (!text) {
    return null;
  }
  return text.slice(0, 900);
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

  await updateStore((store) => {
    store.history.push(interaction);
  });

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
  let generationSource: "template" | "gemini" = "gemini";
  let llmGenerated: GeminiSimulationPayload | null = null;
  try {
    llmGenerated = await generateSimulationFromGemini(requestedTopic, level);
  } catch (error) {
    res.status(502).json({
      error: `Gemini simulation error: ${(error as Error).message}`
    });
    return;
  }
  if (!llmGenerated || llmGenerated.steps.length === 0) {
    res.status(502).json({ error: "Simulation generation failed. Gemini did not return valid steps." });
    return;
  }
  simulationSteps = llmGenerated.steps;
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

  await updateStore((store) => {
    store.history.push(interaction);
  });

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

  await updateStore((store) => {
    store.history.push(interaction);
  });

  res.json({ response: responseText });
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

  await updateStore((store) => {
    store.history.push(interaction);
  });

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

  await updateStore((store) => {
    store.history.push(interaction);
  });

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

app.listen(port, () => {
  console.log(`Interactive Tech Tutor API running on http://localhost:${port}`);
});
