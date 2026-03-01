import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, prewarmApi } from "./api";
import {
  ChatMessage,
  DifficultyLevel,
  HistoryItem,
  ProblemSet,
  ProgressRecord,
  SimulationGenerationResponse,
  Topic,
  UserPreferences
} from "./types";

const LEVELS: DifficultyLevel[] = ["beginner", "intermediate", "advanced"];

type RecognitionConstructor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type AppView = "home" | "simulation" | "history-list" | "history-detail" | "progress-list";

type VisualKind = "service" | "store" | "queue" | "decision" | "client" | "processor";

interface VisualNode {
  id: string;
  label: string;
  kind: VisualKind;
}

interface VisualStep {
  id: string;
  title: string;
  action: string;
  highlightNodeIds: string[];
}

interface VisualPlan {
  sceneTitle: string;
  nodes: VisualNode[];
  steps: VisualStep[];
}

function toNodeKind(token: string): VisualKind {
  const value = token.toLowerCase();
  if (value.includes("queue") || value.includes("stream") || value.includes("event")) {
    return "queue";
  }
  if (value.includes("db") || value.includes("data") || value.includes("table") || value.includes("store")) {
    return "store";
  }
  if (value.includes("auth") || value.includes("rule") || value.includes("policy")) {
    return "decision";
  }
  if (value.includes("api") || value.includes("service") || value.includes("endpoint")) {
    return "service";
  }
  if (value.includes("user") || value.includes("client") || value.includes("browser")) {
    return "client";
  }
  return "processor";
}

