# Prism: Product Requirements Document and Agentic Roadmap

| Field | Value |
| --- | --- |
| Product | Prism, an adaptive educational rendering engine |
| Document version | 1.0 |
| Date | 2026-10-05 |
| Status | Approved for build (hackathon MVP first, then full product) |
| Audience | Human engineers and autonomous AI coding agents |

---

## 0. How to Use This Document (Read First, Coding Agents)

This file is the single source of truth for Prism. Sections 1 to 7 are context. Section 8 is the work queue. Section 9 is the running log.

### 0.1 Operating rules

1. Read Sections 1 to 7 once before writing any code.
2. Work from Section 8. Pick the **first unchecked task** (`- [ ]`) in the lowest-numbered phase whose dependencies are checked.
3. Complete all tasks tagged `[MVP]` across all phases before starting any untagged task. The MVP order is listed in Section 8.0.
4. Commit after every reasonable change. A task usually produces several small commits. Stage files explicitly by path (never `git add .`, `git add -A`, or `git commit -a`). Use Conventional Commits: `type(scope): summary` (example: `feat(ingestion): add chunker with source spans`), with the task ID in the commit body (`Task: P2-03`). Never add `Co-authored-by` trailers or any AI attribution.
5. When a task is done and its "Done when" condition holds, change `- [ ]` to `- [x]` in this file and commit that alone as `docs(prd): check off P2-03`, then push.
6. If you deviate from this document, add a dated entry to Section 9.1 (Decision Log) explaining what and why.
7. If a task is blocked (missing API key, unavailable service), implement it behind its interface with a stub, add an entry to Section 9.2 (Blockers), and move to the next task.
8. Never change the schemas in Sections 5.2, 5.3, or 5.7 without updating this file in the same commit.

### 0.2 Hard constraints

- TypeScript in strict mode everywhere. No `any` in committed code.
- Zod schemas in `src/lib/schemas/` are the source of truth for all structured data. Derive TypeScript types with `z.infer`.
- The LLM never generates UI code at runtime. It only selects and configures components from the renderer registry (Section 5.5).
- Every LLM call returns structured output validated by Zod. On validation failure, retry once with the error message, then fail the job with a logged error.
- All secrets come from environment variables (Section 7.6). Never hardcode keys.
- Every interactive component must be keyboard operable and screen reader labelled (Section 6.3). This applies to all renderers, including the visual ones.
- All learning activity is recorded as interface-agnostic events (Section 5.7). A renderer must not keep private progress state.
- Use the latest stable versions of all dependencies at install time and record them in `package.json`. Do not pin versions from memory.

### 0.3 Glossary

| Term | Meaning |
| --- | --- |
| Knowledge Graph (KG) | The structured JSON that Prism extracts from an uploaded source. Contains concepts, relationships, and quiz items. |
| Concept | The smallest teachable unit in a lesson. Every renderer, quiz, and progress metric is keyed to a concept ID. |
| Render Profile | A learner's settings object that controls how a lesson is presented. |
| Preset | A named starting Render Profile (for example `hyper_focus`). |
| Renderer | A frontend layout that presents a Knowledge Graph (cards, reader, conversation, visual). |
| Learning Event | A record of something the learner did, identical in shape across all renderers. |
| Variant | A cached alternative rendering of a concept's text (for example a simpler reading level). |

---

## 1. Executive Summary and Vision

### 1.1 Summary

Educational content is locked to the medium it was authored in. A PDF serves fluent sighted readers. A two-hour lecture recording serves people who can hear it and sustain attention for two hours. Everyone else gets a retrofit, if they get anything.

Prism separates knowledge from interface. A teacher or creator uploads content once (PDF, text, or audio). Prism's ingestion pipeline converts it into a structured Knowledge Graph. When a learner opens the lesson, the frontend composes an interface from that graph according to the learner's Render Profile. The same lesson can be a spoken conversation, a swipe-card sprint with micro-quizzes, a typography-tuned reader with synchronized read-aloud, or a captioned visual view with sign clips for key terms.

### 1.2 Vision

Prism can become anything for anyone. The four launch renderers are examples, not a fixed menu. A learner describes what they need in plain language, and Prism configures itself. The curriculum adapts to the student.

### 1.3 Three product surfaces

| Surface | Customer | Value |
| --- | --- | --- |
| Core Engine | All users | Ingestion, Knowledge Graph, profiles, renderers, events |
| B2B School Portal | Schools and districts | One upload per class, every student served, one dashboard for all progress |
| B2C Creator Marketplace | Independent creators and individual buyers | One upload reaches learners that a fixed format excludes |

### 1.4 Success metrics

| Metric | Target (first 6 months after launch) |
| --- | --- |
| Lesson completion rate | At least 20 percentage points above the same content delivered as the original file |
| Teacher time from upload to published lesson | Under 10 minutes for a 20-page source, including review |
| Extraction acceptance rate | At least 85% of extracted concepts published without teacher edits |
| Quiz accuracy parity | Mastery rates within 5 percentage points across renderers for the same lesson |
| Marketplace conversion | At least 3% of course page visitors purchase |
| Accessibility conformance | WCAG 2.2 AA on all surfaces, verified by automated and manual audit |

---

## 2. Problem Statement and Proposed Solution

### 2.1 Problem

1. **Fixed medium.** Knowledge is trapped in the format it was created in.
2. **Accessibility is expensive and manual.** Making one course accessible today means transcription, audio recording, reformatting, and building quizzes separately. Most teachers and creators cannot afford the time or money.
3. **Fragmented data.** When accommodations exist, they live in separate tools. Schools cannot see one student's progress next to another's if they used different materials.
4. **Lost market.** Creators lose buyers who cannot use the format the course ships in.

### 2.2 Solution

A three-stage engine:

1. **Ingest.** Upload a source once. An AI pipeline extracts a Knowledge Graph and a quiz bank. The teacher reviews and publishes.
2. **Profile.** Each learner has a Render Profile, set by choosing a preset, adjusting settings, or describing needs in plain language.
3. **Render.** The frontend selects and configures vetted components to present the Knowledge Graph according to the profile. Switching profile mid-lesson keeps the learner's place.

Every renderer emits the same Learning Events against the same concept IDs, so progress is comparable across all learners.

### 2.3 Product principles

These principles resolve ambiguity. When a requirement is unclear, apply them in order.

1. **Knowledge is separate from interface.** No renderer-specific content is stored in the Knowledge Graph.
2. **Profiles are preferences, not diagnoses.** Prism never asks for or stores a medical or disability label. Presets are named by experience (`hyper_focus`), never by condition. Any learner can choose any preset and mix settings.
3. **One event model.** Progress and engagement are measured the same way in every renderer.
4. **AI composes, it does not improvise UI.** The model chooses from tested components. Runtime-generated code is prohibited.
5. **Human review on extraction.** AI extraction is lossy. A teacher or creator approves the Knowledge Graph before learners see it.
6. **Additive accessibility.** Adaptive renderers add to platform accessibility. They never replace it. The voice renderer coexists with full screen reader support.
7. **Honest claims.** Prism does not claim capabilities it lacks, such as full sign language translation.

### 2.4 Non-goals (v1)

- Full automatic translation of lessons into sign language. Prism v1 shows clips of human signers for key terms only.
- Diagnosing or inferring any condition from learner behavior.
- Generating video lectures or 3D avatars.
- Authoring tools for creating lessons from scratch. Prism ingests existing material.
- Native mobile apps. v1 is a responsive web app.
- Live classroom features such as video calls or chat.

---

## 3. User Personas

### 3.1 Principal: Dr. Amara Okafor

- **Role:** Head of a 900-student secondary school. Org admin in Prism.
- **Goals:** See whether every classroom is progressing. Show inclusion outcomes to the board and regulators. Control costs.
- **Frustrations:** Accommodation data is scattered across tools and paper plans. She cannot compare progress across students using different materials.
- **Needs from Prism:** One dashboard that shows progress and engagement for all classrooms on a common scale. Aggregated views that do not expose which individual students use which accommodations.

### 3.2 Teacher: Mr. Daniel Reyes

- **Role:** Teaches biology to five classes of about 30 students.
- **Goals:** Teach one curriculum to the whole room. Spend time teaching, not reformatting.
- **Frustrations:** He has no time to produce multiple versions of each lesson. He worries AI will misstate his material.
- **Needs from Prism:** Upload once. A fast review screen to correct extraction errors. Per-student and per-concept progress so he knows what to reteach.

### 3.3 Creator: Priya Nair

- **Role:** Independent instructor selling a personal finance course.
- **Goals:** Grow revenue without re-recording content. Reach buyers she currently loses.
- **Frustrations:** Captioning, audio versions, and interactive quizzes each cost money and time.
- **Needs from Prism:** Upload existing material, set a price, get paid. See which formats her buyers use.

### 3.4 Blind student: Tunde, 16

- **Context:** Blind since birth. Fast, expert screen reader user. Uses a laptop and a phone.
- **Frustrations:** Untagged PDFs, image-only slides, and quizzes built as inaccessible widgets.
- **Needs from Prism:** A conversational tutor he can talk to hands-free, with interruption and repeat commands. Equally, a fully screen-reader-navigable interface for when he prefers his own tools and speed.
- **Default preset:** `voice_native`.

### 3.5 Student with ADHD: Maya, 14

- **Context:** Bright, quick, loses focus on long text or video within minutes.
- **Frustrations:** Walls of text. Long gaps between effort and feedback.
- **Needs from Prism:** One idea at a time. Frequent short quizzes. Visible progress. Sessions that end at natural stopping points.
- **Default preset:** `hyper_focus`.

### 3.6 Dyslexic student: Leo, 12

- **Context:** Strong verbal reasoning. Reading dense text is slow and tiring.
- **Frustrations:** Small fonts, tight spacing, long lines, timed reading.
- **Needs from Prism:** Control over font, spacing, line length, and background. Read-aloud with word highlighting. Shorter paragraphs and plainer wording on request.
- **Default preset:** `cognitive_ease`.

### 3.7 Deaf student: Sofia, 15

- **Context:** Deaf. ASL is her first language and written English is her second.
- **Frustrations:** Audio lectures with poor auto-captions or none. Dense written English with no visual support.
- **Needs from Prism:** Accurate transcripts of audio sources. Plain-language concept cards with visuals. Clips of real signers for key terms. No audio-only cues anywhere.
- **Default preset:** `visual_sign`.

---

## 4. User Stories and Acceptance Criteria

Story IDs are referenced by roadmap tasks.

### 4.1 Core Engine

**CE-1. Upload and extract.** As a teacher or creator, I upload a PDF, text file, or audio file so that Prism turns it into a lesson.
- Accepts `.pdf`, `.txt`, `.md`, `.docx`, `.mp3`, `.wav`, `.m4a` up to 50 MB.
- Shows staged progress (uploading, reading, extracting, generating quizzes, ready for review).
- Produces a Knowledge Graph that validates against the schema in Section 5.2.
- Every concept links back to its location in the source (page or timestamp).

**CE-2. Review and publish.** As a teacher or creator, I review extracted concepts and quiz items so that nothing wrong reaches learners.
- I can edit, merge, reorder, delete, and add concepts and quiz items.
- Each concept shows its source excerpt beside it.
- A lesson is invisible to learners until I publish it.
- Editing a published lesson creates a new graph version without erasing learner progress on unchanged concepts.

