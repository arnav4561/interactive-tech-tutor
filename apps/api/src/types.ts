export type DifficultyLevel = "beginner" | "intermediate" | "advanced";

export type InteractionType = "voice" | "text" | "action" | "visual";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface VoiceSettings {
  narrationEnabled: boolean;
  interactionEnabled: boolean;
  navigationEnabled: boolean;
  rate: number;
  voiceName: string;
}

export interface UserPreferences {
  userId: string;
  interactionMode: "voice" | "click" | "both";
  voiceSettings: VoiceSettings;
}

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
  userId: string;
  topicId: string;
  level: DifficultyLevel;
  status: "not-started" | "in-progress" | "completed";
  score: number;
  timeSpent: number;
  updatedAt: string;
}

export interface InteractionRecord {
  id: string;
  userId: string;
  topicId: string;
  type: InteractionType;
  input: string;
  output: string;
  timestamp: string;
  meta: Record<string, unknown>;
}

export interface StoreData {
  users: User[];
  preferences: UserPreferences[];
  progress: ProgressRecord[];
  history: InteractionRecord[];
}
