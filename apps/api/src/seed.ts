import { DifficultyLevel, ProblemSet, Topic } from "./types.js";

export const LEVELS: DifficultyLevel[] = ["beginner", "intermediate", "advanced"];

export const TOPICS: Topic[] = [
  {
    id: "http-basics",
    title: "HTTP Request Lifecycle",
    description: "Learn how a browser request moves through DNS, server, and response phases.",
    narration: [
      "A browser starts by resolving a domain using DNS.",
      "The request reaches the server where routes and handlers process it.",
      "The server sends a response that the browser renders for the user."
    ],
    visualTheme: "network"
  },
  {
    id: "react-state",
    title: "React State and Rendering",
    description: "Understand how state updates trigger rendering and UI synchronization.",
    narration: [
      "React stores component state and watches for updates.",
      "When state changes, React schedules a render pass.",
      "The DOM updates only where changes are needed."
    ],
    visualTheme: "ui"
  },
  {
    id: "sql-indexing",
    title: "SQL Indexing Fundamentals",
    description: "Explore how indexes speed up lookups and their write-time tradeoffs.",
    narration: [
      "Without an index, the database scans many rows.",
      "An index narrows the search path to matching entries.",
      "Faster reads can cost additional write overhead."
    ],
    visualTheme: "database"
  }
];

export const PROBLEM_SETS: ProblemSet[] = [
  {
    topicId: "http-basics",
    level: "beginner",
    passingScore: 70,
    problems: [
      {
        id: "http-b-1",
        question: "What service translates a domain name to an IP address?",
        choices: ["CDN", "DNS", "TLS", "SMTP"],
        answer: "DNS",
        explanation: "DNS resolves domain names before HTTP requests can be sent."
      }
    ]
  },
  {
    topicId: "http-basics",
    level: "intermediate",
    passingScore: 75,
    problems: [
      {
        id: "http-i-1",
        question: "What status code usually indicates a successful GET response?",
        choices: ["201", "302", "404", "200"],
        answer: "200",
        explanation: "A normal successful GET generally returns HTTP 200."
      }
    ]
  },
  {
    topicId: "http-basics",
    level: "advanced",
    passingScore: 80,
    problems: [
      {
        id: "http-a-1",
        question: "Which header helps clients validate cached resources?",
        choices: ["If-None-Match", "Authorization", "User-Agent", "Upgrade"],
        answer: "If-None-Match",
        explanation: "ETag validation commonly uses If-None-Match for cache checks."
      }
    ]
  },
  {
    topicId: "react-state",
    level: "beginner",
    passingScore: 70,
    problems: [
      {
        id: "react-b-1",
        question: "What usually triggers a React component re-render?",
        choices: ["State change", "CSS load", "Window resize", "Console log"],
        answer: "State change",
        explanation: "State or prop changes are the standard render triggers."
      }
    ]
  },
  {
    topicId: "react-state",
    level: "intermediate",
    passingScore: 75,
    problems: [
      {
        id: "react-i-1",
        question: "Which hook is used to store component-local state?",
        choices: ["useMemo", "useRef", "useState", "useContext"],
        answer: "useState",
        explanation: "useState manages local mutable state in function components."
      }
    ]
  },
  {
    topicId: "react-state",
    level: "advanced",
    passingScore: 80,
    problems: [
      {
        id: "react-a-1",
        question: "What optimization avoids expensive recalculation between renders?",
        choices: ["useEffect", "useMemo", "useId", "useLayoutEffect"],
        answer: "useMemo",
        explanation: "useMemo memoizes computed values based on dependencies."
      }
    ]
  },
  {
    topicId: "sql-indexing",
    level: "beginner",
    passingScore: 70,
    problems: [
      {
        id: "sql-b-1",
        question: "What is a core benefit of an index?",
        choices: ["Smaller schema", "Faster lookups", "No backups", "No locking"],
        answer: "Faster lookups",
        explanation: "Indexes improve read speed for indexed columns."
      }
    ]
  },
  {
    topicId: "sql-indexing",
    level: "intermediate",
    passingScore: 75,
    problems: [
      {
        id: "sql-i-1",
        question: "Which query is most helped by an index on email?",
        choices: [
          "SELECT * FROM users WHERE email = ?",
          "UPDATE users SET last_login = NOW()",
          "DROP TABLE users",
          "SELECT NOW()"
        ],
        answer: "SELECT * FROM users WHERE email = ?",
        explanation: "Equality lookups on indexed columns are highly optimized."
      }
    ]
  },
  {
    topicId: "sql-indexing",
    level: "advanced",
    passingScore: 80,
    problems: [
      {
        id: "sql-a-1",
        question: "What tradeoff comes with adding many indexes?",
        choices: ["No read support", "Faster writes", "Slower writes", "No constraints"],
        answer: "Slower writes",
        explanation: "Each write may need index maintenance, increasing write cost."
      }
    ]
  }
];
