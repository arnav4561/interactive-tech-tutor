# Interactive Tech Tutor 🎓

An AI-powered interactive learning platform that generates real-time visual simulations with voice narration for any technical topic — built on AWS.

🌐 **Live Demo:** https://master.d3kfpuqsbfsujm.amplifyapp.com

---

## What It Does

Interactive Tech Tutor lets you learn any technical concept through:

- **AI-Generated Visual Simulations** — Type any topic (binary search tree, bubble sort, neural networks, etc.) and the app instantly generates a step-by-step animated simulation with canvas diagrams
- **Voice Narration** — Each simulation step is narrated aloud with complete, accurate explanations
- **Voice Commands** — Control the simulation hands-free: say "go to step 3", "pause", "repeat" and the app responds
- **Topic Chat** — Ask follow-up questions about the topic and get instant AI tutor responses
- **3D Visualizations** — 3D topics (cube rotation, molecular structures) render with Three.js overlays

---

## AWS Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User Browser                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   AWS Amplify (Frontend)                    │
│              React + Vite + TypeScript                      │
│         https://master.d3kfpuqsbfsujm.amplifyapp.com        │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS API calls
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node.js / Express API                     │
│                      (Render.com)                           │
└────────┬──────────────────┬────────────────────┬────────────┘
         │                  │                    │
         ▼                  ▼                    ▼
┌─────────────┐   ┌──────────────────┐  ┌──────────────────┐
│  AWS Bedrock│   │   AWS DynamoDB   │  │     AWS S3       │
│  Nova Pro   │   │                  │  │                  │
│             │   │ - itt-users      │  │ Simulation Cache │
│• Simulation │   │ - itt-sessions   │  │ (JSON responses) │
│  generation │   │ - itt-simulation │  │                  │
│• Chat AI    │   │   -history       │  │                  │
│• Fact check │   │                  │  │                  │
└─────────────┘   └──────────────────┘  └──────────────────┘
```

### AWS Services Used

| Service | Purpose |
|---|---|
| **AWS Amplify** | Frontend hosting with CI/CD from GitHub |
| **AWS Bedrock (Nova Pro)** | AI simulation generation, fact-checking, chat responses |
| **AWS DynamoDB** | User accounts, sessions, simulation history |
| **AWS S3** | Simulation response caching for fast repeat loads |

---

## Features

### 🎬 AI Simulation Generation
- Generates 8–12 step visual simulations for any technical topic
- Canvas renderer draws tree nodes, bars, circles, arrows, matrices, flowcharts
- Each step has proportional visuals matching the narration
- Factually accurate — BST traversals, sorting comparisons, algorithm steps

### 🎤 Voice Control
- Web Speech API for real-time voice recognition
- Natural language commands: "go to step 4", "pause", "repeat"
- Voice narration via Speech Synthesis API
- Mic button in navbar with visual on/off states

### 🌳 Data Structure Visualizations
- **Binary Search Tree** — hierarchical node layout with parent-child connections
- **Sorting Algorithms** — animated bars with proportional heights growing from baseline
- **Graphs & Trees** — automatic layout based on BST ordering
- **Matrices** — labeled quadrant diagrams (confusion matrix, etc.)

### 🧊 3D Visualizations
- Three.js overlay for 3D topics
- Rotating cube, sphere, cylinder, cone, torus
- Injected automatically based on topic keywords

### 💬 Topic Chat
- Context-aware AI tutor chat per topic
- Last 5 messages sent as context for coherent conversation
- Timestamps on all messages (24-hour format)

### 👤 User Authentication
- Register with name, email, password
- JWT-based sessions stored in DynamoDB
- Simulation history tracked per user

---

## Tech Stack

**Frontend**
- React 18 + TypeScript
- Vite
- Three.js (3D rendering)
- Web Speech API (voice)
- Canvas API (2D simulation rendering)

**Backend**
- Node.js + Express
- TypeScript
- AWS SDK v3

**AWS**
- Amplify (hosting)
- Bedrock / Nova Pro (AI)
- DynamoDB (database)
- S3 (cache)

---

## Local Development

### Prerequisites
- Node.js 18+
- AWS account with Bedrock, DynamoDB, S3 access
- AWS credentials configured

### Setup

```bash
# Clone the repo
git clone https://github.com/arnav4561/interactive-tech-tutor
cd interactive-tech-tutor

# Install dependencies
npm install

# Configure environment variables
cp apps/api/.env.example apps/api/.env
# Fill in: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Fill in: S3_BUCKET_NAME, DYNAMODB_TABLE_PREFIX=itt

cp apps/web/.env.example apps/web/.env
# Fill in: VITE_API_URL=http://localhost:10000

# Start development servers
npm run dev --workspace apps/api
npm run dev --workspace apps/web
```

### Environment Variables

**Backend (`apps/api/.env`)**
```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
S3_BUCKET_NAME=interactive-tech-tutor-cache
DYNAMODB_TABLE_PREFIX=itt
JWT_SECRET=your_jwt_secret
CACHE_VERSION=27
PORT=10000
```

**Frontend (`apps/web/.env`)**
```
VITE_API_URL=http://localhost:10000
```

---

## How It Works

1. **User enters a topic** — e.g. "binary search tree"
2. **Backend calls AWS Bedrock** (Nova Pro) to generate a structured simulation with 8–12 steps, each with a subtitle and canvas elements
3. **Response is cached in S3** for instant repeat loads
4. **Frontend renders the simulation** on an HTML Canvas, drawing tree nodes, bars, arrows etc. step by step
5. **Voice narration reads each subtitle** aloud while the canvas animates
6. **User can ask questions** in the chat panel — backend calls Bedrock again with topic context to generate tutor responses
7. **All user data** (account, sessions, history) is stored in DynamoDB

---

## Project Structure

```
interactive-tech-tutor/
├── apps/
│   ├── api/                 # Node.js Express backend
│   │   └── src/
│   │       ├── index.ts     # Main API server
│   │       ├── auth.ts      # JWT auth middleware
│   │       └── store.ts     # Data store utilities
│   └── web/                 # React frontend
│       └── src/
│           ├── App.tsx              # Main app component
│           ├── SimulationCanvasRenderer.ts  # Canvas rendering engine
│           └── styles.css           # Global styles
├── package.json             # Monorepo root
└── README.md
```

---

## License

MIT