**CE-3. Choose a profile.** As a learner, I pick a preset or adjust settings so that lessons suit me.
- First-run onboarding offers the presets with a live preview and a "describe what you need" box.
- Onboarding is fully usable by keyboard, screen reader, and voice.
- I am never asked about a diagnosis or disability.

**CE-4. Describe my needs.** As a learner, I type or say what helps me learn so that Prism configures itself.
- Free text such as "I lose focus quickly and like being quizzed" produces a valid Render Profile.
- Prism shows what it changed in plain language and lets me undo.
- Requests outside the settings schema get a clear "I can't do that yet" response, not a silent failure.

**CE-5. Switch mid-lesson.** As a learner, I change my profile during a lesson without losing my place.
- The switch completes in under 300 ms with no network call.
- The current concept, quiz state, and progress carry over.

**CE-6. Voice conversation.** As a learner, I complete a whole lesson by voice.
- I can say "teach me", "repeat", "explain that more simply", "slower", "quiz me", "pause", and "where am I".
- I can interrupt speech at any time by speaking or pressing a key.
- Quiz answers given by voice are graded and recorded as the same events as tapped answers.

**CE-7. Card sprint.** As a learner, I move through one concept per card with frequent micro-quizzes.
- Cards advance by swipe, tap, arrow key, or space bar.
- A quiz appears after every N concepts, where N comes from my profile.
- Correct answers give immediate positive feedback that respects reduced-motion settings.

**CE-8. Tuned reading.** As a learner, I control typography and can have text read aloud with highlighting.
- I can set font, size, letter spacing, word spacing, line height, line length, and background tint.
- Read-aloud highlights the current word or sentence in sync.
- I can ask for a simpler version of any concept.

**CE-9. Visual and sign support.** As a learner, I get transcripts, visual concept cards, and sign clips for key terms.
- Audio sources have a timestamped transcript.
- Concepts with a verified sign clip show a "See it signed" control.
- No information or feedback is conveyed by sound alone.

**CE-10. Universal progress.** As any stakeholder, I see progress measured identically across renderers.
- Mastery is computed per concept from Learning Events with no reference to the renderer used.

### 4.2 B2B School Portal

**B2B-1. Set up a school.** As a principal, I create an organization and invite teachers.
- Email invitations with role assignment (principal, teacher, student).
- Teachers can create classrooms and add students by email, CSV, or join code.

**B2B-2. Assign a lesson.** As a teacher, I assign a published lesson to a classroom with an optional due date.
- Every enrolled student sees the lesson in their own Render Profile.
- I upload once. I do nothing per student.

**B2B-3. Classroom progress.** As a teacher, I see each student's progress and each concept's difficulty.
- A student-by-concept mastery grid.
- A list of concepts ranked by error rate.
- No display of a student's Render Profile unless that student (or guardian, per school policy) has opted in to share it.

**B2B-4. School dashboard.** As a principal, I see all classrooms on one screen.
- Per-classroom completion, average mastery, active learners, and time on task.
- Filters by grade, subject, teacher, and date range.
- Renderer usage shown only as school-wide aggregates, with any group smaller than 5 suppressed.
- CSV export of aggregated data.

**B2B-5. Student privacy.** As a student, my presentation settings are private by default.
- Teachers and principals cannot see my profile without opt-in.
- I can change my profile at any time without anyone being notified.

### 4.3 B2C Creator Marketplace

**B2C-1. Publish a course.** As a creator, I group lessons into a course, set a price, and publish a listing.
- A course contains one or more published lessons in order.
- The listing has a title, description, cover image with alt text, price, and a free preview lesson.

**B2C-2. Get paid.** As a creator, I connect a payout account and receive revenue minus the platform fee.
- Onboarding through a payment provider's hosted flow.
- A creator cannot publish a paid course until payout onboarding completes.

**B2C-3. Browse and preview.** As a buyer, I browse courses and try the preview lesson in my own profile.
- The preview renders through the same engine as paid content.
- The catalog is searchable and filterable by topic and price.

**B2C-4. Purchase and learn.** As a buyer, I buy a course and consume it in my preferred format.
- Checkout through a hosted payment page.
- Access is granted on payment confirmation by webhook, never by client redirect alone.
- My library lists purchased courses with progress.

**B2C-5. Creator analytics.** As a creator, I see sales, completion, and aggregate format usage.
- Revenue over time, enrollments, completion rate, and hardest concepts.
- Renderer usage as aggregate percentages only, suppressed below 5 buyers.

---

## 5. Functional Requirements

### 5.1 Ingestion data flow

```
[Upload] -> [Storage] -> [Text extraction] -> [Chunking] -> [Concept extraction (map)]
   -> [Merge and order (reduce)] -> [Quiz generation] -> [Validation and grounding]
   -> [Sign tagging] -> status: needs_review -> [Teacher review] -> status: published
```

| Step | Input | Process | Output |
| --- | --- | --- | --- |
| 1. Upload | File from teacher or creator | Client requests a signed upload URL, uploads directly to object storage, then creates a `lessons` row with status `uploading` and an `ingestion_jobs` row | Stored file, lesson ID |
| 2. Text extraction | Stored file | PDF: extract the text layer per page. DOCX: convert to text with headings. Text and Markdown: read directly. Audio: speech-to-text with word timestamps | `SourceDocument`: ordered segments, each with text and a locator (page number or start and end time) |
| 3. Chunking | `SourceDocument` | Split on headings, then by size (about 1,500 tokens, 150 token overlap). Each chunk keeps its locators | `Chunk[]` |
| 4. Concept extraction | Each chunk | Heavy LLM with structured output extracts candidate concepts. Runs in parallel with a concurrency limit of 4 | `CandidateConcept[]` per chunk |
| 5. Merge and order | All candidates | One LLM call deduplicates, merges overlaps, orders concepts pedagogically, groups them into sections, and assigns prerequisite edges | Ordered `Concept[]`, `Section[]` |
| 6. Quiz generation | Each concept | LLM writes at least 2 quiz items per concept, with at least one multiple-choice item. Answers must be supported by the concept's source excerpt | `QuizItem[]` |
| 7. Validation | Draft graph | Zod validation. Referential checks (every quiz item points to a real concept, prerequisites form no cycles). Grounding check: fast LLM confirms each concept and answer is supported by its source excerpt, and flags the ones that are not | Valid graph with `flags[]` on doubtful items |
| 8. Sign tagging | Concepts | Fast LLM matches each concept's key term to the list of available sign glosses by meaning, or returns none. All links start unverified | `concept_sign_links` rows |
| 9. Review | Draft graph | Teacher edits in the review UI. Flagged items are listed first | Approved graph |
| 10. Publish | Approved graph | Status becomes `published`. Graph version increments. Normalized `concepts` and `quiz_items` rows are written | Lesson visible to learners |

Failure handling: each step writes its stage and progress to `ingestion_jobs`. A failed step sets status `failed` with a human-readable error, and the job is resumable from the failed step.

### 5.2 Knowledge Graph schema

Stored as JSONB on `lessons.graph` and mirrored into normalized tables at publish time. Define in `src/lib/schemas/knowledge-graph.ts`.

```ts
import { z } from "zod";

export const SourceLocator = z.object({
  kind: z.enum(["page", "time", "offset"]),
  start: z.number(),          // page number, seconds, or character offset
  end: z.number().optional(),
  excerpt: z.string().max(1200), // verbatim source text supporting the concept
});

export const Concept = z.object({
  id: z.string(),                 // stable, e.g. "c_01HZX..." (ULID)
  sectionId: z.string(),
  order: z.number().int(),
  title: z.string().max(80),      // short, one idea
  summary: z.string().max(240),   // one or two sentences; used by cards and voice
  body: z.string(),               // full explanation in plain Markdown
  keyTerm: z.string().optional(), // the main vocabulary item, if any
  definition: z.string().optional(),
  examples: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]), // concept ids
  visualHint: z.string().optional(), // description of a helpful diagram or image
  source: SourceLocator,
  flags: z.array(z.enum(["ungrounded", "low_confidence", "edited"])).default([]),
});

export const QuizItem = z.object({
  id: z.string(),
  conceptId: z.string(),
  type: z.enum(["mcq", "true_false", "short_answer"]),
  prompt: z.string(),
  options: z.array(z.string()).optional(),    // mcq only, 3 to 4 options
  answer: z.string(),                         // correct option text, "true"/"false", or model answer
  acceptable: z.array(z.string()).default([]),// alternative correct phrasings
  explanation: z.string(),                    // shown or spoken after answering
  difficulty: z.enum(["recall", "apply"]),
  flags: z.array(z.enum(["ungrounded", "low_confidence", "edited"])).default([]),
});

export const Section = z.object({
  id: z.string(),
  title: z.string(),
  order: z.number().int(),
});

export const KnowledgeGraph = z.object({
  schemaVersion: z.literal(1),
  lessonId: z.string(),
  title: z.string(),
  overview: z.string().max(600),
  language: z.string().default("en"),
  sections: z.array(Section),
  concepts: z.array(Concept).min(1),
  quizItems: z.array(QuizItem),
  transcript: z.array(z.object({     // present for audio sources
    start: z.number(), end: z.number(), text: z.string(),
  })).optional(),
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;
```

Rules:
- The graph contains no presentation data (no fonts, layouts, or renderer names).
- Concept and quiz item IDs are stable across graph versions when the item is unchanged or merely edited. Deleting an item retires its ID.

### 5.3 Render Profile schema

Define in `src/lib/schemas/render-profile.ts`. Stored in `render_profiles.profile`.

```ts
export const RenderProfile = z.object({
  schemaVersion: z.literal(1),
  preset: z.enum(["standard", "voice_native", "hyper_focus", "cognitive_ease", "visual_sign", "custom"]),
  layout: z.enum(["reader", "cards", "conversation", "visual"]),
  content: z.object({
    readingLevel: z.enum(["original", "plain", "simple"]).default("original"),
    chunkSize: z.enum(["concept", "section", "full"]).default("section"),
    showExamples: z.boolean().default(true),
  }),
  quiz: z.object({
    cadence: z.number().int().min(1).max(10).default(5), // quiz after every N concepts
    itemsPerCheck: z.number().int().min(1).max(5).default(1),
    retryOnWrong: z.boolean().default(true),
  }),
  typography: z.object({
    font: z.enum(["system", "atkinson", "lexend", "opendyslexic"]).default("system"),
    sizeScale: z.number().min(0.8).max(2.5).default(1),
    letterSpacing: z.number().min(0).max(0.3).default(0),  // em
    wordSpacing: z.number().min(0).max(0.6).default(0),    // em
    lineHeight: z.number().min(1.2).max(2.4).default(1.5),
    maxLineLength: z.number().int().min(30).max(90).default(70), // characters
    wordAnchors: z.boolean().default(false), // bold the leading letters of each word
  }),
  audio: z.object({
    readAloud: z.boolean().default(false),
    syncHighlight: z.enum(["off", "sentence", "word"]).default("off"),
    rate: z.number().min(0.5).max(3).default(1),
    voiceInput: z.boolean().default(false),
    earcons: z.boolean().default(false),   // short non-speech audio cues
  }),
  visual: z.object({
    theme: z.enum(["system", "light", "dark", "high_contrast", "cream", "blue_tint"]).default("system"),
    reducedMotion: z.boolean().default(false),
    captions: z.boolean().default(true),
    signClips: z.boolean().default(false),
    signLanguage: z.enum(["ase"]).default("ase"), // ISO 639-3; ASL only in v1
    conceptImages: z.boolean().default(false),
  }),
  feedback: z.object({
    progressBar: z.boolean().default(true),
    streaks: z.boolean().default(false),
    celebration: z.enum(["none", "subtle", "full"]).default("subtle"),
    haptics: z.boolean().default(false),
  }),
});
export type RenderProfile = z.infer<typeof RenderProfile>;
```