function buildVisualPlanFromTopic(topic: Topic): VisualPlan {
  const mergedText = `${topic.title} ${topic.description} ${topic.narration.join(" ")}`
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .toLowerCase();

  const domainCatalog = [
    {
      key: "database",
      keywords: ["sql", "database", "query", "table", "index", "transaction", "postgres", "mongodb"],
      nodes: [
        { label: "CLIENT", kind: "client" as const },
        { label: "QUERY", kind: "service" as const },
        { label: "PLANNER", kind: "processor" as const },
        { label: "INDEX", kind: "store" as const },
        { label: "TABLE", kind: "store" as const },
        { label: "RESULT", kind: "service" as const }
      ]
    },
    {
      key: "network",
      keywords: ["http", "api", "network", "packet", "request", "response", "gateway", "route"],
      nodes: [
        { label: "CLIENT", kind: "client" as const },
        { label: "DNS", kind: "processor" as const },
        { label: "GATEWAY", kind: "service" as const },
        { label: "ROUTER", kind: "queue" as const },
        { label: "SERVICE", kind: "service" as const },
        { label: "RESPONSE", kind: "service" as const }
      ]
    },
    {
      key: "ai",
      keywords: ["model", "ai", "ml", "neural", "embedding", "inference", "training", "llm"],
      nodes: [
        { label: "INPUT", kind: "client" as const },
        { label: "TOKENIZER", kind: "processor" as const },
        { label: "EMBEDDING", kind: "store" as const },
        { label: "MODEL", kind: "processor" as const },
        { label: "DECODER", kind: "decision" as const },
        { label: "OUTPUT", kind: "service" as const }
      ]
    },
    {
      key: "frontend",
      keywords: ["react", "ui", "frontend", "component", "state", "render", "hook", "dom"],
      nodes: [
        { label: "EVENT", kind: "client" as const },
        { label: "STATE", kind: "store" as const },
        { label: "HOOK", kind: "processor" as const },
        { label: "RENDER", kind: "service" as const },
        { label: "DOM", kind: "service" as const },
        { label: "USER", kind: "client" as const }
      ]
    },
    {
      key: "security",
      keywords: ["auth", "token", "jwt", "encryption", "permission", "policy", "secure", "oauth"],
      nodes: [
        { label: "USER", kind: "client" as const },
        { label: "AUTH", kind: "decision" as const },
        { label: "TOKEN", kind: "store" as const },
        { label: "POLICY", kind: "decision" as const },
        { label: "RESOURCE", kind: "service" as const },
        { label: "AUDIT", kind: "store" as const }
      ]
    }
  ] as const;

  const domain = domainCatalog
    .map((entry) => ({
      entry,
      score: entry.keywords.reduce((sum, keyword) => sum + (mergedText.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.entry;

  const tokens = Array.from(
    new Set(
      mergedText
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4)
    )
  ).slice(0, 12);

  const fallbackNodes = ["input", "transform", "validate", "route", "store", "output"].map((token) => ({
    label: token.toUpperCase(),
    kind: toNodeKind(token)
  }));

  const baseNodes = domain?.nodes ?? fallbackNodes;
  const nodes: VisualNode[] = baseNodes.slice(0, 8).map((node, index) => ({
    id: `node-${index + 1}`,
    label: node.label,
    kind: node.kind
  }));

  const narrationLines = topic.narration.filter((line) => line.trim().length > 0);
  const stepSource =
    narrationLines.length > 0
      ? narrationLines
      : [
          `Initialize ${topic.title} context and identify input.`,
          "Process through core transformation stages.",
          "Validate intermediate output and handle edge cases.",
          "Deliver final output and close feedback loop."
        ];

  const steps: VisualStep[] = stepSource.slice(0, 8).map((line, index) => {
    const focusTerms = line
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 4);

    const matched = nodes
      .filter((node) => {
        const label = node.label.toLowerCase();
        return focusTerms.some((term) => label.includes(term) || term.includes(label.slice(0, 4)));
      })
      .map((node) => node.id);

    const fallback = [
      nodes[index % nodes.length]?.id,
      nodes[(index + 1) % nodes.length]?.id
    ].filter((value): value is string => Boolean(value));

    const highlightNodeIds = matched.length > 0 ? matched.slice(0, 3) : fallback;
    const conciseAction = line.trim().replace(/\s+/g, " ").slice(0, 150);
    const termHint = tokens[index % Math.max(tokens.length, 1)] ?? "";
    const action = termHint && !conciseAction.toLowerCase().includes(termHint)
      ? `${conciseAction} [focus: ${termHint.toUpperCase()}]`
      : conciseAction;

    return {
      id: `step-${index + 1}`,
      title: `Stage ${index + 1}`,
      action,
      highlightNodeIds
    };
  });

  return {
    sceneTitle: topic.title,
    nodes,
    steps
  };
}

function defaultPreferences(): UserPreferences {
  return {
    interactionMode: "click",
    voiceSettings: {
      narrationEnabled: false,
      interactionEnabled: false,
      navigationEnabled: false,
      rate: 1,
      voiceName: ""
    }
  };
}

function loadVoiceCapturePreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return localStorage.getItem("itt_voice_capture") === "true";
}

function loadSubtitlePreference(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return localStorage.getItem("itt_subtitles") !== "false";
}

export default function App(): JSX.Element {
  const [displayName, setDisplayName] = useState<string>(() => localStorage.getItem("itt_name") ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [token, setToken] = useState<string>(() => localStorage.getItem("itt_token") ?? "");
  const [userEmail, setUserEmail] = useState<string>(() => localStorage.getItem("itt_email") ?? "");
  const [userName, setUserName] = useState<string>(() => localStorage.getItem("itt_name") ?? "");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string>("");
  const [selectedLevel, setSelectedLevel] = useState<DifficultyLevel>("beginner");
  const [problemSets, setProblemSets] = useState<ProblemSet[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<ProgressRecord[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [feedbackText, setFeedbackText] = useState("");
  const [uploadFeedback, setUploadFeedback] = useState("");
  const [statusMessage, setStatusMessage] = useState("Ready.");
  const [loading, setLoading] = useState(false);
  const [appView, setAppView] = useState<AppView>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(true);
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false);
  const [simulationPaused, setSimulationPaused] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceCaptureEnabled, setVoiceCaptureEnabled] = useState<boolean>(() => loadVoiceCapturePreference());
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(() => loadSubtitlePreference());
  const [preferences, setPreferences] = useState<UserPreferences>(() => defaultPreferences());
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [customTopicInput, setCustomTopicInput] = useState("");
  const [generatingTopic, setGeneratingTopic] = useState(false);
  const [generatedProblemSets, setGeneratedProblemSets] = useState<Record<string, ProblemSet[]>>({});
  const [generatedVisualPlans, setGeneratedVisualPlans] = useState<Record<string, VisualPlan>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentStepText, setCurrentStepText] = useState("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const narrationTimersRef = useRef<number[]>([]);
  const subtitleTimerRef = useRef<number | null>(null);
  const voiceCaptureDesiredRef = useRef(false);
  const narrationSessionRef = useRef(0);
  const appViewRef = useRef<AppView>("home");
  const lastNarratedTopicRef = useRef("");
  const isNarratingRef = useRef(false);
  const simulationStepRef = useRef(0);

  const selectedTopic = useMemo(
    () => topics.find((topic) => topic.id === selectedTopicId) ?? null,
    [topics, selectedTopicId]
  );

  const topicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    topics.forEach((topic) => {
      map.set(topic.id, topic.title);
    });
    return map;
  }, [topics]);

  const chatHistory = useMemo(
    () => history.filter((item) => item.type === "text" || item.type === "voice"),
    [history]
  );

  const selectedHistoryItem = useMemo(
    () => chatHistory.find((item) => item.id === selectedHistoryId) ?? null,
    [chatHistory, selectedHistoryId]
  );

  const selectedVisualPlan = useMemo(() => {
    if (!selectedTopic) {
      return null;
    }
    return generatedVisualPlans[selectedTopic.id] ?? buildVisualPlanFromTopic(selectedTopic);
  }, [generatedVisualPlans, selectedTopic]);

  const sortedProgress = useMemo(
    () =>
      progress
        .slice()
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [progress]
  );

  const currentProblemSet = useMemo(
    () => problemSets.find((set) => set.level === selectedLevel),
    [problemSets, selectedLevel]
  );

  const unlockedLevels = useMemo(() => {
    const completed = new Set(
      progress
        .filter((record) => record.topicId === selectedTopicId && record.status === "completed")
        .map((record) => record.level)
    );
    const unlocked = new Set<DifficultyLevel>(["beginner"]);
    if (completed.has("beginner")) {
      unlocked.add("intermediate");
    }
    if (completed.has("intermediate")) {
      unlocked.add("advanced");
    }
    return unlocked;
  }, [progress, selectedTopicId]);

  const persistPreferences = useCallback(
    async (next: UserPreferences) => {
      if (!token) {
        return;
      }
      try {
        await apiPut<{ preferences: UserPreferences }>("/preferences", next, token);
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [token]
  );

  const setAndPersistPreferences = useCallback(
    (next: UserPreferences) => {
      setPreferences(next);
      void persistPreferences(next);
    },
    [persistPreferences]
  );

  const speakText = useCallback(
    (text: string, interrupt = false): Promise<void> => {
      if (!("speechSynthesis" in window)) {
        return Promise.resolve();
      }
      const synth = window.speechSynthesis;
      if (interrupt) {
        synth.cancel();
      }
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = preferences.voiceSettings.rate;
        const byName = availableVoices.find(
          (item) => item.name.toLowerCase() === preferences.voiceSettings.voiceName.toLowerCase()
        );
        const voiceBox = availableVoices.find((item) => item.name.toLowerCase().includes("voice box"));
        const fallbackEnglish = availableVoices.find((item) => item.lang.toLowerCase().startsWith("en"));
        const preferredVoice = byName ?? voiceBox ?? fallbackEnglish;
        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        synth.speak(utterance);
      });
    },
    [availableVoices, preferences.voiceSettings.rate, preferences.voiceSettings.voiceName]
  );

  const speak = useCallback(
    (text: string, interrupt = false) => {
      void speakText(text, interrupt);
    },
    [speakText]
  );

  const clearNarrationTimers = useCallback(() => {
    narrationSessionRef.current += 1;
    isNarratingRef.current = false;
    narrationTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    narrationTimersRef.current = [];
    if (subtitleTimerRef.current !== null) {
      window.clearTimeout(subtitleTimerRef.current);
      subtitleTimerRef.current = null;
    }
    setSubtitle("");
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const pushSubtitle = useCallback((text: string, durationMs = 2600) => {
    setSubtitle(text);
    if (subtitleTimerRef.current !== null) {
      window.clearTimeout(subtitleTimerRef.current);
    }
    subtitleTimerRef.current = window.setTimeout(() => {
      setSubtitle("");
      subtitleTimerRef.current = null;
    }, durationMs);
  }, []);

  const playNarration = useCallback(
    (topic: Topic) => {
      if (lastNarratedTopicRef.current === topic.id && appViewRef.current === "simulation") {
        return;
      }
      lastNarratedTopicRef.current = topic.id;
      clearNarrationTimers();
      if (appViewRef.current !== "simulation") {
        return;
      }
      const sessionId = narrationSessionRef.current;
      const narrationLines = topic.narration.filter((line) => line.trim().length > 0);
      if (narrationLines.length === 0) {
        return;
      }

      const run = async () => {
        isNarratingRef.current = true;
        for (const line of narrationLines) {
          if (narrationSessionRef.current !== sessionId || appViewRef.current !== "simulation") {
            isNarratingRef.current = false;
            return;
          }
          if (subtitlesEnabled) {
            setSubtitle(line);
          } else {
            setSubtitle("");
          }

          if (preferences.voiceSettings.narrationEnabled) {
            await speakText(line, false);
          } else {
            const waitMs = Math.max(1300, Math.round((line.length * 35) / preferences.voiceSettings.rate));
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => resolve(), waitMs);
              narrationTimersRef.current.push(timer);
            });
          }

          if (narrationSessionRef.current !== sessionId || appViewRef.current !== "simulation") {
            isNarratingRef.current = false;
            return;
          }
        }

        isNarratingRef.current = false;
        if (narrationSessionRef.current === sessionId && subtitlesEnabled) {
          setSubtitle("");
        }
      };

      void run();
    },
    [clearNarrationTimers, preferences.voiceSettings.narrationEnabled, preferences.voiceSettings.rate, speakText, subtitlesEnabled]
  );

  const loadHistory = useCallback(async (topicId?: string) => {
    if (!token) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const query = topicId ? `?topicId=${encodeURIComponent(topicId)}` : "";
      const response = await apiGet<{ history: HistoryItem[] }>(`/history${query}`, token);
      setHistory(response.history);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  const runActionFeedback = useCallback(
    async (actionType: "drag" | "scroll" | "back" | "voice-command" | "navigation", detail: string) => {
      if (!token || !selectedTopicId) {
        return;
      }
      try {
        const response = await apiPost<{ response: string }>(
          "/ai/feedback/action",
          {
            topicId: selectedTopicId,
            actionType,
            detail
          },
          token
        );
        setFeedbackText(response.response);
        if (appViewRef.current === "simulation") {
          if (subtitlesEnabled) {
            pushSubtitle(response.response, 3200);
          }
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [loadHistory, pushSubtitle, selectedTopicId, subtitlesEnabled, token]
  );

  const bootstrap = useCallback(
    async (authToken: string) => {
      setLoading(true);
      try {
        const [topicsResponse, progressResponse, prefResponse] = await Promise.all([
          apiGet<{ topics: Topic[] }>("/topics", authToken),
          apiGet<{ progress: ProgressRecord[] }>("/progress", authToken),
          apiGet<{ preferences: UserPreferences }>("/preferences", authToken)
        ]);

        setTopics(topicsResponse.topics);
        setProgress(progressResponse.progress);
        setPreferences({
          ...prefResponse.preferences,
          interactionMode: "click",
          voiceSettings: {
            ...prefResponse.preferences.voiceSettings,
            narrationEnabled: false,
            interactionEnabled: false,
            navigationEnabled: false,
            rate: 1
          }
        });
        setSelectedTopicId((current) => current || topicsResponse.topics[0]?.id || "");
        if (!userName.trim()) {
          const localEmail = localStorage.getItem("itt_email") ?? "";
          const localName = localStorage.getItem("itt_name") ?? "";
          setUserName(localName.trim() || localEmail.split("@")[0] || "Learner");
        }
        setAppView("home");
        setStatusMessage("Session restored.");
      } catch (error) {
        setStatusMessage((error as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [userName]
  );

  const handleAuth = useCallback(async () => {
    setLoading(true);
    setStatusMessage(registerMode ? "Creating account..." : "Authenticating...");
    try {
      const route = registerMode ? "/auth/register" : "/auth/login";
      const response = await apiPost<{
        token: string;
        user: { email: string };
      }>(route, { email, password });

      const fallbackName = response.user.email.split("@")[0] || "Learner";
      const storedName = localStorage.getItem("itt_name")?.trim() ?? "";
      const normalizedName = registerMode ? displayName.trim() || fallbackName : storedName || fallbackName;
      setToken(response.token);
      setUserEmail(response.user.email);
      setUserName(normalizedName);
      localStorage.setItem("itt_token", response.token);
      localStorage.setItem("itt_email", response.user.email);
      if (normalizedName) {
        localStorage.setItem("itt_name", normalizedName);
      }
      setStatusMessage(registerMode ? "Account created." : "Login successful.");
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [displayName, email, password, registerMode]);

  const handleLogout = useCallback(() => {
    voiceCaptureDesiredRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setVoiceCaptureEnabled(false);
    setAppView("home");
    setMenuOpen(false);
    setToken("");
    setUserEmail("");
    setUserName("");
    setTopics([]);
    setProgress([]);
    setProblemSets([]);
    setHistory([]);
    setMessages([]);
    setGeneratedProblemSets({});
    setGeneratedVisualPlans({});
    setCustomTopicInput("");
    setSelectedHistoryId("");
    setChatPanelOpen(true);
    setToolsPanelOpen(false);
    setSimulationPaused(false);
    clearNarrationTimers();
    localStorage.removeItem("itt_token");
    localStorage.removeItem("itt_email");
    localStorage.removeItem("itt_name");
    localStorage.removeItem("itt_voice_capture");
    localStorage.removeItem("itt_subtitles");
    setStatusMessage("Logged out.");
  }, [clearNarrationTimers]);

  const generateCustomSimulation = useCallback(async () => {
    const requestedTopic = customTopicInput.trim();
    if (!token || !requestedTopic) {
      return;
    }

    setGeneratingTopic(true);
    try {
      const response = await apiPost<SimulationGenerationResponse>(
        "/ai/simulation",
        {
          topic: requestedTopic,
          level: selectedLevel
        },
        token
      );
      setTopics((current) => [response.topic, ...current.filter((topic) => topic.id !== response.topic.id)]);
      setGeneratedProblemSets((current) => ({
        ...current,
        [response.topic.id]: response.problemSets
      }));
      setGeneratedVisualPlans((current) => ({
        ...current,
        [response.topic.id]: buildVisualPlanFromTopic(response.topic)
      }));
      setSelectedTopicId(response.topic.id);
      setAppView("simulation");
      simulationStepRef.current = 0;
      setSimulationPaused(false);
      setMenuOpen(false);
      setMessages((current) => [...current, { role: "assistant", text: response.openingMessage }]);
      if (subtitlesEnabled) {
        setSubtitle(response.openingMessage);
      }
      const source = response.generationSource === "gemini" ? "Gemini" : "template";
      setStatusMessage(`Generated simulation for ${response.topic.title} (${source}).`);
      setCustomTopicInput("");
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setGeneratingTopic(false);
    }
  }, [customTopicInput, selectedLevel, subtitlesEnabled, token]);

  const sendChat = useCallback(
    async (mode: "voice" | "text", rawMessage?: string) => {
      const message = (rawMessage ?? chatInput).trim();
      if (!message || !token || !selectedTopicId) {
        return;
      }

      setMessages((current) => [...current, { role: "user", text: message }]);
      setChatInput("");

      try {
        const response = await apiPost<{ response: string }>(
          "/ai/chat",
          {
            topicId: selectedTopicId,
            message,
            mode
          },
          token
        );
        setMessages((current) => [...current, { role: "assistant", text: response.response }]);
        if (appViewRef.current === "simulation") {
          if (subtitlesEnabled) {
            pushSubtitle(response.response, 3200);
          }
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [chatInput, loadHistory, pushSubtitle, selectedTopicId, subtitlesEnabled, token]
  );

  const processVoiceCommand = useCallback(
    (input: string): boolean => {
      const command = input.toLowerCase();
      if (command.includes("next topic")) {
        const currentIndex = topics.findIndex((item) => item.id === selectedTopicId);
        const nextTopic = topics[(currentIndex + 1) % topics.length];
        if (nextTopic) {
          setSelectedTopicId(nextTopic.id);
          setStatusMessage(`Switched to topic: ${nextTopic.title}`);
          void runActionFeedback("voice-command", `next-topic:${nextTopic.title}`);
        }
        return true;
      }

      if (command.includes("previous topic") || command.includes("back topic")) {
        const currentIndex = topics.findIndex((item) => item.id === selectedTopicId);
        const prevIndex = currentIndex <= 0 ? topics.length - 1 : currentIndex - 1;
        const prevTopic = topics[prevIndex];
        if (prevTopic) {
          setSelectedTopicId(prevTopic.id);
          setStatusMessage(`Switched to topic: ${prevTopic.title}`);
          void runActionFeedback("voice-command", `previous-topic:${prevTopic.title}`);
        }
        return true;
      }

      for (const level of LEVELS) {
        if (command.includes(level)) {
          if (!unlockedLevels.has(level)) {
            setStatusMessage(`${level} is locked. Complete previous level first.`);
            return true;
          }
          setSelectedLevel(level);
          setStatusMessage(`Difficulty changed to ${level}.`);
          void runActionFeedback("voice-command", `difficulty:${level}`);
          return true;
        }
      }

      if (command.includes("mute narration")) {
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: false }
        };
        setAndPersistPreferences(next);
        void runActionFeedback("voice-command", "mute-narration");
        return true;
      }

      if (command.includes("enable narration") || command.includes("unmute narration")) {
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: true }
        };
        setAndPersistPreferences(next);
        void runActionFeedback("voice-command", "unmute-narration");
        return true;
      }

      if (command.includes("mute subtitles")) {
        setSubtitlesEnabled(false);
        setStatusMessage("Subtitles muted.");
        return true;
      }

      if (command.includes("show subtitles") || command.includes("unmute subtitles")) {
        setSubtitlesEnabled(true);
        setStatusMessage("Subtitles enabled.");
        return true;
      }

      if (command.includes("stop voice capture") || command.includes("stop listening")) {
        setVoiceCaptureEnabled(false);
        setStatusMessage("Voice capture disabled by voice command.");
        void runActionFeedback("voice-command", "stop-capture");
        return true;
      }

      if (command.includes("start voice capture") || command.includes("resume listening")) {
        setVoiceCaptureEnabled(true);
        setStatusMessage("Voice capture enabled by voice command.");
        void runActionFeedback("voice-command", "start-capture");
        return true;
      }

      if (command.includes("go back")) {
        setAppView((current) => {
          if (current === "history-detail") {
            return "history-list";
          }
          if (current === "simulation" || current === "history-list" || current === "progress-list") {
            return "home";
          }
          return current;
        });
        setStatusMessage("Moved back.");
        return true;
      }

      return false;
    },
    [preferences, runActionFeedback, selectedTopicId, setAndPersistPreferences, topics, unlockedLevels]
  );

  const startListening = useCallback(() => {
    if (listening) {
      return;
    }
    if (appView !== "simulation") {
      return;
    }
    if (!preferences.voiceSettings.interactionEnabled && !preferences.voiceSettings.navigationEnabled) {
      setStatusMessage("Enable Voice Interaction or Voice Navigation before capturing voice.");
      return;
    }

    const win = window as Window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      setStatusMessage("Speech recognition is not supported in this browser.");
      return;
    }

    voiceCaptureDesiredRef.current = true;

    if (!recognitionRef.current) {
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognitionRef.current = recognition;
    }

    recognitionRef.current.onresult = (event) => {
      const lastResult = event.results[event.results.length - 1];
      const transcript = lastResult[0]?.transcript?.trim();
      if (!transcript) {
        return;
      }

      const handled = preferences.voiceSettings.navigationEnabled ? processVoiceCommand(transcript) : false;

      if (!handled && preferences.voiceSettings.interactionEnabled) {
        void sendChat("voice", transcript);
      }
    };
    recognitionRef.current.onerror = (event) => {
      setStatusMessage(`Voice input error: ${event.error}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        voiceCaptureDesiredRef.current = false;
        setVoiceCaptureEnabled(false);
      }
    };
    recognitionRef.current.onend = () => {
      setListening(false);
      if (!voiceCaptureDesiredRef.current) {
        return;
      }
      window.setTimeout(() => {
        if (!voiceCaptureDesiredRef.current || !recognitionRef.current) {
          return;
        }
        try {
          recognitionRef.current.start();
          setListening(true);
        } catch (_error) {
          // Browser may reject rapid restart; next recognition cycle will retry.
        }
      }, 280);
    };

    try {
      recognitionRef.current.start();
      setListening(true);
      setStatusMessage("Voice capture active.");
    } catch (error) {
      setStatusMessage(`Unable to start voice capture: ${(error as Error).message}`);
    }
  }, [appView, listening, preferences, processVoiceCommand, sendChat]);

  const stopListening = useCallback(() => {
    voiceCaptureDesiredRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
    }
  }, []);

  const submitCurrentProblemSet = useCallback(async () => {
    if (!currentProblemSet || !token || !selectedTopicId) {
      return;
    }

    const solved = currentProblemSet.problems.length;
    const correctCount = currentProblemSet.problems.filter(
      (problem) => selectedAnswers[problem.id] === problem.answer
    ).length;
    const score = solved === 0 ? 0 : Math.round((correctCount / solved) * 100);
    const status = score >= currentProblemSet.passingScore ? "completed" : "in-progress";

    try {
      const response = await apiPost<{ unlockedLevel: DifficultyLevel | null; progress: ProgressRecord }>(
        "/progress/update",
        {
          topicId: selectedTopicId,
          level: currentProblemSet.level,
          status,
          score,
          timeSpent: Math.max(60, solved * 25)
        },
        token
      );
      setProgress((current) => {
        const next = current.filter(
          (record) => !(record.topicId === selectedTopicId && record.level === currentProblemSet.level)
        );
        next.push(response.progress);
        return next;
      });
      if (response.unlockedLevel) {
        setSelectedLevel(response.unlockedLevel);
      }
      setStatusMessage(
        response.unlockedLevel
          ? `Level completed. ${response.unlockedLevel} unlocked.`
          : status === "completed"
            ? "Level completed."
            : "Level in progress. Improve score to unlock next level."
      );
    } catch (error) {
      setStatusMessage((error as Error).message);
    }
  }, [currentProblemSet, selectedAnswers, selectedTopicId, token]);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!token || !selectedTopicId) {
        return;
      }
      try {
        const response = await apiPost<{ response: string }>(
          "/ai/visual",
          {
            topicId: selectedTopicId,
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
            size: file.size
          },
          token
        );
        setUploadFeedback(response.response);
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [loadHistory, selectedTopicId, token]
  );

  const deleteTopicHistory = useCallback(async () => {
    if (!token || !selectedTopicId) {
      return;
    }
    try {
      await apiDelete<{ removedCount: number }>(`/history/topic/${selectedTopicId}`, token);
      await loadHistory();
      setStatusMessage("Topic history deleted.");
    } catch (error) {
      setStatusMessage((error as Error).message);
    }
  }, [loadHistory, selectedTopicId, token]);

  const openHistoryPage = useCallback(async () => {
    setMenuOpen(false);
    setSelectedHistoryId("");
    await loadHistory();
    setAppView("history-list");
    setStatusMessage("Viewing interaction history.");
  }, [loadHistory]);

  const openHistoryDetail = useCallback((historyId: string) => {
    setSelectedHistoryId(historyId);
    setAppView("history-detail");
  }, []);

  const openProgressPage = useCallback(() => {
    setMenuOpen(false);
    setAppView("progress-list");
    setStatusMessage("Viewing topic progress.");
  }, []);

  const navigateBack = useCallback(() => {
    if (appView === "history-detail") {
      setAppView("history-list");
      return;
    }
    if (appView === "history-list") {
      setAppView("home");
      setStatusMessage("Returned to home.");
      return;
    }
    if (appView === "progress-list") {
      setAppView("home");
      setStatusMessage("Returned to home.");
      return;
    }
    if (appView === "simulation") {
      setSimulationPaused(true);
      setToolsPanelOpen(false);
      setAppView("home");
      setStatusMessage("Returned to home.");
    }
  }, [appView]);

  useEffect(() => {
    if (token) {
      void bootstrap(token);
    }
  }, [bootstrap, token]);

  useEffect(() => {
    if (token) {
      return;
    }
    void prewarmApi();
  }, [token]);

  useEffect(() => {
    appViewRef.current = appView;
  }, [appView]);

  useEffect(() => {
    if (appView !== "simulation") {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" && !simulationPaused) {
        setSimulationPaused(true);
        setStatusMessage("Simulation paused because this tab is in the background.");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [appView, simulationPaused]);

  useEffect(() => {
    localStorage.setItem("itt_voice_capture", String(voiceCaptureEnabled));
  }, [voiceCaptureEnabled]);

  useEffect(() => {
    localStorage.setItem("itt_subtitles", String(subtitlesEnabled));
  }, [subtitlesEnabled]);

  useEffect(() => {
    if (!token) {
      return;
    }
    // Voice capture is intentionally disabled in the current simulation build.
    stopListening();
  }, [appView, stopListening, token, voiceCaptureEnabled]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const synth = window.speechSynthesis;
    const refreshVoices = () => {
      const voices = synth.getVoices();
      setAvailableVoices(voices);
      const matchedVoice = voices.find((voice) => voice.name.toLowerCase().includes("voice box"));
      if (
        matchedVoice &&
        !preferences.voiceSettings.voiceName &&
        preferences.voiceSettings.interactionEnabled
      ) {
        const next = {
          ...preferences,
          voiceSettings: {
            ...preferences.voiceSettings,
            voiceName: matchedVoice.name
          }
        };
        setAndPersistPreferences(next);
      }
    };

    refreshVoices();
    synth.addEventListener("voiceschanged", refreshVoices);
    return () => synth.removeEventListener("voiceschanged", refreshVoices);
  }, [
    preferences,
    preferences.voiceSettings.interactionEnabled,
    preferences.voiceSettings.voiceName,
    setAndPersistPreferences
  ]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void loadHistory();
  }, [loadHistory, selectedTopicId, token]);

  useEffect(() => {
    if (!token || appView !== "simulation" || !selectedTopicId) {
      return;
    }

    const loadTopicData = async () => {
      const generatedSet = generatedProblemSets[selectedTopicId];
      if (generatedSet) {
        setProblemSets(generatedSet);
        setSelectedAnswers({});
        return;
      }

      try {
        const response = await apiGet<{ problemSets: ProblemSet[] }>(
          `/topics/${selectedTopicId}/problem-sets`,
          token
        );
        setProblemSets(response.problemSets);
        setSelectedAnswers({});
      } catch (error) {
        setProblemSets([]);
        setStatusMessage((error as Error).message);
      }
    };

    void loadTopicData();
  }, [appView, generatedProblemSets, selectedTopicId, token]);

  useEffect(() => {
    if (!selectedTopicId) {
      return;
    }
    const topicProgress = progress.filter((record) => record.topicId === selectedTopicId);
    const advancedDone = topicProgress.find(
      (record) => record.level === "advanced" && record.status === "completed"
    );
    if (advancedDone) {
      setStatusMessage("Topic completed across all levels.");
    }
  }, [progress, selectedTopicId]);

  useEffect(() => {
    if (!unlockedLevels.has(selectedLevel)) {
      setSelectedLevel("beginner");
    }
  }, [selectedLevel, unlockedLevels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedTopic || !selectedVisualPlan || appView !== "simulation") {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    let animationFrame = 0;
    let lastRenderTime = performance.now();
    let elapsedStepMs = 0;
    let simClock = 0;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);

    const stepDurationMs = 2600;
    const seed = selectedVisualPlan.sceneTitle
      .split("")
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const paletteOptions = [
      {
        bgA: "#f5f7fb",
        bgB: "#edf2f9",
        bgC: "#fff3c4",
        line: "rgba(43, 53, 69, 0.22)",
        text: "#1f2937",
        accent: "#f7c948",
        card: "rgba(255, 255, 255, 0.84)"
      },
      {
        bgA: "#f4f7f8",
        bgB: "#e7edf1",
        bgC: "#ffe8af",
        line: "rgba(39, 45, 56, 0.22)",
        text: "#20262f",
        accent: "#efb940",
        card: "rgba(255, 255, 255, 0.82)"
      },
      {
        bgA: "#f8f9fa",
        bgB: "#edf1f4",
        bgC: "#fff0bf",
        line: "rgba(49, 55, 66, 0.2)",
        text: "#1f252f",
        accent: "#e7ad2f",
        card: "rgba(255, 255, 255, 0.85)"
      }
    ] as const;
    const palette = paletteOptions[seed % paletteOptions.length];

    const nodes = selectedVisualPlan.nodes.slice(0, 12);
    const steps = selectedVisualPlan.steps.length > 0 ? selectedVisualPlan.steps : [
      {
        id: "step-1",
        title: "Step 1",
        action: `Exploring ${selectedTopic.title} flow.`,
        highlightNodeIds: nodes.slice(0, 3).map((item) => item.id)
      }
    ];

    if (simulationStepRef.current >= steps.length) {
      simulationStepRef.current = 0;
    }

    const nodeLayouts = nodes.map((node, index) => {
      const count = Math.max(nodes.length, 1);
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      const radiusX = Math.max(140, width * 0.33);
      const radiusY = Math.max(110, height * 0.27);
      return {
        node,
        x: width * 0.5 + Math.cos(angle) * radiusX,
        y: height * 0.52 + Math.sin(angle) * radiusY
      };
    });

    const nodeMap = new Map(nodeLayouts.map((item) => [item.node.id, item]));

    const draggable = {
      x: width * 0.08,
      y: height * 0.82,
      size: 38,
      label: "CTRL"
    };

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const drawRoundedRect = (x: number, y: number, w: number, h: number, radius: number) => {
      context.beginPath();
      context.moveTo(x + radius, y);
      context.lineTo(x + w - radius, y);
      context.quadraticCurveTo(x + w, y, x + w, y + radius);
      context.lineTo(x + w, y + h - radius);
      context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      context.lineTo(x + radius, y + h);
      context.quadraticCurveTo(x, y + h, x, y + h - radius);
      context.lineTo(x, y + radius);
      context.quadraticCurveTo(x, y, x + radius, y);
      context.closePath();
    };

    const drawNodeByKind = (x: number, y: number, size: number, kind: VisualKind) => {
      if (kind === "store") {
        drawRoundedRect(x - size * 1.1, y - size * 0.8, size * 2.2, size * 1.6, 8);
        return;
      }
      if (kind === "queue") {
        context.beginPath();
        context.moveTo(x - size, y);
        context.lineTo(x, y - size);
        context.lineTo(x + size, y);
        context.lineTo(x, y + size);
        context.closePath();
        return;
      }
      if (kind === "decision") {
        context.beginPath();
        context.moveTo(x, y - size * 1.2);
        context.lineTo(x + size, y);
        context.lineTo(x, y + size * 1.2);
        context.lineTo(x - size, y);
        context.closePath();
        return;
      }
      if (kind === "client") {
        context.beginPath();
        context.arc(x, y, size, 0, Math.PI * 2);
        context.closePath();
        return;
      }
      if (kind === "service") {
        context.beginPath();
        context.rect(x - size, y - size, size * 2, size * 2);
        context.closePath();
        return;
      }
      context.beginPath();
      context.moveTo(x, y - size * 1.2);
      context.lineTo(x + size, y + size * 0.9);
      context.lineTo(x - size, y + size * 0.9);
      context.closePath();
    };

    const drawBackground = () => {
      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, palette.bgA);
      bg.addColorStop(0.62, palette.bgB);
      bg.addColorStop(1, palette.bgC);
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      for (let x = 0; x < width; x += 56) {
        context.strokeStyle = "rgba(24, 34, 45, 0.04)";
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = 0; y < height; y += 52) {
        context.strokeStyle = "rgba(24, 34, 45, 0.04)";
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      context.fillStyle = palette.text;
      context.font = "700 15px 'Trebuchet MS', sans-serif";
      context.fillText(selectedVisualPlan.sceneTitle, 20, 28);
      context.font = "12px 'Trebuchet MS', sans-serif";
      context.fillStyle = "rgba(30, 37, 46, 0.72)";
      context.fillText("Topic-driven motion sequence generated from model context", 20, 48);
    };

    const syncSubtitleWithStep = () => {
      const currentStep = steps[simulationStepRef.current];
      setCurrentStepText(currentStep ? `${currentStep.title}: ${currentStep.action}` : "");
      if (!subtitlesEnabled) {
        setSubtitle("");
        return;
      }
      setSubtitle(currentStep ? currentStep.action : "");
    };

    syncSubtitleWithStep();

    const render = (time: number) => {
      const deltaMs = Math.min(50, time - lastRenderTime);
      lastRenderTime = time;

      if (!simulationPaused && !document.hidden) {
        simClock += deltaMs;
        elapsedStepMs += deltaMs;
        if (elapsedStepMs >= stepDurationMs) {
          elapsedStepMs = 0;
          simulationStepRef.current = (simulationStepRef.current + 1) % steps.length;
          syncSubtitleWithStep();
        }
      }

      drawBackground();

      const currentStep = steps[simulationStepRef.current];
      const highlighted = new Set(currentStep?.highlightNodeIds ?? []);

      const highlightedLayouts = (currentStep?.highlightNodeIds ?? [])
        .map((id) => nodeMap.get(id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      drawRoundedRect(16, 58, Math.min(width - 32, 560), 50, 10);
      context.fillStyle = palette.card;
      context.fill();
      context.strokeStyle = palette.line;
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = palette.text;
      context.font = "700 12px 'Trebuchet MS', sans-serif";
      context.fillText(`Now Explaining: ${currentStep?.title ?? "Stage"}`, 28, 79);
      context.font = "11px 'Trebuchet MS', sans-serif";
      context.fillText((currentStep?.action ?? "").slice(0, 84), 28, 98);

      for (let index = 0; index < highlightedLayouts.length - 1; index += 1) {
        const from = highlightedLayouts[index];
        const to = highlightedLayouts[index + 1];
        context.strokeStyle = "rgba(63, 74, 89, 0.72)";
        context.lineWidth = 2.2;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }

      nodeLayouts.forEach((item, index) => {
        const pulse = highlighted.has(item.node.id) ? 1 + 0.08 * Math.sin(simClock / 180 + index) : 1;
        const size = 24 * pulse;
        drawNodeByKind(item.x, item.y, size, item.node.kind);
        context.fillStyle = highlighted.has(item.node.id)
          ? "rgba(247, 201, 72, 0.64)"
          : "rgba(255, 255, 255, 0.88)";
        context.fill();
        context.strokeStyle = palette.line;
        context.lineWidth = highlighted.has(item.node.id) ? 2 : 1.2;
        context.stroke();

        context.fillStyle = palette.text;
        context.font = "600 11px 'Trebuchet MS', sans-serif";
        const label = item.node.label.length > 10 ? `${item.node.label.slice(0, 10)}.` : item.node.label;
        context.fillText(label, item.x - 30, item.y + 4);
      });

      const target = highlightedLayouts[0] ?? nodeLayouts[0];
      const markerRadius = 14;
      context.beginPath();
      context.arc(target.x, target.y, markerRadius, 0, Math.PI * 2);
      context.strokeStyle = "rgba(37, 49, 68, 0.8)";
      context.lineWidth = 2;
      context.setLineDash([5, 4]);
      context.stroke();
      context.setLineDash([]);

      drawRoundedRect(draggable.x, draggable.y, draggable.size, draggable.size, 9);
      context.fillStyle = palette.accent;
      context.fill();
      context.strokeStyle = "rgba(39, 43, 49, 0.6)";
      context.lineWidth = 1.2;
      context.stroke();
      context.fillStyle = palette.text;
      context.font = "700 10px 'Trebuchet MS', sans-serif";
      context.fillText(draggable.label, draggable.x + 6, draggable.y + draggable.size / 2 + 4);

      drawRoundedRect(16, height - 68, 300, 50, 10);
      context.fillStyle = palette.card;
      context.fill();
      context.strokeStyle = palette.line;
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = palette.text;
      context.font = "700 12px 'Trebuchet MS', sans-serif";
      context.fillText(currentStep?.title ?? "Step", 28, height - 43);
      context.font = "11px 'Trebuchet MS', sans-serif";
      const actionText = (currentStep?.action ?? "").slice(0, 62);
      context.fillText(actionText, 28, height - 24);

      animationFrame = window.requestAnimationFrame(render);
    };

    const pointInDraggable = (x: number, y: number): boolean => {
      return (
        x >= draggable.x &&
        x <= draggable.x + draggable.size &&
        y >= draggable.y &&
        y <= draggable.y + draggable.size
      );
    };

    const pointerToCanvas = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (simulationPaused) {
        return;
      }
      const point = pointerToCanvas(event);
      if (pointInDraggable(point.x, point.y)) {
        dragging = true;
        dragOffsetX = point.x - draggable.x;
        dragOffsetY = point.y - draggable.y;
        canvas.setPointerCapture(event.pointerId);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      const point = pointerToCanvas(event);
      draggable.x = point.x - dragOffsetX;
      draggable.y = point.y - dragOffsetY;
    };

    const onPointerUp = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      const centerX = draggable.x + draggable.size / 2;
      const centerY = draggable.y + draggable.size / 2;
      const currentStep = steps[simulationStepRef.current];
      const targetNode = currentStep.highlightNodeIds
        .map((id) => nodeMap.get(id))
        .find((item): item is NonNullable<typeof item> => Boolean(item)) ?? nodeLayouts[0];
      const distance = Math.hypot(centerX - targetNode.x, centerY - targetNode.y);
      const isCorrect = distance < 46;
      void runActionFeedback("drag", isCorrect ? "correct placement" : "missed placement");
    };

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);
    animationFrame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
    };
  }, [appView, runActionFeedback, selectedTopic, selectedVisualPlan, simulationPaused, subtitlesEnabled]);

  useEffect(() => {
    if (appView === "simulation") {
      return;
    }
    lastNarratedTopicRef.current = "";
    setCurrentStepText("");
    clearNarrationTimers();
  }, [appView, clearNarrationTimers]);

  useEffect(() => {
    return () => {
      voiceCaptureDesiredRef.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      clearNarrationTimers();
    };
  }, [clearNarrationTimers]);

  const userMenu = (
    <>
      <button
        className="menu-toggle"
        onClick={() => setMenuOpen((value) => !value)}
        aria-label="Open menu"
      >
        ☰
      </button>
      {menuOpen ? <button className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-label="Close menu" /> : null}
      <aside className={menuOpen ? "side-menu open" : "side-menu"}>
        <section className="side-menu-section">
          <button className="ghost menu-option" onClick={openProgressPage}>
            Topic Progress
          </button>
        </section>
        <section className="side-menu-section">
          <button className="ghost menu-option" onClick={() => void openHistoryPage()}>
            Interaction History
          </button>
        </section>
        <section className="side-menu-section">
          <button
            className="ghost menu-option"
            onClick={handleLogout}
          >
            Logout
          </button>
        </section>
      </aside>
    </>
  );

  if (!token) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Interactive Tech Tutor</h1>
          <p>{registerMode ? "Create an account to start learning." : "Login to continue your learning session."}</p>
          {registerMode ? (
            <label>
              Name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </label>
          ) : null}
          <label>
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Minimum 8 characters"
            />
          </label>
          <button disabled={loading} onClick={() => void handleAuth()}>
            {loading ? "Please wait..." : registerMode ? "Create Account" : "Login"}
          </button>
          <button className="ghost" onClick={() => setRegisterMode((value) => !value)}>
            {registerMode ? "Use existing account" : "Create new account"}
          </button>
          {loading ? <div className="auth-progress">Processing request...</div> : null}
          <div className="status">{statusMessage}</div>
        </div>
      </div>
    );
  }

  if (appView === "home") {
    return (
      <div className="home-shell">
        {userMenu}
        <div className="home-ambient" aria-hidden="true">
          <span className="ambient-icon i1">&lt;/&gt;</span>
          <span className="ambient-icon i2">{"{}"}</span>
          <span className="ambient-icon i3">API</span>
          <span className="ambient-icon i4">NN</span>
          <span className="ambient-icon i5">SQL</span>
          <span className="ambient-icon i6">TS</span>
          <span className="ambient-icon i7">λ</span>
          <span className="ambient-icon i8">ML</span>
        </div>
        <div className="home-content">
          <div className="home-hero">
            <div className="home-hero-copy">
              <h1>Welcome, {userName || "Learner"}</h1>
              <p>Enter any technical topic and get a dynamic simulation with step-by-step visual flow.</p>
            </div>
            <div className="hero-character-wrap" aria-hidden="true">
              <div className="mentor-character">
                <div className="mentor-chair" />
                <div className="mentor-leg leg-left" />
                <div className="mentor-leg leg-right" />
                <div className="mentor-shoe shoe-left" />
                <div className="mentor-shoe shoe-right" />
                <div className="mentor-torso" />
                <div className="mentor-neck" />
                <div className="mentor-head">
                  <span className="eye eye-left" />
                  <span className="eye eye-right" />
                </div>
                <div className="mentor-hair" />
                <div className="mentor-arm upper-left" />
                <div className="mentor-arm upper-right" />
                <div className="mentor-forearm fore-left" />
                <div className="mentor-forearm fore-right" />
                <div className="mentor-laptop">
                  <span>{"<dev/>"}</span>
                </div>
                <div className="mentor-desk" />
              </div>
            </div>
          </div>
          <div className="home-controls">
            <label>
              Topic
              <input
                value={customTopicInput}
                onChange={(event) => setCustomTopicInput(event.target.value)}
                placeholder="e.g. Event sourcing, OAuth 2.0, CPU scheduling"
              />
            </label>
            <button
              disabled={generatingTopic || !customTopicInput.trim()}
              onClick={() => void generateCustomSimulation()}
            >
              {generatingTopic ? "Generating Simulation..." : "Generate And Open Simulation"}
            </button>
          </div>
          <div className="status">{statusMessage}</div>
        </div>
      </div>
    );
  }

  if (appView === "history-list") {
    return (
      <div className="history-shell">
        {userMenu}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back">
              ←
            </button>
            <h1>Interaction History</h1>
          </header>
          <p className="history-description">Select a previous chat to view full details.</p>
          {historyLoading ? <p>Loading interaction history...</p> : null}
          {!historyLoading && chatHistory.length === 0 ? (
            <div className="history-empty">
              No previous interaction chats yet. Start a simulation and send your first message.
            </div>
          ) : (
            <div className="history-list">
              {chatHistory
                .slice()
                .reverse()
                .map((item) => (
                  <button
                    key={item.id}
                    className="history-item"
                    onClick={() => openHistoryDetail(item.id)}
                  >
                    <strong>{topicTitleById.get(item.topicId) ?? item.topicId}</strong>
                    <span>{new Date(item.timestamp).toLocaleString()}</span>
                    <p>{item.input}</p>
                  </button>
                ))}
            </div>
          )}
          {selectedTopicId ? (
            <button className="ghost delete-history" onClick={() => void deleteTopicHistory()}>
              Delete Current Topic History
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (appView === "history-detail") {
    return (
      <div className="history-shell">
        {userMenu}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back">
              ←
            </button>
            <h1>Chat Detail</h1>
          </header>
          {!selectedHistoryItem ? (
            <div className="history-empty">
              This interaction is no longer available.
            </div>
          ) : (
            <article className="history-detail-card">
              <div className="history-meta">
                <strong>{topicTitleById.get(selectedHistoryItem.topicId) ?? selectedHistoryItem.topicId}</strong>
                <span>{new Date(selectedHistoryItem.timestamp).toLocaleString()}</span>
              </div>
              <div className="history-chat-block">
                <h3>You</h3>
                <p>{selectedHistoryItem.input}</p>
              </div>
              <div className="history-chat-block">
                <h3>Tutor</h3>
                <p>{selectedHistoryItem.output}</p>
              </div>
            </article>
          )}
        </div>
      </div>
    );
  }

  if (appView === "progress-list") {
    return (
      <div className="history-shell">
        {userMenu}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back">
              ←
            </button>
            <h1>Topic Progress</h1>
          </header>
          {sortedProgress.length === 0 ? (
            <div className="history-empty">No progress yet. Complete a simulation to track progress.</div>
          ) : (
            <div className="history-list">
              {sortedProgress.map((item, index) => (
                <article key={`${item.topicId}-${item.level}-${index}`} className="history-item">
                  <strong>{topicTitleById.get(item.topicId) ?? item.topicId}</strong>
                  <span>{new Date(item.updatedAt).toLocaleString()}</span>
                  <p>
                    Level: {item.level} | Status: {item.status} | Score: {item.score}%
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={chatPanelOpen ? "app-shell chat-open" : "app-shell chat-closed"}>
      {userMenu}
      <button className="sim-back-floating" onClick={navigateBack} aria-label="Go back">
        ←
      </button>
      <main className="simulation-area">
        <header className="top-bar">
          <div className="top-title-wrap compact">
            <h1>Interactive Tech Tutor</h1>
          </div>
          <div className="top-actions icon-stack">
            <button
              className={chatPanelOpen ? "active icon-button" : "icon-button"}
              onClick={() => setChatPanelOpen((value) => !value)}
              aria-label={chatPanelOpen ? "Hide chat panel" : "Show chat panel"}
              title={chatPanelOpen ? "Hide chat panel" : "Show chat panel"}
            >
              ▤
            </button>
            <button
              className={toolsPanelOpen ? "active icon-button" : "icon-button"}
              onClick={() => setToolsPanelOpen((value) => !value)}
              aria-label={toolsPanelOpen ? "Hide controls" : "Show controls"}
              title={toolsPanelOpen ? "Hide controls" : "Show controls"}
            >
              ...
            </button>
          </div>
        </header>

        <section className="topic-summary compact">
          <h2>{selectedTopic?.title ?? "Simulation Topic"}</h2>
          <p className="now-explaining">
            Now Explaining: {currentStepText || "Preparing simulation sequence..."}
          </p>
        </section>

        <section className="canvas-wrapper">
          <canvas ref={canvasRef} className="sim-canvas" />
        </section>

        {toolsPanelOpen ? (
          <section className="panel-section tools-panel floating">
            <h3>Simulation Controls</h3>
            <label className="toggle">
              <input
                type="checkbox"
                checked={subtitlesEnabled}
                onChange={(event) => setSubtitlesEnabled(event.target.checked)}
              />
              Subtitles
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={voiceCaptureEnabled}
                disabled
                onChange={(event) => setVoiceCaptureEnabled(event.target.checked)}
              />
              Voice Capture (coming soon)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={preferences.voiceSettings.interactionEnabled}
                disabled
                onChange={() => undefined}
              />
              Voice Interaction (coming soon)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={preferences.voiceSettings.navigationEnabled}
                disabled
                onChange={() => undefined}
              />
              Voice Navigation (coming soon)
            </label>
            <div className="voice-note">Voice narration is intentionally disabled in simulation for now.</div>
          </section>
        ) : null}
      </main>

      {chatPanelOpen ? (
        <aside className="interaction-panel">
          <section className="panel-section">
            <h3>Topic Chat</h3>
            <div className="chat-window">
              {messages.slice(-16).map((message, index) => (
                <p key={`${message.role}-${index}`} className={`chat-${message.role}`}>
                  <strong>{message.role === "user" ? "You" : "Tutor"}:</strong> {message.text}
                </p>
              ))}
            </div>
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask a question about the active simulation..."
            />
            <button onClick={() => void sendChat("text")}>Send</button>
          </section>

          <section className="panel-section">
            <h3>Visual Input</h3>
            <input
              type="file"
              accept="image/*,.pdf,.doc,.docx"
              capture="environment"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleUpload(file);
                }
              }}
            />
            <p>{uploadFeedback || "Upload an image/document for analysis."}</p>
          </section>
        </aside>
      ) : null}

      <div className="sim-controls-bottom">
        <button
          className="sim-play-toggle icon-button"
          onClick={() => setSimulationPaused((value) => !value)}
          aria-label={simulationPaused ? "Play simulation" : "Pause simulation"}
          title={simulationPaused ? "Play simulation" : "Pause simulation"}
        >
          {simulationPaused ? "▶" : "❚❚"}
        </button>
      </div>
      <div className="subtitle-bar">
        {subtitlesEnabled ? subtitle || "Simulation subtitles will appear here." : "Subtitles are muted."}
      </div>
      <div className="status-bar">{loading ? "Loading..." : statusMessage}</div>
    </div>
  );
}
