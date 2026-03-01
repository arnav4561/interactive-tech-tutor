export type DifficultyLevel = "beginner" | "intermediate" | "advanced";

export interface Topic {
  id: string;
  title: string;
  description: string;
  narration: string[];
  visualTheme: string;
}

export interface Problem {
  id: string;
  question: string;
  choices: string[];
  answer: string;
  explanation: string;
}

export interface ProblemSet {
  topicId: string;
  level: DifficultyLevel;
  passingScore: number;
  problems: Problem[];
}

export interface ProgressRecord {
  topicId: string;
  level: DifficultyLevel;
  status: "not-started" | "in-progress" | "completed";
  score: number;
  timeSpent: number;
  updatedAt: string;
}

export interface VoiceSettings {
  narrationEnabled: boolean;
  interactionEnabled: boolean;
  navigationEnabled: boolean;
  rate: number;
  voiceName: string;
}

export interface UserPreferences {
  interactionMode: "voice" | "click" | "both";
  voiceSettings: VoiceSettings;
}

export interface HistoryItem {
  id: string;
  topicId: string;
  type: "voice" | "text" | "action" | "visual";
  input: string;
  output: string;
  timestamp: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SimulationVector3 {
  x: number;
  y: number;
  z: number;
}

export interface SimulationObject {
  id: string;
  type: "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane" | "line" | "arrow" | "text";
  color: string;
  size: SimulationVector3;
  position: SimulationVector3;
  rotation?: SimulationVector3;
  label?: string;
}

export interface SimulationMovement {
  objectId: string;
  type: "translate" | "rotate" | "scale" | "pulse";
  to?: SimulationVector3;
  axis?: SimulationVector3;
  durationMs: number;
  repeat?: number;
}

export interface SimulationLabel {
  text: string;
  objectId?: string;
  position?: SimulationVector3;
  color?: string;
}

export interface SimulationConnection {
  fromId: string;
  toId: string;
  type?: "line" | "arrow" | "dashed";
  color?: string;
  label?: string;
}

export interface SimulationMathExpression {
  expression: string;
  variables?: Record<string, number>;
}

export interface SimulationGraph {
  type: "line" | "scatter" | "bar";
  title: string;
  x: number[];
  y: number[];
}

export interface SimulationStep {
  step: number;
  concept?: string;
  objects: SimulationObject[];
  movements: SimulationMovement[];
  labels: SimulationLabel[];
  connections?: SimulationConnection[];
  annotation: string;
  mathExpressions?: SimulationMathExpression[];
  graph?: SimulationGraph;
}

export interface SimulationGenerationResponse {
  topic: Topic;
  problemSets: ProblemSet[];
  openingMessage: string;
  generationSource?: "template" | "gemini";
  explanation_script: string;
  simulation_steps: SimulationStep[];
}