Presets (define in `src/lib/profile/presets.ts`). Only differences from defaults are listed.

| Preset | Layout | Key overrides |
| --- | --- | --- |
| `standard` | `reader` | Defaults |
| `voice_native` | `conversation` | `audio.readAloud` true, `audio.voiceInput` true, `audio.earcons` true, `content.chunkSize` concept, `quiz.cadence` 3 |
| `hyper_focus` | `cards` | `content.chunkSize` concept, `quiz.cadence` 3, `feedback.streaks` true, `feedback.celebration` full, `feedback.haptics` true |
| `cognitive_ease` | `reader` | `typography.font` lexend, `letterSpacing` 0.05, `wordSpacing` 0.16, `lineHeight` 1.8, `maxLineLength` 60, `audio.readAloud` true, `audio.syncHighlight` word, `visual.theme` cream, `content.readingLevel` plain |
| `visual_sign` | `visual` | `visual.captions` true, `visual.signClips` true, `visual.conceptImages` true, `content.readingLevel` plain, `feedback.haptics` true, `audio.earcons` false |

Note on `typography.wordAnchors`: this implements the leading-letter bolding style popularized as "Bionic Reading" (a third-party trademark; do not use the name in the UI). Research support for it is limited, so it is off by default in every preset and offered as a user toggle. The spacing, line length, and read-aloud settings carry the `cognitive_ease` preset.

### 5.4 Intent parsing

Two intent parsers, both using the fast LLM with structured output.

**A. Needs to profile (onboarding and settings).** Endpoint `POST /api/profile/parse`.

1. Input: free text or transcribed speech, plus the learner's current profile.
2. The LLM returns `{ patch: DeepPartial<RenderProfile>, explanation: string, unsupported: string[] }`.
3. The server merges the patch into the current profile and validates the result with Zod. Invalid results are rejected and the current profile is kept.
4. The client shows the `explanation` (for example "I switched to cards with a quiz every 3 concepts") with Apply and Undo.
5. `unsupported` lists requests that no setting covers. These are logged to a `unmet_needs` table to guide the product roadmap.

**B. In-session commands.** Endpoint `POST /api/session/intent`. Common commands are matched locally by keyword first, and only unmatched utterances go to the LLM.

```ts
export const SessionIntent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("next") }),
  z.object({ type: z.literal("previous") }),
  z.object({ type: z.literal("repeat") }),
  z.object({ type: z.literal("simplify") }),
  z.object({ type: z.literal("elaborate") }),
  z.object({ type: z.literal("example") }),
  z.object({ type: z.literal("quiz_me") }),
  z.object({ type: z.literal("answer"), value: z.string() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("where_am_i") }),
  z.object({ type: z.literal("go_to"), target: z.string() }),     // section or concept title
  z.object({ type: z.literal("set_rate"), direction: z.enum(["slower", "faster"]) }),
  z.object({ type: z.literal("change_profile"), request: z.string() }), // forwards to parser A
  z.object({ type: z.literal("question"), text: z.string() }),    // free question about the lesson
  z.object({ type: z.literal("unknown") }),
]);
```

Free questions (`question`) are answered by the fast LLM using only the lesson's Knowledge Graph as context. If the graph does not contain the answer, the tutor says so.

### 5.5 Rendering engine and state switching

**Architecture.** Lesson state lives in one store. Renderers are views over that store and hold no progress state of their own.

```
RenderProfile (store) ----\
                           >--> <PrismRenderer> --> registry[profile.layout] --> <CardsRenderer | ReaderRenderer | ...>
LessonSession (store) ----/                                   |
        ^                                                     v
        +------------------ actions (next, answer, ...) ------+
        |
        +--> EventQueue --> POST /api/events
```

**LessonSession store** (`src/lib/session/store.ts`):

```ts
type SessionPhase = "intro" | "learning" | "quiz" | "feedback" | "complete";

interface LessonSession {
  lessonId: string;
  graphVersion: number;
  phase: SessionPhase;
  conceptIndex: number;            // position in ordered concepts
  seenConceptIds: string[];
  conceptsSinceQuiz: number;
  activeQuizItemId: string | null;
  lastAnswer: { quizItemId: string; correct: boolean } | null;
  startedAt: number;
}
```

**State machine.**

```
intro --start--> learning
learning --next (conceptsSinceQuiz < cadence)--> learning
learning --next (conceptsSinceQuiz >= cadence) or quiz_me--> quiz
quiz --answer--> feedback
feedback --continue (wrong and retryOnWrong)--> quiz (same concept, different item if available)
feedback --continue (more concepts)--> learning
feedback --continue (no more concepts)--> complete
```

**Renderer registry** (`src/renderers/registry.ts`): maps `layout` to a lazily loaded component. Every renderer receives the same props: `{ graph, session, profile, actions }`.

**Switching rules.**
- Changing the profile updates the profile store. `<PrismRenderer>` swaps the component. `LessonSession` is untouched, so position and quiz state persist.
- A switch performs no network request. Profile persistence to the server is debounced and happens in the background.
- All renderer bundles for the learner's likely layouts are prefetched after first paint.
- On switch, focus moves to the new renderer's main heading and a polite live region announces the change.

**Content variants.** When `content.readingLevel` is not `original`, the renderer requests a variant by `(conceptId, graphVersion, readingLevel)`. The server returns the cached row from `concept_variants` or generates it once with the fast LLM, stores it, and returns it. Variants are prewarmed for `plain` at publish time.

### 5.6 Renderer specifications

All renderers share: the session store, the event queue, a settings button, a profile switcher, and full keyboard and screen reader support.

**5.6.1 Cards renderer (`cards`)**
- One concept per full-height card: title, summary, optional example, optional image.
- Advance by swipe, tap, right arrow, or space. Go back by swipe back or left arrow.
- A "More" control expands the concept body in place.
- After `quiz.cadence` concepts, a quiz card appears. MCQ options are large tap targets (minimum 44 by 44 CSS pixels).
- Correct answer: progress bar advances, celebration per `feedback.celebration`, optional haptic pulse. Wrong answer: neutral tone, show explanation, then retry if enabled.
- Celebration animation must not flash more than 3 times per second and is replaced by a static check mark when reduced motion is on.
- Session summary card at completion: concepts mastered, streak, time spent, and a suggested stopping point every 10 minutes.

**5.6.2 Reader renderer (`reader`)**
- Continuous or sectioned text per `content.chunkSize`, styled entirely from `typography` and `visual` settings through CSS custom properties.
- A persistent settings panel with live sliders. Changes apply immediately.
- Read-aloud controls: play, pause, rate, skip sentence. Highlighting follows `audio.syncHighlight` using speech boundary events or provider word timestamps.
- Word anchors applied at render time by a pure function. The underlying text and the accessibility tree are unchanged (use `<b>` inside an element whose accessible name is the plain word).
- Inline quiz blocks appear at the configured cadence.
- "Simpler" button on each concept switches that concept to the next reading level.

**5.6.3 Conversation renderer (`conversation`)**
- A tutor loop: the tutor speaks the concept summary, pauses for a command, and continues. See intents in Section 5.4.
- Input: speech-to-text when `audio.voiceInput` is on, and always a text input and keyboard shortcuts as an equal path.
- Barge-in: any detected speech or key press stops text-to-speech within 200 ms.
- Quizzes are spoken. For MCQ, options are read with letters and the learner answers by letter or by content. Short answers are graded by the fast LLM against `answer` and `acceptable`, returning `{ correct: boolean, feedback: string }`.
- The screen shows a minimal transcript of the conversation with a visible state indicator (listening, thinking, speaking). The transcript is a proper ARIA log region so screen reader users can review it.
- If text-to-speech and a screen reader would talk over each other, the learner can turn Prism speech off and use the transcript with their own screen reader.
- Earcons mark state changes (listening started, correct, incorrect) when `audio.earcons` is on.

**5.6.4 Visual renderer (`visual`)**
- For audio sources: a transcript panel with timestamps, synchronized to audio playback when the learner chooses to play it.
- Concept cards in plain language with an image or diagram when `visual.conceptImages` is on. Images are generated or selected at publish time from `visualHint`, reviewed by the teacher, and stored with alt text.
- "See it signed" button on concepts that have a verified sign clip. Clips are short looping videos of human signers with playback speed control. Concepts without a clip show the fingerspelled key term, labelled as fingerspelling.
- All feedback is visual and optionally haptic. No earcons. No audio-only content.
- The UI text states plainly: "Signs are shown for key terms. This is not a full translation."

### 5.7 Learning events and mastery

Define in `src/lib/schemas/events.ts`. Clients batch events and send them to `POST /api/events` every 5 seconds and on page hide.

```ts
export const LearningEvent = z.object({
  id: z.string(),                 // client-generated ULID for idempotency
  userId: z.string(),
  lessonId: z.string(),
  graphVersion: z.number().int(),
  type: z.enum([
    "lesson_started", "concept_viewed", "concept_variant_requested",
    "quiz_presented", "quiz_answered", "question_asked",
    "session_paused", "session_resumed", "lesson_completed", "profile_changed",
  ]),
  conceptId: z.string().optional(),
  quizItemId: z.string().optional(),
  correct: z.boolean().optional(),        // quiz_answered only
  durationMs: z.number().int().optional(),// active time attributed to this event
  layout: z.enum(["reader", "cards", "conversation", "visual"]), // product analytics only
  occurredAt: z.string().datetime(),
});
```

**Mastery (identical for all renderers).** Maintained in `concept_mastery` by a database function on insert of `quiz_answered`:

| Status | Rule |
| --- | --- |
| `not_started` | No `concept_viewed` event |
| `in_progress` | Viewed, and the mastered rule is not met |
| `mastered` | The two most recent answers on that concept's quiz items are both correct |

- Lesson progress = mastered concepts divided by total concepts in the current graph version.
- Engagement = active minutes (sum of `durationMs`, capped at 60 seconds per event to exclude idle time) and sessions per week.
- The `layout` field is never exposed in teacher or principal views except through the suppressed aggregate in B2B-4.

### 5.8 B2B data flows

**Onboarding.** Principal signs up, creates an organization, invites teachers by email. Teacher accepts, creates a classroom, and adds students by email list, CSV, or a 6-character join code. Students sign in and complete profile onboarding (CE-3).

**Teach.** Teacher uploads a source (5.1), reviews, publishes, and assigns the lesson to one or more classrooms with an optional due date. Students see it under "Assigned". Each opens it in their own profile.

**Monitor.** Events flow into `learning_events` and `concept_mastery`. Dashboards read from SQL views:
- `v_classroom_student_progress`: per student, per lesson progress and active minutes.
- `v_classroom_concept_difficulty`: per concept, error rate and attempts.
- `v_org_classroom_summary`: per classroom completion, average mastery, active learners.
- `v_org_layout_usage`: org-wide layout share with groups under 5 removed.

**Roles and access.**

