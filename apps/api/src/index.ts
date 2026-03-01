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
  durationMs: z.number().min(300).max(10000).default(2200),
  repeat: z.number().int().min(0).max(8).default(0)
});

const simLabelSchema = z.object({
  text: z.string().min(1).max(180),
  objectId: z.string().min(1).max(40).optional(),
  position: vec3Schema.optional(),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional()
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
  objects: z.array(simObjectSchema).min(1).max(24),
  movements: z.array(simMovementSchema).max(40).default([]),
  labels: z.array(simLabelSchema).max(24).default([]),
  annotation: z.string().min(8).max(300),
  mathExpressions: z.array(simMathExpressionSchema).max(10).optional(),
  graph: simGraphSchema.optional()
});

const llmSimulationSchema = z.object({
  description: z.string().min(20).max(1400),
  narration: z.array(z.string().min(8).max(700)).min(3).max(14),
  openingMessage: z.string().min(20).max(700),
  explanation_script: z.string().min(40).max(2800),
  simulation_steps: z.array(simStepSchema).min(3).max(12),
  problemSets: z
    .array(
      z.object({
        level: z.enum(["beginner", "intermediate", "advanced"]),
        passingScore: z.number().min(60).max(95),
        problems: z
          .array(
            z.object({
              question: z.string().min(10).max(700),
              choices: z.array(z.string().min(1).max(260)).min(2).max(10),
              answer: z.string().min(1).max(260),
              explanation: z.string().min(10).max(700)
            })
          )
          .min(1)
          .max(12)
      })
    )
    .min(3)
    .max(12)
    .optional()
});

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

function topicKeywords(topic: Topic): string[] {
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
  if (unique.length >= 4) {
    return unique;
  }
  return [...unique, "input", "process", "validate", "output"].slice(0, 6);
}

