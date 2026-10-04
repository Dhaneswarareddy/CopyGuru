import { EMBEDDING_DIMENSIONS } from '@/lib/config';
import type { Db } from './client';

/**
 * Ordered, append-only migrations. Never edit an applied migration; add a new
 * one. Applied ids are tracked in `schema_migrations`.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','ACTIVE','ENDED')),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  host_user_id  uuid NOT NULL REFERENCES users(id),
  question_seq  integer NOT NULL DEFAULT 0,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  ended_at      timestamptz
);

CREATE TABLE session_participants (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'PARTICIPANT',
  token_hash    text NOT NULL UNIQUE,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  UNIQUE (session_id, user_id)
);
CREATE UNIQUE INDEX session_participants_name_uq ON session_participants (session_id, lower(display_name));

CREATE TABLE session_questions (
  id                       uuid PRIMARY KEY,
  session_id               uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  number                   integer NOT NULL,
  content_type             text NOT NULL DEFAULT 'IMAGE',
  content                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  representative_image_id  uuid,
  original_answer_id       uuid,
  created_by               uuid REFERENCES session_participants(id) ON DELETE SET NULL,
  -- denormalised read model, maintained by QuestionService.recompute()
  answer_count             integer NOT NULL DEFAULT 0,
  image_count              integer NOT NULL DEFAULT 0,
  consensus_pct            real,
  consensus_level          text NOT NULL DEFAULT 'NONE',
  consensus                jsonb,
  challenge_count          integer NOT NULL DEFAULT 0,
  open_challenge_count     integer NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CHALLENGED','RESOLVED')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_activity_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, number)
);
CREATE INDEX session_questions_activity_idx ON session_questions (session_id, last_activity_at DESC);

CREATE TABLE question_images (
  id               uuid PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id      uuid REFERENCES session_questions(id) ON DELETE CASCADE,
  participant_id   uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  display_key      text NOT NULL,
  thumb_key        text NOT NULL,
  original_key     text,
  width            integer NOT NULL,
  height           integer NOT NULL,
  bytes            integer NOT NULL,
  sha256           text NOT NULL,
  embedding        vector(${EMBEDDING_DIMENSIONS}),
  embedding_model  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- session-scoped lookups; the planner filters by session first
CREATE INDEX question_images_session_idx ON question_images (session_id, question_id);
-- approximate nearest neighbour index for larger deployments
CREATE INDEX question_images_embedding_idx ON question_images USING hnsw (embedding vector_cosine_ops);

CREATE TABLE submissions (
  id                     uuid PRIMARY KEY,
  session_id             uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id         uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  image_id               uuid NOT NULL REFERENCES question_images(id) ON DELETE CASCADE,
  question_id            uuid REFERENCES session_questions(id) ON DELETE CASCADE,
  candidate_question_id  uuid REFERENCES session_questions(id) ON DELETE SET NULL,
  status                 text NOT NULL CHECK (status IN ('COMPLETED','PENDING_CONFIRMATION','SIMILARITY_FAILED')),
  match_decision         text NOT NULL CHECK (match_decision IN ('HIGH_MATCH','POSSIBLE_MATCH','NO_MATCH','UNKNOWN')),
  similarity_score       real,
  user_confirmed_match   boolean,
  raw_answer             text NOT NULL,
  answer_type            text NOT NULL DEFAULT 'TEXT',
  source                 text NOT NULL DEFAULT 'upload',
  created_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz
);
CREATE INDEX submissions_participant_idx ON submissions (participant_id, created_at DESC);
CREATE INDEX submissions_question_idx ON submissions (question_id);

CREATE TABLE answers (
  id                    uuid PRIMARY KEY,
  session_id            uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id           uuid NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
  participant_id        uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  submission_id         uuid REFERENCES submissions(id) ON DELETE SET NULL,
  answer_type           text NOT NULL DEFAULT 'TEXT',
  raw_answer            text NOT NULL,
  normalized_answer     text NOT NULL,
  effective_normalized  text NOT NULL,
  value                 jsonb NOT NULL,
  relationship          text NOT NULL CHECK (relationship IN ('ORIGINAL','AGREES','CHALLENGES','INDEPENDENT','UNDECIDED')),
  endorsed_answer_id    uuid REFERENCES answers(id) ON DELETE SET NULL,
  source                text NOT NULL DEFAULT 'IMAGE_SUBMISSION',
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- one answer per participant per question: prevents duplicate "votes"
  UNIQUE (question_id, participant_id)
);
CREATE INDEX answers_session_idx ON answers (session_id);

ALTER TABLE session_questions
  ADD CONSTRAINT session_questions_rep_image_fk FOREIGN KEY (representative_image_id) REFERENCES question_images(id) ON DELETE SET NULL,
  ADD CONSTRAINT session_questions_orig_answer_fk FOREIGN KEY (original_answer_id) REFERENCES answers(id) ON DELETE SET NULL;

CREATE TABLE challenges (
  id                    uuid PRIMARY KEY,
  session_id            uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id           uuid NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
  original_answer_id    uuid NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  challenger_answer_id  uuid NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  challenger_id         uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  reason                text,
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISCUSSION','RESOLVED','DISMISSED')),
  resolution            text CHECK (resolution IN ('ORIGINAL_ACCEPTED','CHALLENGE_ACCEPTED','BOTH_VALID','UNRESOLVED')),
  resolution_note       text,
  resolved_by           uuid REFERENCES session_participants(id) ON DELETE SET NULL,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, challenger_id)
);
CREATE INDEX challenges_session_idx ON challenges (session_id, status);

CREATE TABLE challenge_responses (
  id              uuid PRIMARY KEY,
  challenge_id    uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  stance          text NOT NULL CHECK (stance IN ('ORIGINAL','CHALLENGE','OTHER')),
  answer_id       uuid REFERENCES answers(id) ON DELETE SET NULL,
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- one vote per participant per challenge
  UNIQUE (challenge_id, participant_id)
);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  type          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  question_id   uuid REFERENCES session_questions(id) ON DELETE CASCADE,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, created_at DESC);

CREATE TABLE session_events (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type         text NOT NULL,
  actor_id     uuid,
  question_id  uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_session_idx ON session_events (session_id, id DESC);
CREATE INDEX session_events_question_idx ON session_events (question_id, id);

-- used only by the "database" storage driver (single-container deployments)
CREATE TABLE stored_blobs (
  key         text PRIMARY KEY,
  mime        text NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
];

MIGRATIONS.push({
  id: '002_chat',
  sql: /* sql */ `
CREATE TABLE chat_messages (
  id            bigserial PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_id     uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  -- NULL = public ("Everyone"); otherwise a private message to that participant
  recipient_id  uuid REFERENCES session_participants(id) ON DELETE CASCADE,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_public_idx ON chat_messages (session_id, id) WHERE recipient_id IS NULL;
CREATE INDEX chat_messages_sender_idx ON chat_messages (sender_id, recipient_id, id) WHERE recipient_id IS NOT NULL;
CREATE INDEX chat_messages_recipient_idx ON chat_messages (recipient_id, sender_id, id) WHERE recipient_id IS NOT NULL;

-- how far each participant has read each conversation
-- channel = 'public' or the other participant's id
CREATE TABLE chat_reads (
  participant_id  uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  channel         text NOT NULL,
  last_read_id    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (participant_id, channel)
);
`,
});

MIGRATIONS.push({
  id: '003_join_requests',
  sql: /* sql */ `
-- "Ask to join" from the public session list; a host admits or declines.
CREATE TABLE join_requests (
  id              uuid PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  display_name    text NOT NULL,
  -- hash of the token the requester already holds; it becomes their
  -- participant token if (and only if) the request is approved
  token_hash      text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELLED')),
  participant_id  uuid REFERENCES session_participants(id) ON DELETE SET NULL,
  decided_by      uuid REFERENCES session_participants(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  -- refreshed while the requester's page is still waiting
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX join_requests_session_idx ON join_requests (session_id, status, created_at);
CREATE INDEX sessions_listing_idx ON sessions (status, created_at DESC);
`,
});

MIGRATIONS.push({
  id: '004_remove_participants',
  sql: /* sql */ `
-- A removed participant loses access; their answers and images stay on record.
ALTER TABLE session_participants
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid REFERENCES session_participants(id) ON DELETE SET NULL;
`,
});

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.tx(async () => {
      await db.exec(m.sql);
      await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    ran.push(m.id);
  }
  return ran;
}