| Data | Student | Teacher | Principal |
| --- | --- | --- | --- |
| Own profile and progress | Read and write | No access | No access |
| Students' progress in own classrooms | No | Read | Read |
| A student's Render Profile | Own only | Only with opt-in | Only with opt-in |
| All classrooms in the org | No | No | Read |
| Lessons | Assigned only | Own: full control | Read |

### 5.9 B2C data flows

**Creator.** Sign up as creator. Upload and publish lessons (5.1). Create a course, order lessons, mark one as free preview, set price. Complete payout onboarding through the payment provider's hosted flow. Publish the listing.

**Buyer.** Browse the catalog. Open a course page. Try the preview lesson in their own profile without an account (profile stored locally until sign-up). Click Buy, complete hosted checkout. The payment webhook creates a `purchases` row with status `paid`, which grants access. The course appears in the buyer's library.

**Money.** The platform fee is a configurable percentage (`PLATFORM_FEE_BPS`). Refunds within 14 days set the purchase to `refunded` and revoke access. Payouts are handled by the payment provider.

**Trust.** Creators attest they own the rights to uploaded content. Listings pass an automated moderation check before publishing, and a report button sends listings to a manual review queue.

---

## 6. Non-Functional Requirements

### 6.1 Performance

| Operation | Target |
| --- | --- |
| Profile or layout switch | Under 300 ms, zero network calls |
| Lesson first contentful paint (published lesson, warm cache) | Under 1.5 s on a mid-range phone over 4G |
| Card advance | Under 100 ms |
| Voice turn: end of learner speech to first tutor audio | Under 1.5 s at the 90th percentile |
| Barge-in: speech detected to audio stopped | Under 200 ms |
| In-session intent (local keyword match) | Under 50 ms |
| In-session intent (LLM path) | Under 800 ms at the 90th percentile |
| Ingestion of a 20-page text PDF | Under 90 s to `needs_review` |
| Ingestion of 60 minutes of audio | Under 6 minutes to `needs_review` |
| Dashboard load (school of 1,000 students) | Under 2 s |

### 6.2 LLM cost controls

These are budget targets to validate against real provider pricing during Phase 8.

| Control | Requirement |
| --- | --- |
| Model tiers | Two tiers behind one interface: `heavy` for extraction and merge, `fast` for intents, grading, variants, and grounding checks |
| Ingestion budget | Target at most 0.50 USD per 20-page source. Token usage and cost recorded per job in `ingestion_jobs` |
| Learner session budget | Target at most 0.02 USD per learner per lesson outside the conversation renderer, and at most 0.15 USD in it |
| Caching | Variants cached permanently per `(conceptId, graphVersion, readingLevel)`. Text-to-speech audio cached per `(text hash, voice, rate)` |
| Local first | Keyword matching before any LLM intent call. MCQ and true/false graded locally with no LLM |
| Prompt size | Tutor calls send only the current section and the lesson overview, never the full graph |
| Limits | Per-user rate limits on all LLM-backed endpoints. Per-organization monthly spend cap with alerts at 80% |
| Prompt caching | Use provider prompt caching for stable system prompts where available |

### 6.3 Accessibility

- Conformance target: WCAG 2.2 Level AA on every page and every renderer.
- Full keyboard operation with visible focus. No keyboard traps. Logical focus order.
- Semantic HTML first. ARIA only where native semantics are insufficient.
- Works with NVDA, JAWS, VoiceOver (macOS and iOS), and TalkBack.
- Respects `prefers-reduced-motion`, `prefers-color-scheme`, and `prefers-contrast`. Profile settings override system settings when set explicitly.
- No content flashes more than 3 times per second.
- Text resizes to 200% without loss of content. Reflows at 320 CSS pixels wide.
- Minimum target size of 24 by 24 CSS pixels everywhere and 44 by 44 in the cards renderer.
- Color is never the only carrier of meaning (correct and incorrect use icon plus text).
- All media has captions or transcripts. All images have alt text reviewed by the uploader.
- Automated checks (axe) run in CI on every renderer. Manual screen reader test scripts live in `docs/a11y-test-scripts.md`.
- People with disabilities take part in usability testing before each major release, including Deaf ASL users for the sign features.

### 6.4 Privacy and security

- Render Profiles may reveal sensitive information. They are private to the learner by default and protected by row-level security.
- No diagnosis or disability field exists anywhere in the data model.
- Row-level security on every table. No table is readable without a policy.
- Student data is never used to train models. LLM and speech providers must be configured for zero data retention where offered.
- Voice audio is processed in memory and not stored. Only the resulting text is kept, and only in the session transcript.
- Compliance targets for school deployments: FERPA and COPPA (United States), GDPR (EU and UK), and NDPA (Nigeria). Requires data processing agreements, parental consent flows for under-13 users, data export, and deletion. Legal review is required before a school pilot.
- Encryption in transit (TLS) and at rest. Signed URLs for all stored files, with expiry of 1 hour or less.
- Payment card data never touches Prism servers. Use hosted checkout only.
- Audit log for admin actions and profile-sharing consent changes.

### 6.5 Reliability and observability

- Availability target: 99.5% monthly for learner-facing routes.
- Ingestion jobs are idempotent and resumable per step.
- Event ingestion is idempotent by event ID. The client queue persists unsent events locally and retries with backoff.
- Graceful degradation: if speech services fail, the conversation renderer falls back to text input and on-screen transcript. If the LLM fails, published lessons remain fully usable in `original` reading level with locally graded quizzes.
- Structured logs with request IDs. Error tracking on client and server. LLM calls traced with model, tokens, latency, and cost.

### 6.6 Compatibility and localization

- Latest two versions of Chrome, Edge, Safari, and Firefox. iOS Safari and Android Chrome.
- Browser speech APIs vary by browser, so server-side speech providers are the production path and browser APIs are the MVP path and fallback.
- UI strings externalized from day one. English only in v1. The Knowledge Graph carries a `language` field for later expansion.

---

## 7. System Architecture and Tech Stack

### 7.1 Architecture overview

```
                         +---------------------------------------------+
                         |              Next.js (App Router)           |
  Browser  <-----------> |  Server Components + Route Handlers (/api)  |
  - PrismRenderer        |  - auth middleware     - rate limiting      |
  - renderers            +----+----------+-----------+-----------+-----+
  - session/profile stores    |          |           |           |
  - event queue               v          v           v           v
                         +--------+ +---------+ +---------+ +----------+
                         |Supabase| | LLM     | | Speech  | | Payments |
                         |Postgres| | gateway | | gateway | | (Stripe) |
                         |Auth    | |LangChain| | TTS/STT | +----------+
                         |Storage | +----+----+ +----+----+
                         |RLS     |      |           |
                         +---+----+      v           v
                             ^      LLM provider   Speech providers
                             |
                         +---+-------------+
                         | Job runner      |  ingestion pipeline steps
                         | (Inngest)       |
                         +-----------------+
```

### 7.2 Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js (App Router), React, TypeScript strict | Server Components for data pages, Client Components for renderers |
| Styling | Tailwind CSS plus CSS custom properties | Typography and theme settings map to custom properties on the renderer root |
| UI primitives | Radix UI | Accessible primitives for dialogs, sliders, tabs |
| Client state | Zustand | `profileStore`, `sessionStore`, `eventQueue` |
| Validation | Zod | Single source of truth for schemas |
| Database, auth, storage | Supabase (Postgres, Auth, Storage, row-level security) | Migrations in `supabase/migrations` |
| AI orchestration | LangChain JS | `withStructuredOutput` with Zod schemas. All calls go through `src/lib/ai/llm.ts` |
| LLM provider | Configurable through env | Two model IDs: `LLM_MODEL_HEAVY`, `LLM_MODEL_FAST`. Choose current models at build time |
| Speech to text | Provider interface. MVP: browser Web Speech API. Production: streaming STT provider with word timestamps | `src/lib/speech/stt.ts` |
| Text to speech | Provider interface. MVP: browser `speechSynthesis`. Production: streaming TTS provider with word timings | `src/lib/speech/tts.ts` |
| Document parsing | `unpdf` for PDF, `mammoth` for DOCX | OCR for scanned PDFs is post-MVP |
| Background jobs | Inngest | MVP may run the pipeline in one route handler with an extended `maxDuration` |
| Payments | Stripe Checkout and Stripe Connect (Express accounts) | Test mode until launch |
| Gestures and motion | Framer Motion (Motion) | All animation gated on reduced motion |
| Charts | Recharts | Each chart has a data table alternative |
| Testing | Vitest (unit), Playwright (end to end), axe-core (accessibility) | |
| Hosting | Vercel (app), Supabase (data) | |
| Observability | Sentry (errors), LangSmith or equivalent (LLM traces) | |

### 7.3 Repository structure

```
prism/
  PRISM_PRD.md                  # this file
  supabase/
    migrations/                 # SQL migrations, numbered
    seed.sql                    # demo org, users, lesson
  docs/
    a11y-test-scripts.md
    demo-script.md
  public/
    fonts/                      # Atkinson Hyperlegible, Lexend, OpenDyslexic (OFL licensed)
    earcons/
  src/
    app/
      (marketing)/              # landing page
      (auth)/                   # sign in, sign up, invite accept
      onboarding/               # profile setup
      learn/[lessonId]/         # lesson player (PrismRenderer)
      teach/                    # teacher: lessons, upload, review, classrooms
      admin/                    # principal dashboard
      create/                   # creator: courses, payouts, analytics
      market/                   # catalog, course pages, library
      api/                      # route handlers (Section 7.5)
    components/                 # shared UI (buttons, dialogs, settings panel)
    renderers/
      registry.ts
      PrismRenderer.tsx
      cards/
      reader/
      conversation/
      visual/
      shared/                   # QuizBlock, ProgressBar, ProfileSwitcher
    lib/
      schemas/                  # Zod: knowledge-graph, render-profile, events, intents
      ai/
        llm.ts                  # model factory, tiers, cost tracking
        prompts/                # one file per prompt
        ingestion/              # extract, chunk, concepts, merge, quiz, validate, signs
        intents/                # profile parser, session intent parser
        tutor/                  # conversation turn, short-answer grader, variants
      speech/                   # stt.ts, tts.ts, providers/
      session/                  # store.ts, machine.ts, events.ts
      profile/                  # store.ts, presets.ts, merge.ts
      supabase/                 # server and browser clients, typed queries
      payments/                 # stripe helpers
      a11y/                     # live region, focus helpers
    tests/
      unit/
      e2e/
      fixtures/                 # sample sources and golden graphs
```

### 7.4 Database schema

