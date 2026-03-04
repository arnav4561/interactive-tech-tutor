import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FORCE_LOGOUT_EVENT, apiDelete, apiGet, apiPost, apiPut, prewarmApi } from "./api";
import { SimulationCanvasRenderer, SimulationCanvasStepLike } from "./SimulationCanvasRenderer";
import {
  ChatMessage,
  DifficultyLevel,
  HistoryItem,
  ProblemSet,
  ProgressRecord,
  Topic,
  UserPreferences
} from "./types";

const LEVELS: DifficultyLevel[] = ["beginner", "intermediate", "advanced"];

let threeLibPromise: Promise<any> | null = null;

function loadThreeLib(): Promise<any> {
  if (!threeLibPromise) {
    threeLibPromise = import("three");
  }
  return threeLibPromise;
}

type RecognitionConstructor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type AppView = "home" | "simulation" | "history-list" | "history-detail" | "progress-list";

type SimulationElementType =
  | "rectangle"
  | "circle"
  | "ellipse"
  | "triangle"
  | "arrow"
  | "curved_arrow"
  | "line"
  | "dashed_line"
  | "text"
  | "path"
  | "polygon"
  | "grid"
  | "axis"
  | "plot_point"
  | "wave"
  | "pulse"
  | "highlight_box"
  | "bar"
  | "matrix"
  | "number_line"
  | "table"
  | "stack"
  | "queue"
  | "flowchart_diamond"
  | "neural_layer"
  | "neural_network"
  | "tree_node"
  | string;

interface SimulationElementAnimation {
  type:
    | "fade_in"
    | "fade_out"
    | "move"
    | "scale_up"
    | "scale_down"
    | "pulse"
    | "rotate"
    | "highlight"
    | "draw"
    | "bounce"
    | "follow_path"
    | "typewriter"
    | "none"
    | string;
  duration?: number;
  direction?: string;
  represents?: string;
  [key: string]: unknown;
}

interface SimulationCanvasElement {
  type: SimulationElementType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  label?: string;
  label_position?: "above" | "below" | "left" | "right";
  animation?: SimulationElementAnimation;
  [key: string]: unknown;
}

interface SimulationCanvasStep {
  step: number;
  concept: string;
  subtitle: string;
  duration_ms?: number;
  canvas_instructions: {
    elements: SimulationCanvasElement[];
  };
  [key: string]: unknown;
}

interface SimulationGenerationApiResponse {
  topic: Topic;
  problemSets: ProblemSet[];
  openingMessage: string;
  generationSource?: "template" | "bedrock";
  explanation_script: string;
  simulation_steps: SimulationCanvasStep[];
}

interface GeneratedSimulation {
  explanationScript: string;
  steps: SimulationCanvasStep[];
  generationSource: "template" | "bedrock";
}

