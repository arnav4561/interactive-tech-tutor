import { useState, type ReactNode } from "react";

interface HomeScreenProps {
  welcomeName: string;
  topic: string;
  generatingTopic: boolean;
  topicListening: boolean;
  statusMessage: string;
  menuButton: ReactNode;
  menuPanel: ReactNode;
  onTopicChange: (value: string) => void;
  onGenerate: () => void;
  onToggleTopicListening: () => void;
}

const FILTERS = [
  { label: "Algorithms", topic: "Binary search" },
  { label: "AI / ML", topic: "Neural networks" },
  { label: "Systems", topic: "OS scheduling" },
  { label: "Web", topic: "OAuth 2.0" },
  { label: "Data", topic: "Database indexing" }
];

export function HomeScreen({
  welcomeName,
  topic,
  generatingTopic,
  topicListening,
  statusMessage,
  menuButton,
  menuPanel,
  onTopicChange,
  onGenerate,
  onToggleTopicListening
}: HomeScreenProps): JSX.Element {
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const handleTopicChange = (value: string) => {
    setActiveFilter(null);
    onTopicChange(value);
  };

  const handleFilterClick = (label: string, filterTopic: string) => {
    if (activeFilter === label) {
      setActiveFilter(null);
      onTopicChange("");
      return;
    }

    setActiveFilter(label);
    onTopicChange(filterTopic);
  };

  return (
    <div className="home-screen">
      {menuButton}
      {menuPanel}

      <header className="home-screen-header">
        <div className="home-screen-brand">
          <span className="home-screen-brand-mark">IT</span>
          <span>Interactive Tech Tutor</span>
        </div>
        <div className="home-screen-context">
          <span className="home-screen-status-dot" />
          <span>Learning workspace</span>
        </div>
      </header>

      <main className="home-screen-main">
        <div className="home-screen-kicker">
          <span>PERSONAL LEARNING SPACE</span>
          <span className="home-screen-kicker-rule" />
          <span>BUILD A CLEARER MENTAL MODEL</span>
        </div>

        <div className="home-screen-hero-grid">
          <section className="home-screen-intro">
            <p className="home-screen-greeting">Welcome back, {welcomeName}</p>
            <h1>Make complex systems legible.</h1>
            <p className="home-screen-description">
              Turn difficult technical ideas into visual explanations you can inspect, pause, and understand at your own pace.
            </p>
          </section>

          <aside className="home-screen-proof" aria-label="How Interactive Tech Tutor works">
            <div className="home-screen-proof-head">
              <span>SESSION ENGINE</span>
              <strong>READY</strong>
            </div>
            <div className="home-screen-proof-diagram" aria-hidden="true">
              <span className="proof-node proof-node-active" />
              <span className="proof-line proof-line-a" />
              <span className="proof-line proof-line-b" />
              <span className="proof-node proof-node-mid" />
              <span className="proof-node proof-node-end" />
            </div>
            <div className="home-screen-proof-list">
              <div className="home-screen-proof-row">
                <span>01</span>
                <div>
                  <strong>Define</strong>
                  <p>Start with the vocabulary that makes the topic click.</p>
                </div>
              </div>
              <div className="home-screen-proof-row">
                <span>02</span>
                <div>
                  <strong>Visualize</strong>
                  <p>Watch the underlying system change step by step.</p>
                </div>
              </div>
              <div className="home-screen-proof-row">
                <span>03</span>
                <div>
                  <strong>Explore</strong>
                  <p>Pause, ask questions, and move through the model.</p>
                </div>
              </div>
            </div>
          </aside>
        </div>
        <section className="home-topic-composer" aria-labelledby="home-topic-title">
          <div className="home-topic-header">
            <div>
              <span className="home-topic-eyebrow">START A NEW SESSION</span>
              <h2 id="home-topic-title">What would you like to understand?</h2>
            </div>
            <span className="home-topic-shortcut">Enter to generate</span>
          </div>

          <div className="home-topic-input-row">
            <input
              className="home-topic-input"
              value={topic}
              onChange={(event) => handleTopicChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !generatingTopic && topic.trim()) {
                  event.preventDefault();
                  onGenerate();
                }
              }}
              placeholder="Try: event sourcing, OAuth 2.0, CPU scheduling"
              aria-label="Technical topic"
            />
            <button
              className={topicListening ? "home-topic-mic is-listening" : "home-topic-mic"}
              disabled={generatingTopic}
              onClick={onToggleTopicListening}
              aria-label={topicListening ? "Stop microphone" : "Use microphone"}
              title={topicListening ? "Stop microphone" : "Use microphone"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
                <path d="M6 11a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z" />
              </svg>
            </button>
            <button
              className="home-topic-submit"
              disabled={generatingTopic || !topic.trim()}
              onClick={onGenerate}
            >
              <span>{generatingTopic ? "Generating..." : "Generate simulation"}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h12.6l-4.3-4.3a1 1 0 0 1 1.4-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l4.3-4.3H5a1 1 0 1 1 0-2Z" />
              </svg>
            </button>
          </div>

          <div className="home-filter-row" role="group" aria-label="Topic filters">
            <span className="home-filter-label">Explore</span>
            {FILTERS.map((filter) => (
              <button
                key={filter.label}
                className={activeFilter === filter.label ? "home-filter-chip is-active" : "home-filter-chip"}
                onClick={() => handleFilterClick(filter.label, filter.topic)}
                aria-pressed={activeFilter === filter.label}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </section>

        {statusMessage ? <p className="home-screen-status" role="status">{statusMessage}</p> : null}
      </main>
    </div>
  );
}
