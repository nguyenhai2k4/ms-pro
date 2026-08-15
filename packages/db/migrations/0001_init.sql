-- 0001_init.sql — initial schema for ProjectApp.
--
-- Migrations are forward-only and are never edited after merge (CLAUDE.md). The runner records
-- a checksum per applied file and refuses to run if a previously applied file has changed, so
-- "never edited" is enforced rather than remembered.
--
-- Source of truth for the shape: docs/FRS.md §6. Source of truth for the vocabularies: the zod
-- enums in packages/shared-types/src/enums.ts — schema.test.ts asserts the two agree, because a
-- value that parses in TypeScript and fails on INSERT is a runtime-only bug.
--
-- Naming: tables and columns are snake_case; the camelCase mapping lives in the query layer and
-- nowhere else.
--
-- Implements: FR-AUTH-01..05, FR-PRJ-01..08, FR-TSK-01..09, FR-SCH-01..03, FR-RES-01..04,
--             FR-RES-07, FR-CAL-01..04, FR-TRK-01..03, FR-COL-05..08, FR-ACL-01..02, FR-RPT-04..06

-- `gen_random_uuid()` is core from PostgreSQL 13, so no pgcrypto extension is required.

-- ---------------------------------------------------------------------------------------------
-- Vocabularies (mirror of packages/shared-types/src/enums.ts)
-- ---------------------------------------------------------------------------------------------

CREATE TYPE plan_tier AS ENUM ('free', 'pro', 'enterprise');
CREATE TYPE auth_provider AS ENUM ('password', 'google', 'microsoft');
CREATE TYPE project_role AS ENUM ('admin', 'editor', 'contributor', 'viewer');
CREATE TYPE dependency_type AS ENUM ('FS', 'SS', 'FF', 'SF');
CREATE TYPE constraint_type AS ENUM ('ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT');
CREATE TYPE schedule_mode AS ENUM ('auto', 'manual');
CREATE TYPE resource_type AS ENUM ('work', 'material', 'cost');
CREATE TYPE rate_unit AS ENUM ('hour', 'use');
CREATE TYPE task_status AS ENUM ('not_started', 'in_progress', 'blocked', 'done');
CREATE TYPE audit_entity_type AS ENUM (
  'task', 'dependency', 'resource', 'assignment', 'baseline', 'project_member', 'project'
);
CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete');
CREATE TYPE export_type AS ENUM ('pdf', 'png', 'xlsx', 'csv', 'json');
CREATE TYPE export_job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE notification_type AS ENUM ('mention', 'comment_reply', 'role_changed');

-- ---------------------------------------------------------------------------------------------
-- Organization & identity (FR-AUTH, FR-PRJ-01)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  plan_tier   plan_tier NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- `user` is awkward to quote everywhere; the table is app_user and the type is User.
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email          text NOT NULL,
  auth_provider  auth_provider NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- FR-AUTH-04: identity is org-scoped, so uniqueness is per organization, not global.
CREATE UNIQUE INDEX app_user_org_email_key ON app_user (org_id, lower(email));

