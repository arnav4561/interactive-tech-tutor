import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
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

export default function App(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [token, setToken] = useState<string>(() => localStorage.getItem("itt_token") ?? "");
  const [userEmail, setUserEmail] = useState<string>(() => localStorage.getItem("itt_email") ?? "");
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
  const [listening, setListening] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>(() => defaultPreferences());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<InstanceType<RecognitionConstructor> | null>(null);
  const narrationTimersRef = useRef<number[]>([]);

  const selectedTopic = useMemo(
    () => topics.find((topic) => topic.id === selectedTopicId) ?? null,
    [topics, selectedTopicId]
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

  const speak = useCallback(
    (text: string, interrupt = false) => {
      if (!("speechSynthesis" in window)) {
        return;
      }
      const synth = window.speechSynthesis;
      if (interrupt) {
        synth.cancel();
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = preferences.voiceSettings.rate;
      if (preferences.voiceSettings.voiceName) {
        const voice = synth
          .getVoices()
          .find((item) => item.name.toLowerCase() === preferences.voiceSettings.voiceName.toLowerCase());
        if (voice) {
          utterance.voice = voice;
        }
      }
      synth.speak(utterance);
    },
    [preferences.voiceSettings.rate, preferences.voiceSettings.voiceName]
  );

  const clearNarrationTimers = useCallback(() => {
    narrationTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    narrationTimersRef.current = [];
    setSubtitle("");
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const playNarration = useCallback(
    (topic: Topic) => {
      clearNarrationTimers();
      if (!preferences.voiceSettings.narrationEnabled && !topic.narration.length) {
        return;
      }

      let offset = 0;
      topic.narration.forEach((line, index) => {
        const duration = Math.max(1800, Math.round((line.length * 45) / preferences.voiceSettings.rate));
        const timer = window.setTimeout(() => {
          setSubtitle(line);
          if (preferences.voiceSettings.narrationEnabled) {
            speak(line);
          }
          if (index === topic.narration.length - 1) {
            const clearTimer = window.setTimeout(() => setSubtitle(""), duration - 300);
            narrationTimersRef.current.push(clearTimer);
          }
        }, offset);
        narrationTimersRef.current.push(timer);
        offset += duration;
      });
    },
    [clearNarrationTimers, preferences.voiceSettings.narrationEnabled, preferences.voiceSettings.rate, speak]
  );

  const loadHistory = useCallback(async () => {
    if (!token || !selectedTopicId) {
      setHistory([]);
      return;
    }
    try {
      const response = await apiGet<{ history: HistoryItem[] }>(`/history?topicId=${selectedTopicId}`, token);
      setHistory(response.history);
    } catch (error) {
      setStatusMessage((error as Error).message);
    }
  }, [selectedTopicId, token]);

  const runActionFeedback = useCallback(
    async (actionType: "drag" | "scroll" | "back", detail: string) => {
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
        if (preferences.voiceSettings.interactionEnabled) {
          speak(response.response, true);
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [loadHistory, preferences.voiceSettings.interactionEnabled, selectedTopicId, speak, token]
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
        setStatusMessage("Session restored.");
      } catch (error) {
        setStatusMessage((error as Error).message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleAuth = useCallback(async () => {
    setLoading(true);
    setStatusMessage("Authenticating...");
    try {
      const route = registerMode ? "/auth/register" : "/auth/login";
      const response = await apiPost<{
        token: string;
        user: { email: string };
      }>(route, { email, password });

      setToken(response.token);
      setUserEmail(response.user.email);
      localStorage.setItem("itt_token", response.token);
      localStorage.setItem("itt_email", response.user.email);
      setStatusMessage(registerMode ? "Account created." : "Login successful.");
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [email, password, registerMode]);

  const handleLogout = useCallback(() => {
    setToken("");
    setUserEmail("");
    setTopics([]);
    setProgress([]);
    setProblemSets([]);
    setHistory([]);
    setMessages([]);
    clearNarrationTimers();
    localStorage.removeItem("itt_token");
    localStorage.removeItem("itt_email");
    setStatusMessage("Logged out.");
  }, [clearNarrationTimers]);

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
        if (preferences.voiceSettings.interactionEnabled && mode === "voice") {
          speak(response.response, true);
        }
        await loadHistory();
      } catch (error) {
        setStatusMessage((error as Error).message);
      }
    },
    [chatInput, loadHistory, preferences.voiceSettings.interactionEnabled, selectedTopicId, speak, token]
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
          return true;
        }
      }

      if (command.includes("mute narration")) {
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: false }
        };
        setAndPersistPreferences(next);
        return true;
      }

      if (command.includes("enable narration") || command.includes("unmute narration")) {
        const next = {
          ...preferences,
          voiceSettings: { ...preferences.voiceSettings, narrationEnabled: true }
        };
        setAndPersistPreferences(next);
        return true;
      }

      if (command.includes("go back")) {
        void runActionFeedback("back", "voice navigation");
        return true;
      }

      return false;
    },
    [preferences, runActionFeedback, selectedTopicId, setAndPersistPreferences, topics, unlockedLevels]
  );

  const startListening = useCallback(() => {
    if (!preferences.voiceSettings.interactionEnabled && !preferences.voiceSettings.navigationEnabled) {
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

    if (!recognitionRef.current) {
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        const lastResult = event.results[event.results.length - 1];
        const transcript = lastResult[0]?.transcript?.trim();
        if (!transcript) {
          return;
        }

        const handled =
          preferences.voiceSettings.navigationEnabled && preferences.interactionMode !== "click"
            ? processVoiceCommand(transcript)
            : false;

        if (!handled && preferences.interactionMode !== "click" && preferences.voiceSettings.interactionEnabled) {
          void sendChat("voice", transcript);
        }
      };
      recognition.onerror = (event) => {
        setStatusMessage(`Voice input error: ${event.error}`);
      };
      recognition.onend = () => {
        setListening(false);
      };
      recognitionRef.current = recognition;
    }

    recognitionRef.current.start();
    setListening(true);
  }, [preferences, processVoiceCommand, sendChat]);

  const stopListening = useCallback(() => {
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

  useEffect(() => {
    if (token) {
      void bootstrap(token);
    }
  }, [bootstrap, token]);

  useEffect(() => {
    if (!token || !selectedTopicId) {
      return;
    }

    const loadTopicData = async () => {
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
        setStatusMessage((error as Error).message);
      }
    };

    void loadTopicData();
    void loadHistory();
  }, [loadHistory, playNarration, selectedTopicId, token, topics]);

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
    if (!canvas || !selectedTopic) {
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
    context.scale(dpr, dpr);

    const particles = Array.from({ length: 14 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 1.4,
      vy: (Math.random() - 0.5) * 1.4,
      radius: 8 + Math.random() * 10
    }));

    const draggable = {
      x: width * 0.12,
      y: height * 0.65,
      size: 34
    };

    const target = {
      x: width * 0.72,
      y: height * 0.14,
      w: width * 0.18,
      h: height * 0.2
    };

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const render = () => {
      context.clearRect(0, 0, width, height);
      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "#071726");
      bg.addColorStop(1, "#1c0f2f");
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      context.fillStyle = "rgba(255, 255, 255, 0.08)";
      context.fillRect(target.x, target.y, target.w, target.h);
      context.strokeStyle = "rgba(255, 255, 255, 0.5)";
      context.strokeRect(target.x, target.y, target.w, target.h);
      context.fillStyle = "#fef4c0";
      context.font = "14px 'Trebuchet MS', sans-serif";
      context.fillText("Drop Zone", target.x + 12, target.y + 24);

      particles.forEach((particle) => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < 0 || particle.x > width) {
          particle.vx *= -1;
        }
        if (particle.y < 0 || particle.y > height) {
          particle.vy *= -1;
        }
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = "rgba(91, 217, 229, 0.35)";
        context.fill();
      });

      context.fillStyle = "#f86266";
      context.fillRect(draggable.x, draggable.y, draggable.size, draggable.size);
      context.fillStyle = "#ffffff";
      context.font = "13px 'Trebuchet MS', sans-serif";
      context.fillText(selectedTopic.title, 24, 34);

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

    const pointerToCanvas = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    };

    const onMouseDown = (event: MouseEvent) => {
      const point = pointerToCanvas(event);
      if (pointInDraggable(point.x, point.y)) {
        dragging = true;
        dragOffsetX = point.x - draggable.x;
        dragOffsetY = point.y - draggable.y;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) {
        return;
      }
      const point = pointerToCanvas(event);
      draggable.x = point.x - dragOffsetX;
      draggable.y = point.y - dragOffsetY;
    };

    const onMouseUp = () => {
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
      void runActionFeedback("scroll", event.deltaY > 0 ? "forward-scroll" : "back-scroll");
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel);
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [runActionFeedback, selectedTopic]);

  useEffect(() => {
    return () => {
      clearNarrationTimers();
    };
  }, [clearNarrationTimers]);

  if (!token) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Interactive Tech Tutor</h1>
          <p>Sign in to continue your multi-modal learning session.</p>
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
            {registerMode ? "Create Account" : "Login"}
          </button>
          <button className="ghost" onClick={() => setRegisterMode((value) => !value)}>
            {registerMode ? "Use existing account" : "Create new account"}
          </button>
          <div className="status">{statusMessage}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="simulation-area">
        <header className="top-bar">
          <div>
            <h1>Interactive Tech Tutor</h1>
            <p>{userEmail}</p>
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
            <button className="ghost" onClick={() => void runActionFeedback("back", "manual-back-navigation")}>
              Back Feedback
            </button>
            <button className="ghost" onClick={handleLogout}>
              Logout
            </button>
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
            Narration
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
          <div className="button-row">
            <button disabled={listening} onClick={startListening}>
              Start Voice
            </button>
            <button className="ghost" disabled={!listening} onClick={stopListening}>
              Stop Voice
            </button>
          </div>
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

        <section className="panel-section">
          <h3>History</h3>
          <button className="ghost" onClick={() => void deleteTopicHistory()}>
            Delete Current Topic History
          </button>
          <div className="history-window">
            {history.slice(-20).map((item) => (
              <p key={item.id}>
                <strong>{new Date(item.timestamp).toLocaleTimeString()}</strong> [{item.type}] {item.input}
              </p>
            ))}
          </div>
        </section>
      </aside>

      <div className="subtitle-bar">{subtitle || "Subtitles will appear here during narration."}</div>
      <div className="status-bar">{loading ? "Loading..." : statusMessage}</div>
    </div>
  );
}