function buildTemplateSimulationSteps(topic: Topic): z.infer<typeof simStepSchema>[] {
  const palette = ["#3b82f6", "#f97316", "#10b981", "#ec4899", "#eab308", "#6366f1", "#14b8a6", "#ef4444"];
  const objectKinds: Array<z.infer<typeof simObjectSchema>["type"]> = [
    "box",
    "sphere",
    "cylinder",
    "cone",
    "torus",
    "plane",
    "arrow"
  ];
  const keywords = topicKeywords(topic);
  const seed = textHash(topic.title.toLowerCase());
  const objectCount = Math.min(10, Math.max(5, keywords.length + 1));
  const radius = 4 + (seed % 3);

  const baseObjects = Array.from({ length: objectCount }).map((_, index) => {
    const angle = (index / objectCount) * Math.PI * 2;
    const keyword = keywords[index % keywords.length] ?? `stage-${index + 1}`;
    return {
      id: `obj-${index + 1}`,
      type: objectKinds[(seed + index) % objectKinds.length],
      color: palette[(seed + index * 3) % palette.length],
      size: {
        x: 0.9 + ((seed + index) % 4) * 0.22,
        y: 0.9 + ((seed + index * 2) % 3) * 0.28,
        z: 0.9 + ((seed + index * 5) % 4) * 0.2
      },
      position: {
        x: Number((Math.cos(angle) * radius).toFixed(2)),
        y: Number((Math.sin(angle) * (radius * 0.42)).toFixed(2)),
        z: Number((((index % 3) - 1) * 0.7).toFixed(2))
      },
      rotation: { x: 0, y: 0, z: 0 },
      label: keyword.toUpperCase().slice(0, 14)
    };
  }) satisfies z.infer<typeof simObjectSchema>[];

  const titleLower = topic.title.toLowerCase();
  const mathTopic = /(math|calculus|matrix|equation|algebra|physics|signal|probability|statistics)/.test(
    titleLower
  );
  const graphTopic = /(graph|plot|chart|signal|trend|statistics|regression|probability|distribution)/.test(
    titleLower
  );

  const stepOneMovements = baseObjects.slice(0, Math.max(2, Math.ceil(baseObjects.length / 3))).map((obj, index) => ({
    objectId: obj.id,
    type: "translate" as const,
    to: { x: obj.position.x + 1.2 + index * 0.4, y: obj.position.y - 0.5, z: obj.position.z },
    durationMs: 1900 + index * 180,
    repeat: 0
  }));

  const stepTwoMovements = baseObjects
    .slice(Math.max(1, Math.floor(baseObjects.length / 3)), Math.max(3, Math.floor((baseObjects.length * 2) / 3)))
    .map((obj, index) => ({
      objectId: obj.id,
      type: index % 2 === 0 ? ("rotate" as const) : ("scale" as const),
      axis: { x: 0.35 + index * 0.06, y: 1, z: 0.2 },
      durationMs: 1700 + index * 200,
      repeat: 0
    }));

  const stepThreeMovements = baseObjects.slice(-Math.max(2, Math.ceil(baseObjects.length / 3))).map((obj, index) => ({
    objectId: obj.id,
    type: index % 2 === 0 ? ("pulse" as const) : ("translate" as const),
    to: { x: obj.position.x + 1.6, y: obj.position.y + 0.4, z: obj.position.z },
    durationMs: 1800 + index * 210,
    repeat: index % 2 === 0 ? 1 : 0
  }));

  return [
    {
      step: 1,
      objects: baseObjects,
      movements: stepOneMovements,
      labels: [
        {
          text: `${topic.title}: input and setup phase`,
          position: { x: 0, y: 4.8, z: 0 },
          color: "#1f2937"
        }
      ],
      annotation: `Step 1 sets the input context for ${topic.title} and positions core components.`,
      mathExpressions: mathTopic
        ? [
            { expression: "v = d / t", variables: { d: 24, t: 6 } },
            { expression: "E = m * c^2", variables: { m: 0.002, c: 300000000 } }
          ]
        : undefined
    },
    {
      step: 2,
      objects: baseObjects,
      movements: stepTwoMovements,
      labels: [
        {
          text: `${topic.title}: transformation and internal processing`,
          position: { x: 0, y: 4.6, z: 0 },
          color: "#1f2937"
        }
      ],
      annotation: `Step 2 executes internal transformations and state changes for ${topic.title}.`,
      graph: graphTopic
        ? {
            type: "line",
            title: `${topic.title} trend`,
            x: [0, 1, 2, 3, 4, 5],
            y: [1, 1.5, 2.7, 3.4, 4.1, 4.8]
          }
        : undefined
    },
    {
      step: 3,
      objects: baseObjects,
      movements: stepThreeMovements,
      labels: [
        {
          text: `${topic.title}: validation and output`,
          position: { x: 0, y: 4.4, z: 0 },
          color: "#1f2937"
        }
      ],
      annotation: `Step 3 validates results and explains final output behavior for ${topic.title}.`
    }
  ];
}

function normalizeSimulationSteps(
  rawSteps: z.infer<typeof simStepSchema>[],
  fallback: z.infer<typeof simStepSchema>[]
): z.infer<typeof simStepSchema>[] {
  if (!rawSteps.length) {
    return fallback;
  }

  return rawSteps.slice(0, 12).map((step, index) => {
    const fallbackStep = fallback[index % fallback.length];
    const objectIds = new Set(step.objects.map((item) => item.id));
    const movements = step.movements
      .filter((move) => objectIds.has(move.objectId))
      .slice(0, 40);
    const labels = step.labels.slice(0, 24);
    const graph =
      step.graph && step.graph.x.length === step.graph.y.length && step.graph.x.length > 1
        ? step.graph
        : undefined;
    return {
      step: step.step,
      objects: step.objects.slice(0, 24),
      movements,
      labels,
      annotation: step.annotation.trim().slice(0, 300) || fallbackStep.annotation,
      mathExpressions: step.mathExpressions?.slice(0, 10),
      graph
    };
  });
}

