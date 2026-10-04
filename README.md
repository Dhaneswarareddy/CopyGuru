# Visual Q&A Sessions

A real-time collaborative platform. People join a temporary session, post a picture with their answer, and the session
recognises when two pictures show the **same content even though they are different photographs**. The second person
is shown the earlier answer and can agree, keep their own answer, or **challenge** it — which notifies everyone live.

- Semantic image matching with a real vision model (OpenAI CLIP, run locally through ONNX — no API key)
- PostgreSQL + pgvector for embeddings and session-scoped similarity search
- Socket.IO for live updates and private notifications
- Next.js (App Router) + React + TypeScript + Tailwind

## Contents

1. [Quick start](#quick-start)
2. [Demo mode](#demo-mode)
3. [How matching works](#how-matching-works)
4. [Architecture](#architecture)
5. [Project structure](#project-structure)
6. [Database schema](#database-schema)
7. [API](#api)
8. [Realtime events](#realtime-events)
9. [Environment variables](#environment-variables)
10. [Testing](#testing)
11. [Deployment](#deployment)
12. [Extending the platform](#extending-the-platform)
13. [Known limitations](#known-limitations)
14. [Recommended next features](#recommended-next-features)

## Quick start

Requires Node.js 22+ (developed on 24). Nothing else: without `DATABASE_URL` the app runs an embedded PostgreSQL
(PGlite + pgvector) in `./.data`.

```bash
npm install
npm run dev            # http://localhost:3000
```

The first start downloads the CLIP model (~90 MB) into `./.cache/models`. Production mode:

```bash
npm run build && npm run start
```

To use a real PostgreSQL instead (the `vector` extension must be installable):

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/vqa npm run dev
```

Migrations run automatically at startup.

## Demo mode

The home page has **Create demo session** (shown when `DEMO_MODE=true`, the default). It creates a started session
with a host, three participants and three questions already posted through the real matching pipeline, then shows
**Open as Host / Participant A / B / C**. Each button opens that identity in its own window, so the whole flow can be
shown on one machine.

Demo sessions add a **Sample photos** picker to the Play tab. Suggested script:

1. Open as *Participant B* → Play → Sample photos → "Dog (another photo)" → answer `Labrador` → Post.
2. The app says the question already exists and shows Participant A's answer, `Golden Retriever`.
3. Choose **Challenge this answer**. Watch the other windows: a notification appears, Question #1 turns *Challenged*.
4. Open as *Participant C* → Questions → Question #1 → support a side or submit an answer. Consensus updates everywhere.
5. Open as *Host* → Host tab for the dashboard; open the question to resolve the challenge.

There are no accounts or passwords. Joining issues a random token kept in the browser; demo links carry it in the URL
fragment.

## How matching works

```
upload → validate & normalise (sharp) → CLIP ViT-B/32 embedding (512-d, unit length)
       → pgvector cosine search, this session only, top K
       → best score per question group → HIGH | POSSIBLE | NO match
```

| Decision | Cosine similarity | What happens |
| --- | --- | --- |
| `HIGH_MATCH` | ≥ 0.86 | Image and answer join the existing question. The participant sees the previous answer and chooses Agree / Challenge / Keep. |
| `POSSIBLE_MATCH` | 0.66 – 0.86 | Nothing is grouped. The participant is shown both images and asked "same question?" |
| `NO_MATCH` | < 0.66 | A new question group is created. |
| model failure | – | Nothing is grouped. The participant chooses Try again / Create new question. |

The thresholds were calibrated on real photographs (`npm run calibrate` prints every pair):

| Pair | Similarity | Decision |
| --- | --- | --- |
| Three different photos of a golden retriever | 0.91 – 0.94 | HIGH |
| Same photo cropped / darkened / mirrored+tilted / re-encoded | 0.89 – 0.96 | HIGH |
| Two photos of the Golden Gate Bridge | 0.88 | HIGH |
| Golden retriever vs labrador, apple vs tomato, adult vs puppy | 0.70 – 0.84 | POSSIBLE (asks) |
| Dog vs tower, apple vs cat, bridge vs dog … | 0.38 – 0.65 | NO |
| Loosely related scenes (bridge vs tower, cat vs dog) | up to 0.70 | a few cross into POSSIBLE (asks) |

A group is scored by its best-matching member, and every submitted image stays in the group, so groups become easier
to hit as they collect more varied photos.

Matching a submission is serialised per session (a transaction-level advisory lock), so two people posting the same
new content at the same moment produce one question, not two.

## Architecture

```
Browser (React)
  │  REST (Bearer token)                 │  Socket.IO (same token)
  ▼                                      ▼
src/app/api/**  — thin route handlers    src/lib/realtime/socketServer.ts
  │  auth, parsing, error mapping          rooms: session:<id>, participant:<id>
  ▼                                      ▲
src/services/**  — business logic        │ emits
  sessions · submissions · questions     │
  challenges · notifications · demo      │
  │              │                       │
  │              └── publishes ──► src/lib/events (EventBus)
  │                                  ├─ event log      → session_events
  │                                  ├─ notifications  → notifications + private socket push
  │                                  └─ realtime       → small "something changed" broadcast
  ▼
src/lib/database/repositories/**  — all SQL
  ▼
PostgreSQL + pgvector   (pg driver, or embedded PGlite)

Ports with swappable implementations:
  ImageEmbedder / ImageSimilarityService   CLIP today
  AnswerMatchingService                    rule-based normalisation today
  StorageService                           disk or Postgres blobs today
  RealtimeGateway                          Socket.IO today
  RepresentativeImageStrategy              first image today
```

Design decisions worth knowing:

- **One process, one port.** `server.ts` runs Next.js and Socket.IO on the same HTTP server, so the app deploys as a
  single service. (Serverless platforms such as Vercel cannot hold WebSocket connections or the in-memory model.)
- **`src/lib/container.ts` is the composition root.** Every service gets its dependencies there; tests pass overrides.
- **Realtime broadcasts carry no content.** The session room only hears `{type, questionId}`; clients then re-fetch
  through the API, where what a viewer may see (answers, names, consensus) is decided per viewer in one place
  (`services/questions/visibility.ts`). Notifications are composed per recipient for the same reason.
- **Answers are immutable.** One answer per participant per question (unique constraint). Agreeing, challenging or a
  host resolution only record a *relationship*; `raw_answer` is never updated.
- **Consensus is agreement, not correctness.** An answer marked "agrees" counts for the answer it endorsed
  (`effective_normalized`) while its own text stays visible.
- **Permissions are centralised** in `src/lib/permissions/permissions.ts` (role → permissions, plus policies derived
  from session settings). Nothing else checks roles.
- **Session settings are declarative** (`src/lib/domain/settings.ts`). The create form renders from that schema and
  the server validates against it.

## Project structure

```
server.ts                      custom server: Next.js + Socket.IO
src/
  app/
    page.tsx                   home: join / host / demo
    s/[code]/page.tsx          the session
    api/                       REST route handlers (thin)
  components/
    home/ session/ participants/ submissions/ questions/ challenges/ notifications/ host/ ui/
  services/
    imageSimilarity/           ImageSimilarityService, CLIP embedder, 3-state matcher
    imageProcessing/           validation, EXIF, resize, thumbnails
    answerMatching/            normalize + compare
    consensus/                 consensus calculation and levels
    sessions/ submissions/ questions/ challenges/ notifications/ demo/
    storage/                   disk and database drivers
    realtime/                  browser socket hook
  lib/
    config.ts                  all environment-driven configuration
    container.ts               dependency wiring
    database/                  client (pg | PGlite), migrations, repositories
    auth/                      tokens, session codes, signed image URLs
    permissions/               Permission enum, roles, policies
    events/                    event types, bus, subscribers
    realtime/                  gateway port, Socket.IO server
    http/                      route wrapper, errors, rate limiting
    domain/                    shared types, settings schema, API view types
    client/                    browser API client and token store
tests/
  unit/ integration/           fast tests (stub embedder; PGlite or real Postgres)
  matching/                    REAL CLIP on real photos
  fixtures/images/             test photos + ATTRIBUTION.json
scripts/
  e2e-acceptance.ts            acceptance scenario over HTTP + WebSocket, against any URL
  ui-walkthrough.ts            Playwright: three simultaneous browser users
  calibrate.ts                 similarity table for a folder of images
  download-model.ts            pre-fetch the model (used in builds)
```

## Database schema

Defined in `src/lib/database/migrations.ts` (append-only migrations, tracked in `schema_migrations`).

| Table | Purpose | Notable columns / constraints |
| --- | --- | --- |
| `users` | A person (guest identity) | `display_name` |
| `sessions` | A session | `code` unique, `status` WAITING/ACTIVE/ENDED, `settings` jsonb, `question_seq` |
| `session_participants` | Membership + role | `role`, `token_hash` unique, unique `(session_id, lower(display_name))`, `removed_at` / `removed_by` |
| `session_questions` | A question / content group | `number` unique per session, `content_type`, `representative_image_id`, `original_answer_id`, cached `answer_count`, `consensus_pct`, `consensus` jsonb, `challenge_count`, `status` |
| `question_images` | Every submitted image | `question_id` (null until placed), storage keys, `embedding vector(512)`, `embedding_model`; HNSW cosine index; btree `(session_id, question_id)` |
| `submissions` | One upload event | `match_decision`, `similarity_score`, `candidate_question_id`, `user_confirmed_match`, `raw_answer`, `status` |
| `answers` | A participant's answer to a question | `raw_answer`, `normalized_answer`, `effective_normalized`, `value` jsonb, `relationship`, `endorsed_answer_id`, unique `(question_id, participant_id)` |
| `challenges` | A challenge | `original_answer_id`, `challenger_answer_id`, `reason`, `status` OPEN/DISCUSSION/RESOLVED/DISMISSED, `resolution`, unique `(question_id, challenger_id)` |
| `challenge_responses` | A vote on a challenge | `stance` ORIGINAL/CHALLENGE/OTHER, unique `(challenge_id, participant_id)` |
| `join_requests` | "Ask to join" from the public list | `display_name`, `token_hash` unique, `status` PENDING/APPROVED/DECLINED/CANCELLED, `participant_id`, `decided_by`, `last_seen_at` |
| `chat_messages` | Chat | `sender_id`, `recipient_id` (null = public, otherwise private to that participant), `body` |
| `chat_reads` | How far each participant has read each conversation | primary key `(participant_id, channel)`, `last_read_id` |
| `notifications` | Per-recipient notification | `type`, `title`, `data` jsonb, `read_at` |
| `session_events` | Append-only audit log | `type`, `actor_id`, `question_id`, `payload` jsonb |
| `stored_blobs` | Image bytes for the `database` storage driver | `key`, `mime`, `data` |

All child tables reference their parent with foreign keys (`ON DELETE CASCADE` from the session down).

Challenge lifecycle (`services/challenges/stateMachine.ts`):

```
OPEN ──first response──▶ DISCUSSION ──▶ RESOLVED (ORIGINAL_ACCEPTED | CHALLENGE_ACCEPTED | BOTH_VALID | UNRESOLVED)
  └───────────────────────────┴───────▶ DISMISSED
```

## API

All endpoints return JSON. Errors are `{ "error": { "code", "message" } }` with a matching HTTP status.
Authenticated endpoints need `Authorization: Bearer <token>` (the token returned by create/join).
`:id` for sessions accepts the session code or its UUID.

| Method & path | Auth | Body | Result |
| --- | --- | --- | --- |
| `GET /api/health` | – | | `{ ok, database, similarityModel }` |
| `GET /api/sessions` | – | | `{ items }`: listed, ongoing sessions (id, name, host name, counts; never the code) |
| `POST /api/sessions/:id/join-requests` | – | `{ displayName }` (`:id` = public id from the list, or the code when the host approves everyone) | `{ requestId, token, sessionName }` |
| `GET /api/join-requests/me` | request token | | `{ status, sessionName, code }` (`code` only once approved) |
| `DELETE /api/join-requests/me` | request token | | cancels the request |
| `GET /api/sessions/:id/join-requests` | host | | `{ items }`: people currently waiting |
| `POST /api/join-requests/:id/decision` | host | `{ decision: APPROVE \| DECLINE }` | `{ items }`: who is still waiting |
| `POST /api/sessions` | – | `{ name, hostName, settings? }` | `{ session, participantId, token }` |
| `POST /api/sessions/demo` | – | | `{ code, identities[{name, role, token}], seeded }` |
| `POST /api/sessions/:id/join` | – | `{ displayName }` | `{ session, participantId, token }` |
| `GET /api/sessions/:id` | member | | session state: session, me, participants, caps, pending submission |
| `POST /api/sessions/:id/start` | host | | `{ session }` |
| `POST /api/sessions/:id/settings` | host | `{ settings }` (any subset) | `{ session }` |
| `POST /api/sessions/:id/participants/:participantId/remove` | host | | `{ participants }` |
| `GET /api/sessions/:id/export` | host | | CSV file of every answer |
| `POST /api/sessions/:id/end` | host | | `{ session }` |
| `POST /api/sessions/:id/submissions` | member | multipart: `image`, `answer`, `source?` | `SubmissionResult` (below) |
| `GET /api/sessions/:id/questions` | member | query: `filter`, `sort`, `search`, `limit`, `offset` | `{ items, total, filters, sorts, … }` |
| `GET /api/sessions/:id/notifications` | member | | `{ items, unread }` |
| `POST /api/sessions/:id/notifications` | member | `{ ids? }` (omit = all) | `{ unread }` |
| `GET /api/sessions/:id/dashboard` | host | | stats, question overview, activity |
| `POST /api/submissions/:id/resolve` | owner | `{ action: USE_EXISTING \| CREATE_NEW \| RETRY }` | `SubmissionResult` |
| `POST /api/submissions/:id/decision` | owner | `{ decision: AGREE \| CHALLENGE \| KEEP, reason? }` | `SubmissionResult` |
| `GET /api/questions/:id` | member | | question detail: images, answers, challenges, history (host) |
| `POST /api/questions/:id/answers` | member | `{ answer }` | question detail |
| `POST /api/questions/:id/challenges` | member | `{ reason?, answer? }` | question detail |
| `POST /api/challenges/:id/respond` | member | `{ stance: ORIGINAL \| CHALLENGE \| OTHER, answer?, comment? }` | question detail |
| `POST /api/challenges/:id/resolve` | host | `{ outcome: ORIGINAL_ACCEPTED \| CHALLENGE_ACCEPTED \| BOTH_VALID \| UNRESOLVED \| DISMISSED, note? }` | question detail |
| `GET /api/sessions/:id/chat` | member | | `{ enabled, privateEnabled, canSend, publicUnread, direct[{participantId, unread}] }` |
| `GET /api/sessions/:id/chat/messages` | member | query: `with=public\|<participantId>`, `before`, `limit` | `{ items, hasMore }`, oldest first |
| `POST /api/sessions/:id/chat/messages` | member | `{ to: "public" \| participantId, text }` | the message |
| `POST /api/sessions/:id/chat/read` | member | `{ channel, lastId }` | chat overview |
| `GET /api/images/:id?v=thumb\|display&sig=…` | signed URL | | image bytes (WebP) |

`SubmissionResult.outcome` is one of:

- `NEW_QUESTION` – a new question group was created
- `MATCHED` – joined an existing question; `prompt` has the previous answer and whether a decision is needed
- `POSSIBLE_MATCH` – uncertain; call `/resolve` with `USE_EXISTING` or `CREATE_NEW`
- `SIMILARITY_UNAVAILABLE` – the model failed; call `/resolve` with `RETRY` or `CREATE_NEW`
- `ALREADY_ANSWERED` – the image joined a question this participant had already answered

Filters: `ALL`, `UNANSWERED`, `ANSWERED` (both relative to the viewer), `CHALLENGED`, `RESOLVED`, `HIGH_CONSENSUS`,
`LOW_CONSENSUS`. Sorts: `NEWEST`, `MOST_ANSWERS`, `MOST_CHALLENGED`, `HIGHEST_CONSENSUS`, `LOWEST_CONSENSUS`.
The response lists the filters and sorts the viewer may use; the UI renders whatever the server offers.

## Realtime events

Connect with Socket.IO to the same origin: `io({ auth: { token } })`.

- `session:event` → `{ type, questionId, data, at }`, sent to everyone in the session. `type` is a domain event
  (`SESSION_CREATED`, `PARTICIPANT_JOINED`, `SESSION_STARTED`, `IMAGE_SUBMITTED`, `QUESTION_MATCHED`,
  `QUESTION_CREATED`, `ANSWER_SUBMITTED`, `ANSWER_RELATIONSHIP_SET`, `ANSWER_CHALLENGED`, `CHALLENGE_CREATED`,
  `CHALLENGE_RESPONSE_ADDED`, `CONSENSUS_UPDATED`, `CHALLENGE_RESOLVED`, `SESSION_ENDED`, `JOIN_REQUESTED`,
  `JOIN_REQUEST_APPROVED`, `JOIN_REQUEST_DECLINED`, `JOIN_REQUEST_CANCELLED`, `PARTICIPANT_REMOVED`,
  `SESSION_SETTINGS_UPDATED`) or `PRESENCE_CHANGED`.
- `session:removed` → sent to a participant the host removed, just before their connection is closed.
- `notification` → a notification object, sent only to its recipient.
- `chat:message` → a chat message. Public messages go to everyone in the session; a private message goes only to
  its sender and its recipient.

## Public session list and "ask to join"

The home page shows **Happening now**: sessions that are running and open to requests. A visitor clicks
**Ask to join**, gives a name, and waits; the host sees them at the top of the session and chooses **Admit** or
**Decline**. An admitted visitor is moved into the session automatically.

- A session is listed when its **Show on the home page** setting is on (the default for new sessions), it has not
  ended, it was created in the last 24 hours, it is not a demo session, and someone who can admit is connected.
- The list shows the session name, the host's name and how many people are in it. It never shows the code.
- Joining with the code is unchanged and needs no approval: having the code is the invitation.
- When a visitor asks, they are handed the token they will use if admitted. Until a host approves, that token
  opens nothing; approval creates the participant with that token's hash, so no secret is sent a second time.
- The waiting page polls every 2.5 seconds, which also tells the host the visitor is still there. Visitors who
  close the page drop out of the host's list after 30 seconds. A refresh keeps the visitor in the queue.
- Only roles with `ADMIT_PARTICIPANTS` (host, moderator, admin) see or decide requests. Other participants only
  see the new person appear once admitted.

## Getting around

The 🏠 button in the session header opens the home page. That does not leave the session: the home page shows
**Your sessions** with a **Back to session** button for every session this browser is still a member of (kept for
24 hours, and dropped when the session ends or access is lost).

## Host controls

- **Remove a participant** — in the participant list (the `3/4` button in the header, or the waiting room), the
  host gets **Remove** next to each person, with a confirmation. The person is disconnected at once and shown
  "You were removed from this session"; their token stops working. What they already contributed (answers, images,
  challenges, votes) stays on record, and their name cannot be reused. The host cannot be removed.
- **Approve everyone who joins** — a setting (off by default). When on, even people with the code wait for the
  host to admit them, through the same request flow as the public list. Guests have no account, so this is what
  stops a removed person from coming straight back under another name.
- **Change settings while the session runs** — Host tab → *Edit settings*. Changes apply to everyone immediately
  (for example turning chat off, or taking the session off the home page).
- **Export results** — Host tab → *Download results (CSV)*: one row per answer with its question, participant,
  relationship, what it agreed with, and the question's consensus. Cells that look like spreadsheet formulas are
  neutralised.
- **Invite card** — the waiting room and Host tab show the join link, a copy button and a QR code.

## Appearance

Light and dark themes, switched with the ☀️/🌙 button (top right of the home page and the session header). The
choice is remembered per browser; until someone chooses, the device's preference is followed.

Theming is done by re-pointing the palette rather than by per-component dark classes: `src/app/globals.css`
defines the colour scales as CSS variables and a `.dark` block swaps what they mean. Components keep using the
same utilities. Three rules keep that working, noted at the top of that file: text on a coloured fill uses
`text-onaccent`, solid brand fills use `bg-accent` or the gradients, and anything that must stay dark in both
themes uses black.

## Chat

Every session has a chat panel (💬 in the header), available from the waiting room onwards:

- **Everyone** — a public channel all members of the session can read.
- **Private messages** — one-to-one conversations, chosen with the "To" selector or the "Message" action in the
  participant list. A private message is stored with its recipient, delivered only to the two participants' own
  socket rooms, and returned by the API only to those two. The host cannot read it, and chat never enters the
  event log or the host dashboard (which is why `ChatService` talks to the realtime gateway directly instead of
  publishing on the event bus).

Two session settings control it: **Chat** (off = no chat at all) and **Private messages** (off = public only).
Unread counts are kept on the server (`chat_reads`), so badges survive a refresh. When a session ends, chat becomes
read-only. Messages are limited to 1,000 characters and 30 per 10 seconds per participant.

## Environment variables

See `.env.example` for the full list with comments.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_SECRET` | dev value | **Set in production.** Signs image URLs. |
| `DATABASE_URL` | unset | PostgreSQL with pgvector. Unset → embedded PGlite at `PGLITE_DIR`. |
| `PGLITE_DIR` | `./.data/pglite` | Embedded database location. |
| `STORAGE_DRIVER` | `disk` | `disk` (`STORAGE_DIR`) or `database` (blobs in Postgres). |
| `IMAGE_MAX_BYTES` | 10 MB | Upload limit. |
| `IMAGE_KEEP_ORIGINAL` | `false` | Also store the untouched upload. |
| `SIMILARITY_MODEL` / `SIMILARITY_DTYPE` | `Xenova/clip-vit-base-patch32` / `q8` | Embedding model and precision. |
| `SIMILARITY_HIGH_THRESHOLD` / `SIMILARITY_POSSIBLE_THRESHOLD` | `0.86` / `0.66` | Match thresholds. |
| `CONSENSUS_HIGH` / `_MODERATE` / `_LOW` | `75` / `50` / `25` | Consensus level thresholds (percent). |
| `DEMO_MODE` | `true` | Show the demo launcher. |
| `PORT` | `3000` | HTTP port. |

## Testing

```bash
npm test                 # everything below except the two scripts (97 tests)
npm run test:unit        # unit + integration, stub embedder, a few seconds
npm run test:matching    # the real CLIP model on real photographs
npm run typecheck
```

Against a running server (local or deployed):

```bash
BASE_URL=http://localhost:3000 npm run test:e2e   # acceptance scenario: 4 users over HTTP + WebSocket
BASE_URL=http://localhost:3000 npm run test:ui    # Playwright: 3 browser users (npx playwright install chromium)
```

Run the same test suite on a real PostgreSQL instead of the embedded one:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/postgres npm test
```

What is covered:

- **Image matching (real model):** identical image, different photo of the same subject, cropped, different angle,
  different lighting, unrelated, ambiguous look-alikes; no pair of different-subject fixtures is auto-grouped.
- **Grouping:** new / high / uncertain (both choices) / no match, session scoping, matching via any group member,
  simultaneous uploads, similarity failure → retry / create new.
- **Answers:** normalisation, consensus thresholds, raw answers preserved on agree / keep / challenge / resolve.
- **Challenges:** create, notify, respond, duplicate votes, parties cannot vote, resolve, dismiss, invalid transitions.
- **Realtime:** real Socket.IO server with several clients; private notifications; nothing leaks across sessions.
- **Joining from the list:** what is listed and what is not, admit, decline, cancel, abandoned requests, permissions,
  double-click safety, the token working only after approval.
- **Host controls:** removing a participant (access cut, contributions kept, limits on who can be removed), live
  settings, approve-all joins, CSV export and its escaping.
- **Chat:** public delivery and ordering, unread counts, paging, private messages visible only to their two
  participants (not the host, not the event log), settings, read-only after the session ends.
- **Security:** invalid codes and tokens, cross-session access, role violations, disguised/oversized/bomb uploads,
  EXIF stripping, answer visibility modes, anonymous mode.

The integration tests replace the vision model with a deterministic stub so application logic can be tested in
milliseconds. That stub is test-only; `tests/matching` and both scripts use the real model.

## Deployment

The app is one long-running Node process that needs **about 1 GB of RAM** (the CLIP model is loaded in-process) and
WebSocket support. That rules out serverless hosts; any container or VM host works. Two ready-made setups:

### Render (no Docker)

`render.yaml` describes a Node web service plus managed PostgreSQL; images are stored in the database, so nothing
needs a disk.

1. Push this repository to GitHub.
2. Render → New → Blueprint → select the repository → Apply.
3. When it is live: `BASE_URL=https://<your-app>.onrender.com npm run test:e2e`.

### Fly.io (Docker, embedded database on a volume)

```bash
fly launch --copy-config --no-deploy
fly volumes create data --size 1
fly secrets set APP_SECRET=$(openssl rand -hex 32)
fly deploy
```

To use managed Postgres instead, set `DATABASE_URL` and `STORAGE_DRIVER=database` as secrets.

### Temporary public link (no account)

Exposes a server running on your own machine through a Cloudflare quick tunnel. Good for a demo; it ends when the
machine sleeps or the tunnel process stops, and the URL changes each time.

```bash
echo "APP_SECRET=$(openssl rand -hex 32)" > .env.local     # once
npm run build && HOSTNAME_BIND=127.0.0.1 npm run start
cloudflared tunnel --url http://127.0.0.1:3000             # prints the https URL
```

`./site.sh` wraps exactly this on a Mac: `./site.sh start` (site + public link), `./site.sh start --local`
(no public link), `./site.sh stop`, `./site.sh status`, `./site.sh restart` (rebuilds first).

### Anywhere else

```bash
npm ci && npm run build && npm run model:download
APP_SECRET=… DATABASE_URL=… STORAGE_DRIVER=database npm run start
```

Put it behind HTTPS with WebSocket upgrade enabled. Health check: `GET /api/health`.

**Run a single instance.** The event bus, presence and rate limiter are in-process. See limitations for what scaling
out needs.

## Extending the platform

| To add… | Do this |
| --- | --- |
| Another vision model | Implement `ImageEmbedder`, register it in `services/imageSimilarity/index.ts`, set `SIMILARITY_PROVIDER`. A different vector size needs a migration of `question_images.embedding`. |
| Smarter answer matching (synonyms, AI) | Implement `AnswerMatchingService` and pass it in `container.ts`. |
| S3 / R2 storage | Implement `StorageService`, add it to `createStorage`. |
| A role | Add it to `ROLE_PERMISSIONS`. |
| A permission or setting-based rule | Add to the `Permission` enum / `POLICIES`. |
| A session setting | Add one entry to `SESSION_SETTINGS_SCHEMA`; the form and validation follow. |
| A Questions-tab filter or sort | Add an entry to `QUESTION_FILTERS` / `QUESTION_SORTS`; the UI picks it up from the API. |
| An image input method | Add an entry to `IMAGE_SOURCES` in `components/submissions/ImageInput.tsx`. |
| A feature that reacts to activity (leaderboard, analytics, webhooks, timers) | Subscribe to the `EventBus` in `lib/events/subscribers`; core services stay untouched. |
| A notification | Add a builder in `NotificationService.builders`. |
| Text / audio / video questions, other answer types | `session_questions.content_type` + `content` and `answers.answer_type` + `value` already carry a type and a JSON payload; add the input UI and a matcher for the new content type. |
| Another representative-image rule | Implement `RepresentativeImageStrategy`. |

## Known limitations

- **Semantic similarity is not identity.** CLIP groups by what a picture shows. Very different shots of the same
  thing (the Eiffel Tower by day, at night, reflected in water: 0.67 – 0.79) land in the "uncertain" band and ask the
  participant rather than grouping automatically. Look-alikes (labrador vs golden retriever) are asked about too,
  and so are a few merely related scenes (a cat vs a dog, a bridge vs a tower score up to 0.70). In the other
  direction, two quite different photos of the same kind of thing can score below 0.66 and start separate questions.
  In the calibration set no different-subject pair reached the automatic-grouping threshold.
  Photos of text-heavy content (worksheets, slides) are matched by overall appearance, not by reading the text; OCR
  would help there.
- **Thresholds are calibrated on a small photo set.** Tune them for your content with `npm run calibrate`.
- **Single instance.** Events, presence and rate limiting live in process memory. Scaling out needs the Socket.IO
  Redis adapter and a shared bus.
- **Guest identity only.** A participant is whoever holds the token in that browser. Clearing storage means joining
  again under a new name. There are no accounts, so a removed person cannot be banned as such: with "Approve
  everyone who joins" on they must get past the host again, but the host only sees whatever name they type.
- **Answers cannot be edited or withdrawn**, by design, and there is one answer per participant per question.
- **A challenge always targets the question's original (first) answer.**
- **Images that could not be embedded** (model failure followed by "Create new question") are stored without an
  embedding, so later uploads cannot match them.
- **Listing is on by default.** Anyone who can open the site sees the names of listed sessions and their hosts.
  Hosts can turn it off per session; there is no site-wide switch yet. A declined visitor can ask again (requests
  are rate-limited per address, but there is no block list).
- **Chat is text only and unmoderated.** There is no voice or video, no editing or deleting of messages, no
  blocking or muting, and no per-message moderation; the host can turn chat or private messages off (at any time)
  or remove a participant. Chat also lets participants tell each other their answers, regardless of the answer
  visibility setting. Private messages are stored unencrypted in the database, so whoever operates the server can
  read them.
- **No data retention job.** Ended sessions and their images stay until deleted from the database.
- **The Dockerfile, `fly.toml` and `render.yaml` have not been built or deployed** (no Docker or cloud credentials
  were available where this was developed). What was tested is the plain Node start path they wrap, locally and
  through a public Cloudflare tunnel, on both the embedded database and a real PostgreSQL 17 + pgvector.
- HEIC uploads are not accepted (phone browsers normally convert camera photos to JPEG).

## Recommended next features

1. OCR + text embeddings alongside CLIP, for worksheet and slide questions.
2. Background re-embedding for images stored without an embedding, and periodic re-clustering of "uncertain" groups.
3. Host tools: merge or split question groups, pick the representative image, remove a participant, edit settings live.
4. Export results (CSV / JSON) and a session summary.
5. Accounts (or magic links) so identity survives across devices.
6. Redis adapter + shared event bus for multiple instances; object storage driver.
7. Host-supplied questions and timers; multiple-choice and numeric answer types.
8. Semantic answer matching ("NYC" = "New York City").

## Image credits

Test and demo photos are from Wikimedia Commons under free licences; see `tests/fixtures/images/ATTRIBUTION.json`.
