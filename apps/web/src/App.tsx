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

type AppView = "home" | "simulation" | "history-list" | "history-detail";

function defaultPreferences(): UserPreferences {
  return {
    interactionMode: "both",
    voiceSettings: {
      narrationEnabled: true,
      interactionEnabled: true,
      navigationEnabled: true,
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
  const [listening, setListening] = useState(false);
  const [voiceCaptureEnabled, setVoiceCaptureEnabled] = useState<boolean>(() => loadVoiceCapturePreference());
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(() => loadSubtitlePreference());
  const [preferences, setPreferences] = useState<UserPreferences>(() => defaultPreferences());
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [customTopicInput, setCustomTopicInput] = useState("");
  const [generatingTopic, setGeneratingTopic] = useState(false);
  const [generatedProblemSets, setGeneratedProblemSets] = useState<Record<string, ProblemSet[]>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const narrationTimersRef = useRef<number[]>([]);
  const subtitleTimerRef = useRef<number | null>(null);
  const voiceCaptureDesiredRef = useRef(false);
  const narrationSessionRef = useRef(0);
  const appViewRef = useRef<AppView>("home");
  const lastNarratedTopicRef = useRef("");
  const isNarratingRef = useRef(false);

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
          if (preferences.voiceSettings.interactionEnabled) {
            speak(response.response, false);
          }
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [loadHistory, preferences.voiceSettings.interactionEnabled, pushSubtitle, selectedTopicId, speak, subtitlesEnabled, token]
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
    setCustomTopicInput("");
    setSelectedHistoryId("");
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
      setSelectedTopicId(response.topic.id);
      setAppView("simulation");
      setMenuOpen(false);
      setMessages((current) => [...current, { role: "assistant", text: response.openingMessage }]);
      const source = response.generationSource === "gemini" ? "Gemini" : "template";
      setStatusMessage(`Generated simulation for ${response.topic.title} (${source}).`);
      setCustomTopicInput("");
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setGeneratingTopic(false);
    }
  }, [customTopicInput, selectedLevel, token]);

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
          if (preferences.voiceSettings.interactionEnabled) {
            speak(response.response, false);
          }
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [chatInput, loadHistory, preferences.voiceSettings.interactionEnabled, pushSubtitle, selectedTopicId, speak, subtitlesEnabled, token]
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
          if (current === "simulation" || current === "history-list") {
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
    setStatusMessage("Voice capture paused.");
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
    if (appView === "simulation") {
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
    localStorage.setItem("itt_voice_capture", String(voiceCaptureEnabled));
  }, [voiceCaptureEnabled]);

  useEffect(() => {
    localStorage.setItem("itt_subtitles", String(subtitlesEnabled));
  }, [subtitlesEnabled]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (appView !== "simulation") {
      stopListening();
      return;
    }
    const captureAllowed =
      voiceCaptureEnabled &&
      (preferences.voiceSettings.interactionEnabled || preferences.voiceSettings.navigationEnabled);

    if (captureAllowed) {
      startListening();
      return;
    }
    stopListening();
  }, [
    preferences.voiceSettings.interactionEnabled,
    preferences.voiceSettings.navigationEnabled,
    startListening,
    stopListening,
    token,
    voiceCaptureEnabled,
    appView
  ]);

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
        const topic = topics.find((item) => item.id === selectedTopicId);
        if (topic) {
          playNarration(topic);
        }
        return;
      }

      try {
        const response = await apiGet<{ problemSets: ProblemSet[] }>(
          `/topics/${selectedTopicId}/problem-sets`,
          token
        );
        setProblemSets(response.problemSets);
        setSelectedAnswers({});
        const topic = topics.find((item) => item.id === selectedTopicId);
        if (topic) {
          playNarration(topic);
        }
      } catch (error) {
        setProblemSets([]);
        setStatusMessage((error as Error).message);
      }
    };

    void loadTopicData();
  }, [appView, generatedProblemSets, playNarration, selectedTopicId, token, topics]);

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
    if (!canvas || !selectedTopic || appView !== "simulation") {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    let animationFrame = 0;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);

    const seed = selectedTopic.title
      .split("")
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const paletteOptions = [
      {
        bgA: "#f8f9fb",
        bgB: "#f1f3f7",
        bgC: "#fff7d1",
        line: "rgba(46, 57, 71, 0.16)",
        nodeFill: "rgba(248, 223, 132, 0.6)",
        nodeStroke: "#5d5a4f",
        text: "#1f2329",
        accent: "#f4c542",
        dock: "rgba(255, 249, 227, 0.92)"
      },
      {
        bgA: "#f5f6f8",
        bgB: "#ebedf1",
        bgC: "#ffeeb3",
        line: "rgba(25, 32, 40, 0.15)",
        nodeFill: "rgba(255, 220, 120, 0.58)",
        nodeStroke: "#3e434c",
        text: "#1d2127",
        accent: "#e6bc39",
        dock: "rgba(255, 248, 215, 0.9)"
      },
      {
        bgA: "#f7f7f7",
        bgB: "#eef0f3",
        bgC: "#fff1be",
        line: "rgba(60, 60, 60, 0.14)",
        nodeFill: "rgba(244, 210, 106, 0.56)",
        nodeStroke: "#44484f",
        text: "#1f2024",
        accent: "#e0ae2b",
        dock: "rgba(254, 247, 219, 0.92)"
      }
    ] as const;
    const palette = paletteOptions[seed % paletteOptions.length];

    const symbolFallback = ["<>", "{}", "[]", "()", "=>", "API", "NN", "DB", "CPU", "ML"];
    const topicTokens = Array.from(
      new Set(
        `${selectedTopic.title} ${selectedTopic.description}`
          .toUpperCase()
          .replace(/[^A-Z0-9 ]/g, " ")
          .split(/\s+/)
          .filter((token) => token.length >= 3)
      )
    )
      .slice(0, 12)
      .map((token) => token.slice(0, 7));
    const symbolPool = topicTokens.length > 0 ? [...topicTokens, ...symbolFallback] : symbolFallback;

    type VisualNodeShape = "circle" | "square" | "triangle";
    const shapes: VisualNodeShape[] = ["circle", "square", "triangle"];
    const nodes = Array.from({ length: 15 }, (_, index) => ({
      x: 70 + Math.random() * Math.max(140, width - 160),
      y: 56 + Math.random() * Math.max(120, height - 150),
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
      size: 14 + Math.random() * 12,
      shape: shapes[(seed + index) % shapes.length],
      label: symbolPool[index % symbolPool.length]
    }));

    const draggable = {
      x: width * 0.12,
      y: height * 0.65,
      size: 42,
      label: symbolPool[0]
    };

    const target = {
      x: width * 0.69,
      y: height * 0.13,
      w: width * 0.24,
      h: height * 0.23
    };

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let lastScrollFeedbackAt = 0;

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

    const drawNode = (x: number, y: number, size: number, shape: VisualNodeShape) => {
      if (shape === "circle") {
        context.beginPath();
        context.arc(x, y, size, 0, Math.PI * 2);
        context.closePath();
        return;
      }
      if (shape === "square") {
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

    const render = () => {
      context.clearRect(0, 0, width, height);
      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, palette.bgA);
      bg.addColorStop(0.6, palette.bgB);
      bg.addColorStop(1, palette.bgC);
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      for (let x = 0; x < width; x += 52) {
        context.strokeStyle = "rgba(20, 24, 31, 0.04)";
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = 0; y < height; y += 46) {
        context.strokeStyle = "rgba(20, 24, 31, 0.04)";
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      drawRoundedRect(target.x, target.y, target.w, target.h, 12);
      context.fillStyle = palette.dock;
      context.fill();
      context.setLineDash([8, 5]);
      context.strokeStyle = palette.line;
      context.lineWidth = 1.4;
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = palette.text;
      context.font = "600 13px 'Trebuchet MS', sans-serif";
      context.fillText("Validation Dock", target.x + 14, target.y + 24);
      context.font = "12px 'Trebuchet MS', sans-serif";
      context.fillStyle = "rgba(30, 33, 39, 0.78)";
      context.fillText("Drop active symbol here", target.x + 14, target.y + 44);

      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 24 || node.x > width - 24) {
          node.vx *= -1;
        }
        if (node.y < 24 || node.y > height - 24) {
          node.vy *= -1;
        }

        for (let j = i + 1; j < nodes.length; j += 1) {
          const other = nodes[j];
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 170) {
            context.strokeStyle = `rgba(65, 72, 84, ${Math.max(0.03, 0.2 - distance / 1200)})`;
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(node.x, node.y);
            context.lineTo(other.x, other.y);
            context.stroke();
          }
        }
      }

      nodes.forEach((node) => {
        drawNode(node.x, node.y, node.size, node.shape);
        context.fillStyle = palette.nodeFill;
        context.fill();
        context.strokeStyle = palette.nodeStroke;
        context.lineWidth = 1.2;
        context.stroke();
        context.fillStyle = palette.text;
        context.font = "600 10px 'Trebuchet MS', sans-serif";
        const label = node.label.length > 6 ? `${node.label.slice(0, 6)}` : node.label;
        context.fillText(label, node.x - node.size * 0.7, node.y + 3);
      });

      drawRoundedRect(draggable.x, draggable.y, draggable.size, draggable.size, 10);
      context.fillStyle = palette.accent;
      context.fill();
      context.strokeStyle = "rgba(45, 45, 45, 0.6)";
      context.lineWidth = 1.4;
      context.stroke();
      context.fillStyle = palette.text;
      context.font = "700 11px 'Trebuchet MS', sans-serif";
      context.fillText(draggable.label.slice(0, 6), draggable.x + 7, draggable.y + draggable.size / 2 + 4);

      context.fillStyle = palette.text;
      context.font = "700 14px 'Trebuchet MS', sans-serif";
      context.fillText(selectedTopic.title, 20, 28);
      context.font = "12px 'Trebuchet MS', sans-serif";
      context.fillStyle = "rgba(26, 29, 34, 0.76)";
      context.fillText("Interactive simulation: drag module + scroll to explore transitions", 20, 48);

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
      const isCorrect =
        centerX >= target.x &&
        centerX <= target.x + target.w &&
        centerY >= target.y &&
        centerY <= target.y + target.h;
      void runActionFeedback("drag", isCorrect ? "correct placement" : "missed placement");
    };

    const onWheel = (event: WheelEvent) => {
      const now = Date.now();
      if (now - lastScrollFeedbackAt < 1000) {
        return;
      }
      lastScrollFeedbackAt = now;
      void runActionFeedback("scroll", event.deltaY > 0 ? "forward-scroll" : "back-scroll");
    };

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);
    canvas.addEventListener("wheel", onWheel);
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [appView, runActionFeedback, selectedTopic]);

  useEffect(() => {
    if (appView === "simulation") {
      return;
    }
    lastNarratedTopicRef.current = "";
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
        <div className="side-menu-header">
          <strong>{userName || "Learner"}</strong>
          <span>{userEmail}</span>
        </div>
        <section className="side-menu-section">
          <h3>Topic Progress</h3>
          {progress.length === 0 ? (
            <p>No progress yet.</p>
          ) : (
            <div className="side-scroll">
              {sortedProgress.map((item, index) => (
                <p key={`${item.topicId}-${item.level}-${index}`}>
                  <strong>{topicTitleById.get(item.topicId) ?? item.topicId}</strong> [{item.level}] {item.status} ({item.score}%)
                </p>
              ))}
            </div>
          )}
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
        <div className="home-content">
          <div className="home-hero">
            <div className="home-hero-copy">
              <h1>Welcome, {userName || "Learner"}</h1>
              <p>Choose a topic, generate a simulation, and learn with voice, visuals, and interactive feedback.</p>
            </div>
            <div className="tech-character-scene" aria-hidden="true">
              <div className="tech-symbol symbol-a">&lt;/&gt;</div>
              <div className="tech-symbol symbol-b">{"{}"}</div>
              <div className="tech-symbol symbol-c">NN</div>
              <div className="tech-symbol symbol-d">API</div>
              <div className="tech-character">
                <div className="character-head" />
                <div className="character-body" />
                <div className="character-arm arm-left" />
                <div className="character-arm arm-right" />
                <div className="character-laptop">
                  <span>{"<code/>"}</span>
                </div>
                <div className="character-desk" />
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
            <label>
              Difficulty
              <select
                value={selectedLevel}
                onChange={(event) => setSelectedLevel(event.target.value as DifficultyLevel)}
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
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

  return (
    <div className="app-shell">
      {userMenu}
      <main className="simulation-area">
        <header className="top-bar">
          <div className="top-title-wrap">
            <button className="back-arrow" onClick={navigateBack} aria-label="Go back">
              ←
            </button>
            <div>
            <h1>Interactive Tech Tutor</h1>
            <p>{userName || userEmail}</p>
            </div>
          </div>
          <div className="top-actions">
            <select value={selectedTopicId} onChange={(event) => setSelectedTopicId(event.target.value)}>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.title}
                </option>
              ))}
            </select>
            <select
              value={selectedLevel}
              onChange={(event) => setSelectedLevel(event.target.value as DifficultyLevel)}
            >
              {LEVELS.map((level) => (
                <option key={level} value={level} disabled={!unlockedLevels.has(level)}>
                  {unlockedLevels.has(level) ? level : `${level} [locked]`}
                </option>
                ))}
            </select>
          </div>
        </header>

        <section className="topic-summary">
          <h2>{selectedTopic?.title ?? "Select a topic"}</h2>
          <p>{selectedTopic?.description ?? "No topic selected."}</p>
          <div className="feedback-strip">
            <strong>Action Feedback:</strong> {feedbackText || "Perform drag/scroll/back actions to receive feedback."}
          </div>
        </section>

        <section className="canvas-wrapper">
          <canvas ref={canvasRef} className="sim-canvas" />
        </section>

        <section className="problem-panel">
          <h3>Current Level Exercise: {selectedLevel}</h3>
          {!currentProblemSet ? (
            <p>No problem set found for this topic/level.</p>
          ) : (
            <div className="problem-list">
              {currentProblemSet.problems.map((problem) => (
                <article key={problem.id} className="problem-card">
                  <p>{problem.question}</p>
                  <div className="choice-group">
                    {problem.choices.map((choice) => (
                      <button
                        key={choice}
                        className={selectedAnswers[problem.id] === choice ? "choice active" : "choice"}
                        onClick={() =>
                          setSelectedAnswers((current) => ({
                            ...current,
                            [problem.id]: choice
                          }))
                        }
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
              <button onClick={() => void submitCurrentProblemSet()}>Submit Level</button>
            </div>
          )}
        </section>
      </main>

      <aside className="interaction-panel">
        <section className="panel-section">
          <h3>Interaction Mode</h3>
          <div className="button-row">
            {(["voice", "click", "both"] as const).map((mode) => (
              <button
                key={mode}
                className={preferences.interactionMode === mode ? "active" : ""}
                onClick={() => setAndPersistPreferences({ ...preferences, interactionMode: mode })}
              >
                {mode}
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <h3>Voice Controls</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={voiceCaptureEnabled}
              onChange={(event) => setVoiceCaptureEnabled(event.target.checked)}
            />
            Capture User Voice ({listening ? "active" : "inactive"})
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={preferences.voiceSettings.narrationEnabled}
              onChange={(event) =>
                setAndPersistPreferences({
                  ...preferences,
                  voiceSettings: {
                    ...preferences.voiceSettings,
                    narrationEnabled: event.target.checked
                  }
                })
              }
            />
            Narration Voice
          </label>
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
              checked={preferences.voiceSettings.interactionEnabled}
              onChange={(event) =>
                setAndPersistPreferences({
                  ...preferences,
                  voiceSettings: {
                    ...preferences.voiceSettings,
                    interactionEnabled: event.target.checked
                  }
                })
              }
            />
            Voice Interaction
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={preferences.voiceSettings.navigationEnabled}
              onChange={(event) =>
                setAndPersistPreferences({
                  ...preferences,
                  voiceSettings: {
                    ...preferences.voiceSettings,
                    navigationEnabled: event.target.checked
                  }
                })
              }
            />
            Voice Navigation
          </label>
          <label>
            System Voice
            <select
              value={preferences.voiceSettings.voiceName}
              onChange={(event) =>
                setAndPersistPreferences({
                  ...preferences,
                  voiceSettings: {
                    ...preferences.voiceSettings,
                    voiceName: event.target.value
                  }
                })
              }
            >
              <option value="">Auto (prefer Voice Box)</option>
              {availableVoices.map((voice) => (
                <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </label>
          <label>
            Narration Speed: {preferences.voiceSettings.rate.toFixed(1)}x
            <input
              type="range"
              min={0.7}
              max={1.8}
              step={0.1}
              value={preferences.voiceSettings.rate}
              onChange={(event) =>
                setAndPersistPreferences({
                  ...preferences,
                  voiceSettings: {
                    ...preferences.voiceSettings,
                    rate: Number(event.target.value)
                  }
                })
              }
            />
          </label>
          <p className="voice-note">
            Voice capture starts only after mic permission and can be turned off anytime.
          </p>
        </section>

        <section className="panel-section">
          <h3>Chat</h3>
          <div className="chat-window">
            {messages.slice(-12).map((message, index) => (
              <p key={`${message.role}-${index}`} className={`chat-${message.role}`}>
                <strong>{message.role === "user" ? "You" : "Tutor"}:</strong> {message.text}
              </p>
            ))}
          </div>
          <textarea
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            placeholder="Ask a question about the current topic..."
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
          <p>{uploadFeedback || "Upload a file or capture an image for analysis."}</p>
        </section>

      </aside>

      <div className="subtitle-bar">
        {subtitlesEnabled ? subtitle || "Subtitles will appear here during narration." : "Subtitles are muted."}
      </div>
      <div className="status-bar">{loading ? "Loading..." : statusMessage}</div>
    </div>
  );
}