-- FR-AUTH-01. Split from app_user so a User row can never be serialised into an API response
-- with credential material attached — the hash lives in a table the API layer does not select.
CREATE TABLE user_credential (
  user_id        uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  password_hash  text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- FR-AUTH-03: logout invalidates server-side, so sessions are rows, not just signed strings.
CREATE TABLE user_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_session_user_id_idx ON user_session (user_id);

-- FR-AUTH-05: single-use, time-limited.
CREATE TABLE password_reset_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Calendars (FR-CAL-01..04) — declared before project, which references the default calendar
-- ---------------------------------------------------------------------------------------------

CREATE TABLE calendar (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for an org-level template calendar shared across projects (FR-CAL-04).
  project_id                  uuid,
  name                        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- ISO weekday numbers, 1 = Monday.
  working_days                smallint[] NOT NULL,
  working_hours_start_minute  integer NOT NULL CHECK (working_hours_start_minute BETWEEN 0 AND 1440),
  working_hours_end_minute    integer NOT NULL CHECK (working_hours_end_minute BETWEEN 0 AND 1440),
  is_default                  boolean NOT NULL DEFAULT false,
  CHECK (working_hours_end_minute > working_hours_start_minute)
);

CREATE TABLE calendar_exception (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id                         uuid NOT NULL REFERENCES calendar (id) ON DELETE CASCADE,
  date                                date NOT NULL,
  is_working                          boolean NOT NULL,
  working_hours_start_minute_override integer CHECK (working_hours_start_minute_override BETWEEN 0 AND 1440),
  working_hours_end_minute_override   integer CHECK (working_hours_end_minute_override BETWEEN 0 AND 1440),
  UNIQUE (calendar_id, date)
);

-- ---------------------------------------------------------------------------------------------
-- Project (FR-PRJ-02..08, FR-TRK-03)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE project (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  start_date   timestamptz NOT NULL,
  calendar_id  uuid NOT NULL REFERENCES calendar (id) ON DELETE RESTRICT,
  status_date  timestamptz,
  created_by   uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_org_id_idx ON project (org_id);
-- FR-PRJ-08: duplicate names within an org are allowed on purpose — no unique index here.

ALTER TABLE calendar
  ADD CONSTRAINT calendar_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES project (id) ON DELETE CASCADE;

-- FR-ACL-01/02, FR-PRJ-06.
CREATE TABLE project_member (
  project_id   uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role         project_role NOT NULL,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  PRIMARY KEY (project_id, user_id)
);
-- FR-AUTH-06 re-reads role per request, so this lookup is on the hot path of every request.
CREATE INDEX project_member_user_id_idx ON project_member (user_id);

-- ---------------------------------------------------------------------------------------------
-- Task (FR-TSK-01..09)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE task (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: FR-TSK-08 requires the user to choose cascade-delete or re-parent.
  -- A silent database cascade would make that choice unreachable.
  parent_id        uuid REFERENCES task (id) ON DELETE RESTRICT,
  wbs_code         text NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  duration_hours   double precision NOT NULL CHECK (duration_hours >= 0),
  start            timestamptz NOT NULL,
  finish           timestamptz NOT NULL,
  pct_complete     double precision NOT NULL DEFAULT 0 CHECK (pct_complete BETWEEN 0 AND 100),
  is_milestone     boolean NOT NULL DEFAULT false,
  schedule_mode    schedule_mode NOT NULL DEFAULT 'auto',
  constraint_type  constraint_type NOT NULL DEFAULT 'ASAP',
  constraint_date  timestamptz,
  calendar_id      uuid REFERENCES calendar (id) ON DELETE SET NULL,
  priority         integer NOT NULL DEFAULT 500 CHECK (priority BETWEEN 0 AND 1000),
  status           task_status NOT NULL DEFAULT 'not_started',
  actual_start     timestamptz,
  actual_finish    timestamptz,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,

  -- FR-TSK-04: a milestone has duration 0.
  CONSTRAINT task_milestone_zero_duration CHECK (NOT is_milestone OR duration_hours = 0),
  -- FR-TSK-06: the six dated constraint types require a date; ASAP/ALAP must not carry one.
  CONSTRAINT task_constraint_date_required CHECK (
    (constraint_type IN ('ASAP', 'ALAP') AND constraint_date IS NULL)
    OR (constraint_type NOT IN ('ASAP', 'ALAP') AND constraint_date IS NOT NULL)
  ),
  CONSTRAINT task_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT task_finish_after_start CHECK (finish >= start)
);

-- FRS §6 indexing note: WBS tree loads.
CREATE INDEX task_project_id_parent_id_idx ON task (project_id, parent_id);
CREATE UNIQUE INDEX task_project_wbs_code_key ON task (project_id, wbs_code);

-- ---------------------------------------------------------------------------------------------
-- Dependency (FR-SCH-01..03)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE dependency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  -- FR-TSK-09: deleting a task removes its links and triggers recalculation.
  predecessor_id  uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  successor_id    uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  type            dependency_type NOT NULL,
  -- FR-SCH-02: signed. Negative is lead.
  lag_hours       double precision NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- FR-SCH-03: the trivial cycle. Longer cycles are the engine's job — the database cannot
  -- express reachability, so cycle rejection lives in the scheduler and is tested there.
  CONSTRAINT dependency_no_self_link CHECK (predecessor_id <> successor_id),
  CONSTRAINT dependency_unique_pair UNIQUE (predecessor_id, successor_id)
);

-- FRS §6: the engine traverses the graph in both directions, so index both directions.
CREATE INDEX dependency_predecessor_id_idx ON dependency (predecessor_id);
CREATE INDEX dependency_successor_id_idx ON dependency (successor_id);
CREATE INDEX dependency_project_id_idx ON dependency (project_id);

-- ---------------------------------------------------------------------------------------------
-- Resources & assignments (FR-RES-01..04, FR-RES-07)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE resource (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type           resource_type NOT NULL,
  rate           numeric(14, 4) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  rate_unit      rate_unit NOT NULL DEFAULT 'hour',
  max_units_pct  double precision NOT NULL DEFAULT 100 CHECK (max_units_pct >= 0),
  calendar_id    uuid REFERENCES calendar (id) ON DELETE SET NULL
);
CREATE INDEX resource_project_id_idx ON resource (project_id);

CREATE TABLE assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  resource_id    uuid NOT NULL REFERENCES resource (id) ON DELETE CASCADE,
  units_pct      double precision NOT NULL DEFAULT 100 CHECK (units_pct >= 0),
  work_hours     double precision NOT NULL DEFAULT 0 CHECK (work_hours >= 0),
  cost           numeric(14, 4) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  effort_driven  boolean NOT NULL DEFAULT false,
  UNIQUE (task_id, resource_id)
);
CREATE INDEX assignment_resource_id_idx ON assignment (resource_id);
CREATE INDEX assignment_task_id_idx ON assignment (task_id);

