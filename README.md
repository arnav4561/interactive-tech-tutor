# Interactive Tech Tutor (MVP)

This repository contains an implementation starter for the Interactive Tech Tutor described in `requirements.md` and `design.md`.

## What Is Implemented

- Browser client with:
  - Animated simulation canvas with drag and scroll interactions
  - Subtitle bar synchronized with narration playback
  - Voice and text input in the right-side interaction panel
  - Topic and difficulty selection with progression tracking
  - File upload entry point for visual input analysis
- API server with:
  - Authentication (`register`, `login`) using JWT
  - Topic and problem set APIs (beginner/intermediate/advanced)
  - Progress tracking and unlock flow
  - Interaction history retrieval and topic-specific deletion
  - AI chat/feedback stub endpoints
  - User voice preference persistence
- Dual persistence mode:
  - PostgreSQL when `DATABASE_URL` is set (recommended for production)
  - Local JSON (`apps/api/data/store.json`) for local/dev fallback

## Project Structure

```txt
apps/
  api/   Express + TypeScript API
  web/   React + TypeScript frontend (Vite)
```

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Run API:

```bash
npm run dev:api
```

3. Run Web app (separate terminal):

```bash
npm run dev:web
```

4. Open:

```txt
http://localhost:5173
```

## Notes

- This is an MVP aligned to the provided specs, with local-file persistence in place of PostgreSQL/Redis.
- External services (Whisper/ElevenLabs/OpenAI Vision) are represented as stubs behind API routes, so providers can be wired in without rewriting UI flows.

## Deploy (Recommended)

Production setup:

- Frontend: `Vercel`
- API: `Render`

### 1. Deploy API to Render

1. Push this project to GitHub.
2. In Render, create a new Blueprint service and select this repo.
3. Render will read `render.yaml` and create `interactive-tech-tutor-api`.
4. Render also provisions `interactive-tech-tutor-db` and injects `DATABASE_URL` into the API.
5. After deploy, copy the API URL (for example: `https://interactive-tech-tutor-api.onrender.com`).
6. Set `FRONTEND_ORIGINS` in Render to include your Vercel URL.

Example:

```txt
https://your-frontend.vercel.app,https://www.your-domain.com
```

### 2. Deploy Frontend to Vercel

1. Import the same GitHub repo in Vercel.
2. Vercel will use `vercel.json`.
3. Add environment variable:

```txt
VITE_API_URL=https://interactive-tech-tutor-api.onrender.com/api
```

4. Deploy.

### 3. Verify

Check:

- `https://your-api.onrender.com/health`
- `https://your-frontend.vercel.app`
- Register/login from the frontend

## Updating After Deploy

Yes, you can keep changing the app after deployment:

1. Edit code locally.
2. Commit and push to GitHub.
3. Vercel and Render auto-redeploy from the new commit.

## Backup And Restore

Use these commands from the repo root:

1. Export a full snapshot:

```bash
npm run backup:export
```

Default output is `apps/api/backups/store-<timestamp>.json`. You can also set a custom path:

```bash
npm run backup:export -- ./my-backup.json
```

2. Restore a snapshot:

```bash
npm run backup:import -- ./my-backup.json
```

The same command works for both local JSON mode and PostgreSQL mode (when `DATABASE_URL` is set).

## Production Caveat

If `DATABASE_URL` is not set, the API falls back to local JSON storage (`apps/api/data/store.json`). On cloud runtimes, that fallback is ephemeral and may reset on restart/redeploy. For production, keep `DATABASE_URL` configured.

For Render free PostgreSQL plans, confirm DB retention/expiry in Render dashboard and either upgrade plan or export backups on a schedule.
