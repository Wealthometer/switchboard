-- Switchboard schema. Every tenant table carries org_id and is protected by row-level security.

CREATE EXTENSION IF NOT EXISTS citext;

-- ── Global tables ──────────────────────────────────────────────────────────
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE member_role AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TABLE memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        member_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         member_role NOT NULL CHECK (role <> 'owner'),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending ON invitations (org_id, email) WHERE accepted_at IS NULL;

-- ── Tenant tables ──────────────────────────────────────────────────────────
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)
);
CREATE TABLE team_members (
  org_id   uuid NOT NULL,
  team_id  uuid NOT NULL,
  user_id  uuid NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (org_id, id)
);

CREATE TYPE ticket_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TABLE sla_policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  priority                ticket_priority NOT NULL,
  first_response_minutes  int NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes      int NOT NULL CHECK (resolution_minutes > 0),
  enabled                 boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, priority)
);

CREATE TABLE ticket_counters (
  org_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number  int NOT NULL DEFAULT 0
);

CREATE TYPE ticket_status AS ENUM ('new', 'open', 'pending', 'on_hold', 'solved', 'closed');
CREATE TYPE ticket_channel AS ENUM ('portal', 'agent', 'email', 'api');
CREATE TABLE tickets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number                    int NOT NULL,
  subject                   text NOT NULL,
  status                    ticket_status NOT NULL DEFAULT 'new',
  priority                  ticket_priority NOT NULL DEFAULT 'normal',
  channel                   ticket_channel NOT NULL,
  requester_id              uuid NOT NULL,
  assignee_id               uuid,
  team_id                   uuid,
  tags                      text[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  first_response_at         timestamptz,
  solved_at                 timestamptz,
  closed_at                 timestamptz,
  -- SLA: due times move forward by the time spent waiting on the customer ("pending").
  first_response_due_at     timestamptz,
  resolution_due_at         timestamptz,
  sla_paused_at             timestamptz,
  sla_paused_seconds        int NOT NULL DEFAULT 0,
  first_response_breached   boolean NOT NULL DEFAULT false,
  resolution_breached       boolean NOT NULL DEFAULT false,
  search                    tsvector GENERATED ALWAYS AS (to_tsvector('english', subject)) STORED,
  UNIQUE (org_id, number),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, requester_id) REFERENCES contacts (org_id, id),
  FOREIGN KEY (org_id, assignee_id) REFERENCES memberships (org_id, user_id) ON DELETE SET NULL (assignee_id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id) ON DELETE SET NULL (team_id)
);
CREATE INDEX tickets_org_status_idx ON tickets (org_id, status, updated_at DESC);
CREATE INDEX tickets_assignee_idx ON tickets (org_id, assignee_id) WHERE status NOT IN ('solved', 'closed');
CREATE INDEX tickets_requester_idx ON tickets (org_id, requester_id);
CREATE INDEX tickets_tags_idx ON tickets USING gin (tags);
CREATE INDEX tickets_search_idx ON tickets USING gin (search);
CREATE INDEX tickets_sla_due_idx ON tickets (first_response_due_at, resolution_due_at) WHERE status NOT IN ('solved', 'closed') AND sla_paused_at IS NULL;

CREATE TYPE author_type AS ENUM ('agent', 'contact', 'system');
CREATE TABLE messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  ticket_id          uuid NOT NULL,
  author_type        author_type NOT NULL,
  author_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  author_contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  body               text NOT NULL,
  internal           boolean NOT NULL DEFAULT false,   -- internal notes are never shown to customers
  created_at         timestamptz NOT NULL DEFAULT now(),
  search             tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES tickets (org_id, id) ON DELETE CASCADE,
  CHECK (NOT (internal AND author_type = 'contact'))
);
CREATE INDEX messages_ticket_idx ON messages (ticket_id, created_at);
CREATE INDEX messages_search_idx ON messages USING gin (search);

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  message_id    uuid,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    int NOT NULL,
  storage_key   text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, ticket_id) REFERENCES tickets (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, message_id) REFERENCES messages (org_id, id) ON DELETE CASCADE
);
CREATE INDEX attachments_ticket_idx ON attachments (ticket_id);

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type   author_type NOT NULL,
  actor_id     uuid,
  entity_type  text NOT NULL,       -- ticket | member | team | sla_policy | invitation | organization
  entity_id    uuid,
  ticket_id    uuid,
  action       text NOT NULL,       -- e.g. ticket.status_changed
  changes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_events (org_id, created_at DESC);
CREATE INDEX audit_ticket_idx ON audit_events (ticket_id, created_at) WHERE ticket_id IS NOT NULL;

-- ── Row-level security ─────────────────────────────────────────────────────
-- Request handlers run inside a transaction that does SET LOCAL ROLE switchboard_tenant and sets
-- app.org_id. Policies then hide every other organization's rows, so a missing WHERE clause in
-- application code can't leak data across tenants. Background jobs run as the owner role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'switchboard_tenant') THEN
    CREATE ROLE switchboard_tenant NOLOGIN;
  END IF;
END $$;
GRANT switchboard_tenant TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO switchboard_tenant;

CREATE FUNCTION current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'invitations', 'teams', 'team_members', 'contacts', 'sla_policies',
                           'ticket_counters', 'tickets', 'messages', 'attachments', 'audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO switchboard_tenant', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (id = current_org());
GRANT SELECT, UPDATE ON organizations TO switchboard_tenant;

-- The tenant role can see who people are, but never their password hashes.
GRANT SELECT (id, email, name, created_at) ON users TO switchboard_tenant;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO switchboard_tenant;
