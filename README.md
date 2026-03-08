# Interactive Tech Tutor

AI-powered technical learning platform that generates interactive visual simulations, voice-guided explanations, and topic-focused chat responses.

Live frontend: `https://master.d3kfpuqsbfsujm.amplifyapp.com`  
Live API: `https://interactive-tech-tutor-api.onrender.com`

## What the project does

- Generates step-by-step simulations for technical topics (data structures, algorithms, OS scheduling, regression, confusion matrix, etc.)
- Renders topic-specific visuals on canvas (with optional 3D overlay for spatial topics)
- Supports voice narration and voice commands on simulation flow
- Provides a topic chat assistant with short contextual tutor responses
- Stores users, sessions, and interaction history in DynamoDB
- Caches generated simulations in S3

## Current architecture

- Frontend: AWS Amplify (React + Vite + TypeScript)
- Backend: Render (Node.js + Express + TypeScript)
- Model: AWS Bedrock, `us.amazon.nova-pro-v1:0`
- Database: AWS DynamoDB
  - `${DYNAMODB_TABLE_PREFIX}-users`
  - `${DYNAMODB_TABLE_PREFIX}-sessions`
  - `${DYNAMODB_TABLE_PREFIX}-simulation-history`
- Cache: AWS S3 (`AWS_S3_BUCKET`)

## Tech stack

- Frontend: React 18, TypeScript, Vite, Three.js, Canvas API, Web Speech API
- Backend: Node.js, Express, TypeScript, Zod, AWS SDK v3
- Infra: AWS Amplify, AWS Bedrock, AWS DynamoDB, AWS S3, Render

## Monorepo structure

```txt
interactive-tech-tutor/
  apps/
    api/
      src/
        index.ts
        auth.ts
        store.ts
    web/
      src/
        App.tsx
        SimulationCanvasRenderer.ts
        api.ts
        styles.css
  package.json
  README.md
```

## Local development

### Prerequisites

- Node.js 18+
- AWS account with Bedrock + DynamoDB + S3 permissions
- Valid AWS credentials

### 1) Install dependencies

```bash
npm install
```

### 2) Configure backend env (`apps/api/.env`)

Start from `apps/api/.env.example` and set values:

```env
PORT=4000
JWT_SECRET=change-me

FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://your-frontend.vercel.app
ALLOWED_ORIGINS=https://interactive-tech-tutor.vercel.app,https://master.d3kfpuqsbfsujm.amplifyapp.com,https://*.amplifyapp.com,http://localhost:5173
CORS_ORIGIN=

DYNAMODB_TABLE_PREFIX=itt
AWS_REGION=us-east-1
AWS_BEDROCK_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_key_here
AWS_SECRET_ACCESS_KEY=your_secret_here
AWS_S3_BUCKET=interactive-tech-tutor-cache
CACHE_VERSION=2
```

Notes:
- `AWS_BEDROCK_REGION` is used for Bedrock model calls.
- `AWS_REGION` is used for DynamoDB and S3.
- Bumping `CACHE_VERSION` invalidates old simulation cache keys.

### 3) Configure frontend env (`apps/web/.env`)

Create `apps/web/.env` manually:

```env
VITE_API_URL=http://localhost:4000
```

### 4) Run services

Backend:
```bash
npm run dev:api
```

Frontend:
```bash
npm run dev:web
```

## API endpoints (main)

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/ai/simulation`
- `POST /api/ai/chat`
- `GET /health`

## Simulation pipeline (current)

1. Frontend sends topic to `/api/ai/simulation`.
2. Backend generates structured steps via Bedrock Nova Pro.
3. Steps are validated and normalized.
4. Topic-specific repair passes adjust invalid coordinates/layouts:
   - BST structure repair
   - Regression point bounds repair
   - OS scheduling minimum-state repair
   - Confusion matrix layout repair
5. Label sanitizer removes placeholders and preserves meaningful labels.
6. Result is cached in S3 and returned to frontend.

## Deployment notes

- Frontend deploy target: Amplify
- Backend deploy target: Render
- Ensure backend env vars are set in Render dashboard (especially AWS creds and `AWS_BEDROCK_REGION`).
- Ensure frontend `VITE_API_URL` points to Render backend URL.

## License

MIT