All tables have `id uuid primary key default gen_random_uuid()` and `created_at timestamptz default now()` unless noted. Row-level security is enabled on every table.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `users_public` | `id` (= `auth.users.id`), `display_name`, `is_creator` | Public user profile |
| `organizations` | `name`, `slug`, `monthly_spend_cap_usd` | A school |
| `org_memberships` | `org_id`, `user_id`, `role` (`principal`, `teacher`, `student`) | Role per org |
| `classrooms` | `org_id`, `teacher_id`, `name`, `grade`, `subject`, `join_code` | A class |
| `enrollments` | `classroom_id`, `student_id` | Class roster |
| `lessons` | `owner_id`, `org_id` (nullable), `title`, `status` (`uploading`, `processing`, `needs_review`, `published`, `failed`), `source_type`, `source_path`, `graph` (jsonb), `graph_version` | A lesson and its Knowledge Graph |
| `ingestion_jobs` | `lesson_id`, `stage`, `progress`, `error`, `tokens_in`, `tokens_out`, `cost_usd` | Pipeline state |
| `concepts` | `id` (text, from graph), `lesson_id`, `graph_version`, `order_index`, `title`, `summary`, `key_term`, `retired` | Normalized concepts for joins |
| `quiz_items` | `id` (text), `lesson_id`, `concept_id`, `type`, `retired` | Normalized quiz items |
| `concept_variants` | `concept_id`, `graph_version`, `reading_level`, `body`, `summary` | Variant cache. Unique on the first three |
| `assignments` | `classroom_id`, `lesson_id`, `due_at` | Lesson assigned to class |
| `render_profiles` | `user_id` (pk), `profile` (jsonb), `share_with_teachers` (bool, default false) | Learner settings |
| `learning_events` | `id` (text pk, client ULID), `user_id`, `lesson_id`, `graph_version`, `type`, `concept_id`, `quiz_item_id`, `correct`, `duration_ms`, `layout`, `occurred_at` | Event log |
| `concept_mastery` | `user_id`, `concept_id`, `lesson_id`, `status`, `attempts`, `correct_count`, `last_two_correct`, `updated_at` | Derived mastery. Unique on user and concept |
| `sign_clips` | `gloss`, `language`, `storage_path`, `source`, `license`, `signer_credit` | Sign video library |
| `concept_sign_links` | `concept_id`, `sign_clip_id`, `verified` (bool), `verified_by` | Concept to sign mapping |
| `unmet_needs` | `user_id` (nullable), `request_text` | Requests no setting covers |
| `courses` | `creator_id`, `title`, `slug`, `description`, `cover_path`, `cover_alt`, `price_cents`, `currency`, `status` (`draft`, `published`, `suspended`) | Marketplace course |
| `course_lessons` | `course_id`, `lesson_id`, `order_index`, `is_preview` | Course contents |
| `creator_accounts` | `user_id` (pk), `stripe_account_id`, `onboarding_complete` | Payout account |
| `purchases` | `buyer_id`, `course_id`, `stripe_session_id`, `amount_cents`, `platform_fee_cents`, `status` (`pending`, `paid`, `refunded`) | Entitlements |
| `audit_log` | `actor_id`, `action`, `target`, `metadata` | Admin and consent actions |

### 7.5 API routes

| Method and path | Purpose | Auth |
| --- | --- | --- |
| `POST /api/lessons` | Create lesson, return signed upload URL | Teacher or creator |
| `POST /api/lessons/[id]/ingest` | Start or resume ingestion | Owner |
| `GET /api/lessons/[id]/status` | Job stage and progress | Owner |
| `PATCH /api/lessons/[id]/graph` | Save review edits | Owner |
| `POST /api/lessons/[id]/publish` | Publish and normalize | Owner |
| `GET /api/lessons/[id]` | Published graph for learners | Entitled learner |
| `POST /api/variants` | Get or create a concept variant | Entitled learner |
| `PUT /api/profile` | Save Render Profile | Self |
| `POST /api/profile/parse` | Free text to profile patch | Self or anonymous (rate limited) |
| `POST /api/session/intent` | Utterance to `SessionIntent` | Entitled learner |
| `POST /api/tutor/turn` | Conversation turn, streamed | Entitled learner |
| `POST /api/tutor/grade` | Grade a short answer | Entitled learner |
| `POST /api/events` | Batch insert Learning Events | Self |
| `POST /api/speech/tts`, `POST /api/speech/stt` | Speech provider proxy | Entitled learner |
| `POST /api/orgs`, `POST /api/orgs/[id]/invites` | Org setup | Principal |
| `POST /api/classrooms`, `POST /api/classrooms/[id]/students`, `POST /api/classrooms/join` | Class management | Teacher, student for join |
| `POST /api/assignments` | Assign lesson | Teacher |
| `GET /api/dashboard/classroom/[id]` | Teacher dashboard data | Teacher of class |
| `GET /api/dashboard/org/[id]` | Principal dashboard data | Principal |
| `POST /api/courses`, `PATCH /api/courses/[id]` | Course management | Creator |
| `POST /api/creator/onboard` | Start payout onboarding | Creator |
| `POST /api/checkout` | Create hosted checkout session | Buyer |
| `POST /api/stripe/webhook` | Payment events | Signature verified |