function normalizeProblemSets(topic: Topic, llmData: z.infer<typeof llmSimulationSchema>): ProblemSet[] {
  const fallbackByLevel = new Map(buildGeneratedProblemSets(topic).map((set) => [set.level, set]));
  const generatedByLevel = new Map((llmData.problemSets ?? []).map((set) => [set.level, set]));

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
): Promise<z.infer<typeof llmSimulationSchema> | null> {
  if (!GEMINI_API_KEY || !GEMINI_MODEL) {
    return null;
  }

  const systemPrompt =
    "You are an expert technical tutor and simulation planner. Return only valid JSON.";
  const userPrompt = `
Generate teaching content for topic "${topic}" at ${level} depth.

Output strict JSON with this shape:
{
  "description": "string",
  "openingMessage": "string",
  "explanation_script": "full step-by-step script for narration",
  "narration": ["line1", "line2", "... 4-8 lines"],
  "simulation_steps": [
    {
      "step": 1,
      "objects": [
        {
          "id": "obj-1",
          "type": "box|sphere|cylinder|cone|torus|plane|line|arrow|text",
          "color": "#RRGGBB",
          "size": { "x": 1, "y": 1, "z": 1 },
          "position": { "x": 0, "y": 0, "z": 0 },
          "rotation": { "x": 0, "y": 0, "z": 0 },
          "label": "optional label"
        }
      ],
      "movements": [
        {
          "objectId": "obj-1",
          "type": "translate|rotate|scale|pulse",
          "to": { "x": 2, "y": 1, "z": 0 },
          "axis": { "x": 0, "y": 1, "z": 0 },
          "durationMs": 2200,
          "repeat": 0
        }
      ],
      "labels": [
        {
          "text": "annotation label",
          "objectId": "obj-1",
          "position": { "x": 0, "y": 2, "z": 0 },
          "color": "#RRGGBB"
        }
      ],
      "annotation": "what this step shows",
      "mathExpressions": [
        { "expression": "v = d / t", "variables": { "d": 10, "t": 2 } }
      ],
      "graph": {
        "type": "line|scatter|bar",
        "title": "graph title",
        "x": [0, 1, 2],
        "y": [0, 1, 4]
      }
    }
  ],
  "problemSets": [
    {
      "level": "beginner",
      "passingScore": 70,
      "problems": [
        {
          "question": "string",
          "choices": ["a", "b", "c", "d"],
          "answer": "one choice exactly",
          "explanation": "string"
        }
      ]
    },
    {
      "level": "intermediate",
      "passingScore": 75,
      "problems": [...]
    },
    {
      "level": "advanced",
      "passingScore": 80,
      "problems": [...]
    }
  ]
}

Rules:
- simulation_steps must be topic-specific and visually meaningful.
- Do not reuse generic object labels across unrelated topics.
- Keep object count per step between 4 and 12.
- Use labels and annotations so a learner can understand what each step means.
- Include mathExpressions only when topic needs math rigor.
- Include graph only when topic needs graph/data representation.
- Keep narration natural and simulation-oriented.
- Problems must match level difficulty.
- Keep content concise and practical.
- Return JSON only, no markdown.
`.trim();

  const response = await fetch(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json"
      }
    })
  }
  );

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

  const parsed = extractJsonObject(content);
  const validated = llmSimulationSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Gemini JSON validation failed: ${validated.error.issues[0]?.message ?? "Unknown issue"}`);
  }

  return validated.data;
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
  const topic = buildGeneratedTopic(requestedTopic, level);
  const fallbackSimulationSteps = buildTemplateSimulationSteps(topic);
  const llmGenerated = await generateSimulationFromGemini(requestedTopic, level);
  if (!llmGenerated) {
    res.status(503).json({
      error:
        "Gemini simulation generation is unavailable. Configure GEMINI_API_KEY and GEMINI_MODEL on the API service."
    });
    return;
  }

  topic.description = llmGenerated.description.trim();
  const narration = normalizeNarration(llmGenerated.narration);
  if (narration.length >= 3) {
    topic.narration = narration;
  }
  const explanationScript = llmGenerated.explanation_script.trim();
  const simulationSteps = normalizeSimulationSteps(llmGenerated.simulation_steps, fallbackSimulationSteps);
  const problemSets = normalizeProblemSets(topic, llmGenerated);
  const openingMessage = llmGenerated.openingMessage.trim();
  const generationSource: "gemini" = "gemini";

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

  res.json({
    topic,
    problemSets,
    openingMessage,
    generationSource,
    explanation_script: explanationScript,
    simulation_steps: simulationSteps
  });
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