interface VoiceActionResponse {
  action_type:
    | "answer_question"
    | "move_element"
    | "modify_element"
    | "play"
    | "pause"
    | "next_step"
    | "previous_step"
    | "restart"
    | "open_menu"
    | "close_menu"
    | "toggle_subtitles"
    | "toggle_voice"
    | "not_possible"
    | "general_answer"
    | string;
  action_params?: Record<string, unknown>;
  spoken_response?: string;
  feedback?: string;
  requires_animation?: boolean;
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
  const [sessionBootstrapping, setSessionBootstrapping] = useState(false);
  const [appView, setAppView] = useState<AppView>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
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
  const [generatedSimulations, setGeneratedSimulations] = useState<Record<string, GeneratedSimulation>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentStepText, setCurrentStepText] = useState("");
  const [mathOverlayLines, setMathOverlayLines] = useState<string[]>([]);
  const [voiceNarrationEnabled, setVoiceNarrationEnabled] = useState(false);
  const [topicListening, setTopicListening] = useState(false);
  const [simulationRendererLoading, setSimulationRendererLoading] = useState(false);
  const [simulationLoadingTopic, setSimulationLoadingTopic] = useState("");
  const [simulationError, setSimulationError] = useState("");
  const [voiceCommandFlash, setVoiceCommandFlash] = useState("");
  const [voiceMicState, setVoiceMicState] = useState<"idle" | "listening" | "processing" | "speaking">("idle");
  const [voiceInterimText, setVoiceInterimText] = useState("");
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const simulationHostRef = useRef<HTMLDivElement | null>(null);
  const simulationThreeHostRef = useRef<HTMLDivElement | null>(null);
  const homeMascotRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const topicRecognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const topicRecognitionActiveRef = useRef(false);
  const topicSilenceTimerRef = useRef<number | null>(null);
  const topicCaptureDesiredRef = useRef(false);
  const topicFinalTranscriptRef = useRef("");
  const topicHasSpokenRef = useRef(false);
  const narrationTimersRef = useRef<number[]>([]);
  const subtitleTimerRef = useRef<number | null>(null);
  const voiceCaptureDesiredRef = useRef(false);
  const narrationSessionRef = useRef(0);
  const appViewRef = useRef<AppView>("home");
  const lastNarratedTopicRef = useRef("");
  const isNarratingRef = useRef(false);
  const simulationStepRef = useRef(0);
  const simulationPausedRef = useRef(false);
  const spokenStepRef = useRef(-1);
  const stepNarrationCompleteRef = useRef(true);
  const stepElapsedMsRef = useRef(0);
  const pausedAtElapsedMsRef = useRef(0);
  const recognitionStartingRef = useRef(false);
  const recognitionActiveRef = useRef(false);
  const recognitionStoppingRef = useRef(false);
  const recognitionRestartTimerRef = useRef<number | null>(null);
  const mathWorkerRef = useRef<Worker | null>(null);
  const mathWorkerTicketRef = useRef(0);
  const commandFlashTimerRef = useRef<number | null>(null);
  const simulationRendererRef = useRef<SimulationCanvasRenderer | null>(null);
  const currentStepConceptRef = useRef("Current step");
  const systemSpeakingRef = useRef(false);
  const simulationLoaderTimeoutRef = useRef<number | null>(null);
  const simulationLoadStartedAtRef = useRef(0);
  const pendingSimulationCommandRef = useRef<{
    id: number;
    action:
      | "next-step"
      | "previous-step"
      | "pause"
      | "play"
      | "restart"
      | "toggle-chat"
      | "toggle-controls"
      | "go-home";
  } | null>(null);
  const commandNonceRef = useRef(0);

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

  const selectedSimulation = useMemo(() => {
    if (!selectedTopic) {
      return null;
    }
    return generatedSimulations[selectedTopic.id] ?? null;
  }, [generatedSimulations, selectedTopic]);

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

  const flashVoiceCommand = useCallback((message: string) => {
    setVoiceCommandFlash(message);
    if (commandFlashTimerRef.current !== null) {
      window.clearTimeout(commandFlashTimerRef.current);
    }
    commandFlashTimerRef.current = window.setTimeout(() => {
      setVoiceCommandFlash("");
      commandFlashTimerRef.current = null;
    }, 2000);
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
      setSessionBootstrapping(true);
      try {
        const [topicsResponse, progressResponse, prefResponse] = await Promise.all([
          apiGet<{ topics: Topic[] }>("/topics", authToken),
          apiGet<{ progress: ProgressRecord[] }>("/progress", authToken),
          apiGet<{ preferences: UserPreferences }>("/preferences", authToken)
        ]);

        setTopics(topicsResponse.topics);
        setProgress(progressResponse.progress);
        setPreferences(prefResponse.preferences);
        setSelectedTopicId((current) => current || topicsResponse.topics[0]?.id || "");
        if (!userName.trim()) {
          const localEmail = localStorage.getItem("itt_email") ?? "";
          const localName = localStorage.getItem("itt_name") ?? "";
          setUserName(localName.trim() || localEmail.split("@")[0] || "Learner");
        }
        if (appViewRef.current !== "simulation") {
          setStatusMessage("Session restored.");
        }
      } catch (error) {
        setStatusMessage((error as Error).message);
      } finally {
        setLoading(false);
        setSessionBootstrapping(false);
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
    setGeneratedSimulations({});
    setCustomTopicInput("");
    setSimulationLoadingTopic("");
    setSelectedHistoryId("");
    setChatPanelOpen(false);
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

  useEffect(() => {
    const onForceLogout = (event: Event) => {
      const custom = event as CustomEvent<{ reason?: string }>;
      handleLogout();
      if (custom.detail?.reason) {
        setStatusMessage(`Session reset: ${custom.detail.reason}`);
      }
    };
    window.addEventListener(FORCE_LOGOUT_EVENT, onForceLogout as EventListener);
    return () => {
      window.removeEventListener(FORCE_LOGOUT_EVENT, onForceLogout as EventListener);
    };
  }, [handleLogout]);

  const generateCustomSimulation = useCallback(async () => {
    const requestedTopic = customTopicInput.trim();
    if (!token || !requestedTopic) {
      return;
    }
    pendingSimulationCommandRef.current = null;
    setSimulationError("");
    if (topicRecognitionRef.current && topicRecognitionActiveRef.current) {
      try {
        topicRecognitionRef.current.stop();
      } catch (_error) {
        // no-op
      }
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
    }
    if (simulationLoaderTimeoutRef.current !== null) {
      window.clearTimeout(simulationLoaderTimeoutRef.current);
      simulationLoaderTimeoutRef.current = null;
    }
    simulationLoadStartedAtRef.current = Date.now();
    setAppView("simulation");
    setSelectedTopicId("");
    setChatPanelOpen(false);
    setSimulationLoadingTopic(requestedTopic);
    setCurrentStepText("Generating simulation plan...");
    setSimulationRendererLoading(true);
    setMenuOpen(false);
    setGeneratingTopic(true);
    try {
      const response = await apiPost<SimulationGenerationApiResponse>(
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
      setGeneratedSimulations((current) => ({
        ...current,
        [response.topic.id]: {
          explanationScript: response.explanation_script,
          steps: response.simulation_steps,
          generationSource: response.generationSource === "template" ? "template" : "bedrock"
        }
      }));
      console.log(
        `[Simulation] source=${response.generationSource ?? "unknown"} steps=${response.simulation_steps.length}`
      );
      setSelectedTopicId(response.topic.id);
      simulationStepRef.current = 0;
      setSimulationPaused(false);
      setMenuOpen(false);
      setMessages((current) => [...current, { role: "assistant", text: response.openingMessage }]);
      if (subtitlesEnabled) {
        setSubtitle(response.openingMessage);
      }
      setStatusMessage("Simulation ready.");
      setCustomTopicInput("");
      setSimulationError("");
    } catch (error) {
      const message = (error as Error).message;
      setSimulationError(message);
      setCurrentStepText(`Simulation generation failed: ${message}`);
      setStatusMessage(message);
    } finally {
      setGeneratingTopic(false);
      const elapsed = Date.now() - simulationLoadStartedAtRef.current;
      const minimumVisibleMs = 1200;
      const waitMore = Math.max(0, minimumVisibleMs - elapsed);
      simulationLoaderTimeoutRef.current = window.setTimeout(() => {
        setSimulationRendererLoading(false);
        setSimulationLoadingTopic("");
        simulationLoaderTimeoutRef.current = null;
      }, waitMore);
    }
  }, [customTopicInput, generatedSimulations, selectedLevel, subtitlesEnabled, token, topics]);

  const captureTopicFromVoice = useCallback(() => {
    const win = window as Window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      setStatusMessage("Speech recognition is not supported in this browser.");
      return;
    }

    if (topicListening) {
      topicCaptureDesiredRef.current = false;
      try {
        topicRecognitionRef.current?.stop();
      } catch (_error) {
        // no-op
      }
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
        topicSilenceTimerRef.current = null;
      }
      return;
    }

    if (!topicRecognitionRef.current) {
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      topicRecognitionRef.current = recognition;
    }

    const recognition = topicRecognitionRef.current;
    topicCaptureDesiredRef.current = true;
    topicFinalTranscriptRef.current = "";
    topicHasSpokenRef.current = false;

    const resetSilenceTimer = () => {
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
      }
      topicSilenceTimerRef.current = window.setTimeout(() => {
        if (topicRecognitionActiveRef.current && topicCaptureDesiredRef.current && topicHasSpokenRef.current) {
          try {
            recognition.stop();
          } catch (_error) {
            topicRecognitionActiveRef.current = false;
            setTopicListening(false);
          }
        }
      }, 2000);
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const segment = result?.[0]?.transcript?.trim() ?? "";
        if (!segment) {
          continue;
        }
        if (result.isFinal) {
          finalTranscript = `${finalTranscript} ${segment}`.trim();
        } else {
          interimTranscript = `${interimTranscript} ${segment}`.trim();
        }
      }
      if (finalTranscript) {
        topicFinalTranscriptRef.current = finalTranscript;
        topicHasSpokenRef.current = true;
      }
      const composed = `${topicFinalTranscriptRef.current} ${interimTranscript}`.trim();
      if (composed) {
        setCustomTopicInput(composed);
      }
      if (topicHasSpokenRef.current) {
        resetSilenceTimer();
      }
    };
    recognition.onerror = (event) => {
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
      topicCaptureDesiredRef.current = false;
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
        topicSilenceTimerRef.current = null;
      }
      setStatusMessage(`Voice input error: ${event.error}`);
    };
    recognition.onend = () => {
      topicRecognitionActiveRef.current = false;
      if (topicCaptureDesiredRef.current && !topicHasSpokenRef.current) {
        try {
          recognition.start();
          topicRecognitionActiveRef.current = true;
          setTopicListening(true);
          return;
        } catch (_error) {
          // Fall through and fully stop.
        }
      }
      setTopicListening(false);
      topicCaptureDesiredRef.current = false;
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
        topicSilenceTimerRef.current = null;
      }
      if (topicFinalTranscriptRef.current.trim()) {
        setCustomTopicInput(topicFinalTranscriptRef.current.trim());
      }
    };

    try {
      if (topicRecognitionActiveRef.current) {
        recognition.stop();
      }
      setTopicListening(true);
      topicRecognitionActiveRef.current = true;
      recognition.start();
      resetSilenceTimer();
    } catch (error) {
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
      topicCaptureDesiredRef.current = false;
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
        topicSilenceTimerRef.current = null;
      }
      setStatusMessage(`Unable to start topic voice input: ${(error as Error).message}`);
    }
  }, [topicListening]);

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
      const interruptCurrentAction = () => {
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
      };
      const enqueueSimulationCommand = (
        action:
          | "next-step"
          | "previous-step"
          | "pause"
          | "play"
          | "restart"
          | "toggle-chat"
          | "toggle-controls"
          | "go-home",
        label: string
      ) => {
        commandNonceRef.current += 1;
        pendingSimulationCommandRef.current = {
          id: commandNonceRef.current,
          action
        };
        interruptCurrentAction();
        flashVoiceCommand(`Command: ${label}`);
      };

      if (command.includes("next step")) {
        enqueueSimulationCommand("next-step", "Next Step");
        return true;
      }
      if (command.includes("previous step") || command.includes("back step")) {
        enqueueSimulationCommand("previous-step", "Previous Step");
        return true;
      }
      if (command.includes("pause")) {
        enqueueSimulationCommand("pause", "Pause");
        return true;
      }
      if (command.includes("play") || command.includes("resume")) {
        enqueueSimulationCommand("play", "Play");
        return true;
      }
      if (command.includes("toggle chat") || command.includes("show chat") || command.includes("hide chat")) {
        enqueueSimulationCommand("toggle-chat", "Toggle Chat");
        return true;
      }
      if (command.includes("toggle controls") || command.includes("show controls") || command.includes("hide controls")) {
        enqueueSimulationCommand("toggle-controls", "Toggle Controls");
        return true;
      }

      if (command.includes("next topic")) {
        interruptCurrentAction();
        const currentIndex = topics.findIndex((item) => item.id === selectedTopicId);
        const nextTopic = topics[(currentIndex + 1) % topics.length];
        if (nextTopic) {
          setSelectedTopicId(nextTopic.id);
          setStatusMessage(`Switched to topic: ${nextTopic.title}`);
          void runActionFeedback("voice-command", `next-topic:${nextTopic.title}`);
          flashVoiceCommand("Command: Next Topic");
        }
        return true;
      }

      if (command.includes("previous topic") || command.includes("back topic")) {
        interruptCurrentAction();
        const currentIndex = topics.findIndex((item) => item.id === selectedTopicId);
        const prevIndex = currentIndex <= 0 ? topics.length - 1 : currentIndex - 1;
        const prevTopic = topics[prevIndex];
        if (prevTopic) {
          setSelectedTopicId(prevTopic.id);
          setStatusMessage(`Switched to topic: ${prevTopic.title}`);
          void runActionFeedback("voice-command", `previous-topic:${prevTopic.title}`);
          flashVoiceCommand("Command: Previous Topic");
        }
        return true;
      }

      for (const level of LEVELS) {
        if (command.includes(level)) {
          interruptCurrentAction();
          if (!unlockedLevels.has(level)) {
            setStatusMessage(`${level} is locked. Complete previous level first.`);
            return true;
          }
          setSelectedLevel(level);
          setStatusMessage(`Difficulty changed to ${level}.`);
          void runActionFeedback("voice-command", `difficulty:${level}`);
          flashVoiceCommand(`Command: ${level}`);
          return true;
        }
      }

      if (command.includes("mute narration")) {
        interruptCurrentAction();
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: false }
        };
        setAndPersistPreferences(next);
        void runActionFeedback("voice-command", "mute-narration");
        flashVoiceCommand("Command: Mute Narration");
        return true;
      }

      if (command.includes("enable narration") || command.includes("unmute narration")) {
        interruptCurrentAction();
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: true }
        };
        setAndPersistPreferences(next);
        void runActionFeedback("voice-command", "unmute-narration");
        flashVoiceCommand("Command: Enable Narration");
        return true;
      }

      if (command.includes("mute subtitles")) {
        interruptCurrentAction();
        setSubtitlesEnabled(false);
        setStatusMessage("Subtitles muted.");
        flashVoiceCommand("Command: Mute Subtitles");
        return true;
      }

      if (command.includes("show subtitles") || command.includes("unmute subtitles")) {
        interruptCurrentAction();
        setSubtitlesEnabled(true);
        setStatusMessage("Subtitles enabled.");
        flashVoiceCommand("Command: Show Subtitles");
        return true;
      }

      if (command.includes("stop voice capture") || command.includes("stop listening")) {
        interruptCurrentAction();
        setVoiceCaptureEnabled(false);
        setStatusMessage("Voice capture disabled by voice command.");
        void runActionFeedback("voice-command", "stop-capture");
        flashVoiceCommand("Command: Mic Off");
        return true;
      }

      if (command.includes("start voice capture") || command.includes("resume listening")) {
        interruptCurrentAction();
        setVoiceCaptureEnabled(true);
        setStatusMessage("Voice capture enabled by voice command.");
        void runActionFeedback("voice-command", "start-capture");
        flashVoiceCommand("Command: Mic On");
        return true;
      }

      if (/^go back( home)?$/.test(command.trim())) {
        enqueueSimulationCommand("go-home", "Go Home");
        setStatusMessage("Moved back.");
        return true;
      }

      flashVoiceCommand("Command: Not recognized");
      return false;
    },
    [flashVoiceCommand, preferences, runActionFeedback, selectedTopicId, setAndPersistPreferences, topics, unlockedLevels]
  );

  const startListening = useCallback(() => {
    if (appView !== "simulation") {
      return;
    }
    voiceCaptureDesiredRef.current = true;
    if (recognitionStoppingRef.current || recognitionStartingRef.current || recognitionActiveRef.current) {
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

    recognitionStoppingRef.current = false;

    if (!recognitionRef.current) {
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognitionRef.current = recognition;
    }

    recognitionRef.current.onresult = (event: any) => {
      if (simulationRendererLoading || generatingTopic || !selectedTopicId) {
        return;
      }
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i]?.[0]?.transcript ?? "";
        if (event.results[i]?.isFinal) {
          finalText += `${chunk} `;
        } else {
          interim += chunk;
        }
      }
      setVoiceInterimText(interim.trim());
      const transcript = finalText.trim();
      if (!transcript) {
        return;
      }
      const result = event.results[event.results.length - 1];
      const confidence = Number(result?.[0]?.confidence ?? 0);
      if (confidence < 0.75) {
        flashVoiceCommand("Command: Low confidence");
        return;
      }
      setVoiceInterimText("");
      setVoiceMicState("processing");
      setListening(false);
      voiceCaptureDesiredRef.current = false;
      recognitionStoppingRef.current = recognitionStartingRef.current || recognitionActiveRef.current;
      try {
        recognitionRef.current?.stop();
      } catch (_error) {
        // no-op
      }

      void (async () => {
        try {
          const stepConcept = currentStepConceptRef.current || "Current step";
          const action = await apiPost<VoiceActionResponse>(
            "/ai/voice-action",
            {
              topicId: selectedTopicId,
              userSpeech: transcript,
              stepConcept,
              stepNumber: simulationStepRef.current + 1
            },
            token
          );
          const params = action.action_params ?? {};
          const respond = async (text: string) => {
            if (!text.trim()) {
              return;
            }
            systemSpeakingRef.current = true;
            setVoiceMicState("speaking");
            await speakText(text, true);
            systemSpeakingRef.current = false;
          };

          let toast = "Action executed";
          if (action.action_type === "play") {
            stepElapsedMsRef.current = pausedAtElapsedMsRef.current;
            setSimulationPaused(false);
            simulationPausedRef.current = false;
            toast = "Playing simulation";
          } else if (action.action_type === "pause") {
            pausedAtElapsedMsRef.current = stepElapsedMsRef.current;
            setSimulationPaused(true); window.speechSynthesis.cancel();
            simulationPausedRef.current = true;
            stepNarrationCompleteRef.current = true;
            toast = "Pausing simulation";
          } else if (action.action_type === "next_step") {
            commandNonceRef.current += 1;
            pendingSimulationCommandRef.current = { id: commandNonceRef.current, action: "next-step" };
            toast = "Going to next step";
          } else if (action.action_type === "previous_step") {
            commandNonceRef.current += 1;
            pendingSimulationCommandRef.current = { id: commandNonceRef.current, action: "previous-step" };
            toast = "Going to previous step";
          } else if (action.action_type === "restart") {
            commandNonceRef.current += 1;
            pendingSimulationCommandRef.current = { id: commandNonceRef.current, action: "restart" };
            toast = "Restarting simulation";
          } else if (action.action_type === "open_menu") {
            setToolsPanelOpen(true);
            toast = "Opening controls";
          } else if (action.action_type === "close_menu") {
            setToolsPanelOpen(false);
            toast = "Closing controls";
          } else if (action.action_type === "toggle_subtitles") {
            setSubtitlesEnabled((value) => !value);
            toast = "Toggling subtitles";
          } else if (action.action_type === "toggle_voice") {
            const checked = !voiceNarrationEnabled;
            setVoiceNarrationEnabled(checked);
            const next = {
              ...preferences,
              voiceSettings: {
                ...preferences.voiceSettings,
                narrationEnabled: checked
              }
            };
            setAndPersistPreferences(next);
            toast = "Toggling voice narration";
          } else if (action.action_type === "move_element") {
            const label = String(params.element_label ?? params.label ?? "");
            const tx = Number(params.target_x ?? params.x ?? 50);
            const ty = Number(params.target_y ?? params.y ?? 50);
            const moved = simulationRendererRef.current?.moveElementByLabel(label, tx, ty, 800) ?? false;
            toast = moved ? "Moving element to new position" : "Unable to find requested element";
            if (action.feedback) {
              await respond(action.feedback);
            }
          } else if (action.action_type === "modify_element") {
            const label = String(params.element_label ?? params.label ?? "");
            const property = String(params.property ?? params.modify ?? "label");
            const newValue = params.new_value ?? params.value ?? "";
            const mappedProperty =
              property.includes("color") ? "color" : property.includes("size") ? "size" : "label";
            const modified =
              simulationRendererRef.current?.modifyElementByLabel(
                label,
                mappedProperty,
                typeof newValue === "number" ? newValue : String(newValue),
                800
              ) ?? false;
            toast = modified ? "Modifying element" : "Unable to modify requested element";
            if (action.feedback) {
              await respond(action.feedback);
            }
          } else {
            if (action.spoken_response) {
              setMessages((current) => [...current, { role: "assistant", text: action.spoken_response ?? "" }]);
              await respond(action.spoken_response);
            }
            toast = action.action_type === "answer_question" ? "Answering your question" : "Responding";
          }

          if (
            action.spoken_response &&
            action.action_type !== "answer_question" &&
            action.action_type !== "general_answer" &&
            action.action_type !== "not_possible" &&
            action.action_type !== "move_element" &&
            action.action_type !== "modify_element"
          ) {
            await respond(action.spoken_response);
          }
          flashVoiceCommand(toast);
        } catch (error) {
          setStatusMessage((error as Error).message);
          processVoiceCommand(transcript);
        } finally {
          void runActionFeedback("voice-command", transcript);
          if (voiceCaptureEnabled && appViewRef.current === "simulation") {
            setVoiceMicState("listening");
            voiceCaptureDesiredRef.current = true;
            if (
              recognitionRef.current &&
              !recognitionStartingRef.current &&
              !recognitionActiveRef.current
            ) {
              try {
                recognitionStartingRef.current = true;
                recognitionRef.current.start();
              } catch (_error) {
                recognitionStartingRef.current = false;
              }
            }
          } else {
            setVoiceMicState("idle");
          }
        }
      })();
    };
    recognitionRef.current.onstart = () => {
      recognitionStartingRef.current = false;
      recognitionActiveRef.current = true;
      setListening(true);
      setVoiceMicState("listening");
      setStatusMessage("Voice capture active.");
    };
    recognitionRef.current.onerror = (event) => {
      recognitionStartingRef.current = false;
      recognitionActiveRef.current = false;
      setStatusMessage(`Voice input error: ${event.error}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        voiceCaptureDesiredRef.current = false;
        setVoiceCaptureEnabled(false);
      }
      if (!systemSpeakingRef.current) {
        setVoiceMicState("idle");
      }
    };
    recognitionRef.current.onend = () => {
      recognitionActiveRef.current = false;
      recognitionStartingRef.current = false;
      setListening(false);
      const wasStopping = recognitionStoppingRef.current;
      recognitionStoppingRef.current = false;
      if (!voiceCaptureDesiredRef.current || appViewRef.current !== "simulation") {
        if (!systemSpeakingRef.current) {
          setVoiceMicState("idle");
        }
        return;
      }
      if (recognitionRestartTimerRef.current !== null) {
        window.clearTimeout(recognitionRestartTimerRef.current);
      }
      recognitionRestartTimerRef.current = window.setTimeout(() => {
        if (
          !voiceCaptureDesiredRef.current ||
          appViewRef.current !== "simulation" ||
          !recognitionRef.current ||
          recognitionStartingRef.current ||
          recognitionActiveRef.current
        ) {
          return;
        }
        try {
          recognitionStartingRef.current = true;
          recognitionRef.current.start();
        } catch (error) {
          recognitionStartingRef.current = false;
          setStatusMessage(`Unable to restart voice capture: ${(error as Error).message}`);
          setVoiceMicState("idle");
        }
      }, wasStopping ? 220 : 280);
    };

    try {
      recognitionStartingRef.current = true;
      recognitionRef.current.start();
    } catch (error) {
      recognitionStartingRef.current = false;
      recognitionActiveRef.current = false;
      setVoiceMicState("idle");
      setStatusMessage(`Unable to start voice capture: ${(error as Error).message}`);
    }
  }, [
    appView,
    flashVoiceCommand,
    generatingTopic,
    preferences,
    processVoiceCommand,
    runActionFeedback,
    selectedTopicId,
    setAndPersistPreferences,
    simulationRendererLoading,
    token,
    voiceCaptureEnabled,
    voiceNarrationEnabled,
    speakText
  ]);

  const stopListening = useCallback(() => {
    voiceCaptureDesiredRef.current = false;
    recognitionStoppingRef.current = recognitionStartingRef.current || recognitionActiveRef.current;
    if (recognitionRestartTimerRef.current !== null) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_error) {
        recognitionStartingRef.current = false;
        recognitionActiveRef.current = false;
        recognitionStoppingRef.current = false;
      }
    }
    setListening(false);
    setVoiceInterimText("");
    if (!systemSpeakingRef.current) {
      setVoiceMicState("idle");
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

  const goHomeDirect = useCallback(() => {
    setMenuOpen(false);
    setToolsPanelOpen(false);
    setAppView("home");
    setStatusMessage("Home.");
  }, []);

  const navigateBack = useCallback(() => {
    if (appView === "history-detail") {
      setAppView("history-list");
      return;
    }
    if (appView === "history-list") {
      goHomeDirect();
      return;
    }
    if (appView === "progress-list") {
      goHomeDirect();
      return;
    }
    if (appView === "simulation") {
      pausedAtElapsedMsRef.current = stepElapsedMsRef.current;
      setSimulationPaused(true); window.speechSynthesis.cancel();
      stepNarrationCompleteRef.current = true;
      setToolsPanelOpen(false);
      goHomeDirect();
    }
  }, [appView, goHomeDirect]);

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
    const worker = new Worker(new URL("./workers/mathWorker.ts", import.meta.url), { type: "module" });
    mathWorkerRef.current = worker;
    return () => {
      worker.terminate();
      mathWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    appViewRef.current = appView;
  }, [appView]);

  useEffect(() => {
    simulationPausedRef.current = simulationPaused;
  }, [simulationPaused]);

  useEffect(() => {
    if (!token) {
      setSessionBootstrapping(false);
      return;
    }
    if (!loading && topics.length > 0) {
      setSessionBootstrapping(false);
    }
  }, [loading, token, topics.length]);

  useEffect(() => {
    localStorage.setItem("itt_voice_capture", String(voiceCaptureEnabled));
  }, [voiceCaptureEnabled]);

  useEffect(() => {
    localStorage.setItem("itt_subtitles", String(subtitlesEnabled));
  }, [subtitlesEnabled]);

  useEffect(() => {
    if (!voiceCaptureEnabled || appView !== "simulation") {
      setVoiceMicState("idle");
      setVoiceInterimText("");
    }
  }, [appView, voiceCaptureEnabled]);

  useEffect(() => {
    const textarea = chatInputRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(220, Math.max(88, textarea.scrollHeight))}px`;
  }, [chatInput]);

  useEffect(() => {
    setVoiceNarrationEnabled(preferences.voiceSettings.narrationEnabled);
  }, [preferences.voiceSettings.narrationEnabled]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (
      appView !== "simulation" ||
      !voiceCaptureEnabled ||
      simulationRendererLoading ||
      generatingTopic ||
      !selectedTopicId ||
      Boolean(simulationError)
    ) {
      stopListening();
      return;
    }
    startListening();
    return () => {
      stopListening();
    };
  }, [
    appView,
    generatingTopic,
    selectedTopicId,
    simulationError,
    simulationRendererLoading,
    startListening,
    stopListening,
    token,
    voiceCaptureEnabled
  ]);

  useEffect(() => {
    if (appView !== "home") {
      return;
    }
    const onEnterGenerate = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || (target as HTMLInputElement).type === "file")) {
        return;
      }
      if (generatingTopic || !customTopicInput.trim()) {
        return;
      }
      event.preventDefault();
      void generateCustomSimulation();
    };

    window.addEventListener("keydown", onEnterGenerate);
    return () => window.removeEventListener("keydown", onEnterGenerate);
  }, [appView, customTopicInput, generateCustomSimulation, generatingTopic]);

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
    const host = simulationHostRef.current;
    if (!host || !selectedTopic || appView !== "simulation") {
      return;
    }

    const steps = selectedSimulation?.steps?.length ? selectedSimulation.steps : [];
    if (!steps.length) {
      setCurrentStepText("No simulation data found for this topic.");
      setMathOverlayLines([]);
      setSimulationRendererLoading(false);
      return;
    }

    setSimulationRendererLoading(true);
    let disposed = false;
    let frameId = 0;
    let stepElapsedMs = stepElapsedMsRef.current;
    let currentStepDurationMs = 3200;
    let lastFrame = performance.now();
    let lastProcessedCommandId = 0;
    let renderer: SimulationCanvasRenderer | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const setStepNarration = (step: SimulationCanvasStep, index: number) => {
      setCurrentStepText(`Step ${index + 1}: ${step.concept}`);
      currentStepConceptRef.current = step.concept;
      setActiveStepIndex(index);
      if (subtitlesEnabled) {
        setSubtitle(step.subtitle);
      } else {
        setSubtitle("");
      }
      setMathOverlayLines([]);

      if (voiceNarrationEnabled && appViewRef.current === "simulation") {
        if ("speechSynthesis" in window && spokenStepRef.current !== index) {
          spokenStepRef.current = index;
          stepNarrationCompleteRef.current = false;
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(step.subtitle);
          utterance.rate = 1;
          utterance.onend = () => {
            stepNarrationCompleteRef.current = true;
          };
          utterance.onerror = () => {
            stepNarrationCompleteRef.current = true;
          };
          console.log("[Narration] speechSynthesis.speak()", {
            subtitle: step.subtitle,
            voiceNarrationEnabled,
            subtitlesEnabled
          });
          window.speechSynthesis.speak(utterance);
        } else {
          stepNarrationCompleteRef.current = true;
        }
      } else if ("speechSynthesis" in window) {
        stepNarrationCompleteRef.current = true;
        window.speechSynthesis.cancel();
      } else {
        stepNarrationCompleteRef.current = true;
      }
    };

    const applyStep = (index: number) => {
      if (!renderer) {
        return;
      }
      const step = steps[index];
      renderer.setStep(step as SimulationCanvasStepLike);
      console.log(`[Simulation] step=${index + 1} elementTypes=`, renderer.getElementTypes());
      const requestedDuration = Number(step.duration_ms);
      currentStepDurationMs =
        Number.isFinite(requestedDuration) && requestedDuration >= 12000 && requestedDuration <= 20000
          ? requestedDuration
          : renderer.getSuggestedDurationMs();
      setStepNarration(step, index);
      renderer.render(performance.now());
      setSimulationRendererLoading(false);
    };

    const onResize = () => {
      renderer?.resize();
      renderer?.render(performance.now());
    };

    renderer = new SimulationCanvasRenderer(host);
    simulationRendererRef.current = renderer;
    renderer.resize();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(host);
    }
    window.addEventListener("resize", onResize);

    if (simulationStepRef.current >= steps.length) {
      simulationStepRef.current = 0;
    }
    stepElapsedMs = 0;
    stepElapsedMsRef.current = 0;
    pausedAtElapsedMsRef.current = 0;
    applyStep(simulationStepRef.current);

    const tick = (now: number) => {
      if (disposed || !renderer) {
        return;
      }
      const delta = Math.min(50, now - lastFrame);
      lastFrame = now;
      stepElapsedMs = stepElapsedMsRef.current;

      const pendingCommand = pendingSimulationCommandRef.current;
      if (pendingCommand && pendingCommand.id > lastProcessedCommandId) {
        lastProcessedCommandId = pendingCommand.id;
        if (pendingCommand.action === "next-step") {
          simulationStepRef.current = (simulationStepRef.current + 1) % steps.length;
          stepElapsedMs = 0;
          stepElapsedMsRef.current = 0;
          pausedAtElapsedMsRef.current = 0;
          applyStep(simulationStepRef.current);
        } else if (pendingCommand.action === "previous-step") {
          simulationStepRef.current = (simulationStepRef.current - 1 + steps.length) % steps.length;
          stepElapsedMs = 0;
          stepElapsedMsRef.current = 0;
          pausedAtElapsedMsRef.current = 0;
          applyStep(simulationStepRef.current);
        } else if (pendingCommand.action === "pause") {
          pausedAtElapsedMsRef.current = stepElapsedMsRef.current;
          simulationPausedRef.current = true;
          setSimulationPaused(true); window.speechSynthesis.cancel();
          stepNarrationCompleteRef.current = true;
        } else if (pendingCommand.action === "play") {
          stepElapsedMs = pausedAtElapsedMsRef.current;
          stepElapsedMsRef.current = stepElapsedMs;
          simulationPausedRef.current = false;
          setSimulationPaused(false);
        } else if (pendingCommand.action === "restart") {
          simulationStepRef.current = 0;
          stepElapsedMs = 0;
          stepElapsedMsRef.current = 0;
          pausedAtElapsedMsRef.current = 0;
          applyStep(simulationStepRef.current);
        } else if (pendingCommand.action === "toggle-chat") {
          setChatPanelOpen((value) => !value);
        } else if (pendingCommand.action === "toggle-controls") {
          setToolsPanelOpen((value) => !value);
        } else if (pendingCommand.action === "go-home") {
          setAppView("home");
        }
        pendingSimulationCommandRef.current = null;
      }

      const pausedNow = simulationPausedRef.current || document.hidden;
      renderer.setPaused(pausedNow, now);
      if (!pausedNow) {
        stepElapsedMs += delta;
        stepElapsedMsRef.current = stepElapsedMs;
        if (stepElapsedMs >= currentStepDurationMs && stepNarrationCompleteRef.current) {
          stepElapsedMs = 0;
          stepElapsedMsRef.current = 0;
          pausedAtElapsedMsRef.current = 0;
          simulationStepRef.current = (simulationStepRef.current + 1) % steps.length;
          applyStep(simulationStepRef.current);
        }
      }

      renderer.render(now);
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onResize);
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stepElapsedMsRef.current = 0;
      pausedAtElapsedMsRef.current = 0;
      renderer?.dispose();
      simulationRendererRef.current = null;
      setSimulationRendererLoading(false);
    };
  }, [
    appView,
    selectedSimulation,
    selectedTopic,
    subtitlesEnabled,
    voiceNarrationEnabled
  ]);
  useEffect(() => {
    if (appView === "simulation") {
      return;
    }
    lastNarratedTopicRef.current = "";
    setCurrentStepText("");
    clearNarrationTimers();
  }, [appView, clearNarrationTimers]);

  useEffect(() => {
    const host = simulationThreeHostRef.current;
    if (!host || appView !== "simulation" || !selectedSimulation?.steps?.length) {
      return;
    }

    const step = selectedSimulation.steps[Math.min(selectedSimulation.steps.length - 1, Math.max(0, activeStepIndex))];
    const elements = [
      ...(Array.isArray(step.canvas_instructions?.elements) ? step.canvas_instructions.elements : []),
      ...(Array.isArray((step as any).elements) ? (step as any).elements : [])
    ].filter((element) => String((element as Record<string, unknown>).render_mode ?? "").toLowerCase() === "3d");

    if (!elements.length) {
      host.innerHTML = "";
      return;
    }

    let disposed = false;
    let frameId = 0;

    const run = async () => {
      const THREE = await loadThreeLib();
      if (disposed) return;

      host.innerHTML = "";
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
      camera.position.set(0, 2.4, 8);
      camera.lookAt(0, 0.4, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      host.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(8, 12, 9);
      key.castShadow = true;
      scene.add(ambient, key);

      const meshes: any[] = [];
      const percentX = (value: unknown) => ((Number(value ?? 50) - 50) / 50) * 4.8;
      const percentY = (value: unknown) => ((50 - Number(value ?? 50)) / 50) * 2.8;
      const sizeOf = (value: unknown, fallback: number) => Math.max(0.2, (Number(value ?? fallback) / 100) * 4);
      const colorOf = (value: unknown) =>
        typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#72d9ff";

      for (const raw of elements) {
        const element = raw as Record<string, unknown>;
        const type = String(element.type ?? "").toLowerCase().replace(/\s+/g, "_");
        const color = colorOf(element.color);
        const material = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45 });
        let mesh: any = null;
        const sx = sizeOf(element.width, 14);
        const sy = sizeOf(element.height, 14);
        if (type === "sphere") {
          mesh = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.22, sx * 0.25), 28, 28), material);
        } else if (type === "cube") {
          mesh = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.5, sy * 0.5, sx * 0.5), material);
        } else if (type === "cylinder") {
          mesh = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.18, sx * 0.2), Math.max(0.18, sx * 0.2), sy * 0.6, 24), material);
        } else if (type === "cone") {
          mesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(0.18, sx * 0.22), sy * 0.62, 24), material);
        } else if (type === "torus") {
          mesh = new THREE.Mesh(new THREE.TorusGeometry(Math.max(0.2, sx * 0.24), 0.08, 16, 64), material);
        } else if (type === "plane") {
          mesh = new THREE.Mesh(new THREE.PlaneGeometry(sx * 0.7, sy * 0.7), material);
        } else if (type === "3d_text" || type === "text_3d") {
          const label = String(element.label ?? element.text ?? "Text");
          const canvas = document.createElement("canvas");
          canvas.width = 512;
          canvas.height = 128;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "rgba(0,0,0,0.4)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 64px Inter, Segoe UI, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label.slice(0, 20), canvas.width / 2, canvas.height / 2);
          }
          const texture = new THREE.CanvasTexture(canvas);
          mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.max(0.8, sx), Math.max(0.35, sy * 0.5)),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true })
          );
        }
        if (!mesh) continue;
        mesh.position.set(percentX(element.x), percentY(element.y), 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        meshes.push(mesh);
      }

      const onResize = () => {
        const width = host.clientWidth || 200;
        const height = host.clientHeight || 200;
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      onResize();
      window.addEventListener("resize", onResize);

      const tick = () => {
        if (disposed) return;
        for (const mesh of meshes) {
          mesh.rotation.y += 0.004;
        }
        renderer.render(scene, camera);
        frameId = window.requestAnimationFrame(tick);
      };
      frameId = window.requestAnimationFrame(tick);

      return () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        host.innerHTML = "";
      };
    };

    let cleanup: (() => void) | undefined;
    void run().then((cb) => {
      cleanup = cb;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [activeStepIndex, appView, selectedSimulation]);

  useEffect(() => {
    const host = homeMascotRef.current;
    if (!host || appView !== "home") {
      return;
    }

    let disposed = false;
    let frameId = 0;
    let cleanup = () => undefined;

    const run = async () => {
      const THREE = await loadThreeLib();
      if (disposed) {
        return;
      }

      host.innerHTML = "";
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
      camera.position.set(0, 1.9, 10);
      camera.lookAt(0, 1.5, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      host.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.8);
      const key = new THREE.DirectionalLight(0x9bb9ff, 1.1);
      key.position.set(6, 8, 9);
      const fill = new THREE.DirectionalLight(0xffd98a, 0.55);
      fill.position.set(-5, 4, 6);
      scene.add(ambient, key, fill);

      const robot = new THREE.Group();
      scene.add(robot);

      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6f7f93, metalness: 0.48, roughness: 0.34 });
      const jointMat = new THREE.MeshStandardMaterial({ color: 0x2f3c4d, metalness: 0.7, roughness: 0.28 });
      const glowMat = new THREE.MeshStandardMaterial({
        color: 0x73ddff,
        emissive: 0x2f7fa8,
        emissiveIntensity: 1.6,
        metalness: 0.3,
        roughness: 0.2
      });

      const torso = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.9, 1.3), bodyMat);
      torso.position.set(0, 1.55, 0);
      robot.add(torso);

      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.35, 16), jointMat);
      neck.position.set(0, 3.15, 0);
      robot.add(neck);

      const head = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.4, 1.6), bodyMat);
      head.position.set(0, 4.05, 0);
      robot.add(head);

      const eyeLeft = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 20), glowMat.clone());
      const eyeRight = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 20), glowMat.clone());
      eyeLeft.position.set(-0.42, 4.1, 0.85);
      eyeRight.position.set(0.42, 4.1, 0.85);
      robot.add(eyeLeft, eyeRight);

      const shoulderLeft = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 16), jointMat);
      const shoulderRight = shoulderLeft.clone();
      shoulderLeft.position.set(-1.42, 2.5, 0);
      shoulderRight.position.set(1.42, 2.5, 0);
      robot.add(shoulderLeft, shoulderRight);

      const armGeo = new THREE.CylinderGeometry(0.19, 0.2, 1.75, 16);
      const armLeft = new THREE.Mesh(armGeo, bodyMat);
      const armRight = new THREE.Mesh(armGeo, bodyMat);
      armLeft.position.set(-1.42, 1.55, 0);
      armRight.position.set(1.42, 1.55, 0);
      robot.add(armLeft, armRight);

      const hip = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 1.1), jointMat);
      hip.position.set(0, -0.05, 0);
      robot.add(hip);

      const legGeo = new THREE.CylinderGeometry(0.24, 0.26, 2.2, 16);
      const legLeft = new THREE.Mesh(legGeo, bodyMat);
      const legRight = new THREE.Mesh(legGeo, bodyMat);
      legLeft.position.set(-0.52, -1.35, 0);
      legRight.position.set(0.52, -1.35, 0);
      robot.add(legLeft, legRight);

      const footGeo = new THREE.BoxGeometry(0.72, 0.28, 1.18);
      const footLeft = new THREE.Mesh(footGeo, jointMat);
      const footRight = new THREE.Mesh(footGeo, jointMat);
      footLeft.position.set(-0.52, -2.56, 0.24);
      footRight.position.set(0.52, -2.56, 0.24);
      robot.add(footLeft, footRight);

      const aura = new THREE.Mesh(
        new THREE.TorusGeometry(2.8, 0.05, 18, 90),
        new THREE.MeshBasicMaterial({ color: 0x7de3ff, transparent: true, opacity: 0.35 })
      );
      aura.rotation.x = Math.PI / 2;
      aura.position.y = -2.1;
      robot.add(aura);

      const eyeLeftMat = eyeLeft.material as { emissiveIntensity: number };
      const eyeRightMat = eyeRight.material as { emissiveIntensity: number };

      const onResize = () => {
        const width = host.clientWidth || 300;
        const height = host.clientHeight || 260;
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };

      onResize();
      window.addEventListener("resize", onResize);

      const tick = (now: number) => {
        const t = now * 0.0011;
        const speaking = topicListening;
        torso.scale.y = 1 + Math.sin(t * 1.8) * 0.03;
        robot.rotation.x = speaking ? -0.08 : 0;
        robot.position.z = speaking ? 0.22 : 0;
        head.rotation.y = speaking ? Math.sin(t * 1.4) * 0.28 : Math.sin(t * 0.65) * 0.12;
        armLeft.rotation.z = -0.18 + Math.sin(t * 0.7) * 0.06;
        armRight.rotation.z = 0.18 - Math.sin(t * 0.7) * 0.06;
        aura.rotation.z += 0.0025;
        eyeLeftMat.emissiveIntensity = speaking ? 3.9 : 1.6;
        eyeRightMat.emissiveIntensity = speaking ? 3.9 : 1.6;

        renderer.render(scene, camera);
        frameId = window.requestAnimationFrame(tick);
      };
      frameId = window.requestAnimationFrame(tick);

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        host.innerHTML = "";
      };
    };

    void run();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [appView, topicListening]);

  useEffect(() => {
    return () => {
      voiceCaptureDesiredRef.current = false;
      topicCaptureDesiredRef.current = false;
      if (commandFlashTimerRef.current !== null) {
        window.clearTimeout(commandFlashTimerRef.current);
      }
      if (recognitionRestartTimerRef.current !== null) {
        window.clearTimeout(recognitionRestartTimerRef.current);
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (topicRecognitionRef.current) {
        topicRecognitionRef.current.stop();
      }
      if (topicSilenceTimerRef.current !== null) {
        window.clearTimeout(topicSilenceTimerRef.current);
      }
      if (simulationLoaderTimeoutRef.current !== null) {
        window.clearTimeout(simulationLoaderTimeoutRef.current);
      }
      clearNarrationTimers();
    };
  }, [clearNarrationTimers]);

  const menuPanel = (
    <>
      {menuOpen ? <button className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-label="Close menu" /> : null}
      <aside className={menuOpen ? "side-menu open" : "side-menu"}>
        <nav className="side-menu-nav">
          <button className="ghost menu-option" onClick={goHomeDirect}>
            Home
          </button>
          <button className="ghost menu-option" onClick={openProgressPage}>
            Topic Progress
          </button>
          <button className="ghost menu-option" onClick={() => void openHistoryPage()}>
            Interaction History
          </button>
          <button className="ghost menu-option" onClick={handleLogout}>
            Logout
          </button>
        </nav>
      </aside>
    </>
  );

  const quickNavTabs = (
    <div className="quick-nav-tabs" role="tablist" aria-label="Section navigation">
      <button
        className={appView === "home" ? "quick-tab active" : "quick-tab"}
        onClick={goHomeDirect}
      >
        Home
      </button>
      <button
        className={appView === "history-list" || appView === "history-detail" ? "quick-tab active" : "quick-tab"}
        onClick={() => void openHistoryPage()}
      >
        Interaction History
      </button>
      <button
        className={appView === "progress-list" ? "quick-tab active" : "quick-tab"}
        onClick={openProgressPage}
      >
        Topic Progress
      </button>
    </div>
  );

  const floatingMenuButton = (
    <button
      className="menu-toggle"
      onClick={() => setMenuOpen((value) => !value)}
      aria-label="Open menu"
    >
      [=]
    </button>
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
          {loading ? (
            <div className="inline-skeleton">
              <div className="skeleton-line sm" />
              <div className="skeleton-line md" />
            </div>
          ) : null}
          <div className="status">{statusMessage}</div>
        </div>
      </div>
    );
  }

  if (appView === "home") {
    return (
      <div className="home-shell">
        {floatingMenuButton}
        {menuPanel}
        <div className="home-ambient" aria-hidden="true">
          <span className="ambient-icon i1">&lt;/&gt;</span>
          <span className="ambient-icon i2">{"{}"}</span>
          <span className="ambient-icon i3">API</span>
          <span className="ambient-icon i4">NN</span>
          <span className="ambient-icon i5">SQL</span>
          <span className="ambient-icon i6">TS</span>
          <span className="ambient-icon i7">GPU</span>
          <span className="ambient-icon i8">ML</span>
        </div>
        <div className="home-content">
          <div className="home-hero">
            <div className="home-hero-copy">
              <h1>Welcome, {userName || "Learner"}</h1>
              <p>Enter any technical topic and get a dynamic simulation with step-by-step visual flow.</p>
            </div>
            <div className="hero-character-wrap" aria-hidden="true">
              <div ref={homeMascotRef} className="mentor-3d-stage" />
            </div>
          </div>
          <div className="home-controls">
            <div className="home-controls-row">
              <input
                className="topic-input"
                value={customTopicInput}
                onChange={(event) => setCustomTopicInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !generatingTopic && customTopicInput.trim()) {
                    event.preventDefault();
                    void generateCustomSimulation();
                  }
                }}
                placeholder="e.g. Event sourcing, OAuth 2.0, CPU scheduling"
              />
              <div className="mic-wrap">
                <button
                  className={topicListening ? "mic-icon-btn listening" : "mic-icon-btn"}
                  disabled={generatingTopic}
                  onClick={captureTopicFromVoice}
                  aria-label={topicListening ? "Stop microphone" : "Start microphone"}
                  title={topicListening ? "Stop microphone" : "Start microphone"}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
                    <path d="M6 11a1 1 0 1 1 2 0 4 4 0 1 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z" />
                  </svg>
                </button>
                {topicListening ? <span className="mic-listening-label">Listening...</span> : null}
              </div>
              <button
                className="generate-btn"
                disabled={generatingTopic || !customTopicInput.trim()}
                onClick={() => void generateCustomSimulation()}
              >
                {generatingTopic ? "Generating Simulation..." : "Generate And Open Simulation"}
              </button>
            </div>
          </div>
          {generatingTopic ? (
            <div className="inline-skeleton">
              <div className="skeleton-line sm" />
              <div className="skeleton-line md" />
            </div>
          ) : null}
          <div className="status">{statusMessage}</div>
        </div>
      </div>
    );
  }

  if (appView === "history-list") {
    return (
      <div className="history-shell">
        {floatingMenuButton}
        {menuPanel}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back" title="Go back">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.7 5.3a1 1 0 0 1 0 1.4L10.41 11H20a1 1 0 1 1 0 2h-9.59l4.3 4.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.41 0Z" />
              </svg>
            </button>
            <h1>Interaction History</h1>
          </header>
          {quickNavTabs}
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
        {floatingMenuButton}
        {menuPanel}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back" title="Go back">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.7 5.3a1 1 0 0 1 0 1.4L10.41 11H20a1 1 0 1 1 0 2h-9.59l4.3 4.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.41 0Z" />
              </svg>
            </button>
            <h1>Chat Detail</h1>
          </header>
          {quickNavTabs}
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
        {floatingMenuButton}
        {menuPanel}
        <div className="history-content">
          <header className="page-header">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back" title="Go back">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.7 5.3a1 1 0 0 1 0 1.4L10.41 11H20a1 1 0 1 1 0 2h-9.59l4.3 4.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.41 0Z" />
              </svg>
            </button>
            <h1>Topic Progress</h1>
          </header>
          {quickNavTabs}
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
      {menuPanel}
      <main className="simulation-area">
        <header className="main-navbar">
          <div className="navbar-left">
            <button
              className="nav-icon-btn menu-inline"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label="Open menu"
              title="Open menu"
            >
              <span />
            </button>
            <button className="nav-icon-btn" onClick={navigateBack} aria-label="Go back" title="Go back">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.7 5.3a1 1 0 0 1 0 1.4L10.41 11H20a1 1 0 1 1 0 2h-9.59l4.3 4.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.41 0Z" />
              </svg>
            </button>
            <div className="top-title-wrap compact">
              <h1>Interactive Tech Tutor</h1>
            </div>
          </div>
          <div className="navbar-actions">
            <button
              className="nav-icon-btn"
              onClick={goHomeDirect}
              aria-label="Go to home"
              title="Home"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3.2 3 10v10a1 1 0 0 0 1 1h5.5a1 1 0 0 0 1-1v-4h3v4a1 1 0 0 0 1 1H20a1 1 0 0 0 1-1V10L12 3.2ZM5 10.9l7-5.3 7 5.3V19h-3.5v-4a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v4H5v-8.1Z" />
              </svg>
            </button>
            <button
              className={chatPanelOpen ? "active nav-icon-btn" : "nav-icon-btn"}
              onClick={() => setChatPanelOpen((value) => !value)}
              aria-label={chatPanelOpen ? "Hide chat panel" : "Show chat panel"}
              title={chatPanelOpen ? "Hide chat panel" : "Show chat panel"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-.7-.3L11.6 18H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 2v11h7a1 1 0 0 1 .7.3L15.9 19H19V5H5Z" />
              </svg>
            </button>
            <button
              className={toolsPanelOpen ? "active nav-icon-btn" : "nav-icon-btn"}
              onClick={() => setToolsPanelOpen((value) => !value)}
              aria-label={toolsPanelOpen ? "Hide controls" : "Show controls"}
              title={toolsPanelOpen ? "Hide controls" : "Show controls"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 12a2 2 0 1 1 .001-3.999A2 2 0 0 1 6 12Zm6 0a2 2 0 1 1 .001-3.999A2 2 0 0 1 12 12Zm6 0a2 2 0 1 1 .001-3.999A2 2 0 0 1 18 12Z" />
              </svg>
            </button>
          </div>
        </header>

        <section className="topic-summary compact">
          <h2>{selectedTopic?.title ?? "Simulation Topic"}</h2>
          <p className="now-explaining">
            Now Explaining: {currentStepText || selectedSimulation?.explanationScript || "Preparing simulation sequence..."}
          </p>
        </section>

        <section className="canvas-wrapper">
          <div ref={simulationHostRef} className="sim-canvas" />
          <div ref={simulationThreeHostRef} className="sim-canvas-3d-overlay" />
          <div className={mathOverlayLines.length > 0 ? "math-overlay visible" : "math-overlay"}>
            {mathOverlayLines.map((line, index) => (
              <p key={`math-line-${index}`}>{line}</p>
            ))}
          </div>
          {simulationRendererLoading || generatingTopic ? (
            <div className="simulation-loader-overlay">
              <div className="simulation-loader-spinner" aria-hidden="true" />
              <p>Generating simulation for {simulationLoadingTopic || customTopicInput || "this topic"}...</p>
            </div>
          ) : null}
          {simulationError ? (
            <div
              style={{
                position: "absolute",
                top: "18px",
                left: "18px",
                right: "18px",
                zIndex: 25,
                background: "rgba(140, 32, 32, 0.88)",
                border: "1px solid rgba(255, 205, 205, 0.65)",
                borderRadius: "12px",
                padding: "14px 16px",
                color: "#fff4f4",
                display: "flex",
                flexDirection: "column",
                gap: "10px"
              }}
            >
              <strong>Simulation Generation Failed</strong>
              <span>{simulationError}</span>
              <button
                className="chat-send-btn"
                onClick={() => void generateCustomSimulation()}
                style={{ alignSelf: "flex-start" }}
              >
                Retry Generation
              </button>
            </div>
          ) : null}
          <div className="sim-voice-corner">
            {voiceInterimText ? <div className="sim-interim-bubble">{voiceInterimText}</div> : null}
            <button
              className={`sim-mic-btn state-${voiceMicState}`}
              onClick={() => setVoiceCaptureEnabled((value) => !value)}
              aria-label={listening ? "Turn microphone off" : "Turn microphone on"}
              title={listening ? "Turn microphone off" : "Turn microphone on"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
                <path d="M6 11a1 1 0 1 1 2 0 4 4 0 1 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z" />
              </svg>
            </button>
            <span className={voiceMicState === "listening" ? "sim-mic-label active" : "sim-mic-label"}>
              {voiceMicState === "listening"
                ? "Listening..."
                : voiceMicState === "processing"
                  ? "Processing..."
                  : voiceMicState === "speaking"
                    ? "Speaking..."
                    : "Mic Off"}
            </span>
          </div>
          {voiceCommandFlash ? <div className="voice-command-flash">{voiceCommandFlash}</div> : null}
          <div className="sim-bottom-bar">
            <button
              className="sim-play-toggle nav-icon-btn"
              onClick={() => {
                if (!simulationPausedRef.current) {
                  pausedAtElapsedMsRef.current = stepElapsedMsRef.current;
                  simulationPausedRef.current = true;
                  setSimulationPaused(true); window.speechSynthesis.cancel();
                  stepNarrationCompleteRef.current = true;
                  return;
                }
                stepElapsedMsRef.current = pausedAtElapsedMsRef.current;
                simulationPausedRef.current = false;
                setSimulationPaused(false);
              }}
              aria-label={simulationPaused ? "Play simulation" : "Pause simulation"}
              title={simulationPaused ? "Play simulation" : "Pause simulation"}
            >
              {simulationPaused ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 5.5a1 1 0 0 1 1.5-.87l8 5.5a1 1 0 0 1 0 1.74l-8 5.5A1 1 0 0 1 8 16.5v-11Z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm10 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Z" />
                </svg>
              )}
            </button>
            <div className="subtitle-bar">
              {subtitlesEnabled ? subtitle || "Simulation subtitles will appear here." : "Subtitles are muted."}
            </div>
          </div>
        </section>

        <aside className={toolsPanelOpen ? "controls-drawer open" : "controls-drawer"}>
          <h3>Simulation Controls</h3>
          <button
            className={subtitlesEnabled ? "switch-row active" : "switch-row"}
            onClick={() => setSubtitlesEnabled((value) => !value)}
          >
            <span>Subtitles</span>
            <span className="switch-knob" />
          </button>
          <button
            className={voiceNarrationEnabled ? "switch-row active" : "switch-row"}
            onClick={() => {
              const checked = !voiceNarrationEnabled;
              setVoiceNarrationEnabled(checked);
              const next = {
                ...preferences,
                voiceSettings: {
                  ...preferences.voiceSettings,
                  narrationEnabled: checked
                }
              };
              setAndPersistPreferences(next);
            }}
          >
            <span>Voice Narration</span>
            <span className="switch-knob" />
          </button>
          <button
            className={voiceCaptureEnabled ? "switch-row active" : "switch-row"}
            onClick={() => setVoiceCaptureEnabled((value) => !value)}
          >
            <span>Voice Capture</span>
            <span className="switch-knob" />
          </button>
          <button
            className={preferences.voiceSettings.interactionEnabled ? "switch-row active" : "switch-row"}
            onClick={() => {
              const next = {
                ...preferences,
                voiceSettings: {
                  ...preferences.voiceSettings,
                  interactionEnabled: !preferences.voiceSettings.interactionEnabled
                }
              };
              setAndPersistPreferences(next);
            }}
          >
            <span>Voice Interaction</span>
            <span className="switch-knob" />
          </button>
          <button
            className={preferences.voiceSettings.navigationEnabled ? "switch-row active" : "switch-row"}
            onClick={() => {
              const next = {
                ...preferences,
                voiceSettings: {
                  ...preferences.voiceSettings,
                  navigationEnabled: !preferences.voiceSettings.navigationEnabled
                }
              };
              setAndPersistPreferences(next);
            }}
          >
            <span>Voice Navigation</span>
            <span className="switch-knob" />
          </button>
          <div className={listening ? "voice-indicator active" : "voice-indicator idle"}>
            <span className="state-dot" />
            {listening ? "Capture Active" : "Capture Idle"}
          </div>
        </aside>
      </main>

      {chatPanelOpen ? (
        <aside className="interaction-panel">
          <section className="panel-section">
            <h3>Topic Chat</h3>
            <div className="chat-window">
              {messages.slice(-16).map((message, index) => (
                <article key={`${message.role}-${index}`} className={`chat-bubble chat-${message.role}`}>
                  <span className="chat-label">{message.role === "user" ? "You" : "Tutor"}</span>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask a question about the active simulation..."
            />
            <button className="chat-send-btn" onClick={() => void sendChat("text")}>
              Send
            </button>
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
    </div>
  );
}

