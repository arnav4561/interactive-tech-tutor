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

export interface SimulationGenerationResponse {
  topic: Topic;
  problemSets: ProblemSet[];
  openingMessage: string;
  generationSource?: "template" | "gemini";
}