-- ---------------------------------------------------------------------------------------------
-- Baselines (FR-TRK-01, FR-TRK-02)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE baseline (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- FR-TRK-01: JSONB snapshot. Read whole, compared whole, never edited.
  snapshot_json  jsonb NOT NULL,
  created_by     uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX baseline_project_id_idx ON baseline (project_id);

-- ---------------------------------------------------------------------------------------------
-- Collaboration (FR-COL-05..08)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE task_comment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  body               text NOT NULL,
  -- FR-COL-05: single-level threading is sufficient for MVP.
  parent_comment_id  uuid REFERENCES task_comment (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_comment_task_id_idx ON task_comment (task_id);

CREATE TABLE mention (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id         uuid NOT NULL REFERENCES task_comment (id) ON DELETE CASCADE,
  mentioned_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  notified_at        timestamptz,
  UNIQUE (comment_id, mentioned_user_id)
);
-- FR-COL-06: the batcher scans for un-notified mentions.
CREATE INDEX mention_pending_idx ON mention (mentioned_user_id) WHERE notified_at IS NULL;

CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  type          notification_type NOT NULL,
  payload_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user_unread_idx ON notification (user_id, created_at DESC) WHERE read_at IS NULL;

-- FR-COL-07. Note there is no foreign key on entity_id: the audit log must outlive the row it
-- describes, and a delete entry whose FK forbids the delete is worse than useless.
CREATE TABLE audit_log_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  actor_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  entity_type    audit_entity_type NOT NULL,
  entity_id      uuid NOT NULL,
  action         audit_action NOT NULL,
  before_json    jsonb,
  after_json     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Invariant 4: an audit row with neither side records nothing. Create has no before,
  -- delete has no after, update must have both.
  CONSTRAINT audit_before_after_present CHECK (
    (action = 'create' AND before_json IS NULL AND after_json IS NOT NULL)
    OR (action = 'delete' AND before_json IS NOT NULL AND after_json IS NULL)
    OR (action = 'update' AND before_json IS NOT NULL AND after_json IS NOT NULL)
  )
);

-- FRS §6 indexing note: the activity feed.
CREATE INDEX audit_log_entry_project_created_idx ON audit_log_entry (project_id, created_at DESC);
CREATE INDEX audit_log_entry_entity_idx ON audit_log_entry (entity_type, entity_id);

-- ---------------------------------------------------------------------------------------------
-- Export jobs (FR-RPT-04..06)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE export_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  type          export_type NOT NULL,
  status        export_job_status NOT NULL DEFAULT 'queued',
  file_url      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX export_job_project_id_idx ON export_job (project_id, created_at DESC);
