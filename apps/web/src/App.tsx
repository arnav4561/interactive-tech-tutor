import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, prewarmApi } from "./api";
import {
  ChatMessage,
  DifficultyLevel,
  HistoryItem,
  ProblemSet,
  ProgressRecord,
  SimulationGraph,
  SimulationGenerationResponse,
  SimulationStep,
  Topic,
  UserPreferences
} from "./types";

const LEVELS: DifficultyLevel[] = ["beginner", "intermediate", "advanced"];

let threeLibPromise: Promise<any> | null = null;
let plotlyLibPromise: Promise<any> | null = null;
let mathjsLibPromise: Promise<any> | null = null;

function loadThreeLib(): Promise<any> {
  if (!threeLibPromise) {
    threeLibPromise = import("three");
  }
  return threeLibPromise;
}

function loadPlotlyLib(): Promise<any> {
  if (!plotlyLibPromise) {
    plotlyLibPromise = import("plotly.js-dist-min");
  }
  return plotlyLibPromise;
}

function loadMathjsLib(): Promise<any> {
  if (!mathjsLibPromise) {
    mathjsLibPromise = import("mathjs");
  }
  return mathjsLibPromise;
}

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

interface GeneratedSimulation {
  explanationScript: string;
  steps: SimulationStep[];
  generationSource: "template" | "gemini";
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
  const [generatedSimulations, setGeneratedSimulations] = useState<Record<string, GeneratedSimulation>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentStepText, setCurrentStepText] = useState("");
  const [activeGraph, setActiveGraph] = useState<SimulationGraph | null>(null);
  const [mathOverlayLines, setMathOverlayLines] = useState<string[]>([]);
  const [voiceNarrationEnabled, setVoiceNarrationEnabled] = useState(false);
  const [topicListening, setTopicListening] = useState(false);

  const simulationHostRef = useRef<HTMLDivElement | null>(null);
  const graphOverlayRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const topicRecognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const narrationTimersRef = useRef<number[]>([]);
  const subtitleTimerRef = useRef<number | null>(null);
  const voiceCaptureDesiredRef = useRef(false);
  const narrationSessionRef = useRef(0);
  const appViewRef = useRef<AppView>("home");
  const lastNarratedTopicRef = useRef("");
  const isNarratingRef = useRef(false);
  const simulationStepRef = useRef(0);
  const spokenStepRef = useRef(-1);

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
        setPreferences(prefResponse.preferences);
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
    setGeneratedSimulations({});
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
      setGeneratedSimulations((current) => ({
        ...current,
        [response.topic.id]: {
          explanationScript: response.explanation_script,
          steps: response.simulation_steps,
          generationSource: response.generationSource === "gemini" ? "gemini" : "template"
        }
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

    if (!topicRecognitionRef.current) {
      const recognition = new RecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      topicRecognitionRef.current = recognition;
    }

    const recognition = topicRecognitionRef.current;
    recognition.onresult = (event) => {
      const spoken = event.results[0]?.[0]?.transcript?.trim();
      if (spoken) {
        setCustomTopicInput(spoken);
        setStatusMessage("Voice topic captured.");
      }
      setTopicListening(false);
    };
    recognition.onerror = (event) => {
      setTopicListening(false);
      setStatusMessage(`Voice input error: ${event.error}`);
    };
    recognition.onend = () => {
      setTopicListening(false);
    };

    try {
      setTopicListening(true);
      recognition.start();
    } catch (error) {
      setTopicListening(false);
      setStatusMessage(`Unable to start topic voice input: ${(error as Error).message}`);
    }
  }, []);

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
    setVoiceNarrationEnabled(preferences.voiceSettings.narrationEnabled);
  }, [preferences.voiceSettings.narrationEnabled]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (appView !== "simulation" || !voiceCaptureEnabled) {
      stopListening();
      return;
    }
    startListening();
    return () => {
      stopListening();
    };
  }, [appView, startListening, stopListening, token, voiceCaptureEnabled]);

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
      setActiveGraph(null);
      return;
    }
    let disposed = false;
    let cleanup = () => undefined;
    let mathEvaluate: ((expression: string, scope?: Record<string, number>) => unknown) | null = null;
    let mathTicket = 0;

    const run = async () => {
      const THREE = await loadThreeLib();
      if (disposed) {
        return;
      }

      host.innerHTML = "";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#f4f7fb");

      const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
      camera.position.set(0, 0, 18);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      host.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.72);
      const directional = new THREE.DirectionalLight(0xffffff, 0.75);
      directional.position.set(9, 10, 12);
      scene.add(ambient);
      scene.add(directional);

      const rootGroup = new THREE.Group();
      scene.add(rootGroup);

      const createTextSprite = (text: string, color = "#1f2937") => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return null;
        }
        canvas.width = 512;
        canvas.height = 128;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(255,255,255,0.94)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = "700 34px Trebuchet MS";
        ctx.fillStyle = color;
        ctx.fillText(text.slice(0, 44), 14, 72);
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(5.4, 1.4, 1);
        return sprite;
      };

      const createObjectMesh = (obj: SimulationStep["objects"][number]) => {
        const color = new THREE.Color(obj.color);
        const material = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.22,
          roughness: 0.54
        });

        let mesh: any;
        if (obj.type === "sphere") {
          mesh = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.2, obj.size.x / 1.4), 32, 24), material);
        } else if (obj.type === "cylinder") {
          mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(Math.max(0.2, obj.size.x / 2), Math.max(0.2, obj.size.z / 2), Math.max(0.2, obj.size.y), 24),
            material
          );
        } else if (obj.type === "cone") {
          mesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(0.2, obj.size.x / 2), Math.max(0.2, obj.size.y), 24), material);
        } else if (obj.type === "torus") {
          mesh = new THREE.Mesh(new THREE.TorusGeometry(Math.max(0.3, obj.size.x / 2), 0.22, 20, 80), material);
        } else if (obj.type === "plane") {
          mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.3, obj.size.x), Math.max(0.3, obj.size.y)), material);
        } else if (obj.type === "line" || obj.type === "arrow") {
          const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(Math.max(0.6, obj.size.x), 0, 0)
          ]);
          mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
        } else if (obj.type === "text") {
          const sprite = createTextSprite(obj.label ?? obj.id, obj.color);
          mesh = sprite ?? new THREE.Group();
        } else {
          mesh = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.2, obj.size.x), Math.max(0.2, obj.size.y), Math.max(0.2, obj.size.z)),
            material
          );
        }

        mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
        if (obj.rotation) {
          mesh.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z);
        }
        return mesh;
      };

      type MovementRuntime = {
        object: any;
        type: "translate" | "rotate" | "scale" | "pulse";
        fromPosition: any;
        fromRotation: any;
        fromScale: any;
        toPosition?: any;
        axis?: any;
        durationMs: number;
        repeat: number;
      };

      let objectMap = new Map<string, any>();
      let movementRuntimes: MovementRuntime[] = [];
      let frameId = 0;
      let lastTime = performance.now();
      let stepElapsedMs = 0;
      const stepDurationMs = 3000;

      const ensureMathEvaluate = async () => {
        if (mathEvaluate) {
          return mathEvaluate;
        }
        const mathjs = await loadMathjsLib();
        mathEvaluate = mathjs.evaluate as (expression: string, scope?: Record<string, number>) => unknown;
        return mathEvaluate;
      };

      const setStepNarration = (step: SimulationStep, index: number) => {
        setCurrentStepText(`Step ${step.step}: ${step.annotation}`);
        if (subtitlesEnabled) {
          setSubtitle(step.annotation);
        } else {
          setSubtitle("");
        }

        const expressions = step.mathExpressions ?? [];
        if (expressions.length === 0) {
          setMathOverlayLines([]);
        } else {
          const currentTicket = ++mathTicket;
          void ensureMathEvaluate().then((evaluateExpression) => {
            if (disposed || currentTicket !== mathTicket) {
              return;
            }
            const mathLines = expressions.map((item) => {
              try {
                const result = evaluateExpression(item.expression, item.variables ?? {});
                return `${item.expression} = ${String(result)}`;
              } catch (_error) {
                return `${item.expression} = [invalid expression]`;
              }
            });
            setMathOverlayLines(mathLines);
          });
        }

        setActiveGraph(step.graph ?? null);

        if (voiceNarrationEnabled && appViewRef.current === "simulation") {
          if ("speechSynthesis" in window) {
            if (spokenStepRef.current !== index) {
              spokenStepRef.current = index;
              window.speechSynthesis.cancel();
              const utterance = new SpeechSynthesisUtterance(step.annotation);
              utterance.rate = 1;
              window.speechSynthesis.speak(utterance);
            }
          }
        } else if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
      };

      const applyStep = (index: number) => {
        const step = steps[index];
        rootGroup.clear();
        objectMap = new Map<string, any>();
        movementRuntimes = [];

        step.objects.forEach((obj) => {
          const mesh = createObjectMesh(obj);
          rootGroup.add(mesh);
          objectMap.set(obj.id, mesh);

          const labelText = obj.label ?? "";
          if (labelText) {
            const label = createTextSprite(labelText, "#202a37");
            if (label) {
              label.position.set(obj.position.x, obj.position.y + Math.max(0.8, obj.size.y / 1.8 + 0.8), obj.position.z);
              rootGroup.add(label);
            }
          }
        });

        step.labels.forEach((label) => {
          const sprite = createTextSprite(label.text, label.color ?? "#1f2937");
          if (!sprite) {
            return;
          }
          if (label.objectId && objectMap.has(label.objectId)) {
            const target = objectMap.get(label.objectId)!;
            sprite.position.copy(target.position.clone().add(new THREE.Vector3(0, 1.8, 0)));
          } else if (label.position) {
            sprite.position.set(label.position.x, label.position.y, label.position.z);
          } else {
            sprite.position.set(0, 4.4, 0);
          }
          rootGroup.add(sprite);
        });

        step.movements.forEach((movement) => {
          const object = objectMap.get(movement.objectId);
          if (!object) {
            return;
          }
          movementRuntimes.push({
            object,
            type: movement.type,
            fromPosition: object.position.clone(),
            fromRotation: object.rotation.clone(),
            fromScale: object.scale.clone(),
            toPosition: movement.to ? new THREE.Vector3(movement.to.x, movement.to.y, movement.to.z) : undefined,
            axis: movement.axis ? new THREE.Vector3(movement.axis.x, movement.axis.y, movement.axis.z) : undefined,
            durationMs: movement.durationMs,
            repeat: movement.repeat ?? 0
          });
        });

        setStepNarration(step, index);
      };

      const updateMovements = (elapsed: number) => {
        movementRuntimes.forEach((item) => {
          const cycleDuration = Math.max(300, item.durationMs);
          const totalCycles = Math.max(1, item.repeat + 1);
          const cappedElapsed = Math.min(elapsed, cycleDuration * totalCycles);
          const currentCycleProgress = Math.min(1, (cappedElapsed % cycleDuration) / cycleDuration);
          const progress = cappedElapsed >= cycleDuration * totalCycles ? 1 : currentCycleProgress;

          if (item.type === "translate" && item.toPosition) {
            item.object.position.lerpVectors(item.fromPosition, item.toPosition, progress);
          } else if (item.type === "rotate") {
            const axis = item.axis ?? new THREE.Vector3(0, 1, 0);
            item.object.rotation.set(
              item.fromRotation.x + axis.x * progress * Math.PI * 2,
              item.fromRotation.y + axis.y * progress * Math.PI * 2,
              item.fromRotation.z + axis.z * progress * Math.PI * 2
            );
          } else if (item.type === "scale") {
            const axis = item.axis ?? new THREE.Vector3(0.45, 0.45, 0.45);
            const target = item.fromScale.clone().add(axis);
            item.object.scale.lerpVectors(item.fromScale, target, progress);
          } else if (item.type === "pulse") {
            const pulse = 1 + 0.18 * Math.sin(progress * Math.PI * 2);
            item.object.scale.set(item.fromScale.x * pulse, item.fromScale.y * pulse, item.fromScale.z * pulse);
          }
        });
      };

      const onResize = () => {
        const width = host.clientWidth || 800;
        const height = host.clientHeight || 450;
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };

      onResize();
      window.addEventListener("resize", onResize);

      if (simulationStepRef.current >= steps.length) {
        simulationStepRef.current = 0;
      }
      applyStep(simulationStepRef.current);

      const animate = (now: number) => {
        const delta = Math.min(50, now - lastTime);
        lastTime = now;

        if (!simulationPaused && !document.hidden) {
          stepElapsedMs += delta;
          updateMovements(stepElapsedMs);
          if (stepElapsedMs >= stepDurationMs) {
            stepElapsedMs = 0;
            simulationStepRef.current = (simulationStepRef.current + 1) % steps.length;
            applyStep(simulationStepRef.current);
          }
        }

        renderer.render(scene, camera);
        frameId = window.requestAnimationFrame(animate);
      };

      frameId = window.requestAnimationFrame(animate);

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("resize", onResize);
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
        renderer.dispose();
        host.innerHTML = "";
      };
    };

    void run();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [
    appView,
    selectedSimulation,
    selectedTopic,
    simulationPaused,
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
    const host = graphOverlayRef.current;
    if (!host || appView !== "simulation") {
      return;
    }
    if (!activeGraph) {
      host.innerHTML = "";
      return;
    }

    let disposed = false;
    let plotlyApi: {
      react: (el: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<void>;
      purge: (el: HTMLElement) => void;
    } | null = null;

    const run = async () => {
      const module = await loadPlotlyLib();
      if (disposed) {
        return;
      }
      plotlyApi = (module.default ?? module) as {
        react: (el: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<void>;
        purge: (el: HTMLElement) => void;
      };

      const traceType = activeGraph.type === "line" ? "scatter" : activeGraph.type;
      await plotlyApi.react(
        host,
        [
          {
            x: activeGraph.x,
            y: activeGraph.y,
            type: traceType,
            mode: activeGraph.type === "line" ? "lines+markers" : "markers",
            marker: { color: "#3a7afe" },
            line: { color: "#1f5fd6" }
          }
        ],
        {
          title: activeGraph.title,
          margin: { l: 36, r: 16, t: 36, b: 32 },
          paper_bgcolor: "rgba(255,255,255,0.94)",
          plot_bgcolor: "rgba(245,248,255,0.95)"
        },
        { displayModeBar: false, responsive: true }
      );
    };

    void run();
    return () => {
      disposed = true;
      if (plotlyApi) {
        plotlyApi.purge(host);
      } else {
        host.innerHTML = "";
      }
    };
  }, [activeGraph, appView]);

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
        [=]
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
            <div className="home-controls-actions">
              <button disabled={topicListening || generatingTopic} onClick={captureTopicFromVoice}>
                {topicListening ? "Listening..." : "Use Voice Topic"}
              </button>
              <button
                disabled={generatingTopic || !customTopicInput.trim()}
                onClick={() => void generateCustomSimulation()}
              >
                {generatingTopic ? "Generating Simulation..." : "Generate And Open Simulation"}
              </button>
            </div>
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
              {"<"}
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
              {"<"}
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
              {"<"}
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
        {"<"}
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
              []
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
            Now Explaining: {currentStepText || selectedSimulation?.explanationScript || "Preparing simulation sequence..."}
          </p>
        </section>

        <section className="canvas-wrapper">
          <div ref={simulationHostRef} className="sim-canvas" />
          <div ref={graphOverlayRef} className={activeGraph ? "graph-overlay visible" : "graph-overlay"} />
          <div className={mathOverlayLines.length > 0 ? "math-overlay visible" : "math-overlay"}>
            {mathOverlayLines.map((line, index) => (
              <p key={`math-line-${index}`}>{line}</p>
            ))}
          </div>
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
                checked={voiceNarrationEnabled}
                onChange={(event) => {
                  const checked = event.target.checked;
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
              />
              Voice Narration
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={voiceCaptureEnabled}
                onChange={(event) => setVoiceCaptureEnabled(event.target.checked)}
              />
              Voice Capture
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={preferences.voiceSettings.interactionEnabled}
                onChange={(event) => {
                  const next = {
                    ...preferences,
                    voiceSettings: {
                      ...preferences.voiceSettings,
                      interactionEnabled: event.target.checked
                    }
                  };
                  setAndPersistPreferences(next);
                }}
              />
              Voice Interaction
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={preferences.voiceSettings.navigationEnabled}
                onChange={(event) => {
                  const next = {
                    ...preferences,
                    voiceSettings: {
                      ...preferences.voiceSettings,
                      navigationEnabled: event.target.checked
                    }
                  };
                  setAndPersistPreferences(next);
                }}
              />
              Voice Navigation
            </label>
            <div className="voice-note">
              Voice capture state: {listening ? "Listening..." : "Idle"}.
            </div>
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
          {simulationPaused ? ">" : "||"}
        </button>
      </div>
      <div className="subtitle-bar">
        {subtitlesEnabled ? subtitle || "Simulation subtitles will appear here." : "Subtitles are muted."}
      </div>
      <div className="status-bar">{loading ? "Loading..." : statusMessage}</div>
    </div>
  );
}

