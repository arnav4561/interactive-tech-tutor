import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, prewarmApi } from "./api";
import {
  ChatMessage,
  DifficultyLevel,
  HistoryItem,
  ProblemSet,
  ProgressRecord,
  SimulationGenerationResponse,
  SimulationStep,
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
  const [sessionBootstrapping, setSessionBootstrapping] = useState(false);
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
  const [mathOverlayLines, setMathOverlayLines] = useState<string[]>([]);
  const [voiceNarrationEnabled, setVoiceNarrationEnabled] = useState(false);
  const [topicListening, setTopicListening] = useState(false);
  const [simulationRendererLoading, setSimulationRendererLoading] = useState(false);
  const [voiceCommandFlash, setVoiceCommandFlash] = useState("");

  const simulationHostRef = useRef<HTMLDivElement | null>(null);
  const homeMascotRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const topicRecognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const topicRecognitionActiveRef = useRef(false);
  const narrationTimersRef = useRef<number[]>([]);
  const subtitleTimerRef = useRef<number | null>(null);
  const voiceCaptureDesiredRef = useRef(false);
  const narrationSessionRef = useRef(0);
  const appViewRef = useRef<AppView>("home");
  const lastNarratedTopicRef = useRef("");
  const isNarratingRef = useRef(false);
  const simulationStepRef = useRef(0);
  const spokenStepRef = useRef(-1);
  const recognitionStartingRef = useRef(false);
  const recognitionActiveRef = useRef(false);
  const recognitionStoppingRef = useRef(false);
  const recognitionRestartTimerRef = useRef<number | null>(null);
  const mathWorkerRef = useRef<Worker | null>(null);
  const mathWorkerTicketRef = useRef(0);
  const commandFlashTimerRef = useRef<number | null>(null);
  const pendingSimulationCommandRef = useRef<{
    id: number;
    action:
      | "next-step"
      | "previous-step"
      | "pause"
      | "play"
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
    }, 1500);
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
        setAppView("home");
        setStatusMessage("Session restored.");
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
    if (topicRecognitionRef.current && topicRecognitionActiveRef.current) {
      try {
        topicRecognitionRef.current.stop();
      } catch (_error) {
        // no-op
      }
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
    }
    const normalizedRequestedTopic = requestedTopic.toLowerCase();
    const existingTopic = topics.find((item) => item.title.trim().toLowerCase() === normalizedRequestedTopic);
    if (existingTopic && generatedSimulations[existingTopic.id]) {
      setSelectedTopicId(existingTopic.id);
      setAppView("simulation");
      setSimulationPaused(false);
      setStatusMessage(`Loaded cached simulation for ${existingTopic.title}.`);
      return;
    }

    setAppView("simulation");
    setSelectedTopicId("");
    setCurrentStepText("Generating simulation plan...");
    setSimulationRendererLoading(true);
    setMenuOpen(false);
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
      setAppView("home");
      setStatusMessage((error as Error).message);
    } finally {
      setGeneratingTopic(false);
      setSimulationRendererLoading(false);
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
      try {
        topicRecognitionRef.current?.stop();
      } catch (_error) {
        // no-op
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
    let finalizedTranscript = "";
    recognition.onresult = (event: any) => {
      let interimTranscript = "";
      const resultStart = typeof event.resultIndex === "number" ? event.resultIndex : 0;
      for (let index = resultStart; index < event.results.length; index += 1) {
        const result = event.results[index];
        const segment = result?.[0]?.transcript?.trim() ?? "";
        if (!segment) {
          continue;
        }
        if (result.isFinal) {
          finalizedTranscript = `${finalizedTranscript} ${segment}`.trim();
        } else {
          interimTranscript = `${interimTranscript} ${segment}`.trim();
        }
      }
      const composed = `${finalizedTranscript} ${interimTranscript}`.trim();
      if (composed) {
        setCustomTopicInput(composed);
      }
    };
    recognition.onerror = (event) => {
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
      setStatusMessage(`Voice input error: ${event.error}`);
    };
    recognition.onend = () => {
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
    };

    try {
      if (topicRecognitionActiveRef.current) {
        recognition.stop();
      }
      setTopicListening(true);
      topicRecognitionActiveRef.current = true;
      recognition.start();
    } catch (error) {
      topicRecognitionActiveRef.current = false;
      setTopicListening(false);
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

      if (command.includes("go back")) {
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
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognitionRef.current = recognition;
    }

    recognitionRef.current.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      const transcript = result?.[0]?.transcript?.trim();
      const confidence = Number(result?.[0]?.confidence ?? 0);
      const isFinal = Boolean(result?.isFinal);
      if (!transcript || !isFinal) {
        return;
      }
      if (confidence < 0.75) {
        flashVoiceCommand("Command: Low confidence");
        return;
      }
      void runActionFeedback("voice-command", transcript);
      processVoiceCommand(transcript);
    };
    recognitionRef.current.onstart = () => {
      recognitionStartingRef.current = false;
      recognitionActiveRef.current = true;
      setListening(true);
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
    };
    recognitionRef.current.onend = () => {
      recognitionActiveRef.current = false;
      recognitionStartingRef.current = false;
      setListening(false);
      const wasStopping = recognitionStoppingRef.current;
      recognitionStoppingRef.current = false;
      if (!voiceCaptureDesiredRef.current || appViewRef.current !== "simulation") {
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
        }
      }, wasStopping ? 220 : 280);
    };

    try {
      recognitionStartingRef.current = true;
      recognitionRef.current.start();
    } catch (error) {
      recognitionStartingRef.current = false;
      recognitionActiveRef.current = false;
      setStatusMessage(`Unable to start voice capture: ${(error as Error).message}`);
    }
  }, [appView, flashVoiceCommand, processVoiceCommand, runActionFeedback]);

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
      setSimulationRendererLoading(false);
      return;
    }
    setSimulationRendererLoading(true);
    let disposed = false;
    let cleanup = () => undefined;

    const run = async () => {
      const THREE = await loadThreeLib();
      if (disposed) {
        return;
      }

      host.innerHTML = "";
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#1a1a2e");

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

      const clampPosition = (position: { x: number; y: number; z: number }) => ({
        x: Math.max(-8.5, Math.min(8.5, position.x)),
        y: Math.max(-4.6, Math.min(4.6, position.y)),
        z: Math.max(-5, Math.min(5, position.z))
      });

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
            new THREE.Vector3(
              obj.type === "arrow" ? Math.max(0.8, obj.size.x) : obj.size.x,
              obj.size.y,
              obj.size.z
            )
          ]);
          mesh = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({
              color,
              transparent: true,
              opacity: 0.9
            })
          );
        } else if (obj.type === "text") {
          const sprite = createTextSprite(obj.label ?? obj.id, obj.color);
          mesh = sprite ?? new THREE.Group();
        } else {
          mesh = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.2, obj.size.x), Math.max(0.2, obj.size.y), Math.max(0.2, obj.size.z)),
            material
          );
        }

        const safePosition = clampPosition(obj.position);
        mesh.position.set(safePosition.x, safePosition.y, safePosition.z);
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

      type ConnectionRuntime = {
        line: any;
        from: any;
        to: any;
      };

      type LabelRuntime = {
        sprite: any;
        target: any;
        offset: any;
        line?: any;
      };

      let objectMap = new Map<string, any>();
      let movementRuntimes: MovementRuntime[] = [];
      let connectionRuntimes: ConnectionRuntime[] = [];
      let labelRuntimes: LabelRuntime[] = [];
      let frameId = 0;
      let lastTime = performance.now();
      let stepElapsedMs = 0;
      const stepDurationMs = 3000;

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
          const worker = mathWorkerRef.current;
          if (!worker) {
            setMathOverlayLines(expressions.map((item) => `${item.expression} = [worker unavailable]`));
          } else {
            const ticket = ++mathWorkerTicketRef.current;
            const onMessage = (event: MessageEvent<{ ticket: number; lines: string[] }>) => {
              if (disposed || event.data.ticket !== ticket) {
                return;
              }
              worker.removeEventListener("message", onMessage as EventListener);
              setMathOverlayLines(event.data.lines);
            };
            worker.addEventListener("message", onMessage as EventListener);
            worker.postMessage({
              ticket,
              expressions
            });
          }
        }

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

      const buildAutoConnections = (objects: SimulationStep["objects"]) => {
        const nodes = objects.filter((obj) => !["line", "arrow", "text"].includes(obj.type));
        if (nodes.length < 2) {
          return [] as Array<{ fromId: string; toId: string }>;
        }

        const topicName = selectedTopic?.title.toLowerCase() ?? "";
        if (topicName.includes("tree") || topicName.includes("decision")) {
          const byY = new Map<number, SimulationStep["objects"]>();
          nodes.forEach((node) => {
            const bucket = Math.round(node.position.y * 10) / 10;
            byY.set(bucket, [...(byY.get(bucket) ?? []), node]);
          });
          const levels = Array.from(byY.entries())
            .sort((a, b) => b[0] - a[0])
            .map((entry) => entry[1].sort((left, right) => left.position.x - right.position.x));

          const links: Array<{ fromId: string; toId: string }> = [];
          for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
            const parents = levels[levelIndex];
            const children = levels[levelIndex + 1];
            parents.forEach((parent) => {
              const nearestChildren = children
                .slice()
                .sort(
                  (left, right) =>
                    Math.abs(left.position.x - parent.position.x) - Math.abs(right.position.x - parent.position.x)
                )
                .slice(0, Math.min(2, children.length));
              nearestChildren.forEach((child) => {
                links.push({ fromId: parent.id, toId: child.id });
              });
            });
          }
          if (links.length > 0) {
            return links;
          }
        }

        const sortedByX = nodes.slice().sort((left, right) => left.position.x - right.position.x);
        return sortedByX.slice(0, -1).map((node, index) => ({
          fromId: node.id,
          toId: sortedByX[index + 1].id
        }));
      };

      const renderConnection = (from: any, to: any, color = "#2a3a4f") => {
        const geometry = new THREE.BufferGeometry().setFromPoints([
          from.position.clone(),
          to.position.clone()
        ]);
        const material = new THREE.LineBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.72
        });
        const line = new THREE.Line(geometry, material);
        rootGroup.add(line);
        connectionRuntimes.push({ line, from, to });
      };

      const updateConnections = () => {
        connectionRuntimes.forEach((connection) => {
          connection.line.geometry.setFromPoints([
            connection.from.position.clone(),
            connection.to.position.clone()
          ]);
        });
      };

      const updateAnchoredLabels = () => {
        labelRuntimes.forEach((item) => {
          const nextPosition = item.target.position.clone().add(item.offset);
          const safe = clampPosition(nextPosition);
          item.sprite.position.set(safe.x, safe.y, safe.z);
          if (item.line) {
            item.line.geometry.setFromPoints([
              item.target.position.clone(),
              item.sprite.position.clone()
            ]);
          }
        });
      };

      const applyStep = (index: number) => {
        const step = steps[index];
        rootGroup.clear();
        objectMap = new Map<string, any>();
        movementRuntimes = [];
        connectionRuntimes = [];
        labelRuntimes = [];

        step.objects.forEach((obj) => {
          const mesh = createObjectMesh(obj);
          rootGroup.add(mesh);
          objectMap.set(obj.id, mesh);

          const labelText = obj.label ?? "";
          if (labelText) {
            const label = createTextSprite(labelText, "#202a37");
            if (label) {
              const offset = new THREE.Vector3(0, Math.max(0.8, obj.size.y / 1.8 + 0.8), 0);
              const raw = mesh.position.clone().add(offset);
              const safe = clampPosition(raw);
              label.position.set(safe.x, safe.y, safe.z);
              rootGroup.add(label);
              const connector = new THREE.BufferGeometry().setFromPoints([
                mesh.position.clone(),
                label.position.clone()
              ]);
              const connectorLine = new THREE.Line(
                connector,
                new THREE.LineBasicMaterial({ color: "#2c3d5a", opacity: 0.45, transparent: true })
              );
              rootGroup.add(connectorLine);
              labelRuntimes.push({
                sprite: label,
                target: mesh,
                offset,
                line: connectorLine
              });
            }
          }
        });

        step.labels.forEach((label) => {
          const sprite = createTextSprite(label.text, label.color ?? "#1f2937");
          if (!sprite) {
            return;
          }
          let connectorFrom: any | null = null;
          if (label.objectId && objectMap.has(label.objectId)) {
            const target = objectMap.get(label.objectId)!;
            connectorFrom = target;
            const raw = target.position.clone().add(new THREE.Vector3(0, 1.8, 0));
            const safe = clampPosition(raw);
            sprite.position.set(safe.x, safe.y, safe.z);
          } else if (label.position) {
            const safe = clampPosition(label.position);
            sprite.position.set(safe.x, safe.y, safe.z);
          } else {
            sprite.position.set(0, 4.4, 0);
          }
          rootGroup.add(sprite);
          if (connectorFrom) {
            const connector = new THREE.BufferGeometry().setFromPoints([
              connectorFrom.position.clone(),
              sprite.position.clone()
            ]);
            const connectorLine = new THREE.Line(
              connector,
              new THREE.LineBasicMaterial({ color: "#3b4a63", opacity: 0.5, transparent: true })
            );
            rootGroup.add(connectorLine);
            labelRuntimes.push({
              sprite,
              target: connectorFrom,
              offset: new THREE.Vector3(0, 1.8, 0),
              line: connectorLine
            });
          }
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
            toPosition: movement.to
              ? (() => {
                  const safe = clampPosition(movement.to);
                  return new THREE.Vector3(safe.x, safe.y, safe.z);
                })()
              : undefined,
            axis: movement.axis ? new THREE.Vector3(movement.axis.x, movement.axis.y, movement.axis.z) : undefined,
            durationMs: movement.durationMs,
            repeat: movement.repeat ?? 0
          });
        });

        const explicitLinks =
          step.connections?.filter(
            (link) => objectMap.has(link.fromId) && objectMap.has(link.toId)
          ) ?? [];

        const linksToRender =
          explicitLinks.length > 0
            ? explicitLinks.map((link) => ({
                fromId: link.fromId,
                toId: link.toId,
                color: link.color ?? "#2a3a4f",
                label: link.label
              }))
            : buildAutoConnections(step.objects).map((link) => ({
                ...link,
                color: "#2a3a4f",
                label: undefined as string | undefined
              }));

        linksToRender.forEach((link) => {
          const fromObject = objectMap.get(link.fromId);
          const toObject = objectMap.get(link.toId);
          if (!fromObject || !toObject) {
            return;
          }
          renderConnection(fromObject, toObject, link.color);
          if (link.label) {
            const sprite = createTextSprite(link.label, "#d6e8ff");
            if (sprite) {
              const midpoint = fromObject.position.clone().lerp(toObject.position, 0.5);
              const safe = clampPosition(midpoint.add(new THREE.Vector3(0, 0.45, 0)));
              sprite.position.set(safe.x, safe.y, safe.z);
              rootGroup.add(sprite);
            }
          }
        });
        updateConnections();

        if (step.graph && step.graph.x.length === step.graph.y.length && step.graph.x.length > 1) {
          const graphGroup = new THREE.Group();
          const maxX = Math.max(...step.graph.x);
          const minX = Math.min(...step.graph.x);
          const maxY = Math.max(...step.graph.y);
          const minY = Math.min(...step.graph.y);
          const spanX = Math.max(1e-3, maxX - minX);
          const spanY = Math.max(1e-3, maxY - minY);
          const plotW = 6.4;
          const plotH = 3.4;
          const origin = new THREE.Vector3(-3.2, -2.2, 0);

          const points = step.graph.x.map((value, pointIndex) => {
            const normalizedX = ((value - minX) / spanX) * plotW;
            const normalizedY = ((step.graph!.y[pointIndex] - minY) / spanY) * plotH;
            return new THREE.Vector3(origin.x + normalizedX, origin.y + normalizedY, 0);
          });

          const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
          graphGroup.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: "#1f5fd6" })));
          points.forEach((point) => {
            const marker = new THREE.Mesh(
              new THREE.SphereGeometry(0.09, 14, 14),
              new THREE.MeshStandardMaterial({ color: "#4db1ff", emissive: "#1c4f8f", emissiveIntensity: 0.55 })
            );
            marker.position.copy(point);
            graphGroup.add(marker);
          });
          rootGroup.add(graphGroup);
        }

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
            const clamped = clampPosition(item.object.position);
            item.object.position.set(clamped.x, clamped.y, clamped.z);
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
        updateConnections();
        updateAnchoredLabels();
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
      let lastProcessedCommandId = 0;

      const animate = (now: number) => {
        const delta = Math.min(50, now - lastTime);
        lastTime = now;

        const pendingCommand = pendingSimulationCommandRef.current;
        if (pendingCommand && pendingCommand.id > lastProcessedCommandId) {
          lastProcessedCommandId = pendingCommand.id;
          if (pendingCommand.action === "next-step") {
            simulationStepRef.current = (simulationStepRef.current + 1) % steps.length;
            stepElapsedMs = 0;
            applyStep(simulationStepRef.current);
          } else if (pendingCommand.action === "previous-step") {
            simulationStepRef.current = (simulationStepRef.current - 1 + steps.length) % steps.length;
            stepElapsedMs = 0;
            applyStep(simulationStepRef.current);
          } else if (pendingCommand.action === "pause") {
            setSimulationPaused(true);
          } else if (pendingCommand.action === "play") {
            setSimulationPaused(false);
          } else if (pendingCommand.action === "toggle-chat") {
            setChatPanelOpen((value) => !value);
          } else if (pendingCommand.action === "toggle-controls") {
            setToolsPanelOpen((value) => !value);
          } else if (pendingCommand.action === "go-home") {
            setAppView("home");
          }
          pendingSimulationCommandRef.current = null;
        }

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
      setSimulationRendererLoading(false);

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("resize", onResize);
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
        renderer.dispose();
        host.innerHTML = "";
        setSimulationRendererLoading(false);
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
      clearNarrationTimers();
    };
  }, [clearNarrationTimers]);

  const menuPanel = (
    <>
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
          {sessionBootstrapping && loading ? (
            <div className="page-skeleton">
              <div className="skeleton-line lg" />
              <div className="skeleton-line md" />
              <div className="skeleton-box" />
            </div>
          ) : null}
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
        {floatingMenuButton}
        {menuPanel}
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
        {floatingMenuButton}
        {menuPanel}
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
          <div className={mathOverlayLines.length > 0 ? "math-overlay visible" : "math-overlay"}>
            {mathOverlayLines.map((line, index) => (
              <p key={`math-line-${index}`}>{line}</p>
            ))}
          </div>
          {simulationRendererLoading || generatingTopic ? (
            <div className="simulation-skeleton">
              <div className="skeleton-line lg" />
              <div className="skeleton-line md" />
            </div>
          ) : null}
          <div className="sim-voice-corner">
            <button
              className={listening ? "sim-mic-btn active" : "sim-mic-btn"}
              onClick={() => setVoiceCaptureEnabled((value) => !value)}
              aria-label={listening ? "Turn microphone off" : "Turn microphone on"}
              title={listening ? "Turn microphone off" : "Turn microphone on"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
                <path d="M6 11a1 1 0 1 1 2 0 4 4 0 1 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z" />
              </svg>
            </button>
            <span className={listening ? "sim-mic-label active" : "sim-mic-label"}>
              {listening ? "Listening..." : "Mic Off"}
            </span>
          </div>
          {voiceCommandFlash ? <div className="voice-command-flash">{voiceCommandFlash}</div> : null}
          <div className="sim-bottom-bar">
            <button
              className="sim-play-toggle nav-icon-btn"
              onClick={() => setSimulationPaused((value) => !value)}
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
      <div className="status-bar">{loading ? "Loading..." : statusMessage}</div>
    </div>
  );
}