### 7.6 Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server only
LLM_PROVIDER=
LLM_API_KEY=
LLM_MODEL_HEAVY=
LLM_MODEL_FAST=
STT_PROVIDER=browser                # browser | <provider>
STT_API_KEY=
TTS_PROVIDER=browser                # browser | <provider>
TTS_API_KEY=
STRIPE_SECRET_KEY=                  # test key until launch
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
PLATFORM_FEE_BPS=1500
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
SENTRY_DSN=
```

---

## 8. Implementation Roadmap (Agent Work Queue)

Task format: `- [ ] **ID** [MVP]? Description. Files. Done when: condition.` Story references are in parentheses.

### 8.0 Hackathon MVP path

The MVP is a live demo of one lesson rendered for three learners (cards, conversation, visual with ASL sign clips), plus a learner describing a need in plain language and watching the interface change. Do tasks tagged `[MVP]` in phase order: Phase 0, then the tagged tasks in Phases 1, 2, 3, 4, 5, and 9. Everything untagged comes after the demo.

MVP simplifications that are allowed:
- Ingestion runs in a single route handler. No job runner.
- Text and PDF sources only. Audio ingestion may be replaced by a pre-transcribed fixture.
- Browser speech APIs only.
- A single seeded demo user per persona. Email and password auth only.
- No payments, no organizations, no dashboards beyond one simple progress view.

### Progress summary

Update this table when a phase completes.

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Project foundation | MVP tasks done. P0-05 awaits a live database check (9.2). P0-07 and P0-08 deferred |
| 1 | Database and schema | Not started |
| 2 | AI ingestion pipeline | Not started |
| 3 | Profiles, intents, and dynamic rendering state | Not started |
| 4 | Renderers | Not started |
| 5 | Learning events and progress | Not started |
| 6 | B2B school portal and dashboards | Not started |
| 7 | B2C creator marketplace | Not started |
| 8 | Hardening | Not started |
| 9 | Demo and launch | Not started |

---

### Phase 0: Project foundation

- [x] **P0-01** [MVP] Scaffold a Next.js App Router project with TypeScript strict, Tailwind, ESLint, and Prettier at the repo root. Done when: `npm run dev` serves a placeholder home page and `npm run lint` passes.
- [x] **P0-02** [MVP] Create the directory structure from Section 7.3 with `.gitkeep` files. Done when: all listed folders exist.
- [x] **P0-03** [MVP] Install core dependencies: `zod`, `zustand`, `@supabase/supabase-js`, `@supabase/ssr`, `langchain` core packages plus the chosen provider package, `unpdf`, `ulid`, Radix primitives, and Motion. Done when: `package.json` lists them and the build passes.
- [x] **P0-04** [MVP] Add `.env.example` with every variable from Section 7.6 and a typed env loader. File: `src/lib/env.ts`. Done when: the app throws a clear error at startup if a required server variable is missing.
- [ ] **P0-05** [MVP] Initialize Supabase locally (`supabase init`) and add browser and server client helpers. Files: `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`. Done when: a server component can query the database.
- [x] **P0-06** [MVP] Set up Vitest with one passing sample test. Done when: `npm test` passes.
- [ ] **P0-07** Set up Playwright with `@axe-core/playwright` and one smoke test that loads the home page with zero axe violations. Done when: `npm run e2e` passes.
- [ ] **P0-08** Add CI (GitHub Actions) that runs lint, type check, unit tests, and e2e on pull requests. Done when: the workflow passes on the main branch.
- [x] **P0-09** [MVP] Build the base layout: skip link, landmark regions, a global polite and assertive live region, and theme tokens as CSS custom properties. Files: `src/app/layout.tsx`, `src/lib/a11y/live-region.tsx`, `src/app/globals.css`. Done when: `announce("text")` is callable from any client component and is read by a screen reader.
- [x] **P0-10** [MVP] Add self-hosted fonts (Atkinson Hyperlegible, Lexend, OpenDyslexic) with their license files. Folder: `public/fonts/`. Done when: each font is selectable through a CSS custom property.

### Phase 1: Database and schema

- [x] **P1-01** [MVP] Write Zod schemas for the Knowledge Graph exactly as in Section 5.2. File: `src/lib/schemas/knowledge-graph.ts`. Done when: unit tests accept a valid fixture and reject a graph whose quiz item references a missing concept.
- [x] **P1-02** [MVP] Write the Render Profile schema exactly as in Section 5.3. File: `src/lib/schemas/render-profile.ts`. Done when: `RenderProfile.parse({ ...minimal })` fills all defaults.
- [x] **P1-03** [MVP] Write the Learning Event and Session Intent schemas from Sections 5.7 and 5.4. Files: `src/lib/schemas/events.ts`, `src/lib/schemas/intents.ts`. Done when: unit tests cover one valid and one invalid case for each.
- [x] **P1-04** [MVP] Migration: `users_public`, `lessons`, `ingestion_jobs`, `concepts`, `quiz_items`, `concept_variants`. Done when: `supabase db reset` applies cleanly.
- [ ] **P1-05** [MVP] Migration: `render_profiles`, `learning_events`, `concept_mastery`, `unmet_needs`. Done when: migration applies cleanly.
- [ ] **P1-06** [MVP] Migration: `sign_clips`, `concept_sign_links`, and a storage bucket `sign-clips`. Done when: migration applies cleanly.
- [ ] **P1-07** [MVP] Row-level security for the tables in P1-04 to P1-06: owners manage their lessons, learners read published lessons they are entitled to, users read and write only their own profile, events, and mastery. Done when: a SQL test proves user A cannot read user B's `render_profiles` row.
- [ ] **P1-08** [MVP] Database trigger: on insert of a `quiz_answered` event, upsert `concept_mastery` using the rule in Section 5.7. Done when: a SQL test shows two consecutive correct answers set status to `mastered` and a later wrong answer returns it to `in_progress`.
- [ ] **P1-09** [MVP] Storage buckets `sources` (private) and `lesson-media` (private), with signed URL helpers. File: `src/lib/supabase/storage.ts`. Done when: a signed upload and a signed download both work in a test.
- [ ] **P1-10** [MVP] Generate TypeScript database types and add a script `npm run db:types`. Done when: typed queries compile.
- [ ] **P1-11** [MVP] Supabase Auth with email and password, sign-in and sign-up pages, and route protection middleware. Files: `src/app/(auth)/`, `src/middleware.ts`. Done when: unauthenticated users are redirected from `/learn`, `/teach`, `/admin`, and `/create`.
- [ ] **P1-12** Migration: `organizations`, `org_memberships`, `classrooms`, `enrollments`, `assignments`, `audit_log`, with row-level security per the access table in Section 5.8. Done when: SQL tests prove a teacher reads only their own classrooms and a principal reads all classrooms in their org.
- [ ] **P1-13** Migration: `courses`, `course_lessons`, `creator_accounts`, `purchases`, with row-level security (published courses are public, purchases readable by buyer and by course creator). Done when: migration and SQL tests pass.
- [ ] **P1-14** SQL function `is_entitled(user_id, lesson_id)` returning true if the user owns the lesson, is enrolled in a classroom it is assigned to, has a paid purchase of a course containing it, or it is a preview lesson. Use it in the lesson read policy. Done when: SQL tests cover all four paths and one denial.
- [ ] **P1-15** SQL views from Section 5.8: `v_classroom_student_progress`, `v_classroom_concept_difficulty`, `v_org_classroom_summary`, `v_org_layout_usage` (with suppression under 5). Done when: SQL tests on seed data return expected rows and the layout view hides a group of 4.

### Phase 2: AI ingestion pipeline

- [ ] **P2-01** [MVP] LLM gateway: a factory returning a `heavy` or `fast` chat model from env, a `generateStructured(schema, prompt, tier)` helper that validates with Zod and retries once on failure, and token and cost tracking. File: `src/lib/ai/llm.ts`. Done when: a unit test with a mocked model shows the retry path and the usage callback.
- [ ] **P2-02** [MVP] Text extraction for `.txt`, `.md`, and `.pdf` into a `SourceDocument` with page locators. File: `src/lib/ai/ingestion/extract.ts`. Done when: a fixture PDF yields segments with correct page numbers.
- [ ] **P2-03** [MVP] Chunker: split by headings, then by size with overlap, preserving locators. File: `src/lib/ai/ingestion/chunk.ts`. Done when: unit tests confirm no chunk exceeds the limit and every chunk has at least one locator.
- [ ] **P2-04** [MVP] Concept extraction prompt and function (map step). Files: `src/lib/ai/prompts/extract-concepts.ts`, `src/lib/ai/ingestion/concepts.ts`. The prompt must require: one idea per concept, a verbatim supporting excerpt, plain wording, no facts absent from the source. Done when: the fixture source yields candidates that all carry excerpts found in the source text.
- [ ] **P2-05** [MVP] Merge and order (reduce step): deduplicate, order, group into sections, assign prerequisites, assign ULIDs. File: `src/lib/ai/ingestion/merge.ts`. Done when: output has unique IDs, contiguous `order`, and no prerequisite cycles (enforced in code, not only by the prompt).
- [ ] **P2-06** [MVP] Quiz generation: at least 2 items per concept with at least one MCQ. File: `src/lib/ai/ingestion/quiz.ts`. Done when: every concept in the fixture graph has 2 or more items and every MCQ has exactly one option equal to `answer`.
- [ ] **P2-07** [MVP] Validation: Zod parse plus referential checks. File: `src/lib/ai/ingestion/validate.ts`. Done when: unit tests reject a dangling `conceptId` and a prerequisite cycle.
- [ ] **P2-08** Grounding check: the fast model verifies each concept and quiz answer against its excerpt and sets the `ungrounded` flag where unsupported. File: `src/lib/ai/ingestion/ground.ts`. Done when: a fixture with one planted false concept gets that concept flagged.
- [ ] **P2-09** [MVP] Pipeline orchestrator that runs the steps in order, writes stage and progress to `ingestion_jobs`, saves the draft graph to `lessons.graph`, and sets status `needs_review`. File: `src/lib/ai/ingestion/pipeline.ts`. Done when: an integration test with a mocked LLM takes a fixture from upload to `needs_review`.
- [ ] **P2-10** [MVP] API routes `POST /api/lessons`, `POST /api/lessons/[id]/ingest`, `GET /api/lessons/[id]/status`. Done when: an authenticated request can upload a file and poll to completion.
- [ ] **P2-11** [MVP] Upload page with drag and drop, a standard file input, and staged progress announced through the live region. File: `src/app/teach/upload/page.tsx`. Done when: a keyboard-only user can upload a file and hear progress updates. (CE-1)
- [ ] **P2-12** [MVP] Review page: list concepts by section with the source excerpt beside each, inline editing of title, summary, and body, delete, and reorder with buttons (not drag only). Flagged items first. File: `src/app/teach/lessons/[id]/review/page.tsx`. Done when: edits persist through `PATCH /api/lessons/[id]/graph` and the result still validates. (CE-2)
- [ ] **P2-13** [MVP] Review page: edit, add, and delete quiz items. Done when: an edited MCQ is saved and validated.
- [ ] **P2-14** [MVP] Publish endpoint and button: validate, increment `graph_version`, upsert `concepts` and `quiz_items`, mark removed IDs `retired`, set status `published`. Done when: a published lesson is readable by an entitled learner through `GET /api/lessons/[id]`. (CE-2)
- [ ] **P2-15** [MVP] Sign tagging: given the glosses in `sign_clips`, match each concept's `keyTerm` by meaning or return none, and write unverified `concept_sign_links`. File: `src/lib/ai/ingestion/signs.ts`. Done when: the fixture lesson links only terms whose gloss exists and never invents a gloss.
- [ ] **P2-16** [MVP] Review page: a "Signs" tab listing proposed concept-to-sign links with the clip playable, and Verify and Remove buttons. Done when: only verified links are returned to learners. (CE-9)
- [ ] **P2-17** [MVP] Variant generation: `POST /api/variants` with get-or-create semantics on `concept_variants`. Prewarm `plain` variants at publish. File: `src/lib/ai/tutor/variants.ts`. Done when: a second request for the same variant makes no LLM call.
- [ ] **P2-18** Audio ingestion: speech-to-text with timestamps into `SourceDocument` with time locators and `graph.transcript`. File: `src/lib/ai/ingestion/extract-audio.ts`. Done when: a fixture audio file yields a transcript and concepts with time locators.
- [ ] **P2-19** DOCX extraction with `mammoth`. Done when: a fixture `.docx` yields headed segments.
- [ ] **P2-20** Move the pipeline to Inngest with one function per step, retries, and resume from the failed step. Done when: killing the process mid-job and restarting resumes without repeating completed steps.
- [ ] **P2-21** Concept image generation or selection from `visualHint` at publish, with required alt text and teacher approval in the review page. Done when: approved images appear in the visual renderer and unapproved ones do not.
- [ ] **P2-22** Graph versioning on re-publish: preserve IDs for unchanged and edited items so `concept_mastery` rows survive. Done when: a test edits one concept, republishes, and the learner's mastery on other concepts is unchanged.
- [ ] **P2-23** Golden-file evaluation: 5 fixture sources with human-approved graphs and a script that reports concept coverage and grounding rate for prompt changes. File: `src/tests/eval/ingestion-eval.ts`. Done when: `npm run eval:ingestion` prints the metrics.

### Phase 3: Profiles, intents, and dynamic rendering state

- [ ] **P3-01** [MVP] Presets from the table in Section 5.3 and a `deepMergeProfile(base, patch)` function that validates its result. Files: `src/lib/profile/presets.ts`, `src/lib/profile/merge.ts`. Done when: every preset parses and an invalid patch throws.
- [ ] **P3-02** [MVP] `profileStore` (Zustand): current profile, `applyPreset`, `applyPatch`, `undo`, local persistence, and debounced server save through `PUT /api/profile`. File: `src/lib/profile/store.ts`. Done when: a reload restores the profile and undo reverts the last change.
- [ ] **P3-03** [MVP] Session state machine as a pure reducer implementing Section 5.5. File: `src/lib/session/machine.ts`. Done when: unit tests cover every transition, including quiz cadence and retry on wrong.
- [ ] **P3-04** [MVP] `sessionStore` wrapping the reducer with actions (`start`, `next`, `previous`, `requestQuiz`, `answer`, `continue`) and per-lesson local persistence. File: `src/lib/session/store.ts`. Done when: reloading mid-lesson restores the same concept and phase.
- [ ] **P3-05** [MVP] Renderer registry with lazy imports and a shared `RendererProps` type. File: `src/renderers/registry.ts`. Done when: each layout key resolves to a component (placeholders are fine).
- [ ] **P3-06** [MVP] `<PrismRenderer>`: reads both stores, renders `registry[profile.layout]`, moves focus to the new renderer's heading and announces on layout change, and prefetches other renderer bundles after first paint. File: `src/renderers/PrismRenderer.tsx`. Done when: switching layout in a test keeps `sessionStore` state identical and makes zero network requests. (CE-5)
- [ ] **P3-07** [MVP] Lesson player route that loads the published graph on the server and mounts `<PrismRenderer>`. File: `src/app/learn/[lessonId]/page.tsx`. Done when: an entitled learner sees the lesson and a non-entitled user gets a 403 page.
- [ ] **P3-08** [MVP] Shared components: `QuizBlock` (MCQ, true/false, short answer; local grading for the first two), `ProgressBar`, `ProfileSwitcher` (preset buttons). Folder: `src/renderers/shared/`. Done when: each is keyboard operable and has a unit test.
- [ ] **P3-09** [MVP] Apply typography and theme settings as CSS custom properties on the renderer root. File: `src/renderers/shared/useProfileStyles.ts`. Done when: changing `typography.lineHeight` updates the rendered style with no remount.
- [ ] **P3-10** [MVP] Needs-to-profile parser: prompt, function, and `POST /api/profile/parse` per Section 5.4 A. Files: `src/lib/ai/prompts/parse-needs.ts`, `src/lib/ai/intents/profile.ts`. Done when: tests with a mocked model cover a valid patch, an invalid patch (rejected, profile unchanged), and an unsupported request (logged to `unmet_needs`). (CE-4)
- [ ] **P3-11** [MVP] "Tell Prism what you need" UI: text box plus microphone button, shows the explanation with Apply and Undo. File: `src/components/NeedsBox.tsx`. Done when: typing "one idea at a time and quiz me often" switches to cards with a low cadence. (CE-4)
- [ ] **P3-12** [MVP] Onboarding page: preset gallery with live preview on a sample concept, the NeedsBox, and Continue. No diagnosis questions. File: `src/app/onboarding/page.tsx`. Done when: the flow can be completed by keyboard alone and by screen reader. (CE-3)
- [ ] **P3-13** [MVP] Settings panel (dialog) exposing every Render Profile field with labelled controls, grouped by Content, Quiz, Text, Audio, Visual, and Feedback. File: `src/components/SettingsPanel.tsx`. Done when: every field in the schema is editable and changes apply live.
- [ ] **P3-14** [MVP] Local keyword matcher for session commands, returning a `SessionIntent` or null. File: `src/lib/ai/intents/local.ts`. Done when: unit tests map at least 3 phrasings for each of next, repeat, simplify, quiz_me, pause, and where_am_i.
- [ ] **P3-15** [MVP] LLM session intent parser and `POST /api/session/intent` for utterances the local matcher misses. File: `src/lib/ai/intents/session.ts`. Done when: "can you go over that again but easier" returns `simplify`.
- [ ] **P3-16** Anonymous profile support: a profile stored locally for signed-out users and migrated to `render_profiles` at sign-up. Done when: a profile set before sign-up is present after it. (B2C-3)

### Phase 4: Renderers

#### 4A. Cards renderer

- [ ] **P4-01** [MVP] `ConceptCard`: title, summary, optional example, expandable body. File: `src/renderers/cards/ConceptCard.tsx`. Done when: it renders a fixture concept and the expand control has correct `aria-expanded`.
- [ ] **P4-02** [MVP] `CardsRenderer`: one card at a time, advance by swipe, tap, arrow keys, and space, with visible Next and Back buttons. File: `src/renderers/cards/CardsRenderer.tsx`. Done when: all four input methods dispatch `next`. (CE-7)
- [ ] **P4-03** [MVP] Quiz card using `QuizBlock`, shown when the session phase is `quiz`, with large option targets. Done when: after `quiz.cadence` concepts the quiz card appears.
- [ ] **P4-04** [MVP] Feedback: progress bar fill, celebration by `feedback.celebration`, static alternative under reduced motion, icon plus text for correct and incorrect, optional haptic through the Vibration API. File: `src/renderers/cards/Feedback.tsx`. Done when: with reduced motion on, no animation runs and the result is still announced.
- [ ] **P4-05** [MVP] Streak counter and completion summary card. Done when: the summary shows concepts mastered and active time.
- [ ] **P4-06** Suggested break card every 10 active minutes with Continue and Stop here. Done when: a fake-timer test shows the card at 10 minutes.

#### 4B. Reader renderer

- [ ] **P4-07** [MVP] `ReaderRenderer`: sections and concepts as semantic headings and paragraphs, styled from profile custom properties, honoring `content.chunkSize`. File: `src/renderers/reader/ReaderRenderer.tsx`. Done when: heading levels are sequential and `maxLineLength` constrains the column. (CE-8)
- [ ] **P4-08** [MVP] Inline quiz blocks at the configured cadence. Done when: answering emits the same session actions as the cards renderer.
- [ ] **P4-09** [MVP] Word anchors: a pure function that splits a word into bold lead and remainder, applied only when `typography.wordAnchors` is true, with the accessible text unchanged. File: `src/renderers/reader/wordAnchors.tsx`. Done when: a screen reader test reads the sentence normally and a unit test covers short words and punctuation.
- [ ] **P4-10** [MVP] Read-aloud with browser `speechSynthesis`: play, pause, rate, and sentence highlighting using boundary events. File: `src/renderers/reader/ReadAloud.tsx`. Done when: the highlighted sentence tracks speech in Chrome.
- [ ] **P4-11** [MVP] "Simpler" button per concept that requests the next reading level from `/api/variants` and swaps the text in place. Done when: the variant displays and a `concept_variant_requested` event is queued.
- [ ] **P4-12** Word-level highlighting using provider word timings, with fallback to sentence level. Done when: word highlight drift stays under 150 ms on the fixture.
- [ ] **P4-13** Background tint themes (`cream`, `blue_tint`, `high_contrast`) meeting contrast requirements. Done when: axe reports no contrast violations in each theme.

#### 4C. Conversation renderer

- [ ] **P4-14** [MVP] Speech interfaces and browser providers: `SttProvider` (start, stop, onPartial, onFinal) and `TtsProvider` (speak, cancel, onBoundary, onEnd). Files: `src/lib/speech/stt.ts`, `src/lib/speech/tts.ts`, `src/lib/speech/providers/browser.ts`. Done when: a test page transcribes speech and speaks text in Chrome.
- [ ] **P4-15** [MVP] Tutor turn endpoint: given the current concept, section, overview, and intent, stream the tutor's spoken reply. Uses only graph content. File: `src/lib/ai/tutor/turn.ts`, route `POST /api/tutor/turn`. Done when: a `question` outside the lesson gets a reply saying the lesson does not cover it.
- [ ] **P4-16** [MVP] `ConversationRenderer` loop: speak concept summary, listen, resolve intent (local first, then LLM), dispatch the session action or tutor turn, repeat. File: `src/renderers/conversation/ConversationRenderer.tsx`. Done when: a learner completes a 3-concept fixture lesson by voice only. (CE-6)
- [ ] **P4-17** [MVP] Barge-in: cancel speech on detected speech or any key press. Done when: speaking over the tutor stops audio within 200 ms in a manual test.
- [ ] **P4-18** [MVP] Spoken quizzes: read prompt and lettered options, accept a letter or the option content, grade MCQ and true/false locally. Done when: saying "B" and saying the option text both register the same answer.
- [ ] **P4-19** [MVP] Short-answer grading endpoint `POST /api/tutor/grade` returning `{ correct, feedback }`. File: `src/lib/ai/tutor/grade.ts`. Done when: tests with a mocked model cover correct, incorrect, and partially correct answers.
- [ ] **P4-20** [MVP] On-screen transcript as an ARIA log, a visible and announced state indicator (listening, thinking, speaking), and a text input as an equal alternative to the microphone. Done when: the whole lesson can be completed with keyboard and text only.
- [ ] **P4-21** [MVP] Keyboard shortcuts with a discoverable help dialog: space (pause or resume), R (repeat), N (next), Q (quiz me), S (simpler). Done when: each shortcut dispatches the right intent and none conflict with common screen reader keys in browse mode.
- [ ] **P4-22** Earcons for listening, correct, and incorrect, gated on `audio.earcons`. Done when: sounds play only with the setting on.
- [ ] **P4-23** Toggle to mute Prism speech and rely on the user's own screen reader, with the transcript announced politely. Done when: with speech off, new tutor messages are read by NVDA or VoiceOver once.
- [ ] **P4-24** Production speech providers with streaming STT and TTS behind the same interfaces, selected by env, plus TTS audio caching. Done when: the voice latency target in Section 6.1 is met on the fixture lesson.

#### 4D. Visual renderer

- [ ] **P4-25** [MVP] Seed the sign clip library: add 15 to 20 ASL clips for the demo lesson's key terms to the `sign-clips` bucket and `sign_clips` table with source, license, and signer credit recorded. Done when: every demo key term either has a clip or is listed in Section 9.3 as fingerspelled.
- [ ] **P4-26** [MVP] `SignClip` component: short looping muted video with play, pause, and speed controls, a text label of the gloss, and a note that it shows the sign for the key term. File: `src/renderers/visual/SignClip.tsx`. Done when: the clip is keyboard operable and does not autoplay under reduced motion.
- [ ] **P4-27** [MVP] `VisualRenderer`: plain-language concept cards (uses the `plain` variant), image when available, "See it signed" button for verified links, and the "not a full translation" notice. File: `src/renderers/visual/VisualRenderer.tsx`. Done when: a concept with a verified link shows the button and one without does not. (CE-9)
- [ ] **P4-28** [MVP] Fingerspelling fallback: for a key term with no clip, show the term spelled with ASL handshape images, labelled "Fingerspelled". File: `src/renderers/visual/Fingerspell.tsx`. Done when: any A to Z term renders with alt text per letter.
- [ ] **P4-29** [MVP] Visual-only feedback for quizzes (icon, text, color, optional haptic) and a test asserting no audio element or speech call is used in this renderer. Done when: the test passes.
- [ ] **P4-30** Transcript panel for audio sources with timestamps, synchronized highlighting during optional playback, and click-to-seek. File: `src/renderers/visual/TranscriptPanel.tsx`. Done when: clicking a line seeks the audio and the active line is highlighted.

### Phase 5: Learning events and progress

- [ ] **P5-01** [MVP] Event queue: `track(event)` adds layout, IDs, and timestamps, batches every 5 seconds and on `visibilitychange`, persists unsent events locally, retries with backoff. File: `src/lib/session/events.ts`. Done when: events queued offline are sent after reconnect with no duplicates.
- [ ] **P5-02** [MVP] `POST /api/events`: validate the batch, enforce `userId` equals the session user, insert with conflict-ignore on ID. Done when: replaying a batch inserts nothing new.
- [ ] **P5-03** [MVP] Emit events from the session store actions (not from renderers): `lesson_started`, `concept_viewed`, `quiz_presented`, `quiz_answered`, `lesson_completed`, `profile_changed`. Done when: completing the fixture lesson in each of the four renderers produces the same event types and counts. (CE-10)
- [ ] **P5-04** [MVP] Active time tracking: attribute `durationMs` to `concept_viewed`, pausing on tab hide and after 60 seconds idle. Done when: a fake-timer test shows idle time excluded.
- [ ] **P5-05** [MVP] Learner home page: assigned and purchased lessons with progress bars from `concept_mastery`. File: `src/app/learn/page.tsx`. Done when: progress matches mastered over total for the seed user.
- [ ] **P5-06** [MVP] Simple progress comparison page for the demo: the same lesson, each demo learner, progress and mastery side by side, with no layout shown. File: `src/app/teach/lessons/[id]/progress/page.tsx`. Done when: three seeded learners using three renderers appear on one common scale.
- [ ] **P5-07** Parity test: an automated test completes the fixture lesson with identical answers in all four renderers and asserts identical `concept_mastery` rows. Done when: the test passes in CI.

### Phase 6: B2B school portal and dashboards

- [ ] **P6-01** Organization creation flow for principals. File: `src/app/admin/setup/page.tsx`, route `POST /api/orgs`. Done when: creating an org makes the creator its principal. (B2B-1)
- [ ] **P6-02** Email invitations with role, an accept page, and expiry after 7 days. Done when: an invited teacher who accepts gets a `teacher` membership.
- [ ] **P6-03** Classroom create, edit, and archive for teachers. File: `src/app/teach/classrooms/`. Done when: a teacher sees only their own classrooms.
- [ ] **P6-04** Add students by email list, CSV upload with validation and error report, and join code. Done when: all three methods create `enrollments` rows. (B2B-1)
- [ ] **P6-05** Assign a published lesson to classrooms with an optional due date. Route `POST /api/assignments`. Done when: enrolled students see the lesson under Assigned. (B2B-2)
- [ ] **P6-06** Teacher classroom dashboard: student-by-concept mastery grid as an accessible table, with sorting. Reads `v_classroom_student_progress`. File: `src/app/teach/classrooms/[id]/page.tsx`. Done when: the grid matches seed data and is navigable by screen reader table commands. (B2B-3)
- [ ] **P6-07** Teacher dashboard: concepts ranked by error rate, linking to the concept in the review page. Reads `v_classroom_concept_difficulty`. Done when: the hardest seeded concept is listed first.
- [ ] **P6-08** Student detail view for teachers: per-lesson progress, active time, and last activity. Shows the Render Profile only if `share_with_teachers` is true. Done when: a test confirms the profile is absent without opt-in. (B2B-3, B2B-5)
- [ ] **P6-09** Student privacy control: a "Share my settings with my teachers" toggle, off by default, with each change written to `audit_log`. Done when: toggling updates the flag and the log. (B2B-5)
- [ ] **P6-10** Principal dashboard: classroom summary table with completion, average mastery, active learners, and time on task. Reads `v_org_classroom_summary`. File: `src/app/admin/page.tsx`. Done when: it loads in under 2 seconds on a seeded org of 1,000 students. (B2B-4)
- [ ] **P6-11** Principal dashboard filters: grade, subject, teacher, and date range, reflected in the URL. Done when: filters change results and survive reload.
- [ ] **P6-12** Principal dashboard charts (progress over time, engagement by week) with a data table alternative for each chart. Done when: every chart has an equivalent table and a text summary.
- [ ] **P6-13** School-wide layout usage panel from `v_org_layout_usage` with suppression under 5 and an explanatory note. Done when: a group of 4 is displayed as "fewer than 5". (B2B-4)
- [ ] **P6-14** CSV export of aggregated classroom data. Done when: the export matches the on-screen table and contains no layout or profile columns.
- [ ] **P6-15** Organization LLM spend tracking against `monthly_spend_cap_usd` with an alert at 80% and a soft block on new ingestion at 100%. Done when: a test org over cap cannot start ingestion and sees a clear message.
- [ ] **P6-16** Consent and age flow: date of birth collection at student sign-up where required, a guardian consent path for under-13 users, and data export and deletion requests. Done when: an under-13 account is inactive until consent is recorded.
- [ ] **P6-17** End-to-end test: principal creates org, teacher uploads and assigns, three students with different presets complete the lesson, dashboards show all three. Done when: the Playwright test passes.

### Phase 7: B2C creator marketplace

- [ ] **P7-01** Creator enablement: a "Become a creator" action that sets `is_creator` and records the content rights attestation. Done when: the creator area unlocks. (B2C-1)
- [ ] **P7-02** Course builder: title, description, cover image with required alt text, lesson ordering with buttons, preview lesson selection, price. File: `src/app/create/courses/[id]/page.tsx`. Done when: a draft course saves and validates. (B2C-1)
- [ ] **P7-03** Stripe Connect onboarding: create an Express account, redirect to hosted onboarding, handle the return, and update `creator_accounts` from the `account.updated` webhook. Done when: in test mode a creator reaches `onboarding_complete = true`. (B2C-2)
- [ ] **P7-04** Publish gate: a paid course cannot be published until onboarding is complete and all lessons are published. Done when: the API rejects publishing otherwise with a clear reason.
- [ ] **P7-05** Automated moderation check on listing text at publish, plus a report button and a manual review queue page. Done when: a flagged listing stays in draft with a reason.
- [ ] **P7-06** Catalog page with search, topic filter, and price filter, server rendered. File: `src/app/market/page.tsx`. Done when: results are correct for seed data and the page passes axe. (B2C-3)
- [ ] **P7-07** Course page: description, lesson list, creator, price, Try the preview, and Buy. File: `src/app/market/[slug]/page.tsx`. Done when: the preview opens in the lesson player without an account. (B2C-3)
- [ ] **P7-08** Checkout: `POST /api/checkout` creates a hosted Checkout session with the platform fee and destination account. Done when: a test-mode purchase completes. (B2C-4)
- [ ] **P7-09** Webhook handler with signature verification for `checkout.session.completed` and `charge.refunded`, idempotent by event ID. Done when: a paid event sets the purchase to `paid` and a refund sets `refunded` and revokes access. (B2C-4)
- [ ] **P7-10** Buyer library with purchased courses and progress. File: `src/app/market/library/page.tsx`. Done when: a purchased course appears and its lessons open.
- [ ] **P7-11** Creator analytics: revenue over time, enrollments, completion rate, hardest concepts, and aggregate layout usage with suppression under 5. File: `src/app/create/analytics/page.tsx`. Done when: figures match seed data. (B2C-5)
- [ ] **P7-12** Refund flow within 14 days from the library. Done when: a test-mode refund revokes access.
- [ ] **P7-13** End-to-end test: creator publishes a paid course, buyer previews, purchases in test mode, and completes a lesson. Done when: the Playwright test passes.

### Phase 8: Hardening

- [ ] **P8-01** Axe checks in Playwright for every route and each renderer in each theme. Done when: zero serious or critical violations.
- [ ] **P8-02** Write and execute manual screen reader scripts for onboarding, each renderer, upload, review, and dashboards with NVDA and VoiceOver. File: `docs/a11y-test-scripts.md`. Done when: all scripts pass and issues found are fixed or logged in Section 9.2.
- [ ] **P8-03** Keyboard-only end-to-end test covering upload, review, publish, and lesson completion in each renderer. Done when: the test passes with no pointer events.
- [ ] **P8-04** Performance budget tests for the targets in Section 6.1 (profile switch, card advance, first paint). Done when: CI fails if a budget is exceeded.
- [ ] **P8-05** Rate limiting on all LLM-backed and speech endpoints, per user and per IP for anonymous routes. Done when: exceeding the limit returns 429 with a retry time.
- [ ] **P8-06** Cost report: a script that summarizes ingestion and session cost per lesson from logged usage and compares against Section 6.2 targets. Done when: `npm run report:cost` prints a table.
- [ ] **P8-07** Prompt-injection defense for ingestion: treat source text as data, wrap it in delimiters, instruct the model to ignore instructions inside it, and add a fixture with an embedded instruction. Done when: the planted instruction does not alter the output.
- [ ] **P8-08** Graceful degradation tests: with the LLM mocked as failing, a published lesson is still completable in reader and cards. With speech failing, the conversation renderer falls back to text. Done when: both tests pass.
- [ ] **P8-09** Security review of row-level security: an automated test attempts cross-tenant reads on every table as each role. Done when: every attempt is denied.
- [ ] **P8-10** Error tracking and LLM tracing wired to all server routes. Done when: a forced error appears with a request ID and a trace shows model, tokens, latency, and cost.
- [ ] **P8-11** Externalize all UI strings to a messages file. Done when: no user-facing string literal remains in components.
- [ ] **P8-12** Usability sessions with at least one blind screen reader user, one Deaf ASL user, one learner with ADHD, and one dyslexic learner. Record findings in Section 9.3 and create tasks for each issue. Done when: findings are logged.

### Phase 9: Demo and launch

- [ ] **P9-01** [MVP] Choose and add the demo source: a dense 3 to 5 page document on a topic with everyday vocabulary (for example the water cycle). Folder: `src/tests/fixtures/demo/`. Done when: the file is committed.
- [ ] **P9-02** [MVP] Seed script: demo teacher, three demo learners with `hyper_focus`, `voice_native`, and `visual_sign` profiles, and the demo lesson ingested, reviewed, and published with verified sign links. File: `supabase/seed.sql` plus `scripts/seed-demo.ts`. Done when: `npm run seed:demo` produces a ready demo from an empty database.
- [ ] **P9-03** [MVP] Demo mode page: one screen with a learner switcher and the lesson player, so the presenter can change learner without signing out. File: `src/app/demo/page.tsx`. Done when: switching learner swaps profile and keeps each learner's own progress.
- [ ] **P9-04** [MVP] Write the demo script: upload live (with the pre-seeded lesson as backup), show three learners, take one need from the audience in the NeedsBox, finish on the shared progress view. File: `docs/demo-script.md`. Done when: a full run-through takes under 4 minutes.
- [ ] **P9-05** [MVP] Offline safety: cache the demo lesson, its variants, and sign clips so the lesson player works if the network drops. Only the NeedsBox requires the network. Done when: the demo runs with the network disabled after first load.
- [ ] **P9-06** [MVP] Deploy to Vercel with a hosted Supabase project and run the demo script against production. Done when: the full script passes on the deployed URL.
- [ ] **P9-07** Landing page explaining Prism for schools and creators, with honest capability statements. Done when: the page passes axe and makes no claim outside this document.
- [ ] **P9-08** Legal documents: terms, privacy policy, data processing agreement template, and creator terms, reviewed by counsel. Done when: documents are published and linked.
- [ ] **P9-09** School pilot checklist: data agreement signed, accounts provisioned, teacher training session, feedback channel. Done when: one school completes a 4-week pilot.
- [ ] **P9-10** Switch payments from test mode to live after pilot sign-off. Done when: one real purchase and payout complete.

---

## 9. Running Log

### 9.1 Decision log

Add entries as `YYYY-MM-DD: decision, reason, affected sections`.

- 2026-10-05: Profiles are user-chosen settings, not diagnosis-based assignments. Reason: needs do not map cleanly to labels, and disability data is sensitive. Affects 2.3, 5.3, 6.4.
- 2026-10-05: Teacher review is required before publish. Reason: AI extraction is lossy and every renderer inherits its errors. Affects 5.1.
- 2026-10-05: Sign support is human-signed clips for key terms, not generated translation. Reason: automatic sign translation is not reliable and concatenated signs are not grammatical ASL. Affects 2.4, 5.6.4.
- 2026-10-05: Word anchors (leading-letter bolding) are an opt-in toggle, off in all presets. Reason: limited research support. Affects 5.3, 5.6.2.
- 2026-10-05: Teachers and principals do not see individual Render Profiles without opt-in, and layout usage is shown only in suppressed aggregates. Reason: the interface a student uses can reveal a disability. Affects 4.2, 5.8, 6.4.
- 2026-10-05: A Deaf student persona was added to the six requested personas. Reason: the demo includes a Deaf learner with ASL support.
- 2026-10-06: Both `@langchain/anthropic` and `@langchain/openai` are installed, and `LLM_PROVIDER` selects between them. Reason: the production provider is an open question (9.3) and the PRD asks for a provider package behind one gateway. Affects 7.2, P0-03.
- 2026-10-06: Latest stable majors at install time are used as-is: Next.js 16, React 19, Zod 4, Tailwind 4. Schemas keep the exact shapes in 5.2, 5.3, and 5.7; only the Zod API surface differs from older majors. Affects 0.2, 7.2.
- 2026-10-06: `KnowledgeGraph` is the PRD 5.2 object plus a refinement for referential integrity (unique ids, section and concept references, prerequisite existence, no cycles, MCQ and true/false answer rules); the plain object is exported as `KnowledgeGraphBase`. Reason: P1-01 requires the schema itself to reject a dangling quiz reference, and P2-07 reuses the same checks. Affects 5.2, P1-01, P2-07.
- 2026-10-06: Migrations and SQL tests run in-process on PGlite (real Postgres compiled to WASM) behind a shim of Supabase's roles, `auth` and `storage` schemas, `auth.uid()`, and default privileges (`src/tests/sql/harness.ts`). Reason: this machine has no Docker, so `supabase db reset` cannot run. Migrations are plain SQL applied in filename order, so they should behave the same under `supabase db reset`; that run is still owed once Docker or a hosted project is available (9.2). Affects P1-04 to P1-15.
- 2026-10-06: Composite keys `(lesson_id, id)` on `concepts` and `quiz_items`, and `lesson_id` columns on `concept_variants` and `concept_sign_links`. Reason: concept and quiz ids are graph-local text ids, and row-level security needs the lesson to decide access. Affects 7.4.
- 2026-10-06: `radix-ui` (the unified package) is used instead of individual `@radix-ui/react-*` packages. Reason: it is the current distribution and tree-shakes the same. Affects 7.2.

### 9.2 Blockers

Add entries as `YYYY-MM-DD: task ID, what is blocked, what was stubbed`.

- 2026-10-06: P1-04 to P1-15, SQL is verified on PGlite, not by `supabase db reset` (see 9.1). Run `npx supabase db reset` once Docker is available and fix any difference.
- 2026-10-06: P0-05, no Docker, WSL, or local Postgres on the development machine, so `supabase start` cannot run and a server component cannot be pointed at a live database yet. Implemented `src/lib/supabase/client.ts` and `server.ts` against the real `@supabase/ssr` API. Task left unchecked until a hosted Supabase project (or Docker) is available. Phase 1 SQL is verified in-process with PGlite instead; see 9.1.

### 9.3 Open questions and findings

- Which LLM, STT, and TTS providers to use in production. Decide in P4-24 and P8-06 using measured latency and cost.
- Source and license for ASL clips. Preferred: clips recorded for Prism by a fluent Deaf signer. Research datasets may restrict commercial use.
- Legal review for FERPA, COPPA, GDPR, and NDPA before any school pilot (P9-08).
- Platform fee percentage. `PLATFORM_FEE_BPS=1500` is a placeholder.
- Whether short-answer grading by LLM is acceptable for graded school assessments or should be limited to practice quizzes.
- Demo lesson key terms with no ASL clip (to be fingerspelled): list here during P4-25.
