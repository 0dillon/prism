# Prism

One lesson, every learner. A teacher uploads a lesson once; Prism turns it into key ideas and
quiz questions, the teacher reviews and publishes it, and each student gets it in the form that
suits how they learn: cards, a reading page, a spoken conversation, or a visual view with key
terms signed or fingerspelled. Everyone's progress is measured the same way, and teachers see
progress, never how a student chose to learn.

Live demo (no account needed): https://prism-ng.vercel.app/demo

## Stack

Next.js (App Router), React, TypeScript, Tailwind, Supabase (Postgres, Auth, Storage, row-level
security), LangChain with Gemini, Vitest, Playwright.

## Getting started

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in your Supabase and LLM keys.
3. Apply the database migrations: `supabase db push`
4. `npm run dev`, then open http://localhost:3000

Optional demo data: `DEMO_PASSWORD=<8+ chars> npm run seed:demo -- --with-progress`

## Scripts

| Command                             | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                       | Development server                                            |
| `npm run build` / `npm start`       | Production build and server                                   |
| `npm run lint`, `npm run typecheck` | Checks                                                        |
| `npm test`                          | Unit and SQL tests (SQL runs on in-process Postgres)          |
| `npm run e2e`                       | Browser tests against a production build                      |
| `npm run e2e:live`                  | Browser tests that need a real Supabase project               |
| `npm run db:types`                  | Regenerate database types from the migrations                 |
| `npm run seed:demo`                 | Create the demo school, teacher, learners and lesson          |
| `npm run account:deletions`         | List (or with `--apply`, carry out) account deletion requests |

## Project layout

- `src/app` — pages and API routes (`/learn`, `/teach`, `/admin`, `/demo`)
- `src/renderers` — the four lesson layouts
- `src/lib` — services: ingestion, sessions, profiles, classrooms, dashboards, consent
- `supabase/migrations` — schema, row-level security, dashboard views
- `src/tests` — unit, SQL and end-to-end tests
- `PRISM_PRD.md` — the product spec, task list and decision log
