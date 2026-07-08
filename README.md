# LLM-utility
# ICP Scoring Engine — Story 3.2

AI-powered lead matching and scoring service. Scores scraped LinkedIn leads (0-100) against a workspace's ideal customer profile (ICP), combining deterministic rules with an LLM call for semantic bio matching.

## Status

Core engine built and running locally against a fresh PostgreSQL instance. Not yet integration-tested with the full NestJS app or a shared team database (rest of the team is currently on Sprint 2 work, so no shared DB exists yet).

## Folder structure

```
icp-scoring/
├── package.json                          — dependencies (includes @google/generative-ai)
├── tsconfig.json                         — TypeScript config
├── src/
│   ├── icp-scoring/
│   │   ├── icp-scoring.types.ts          — interfaces & DTOs
│   │   ├── icp-scoring.service.ts        — core scoring logic (deterministic + Gemini call)
│   │   ├── icp-scoring.repository.ts     — PostgreSQL read/write layer
│   │   ├── icp-scoring.worker.ts         — BullMQ worker + enqueue helper
│   │   ├── icp-scoring.controller.ts     — 5 REST endpoints
│   │   └── icp-scoring.module.ts         — NestJS module registration
│   ├── common/
│   │   ├── config.ts                     — single env-var source of truth
│   │   ├── warmup.ts                     — Wₙ = Base × (1 + n/14) warm-up curve
│   │   └── app.module.snippet.ts         — wiring guide for the main AppModule
│   └── migrations/
│       └── 001_icp_scoring_columns.sql   — adds icp_criteria to workspaces.metadata
└── test/
    └── icp-scoring.test.ts               — local smoke test, 6 sample leads
```

## What changed recently (Gemini swap)

Only 2 files were touched to switch the LLM provider from OpenAI to Gemini:

- `icp-scoring.service.ts` — scoring logic now calls Gemini instead of OpenAI
- `config.ts` — reads `GEMINI_API_KEY` instead of the OpenAI key

Everything else is unchanged from the original build.

**Why Gemini for now:** the architecture doc names OpenAI for this story, but OpenAI's API has no meaningful free tier for sustained use — it's pay-per-token from the start. Gemini's free tier (`gemini-1.5-flash`) is a legitimate option for development/testing. Since the service is built as a swappable LLM abstraction, moving to OpenAI or Anthropic later should be a config change, not a rewrite.

## How it works

1. Story 3.1's scraper finishes → calls `enqueueICPScoringJob()`
2. Job lands in a BullMQ/Redis queue
3. Worker picks it up → `batchScoreLeads()` processes 5 leads at a time
4. Each lead gets a deterministic score (title, industry, location, headcount — 75 pts max) plus a Gemini-scored semantic bio match (25 pts max)
5. `persistScoredLeads()` writes results to the `leads` table in a single DB transaction
6. Leads at or above the workspace's threshold (default 65) are marked `DISCOVERED`; below it, `STOPPED`

## Known open items

- **LLM provider**: currently Gemini for cost reasons during dev. Doc specifies OpenAI; final production provider still to be decided by the team.

## Running the test locally

No database or Redis required for `icp-scoring.test.ts` — it only imports `icp-scoring.service.ts` and `icp-scoring.types.ts`, and calls Gemini directly.

```bash
npm install
export GEMINI_API_KEY=your-key-here
npx ts-node test/icp-scoring.test.ts
```

Takes roughly 30-40 seconds for 6 sample leads, due to the free-tier rate limit pause between batches.

## Setup for the full app

Hand the `common/`, `migrations/`, and `icp-scoring/` folders to whoever wires this into the main NestJS app. They'll need to:

1. Add `GEMINI_API_KEY` to the `.env` file
2. Run `001_icp_scoring_columns.sql` against the shared team database once it exists
3. Follow `app.module.snippet.ts` to register `ICPScoringModule` in the main `AppModule`
