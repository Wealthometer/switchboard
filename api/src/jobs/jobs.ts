import { config } from "../config"
import type { Database, Q } from "../database/database.service"
import { EmailQueue, templates } from "../notifications/email"
import type { RealtimePublisher } from "../realtime/publisher"
import type { StorageService } from "../tickets/storage.service"

/**
 * Periodic jobs. They run across all organizations as the owner role (no RLS), so every query
 * here filters by org explicitly. Each job takes a transaction-scoped advisory lock, so running
 * several worker replicas is safe: only one does a given pass.
 */
type Deps = { db: Database; realtime: RealtimePublisher; email: EmailQueue; storage: StorageService }

async function exclusive<T>(db: Database, lockId: number, fn: (q: Q) => Promise<T>): Promise<T | null> {
  return db.tx(async (q) => {
    const got = (await q<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [lockId])).rows[0]!.ok
    return got ? fn(q) : null
  })
}

type Breach = { id: string; org_id: string; number: number; subject: string; assignee_id: string | null; kind: "first_response" | "resolution" }

/** Flags tickets that just missed a target, records it, and tells the assignee (or the admins). */
export async function scanSlaBreaches({ db, realtime, email }: Deps, now = new Date()): Promise<Breach[]> {
  const breaches = await exclusive(db, 71_001, async (q) => {
    const fr = await q<Breach>(
      `UPDATE tickets SET first_response_breached = true
        WHERE status IN ('new','open','on_hold','pending') AND sla_paused_at IS NULL AND first_response_at IS NULL
          AND NOT first_response_breached AND first_response_due_at < $1
        RETURNING id, org_id, number, subject, assignee_id, 'first_response' AS kind`,
      [now],
    )
    const res = await q<Breach>(
      `UPDATE tickets SET resolution_breached = true
        WHERE status IN ('new','open','on_hold','pending') AND sla_paused_at IS NULL
          AND NOT resolution_breached AND resolution_due_at < $1
        RETURNING id, org_id, number, subject, assignee_id, 'resolution' AS kind`,
      [now],
    )
    const all = [...fr.rows, ...res.rows]
    for (const b of all) {
      await q(
        "INSERT INTO audit_events (org_id, actor_type, actor_id, entity_type, entity_id, ticket_id, action, changes) VALUES ($1, 'system', NULL, 'ticket', $2, $2, 'sla.breached', $3)",
        [b.org_id, b.id, { kind: b.kind }],
      )
    }
    return all
  })
  if (!breaches?.length) return []

  for (const b of breaches) {
    realtime.publish(b.org_id, { type: "sla.breached", ticketId: b.id, number: b.number, kind: b.kind })
    const org = (await db.query<{ name: string; slug: string }>("SELECT name, slug FROM organizations WHERE id = $1", [b.org_id])).rows[0]!
    const recipients = b.assignee_id
      ? await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [b.assignee_id])
      : await db.query<{ email: string }>("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner','admin')", [b.org_id])
    for (const r of recipients.rows) {
      await email.send(
        templates.slaBreached({ to: r.email, orgName: org.name, number: b.number, subject: b.subject, kind: b.kind === "first_response" ? "first response" : "resolution", ticketUrl: `${config().APP_URL}/o/${org.slug}/tickets/${b.number}` }),
      )
    }
  }
  return breaches
}

/** Solved tickets with no follow-up become closed after AUTO_CLOSE_HOURS. A customer reply before then reopens them. */
export async function autoClose({ db, realtime }: Deps, now = new Date()) {
  const closed = await exclusive(db, 71_002, async (q) => {
    const r = await q<{ id: string; org_id: string; number: number }>(
      `UPDATE tickets SET status = 'closed', closed_at = $1, updated_at = $1
        WHERE status = 'solved' AND solved_at < $1::timestamptz - make_interval(hours => $2)
        RETURNING id, org_id, number`,
      [now, config().AUTO_CLOSE_HOURS],
    )
    for (const t of r.rows) {
      await q(
        "INSERT INTO audit_events (org_id, actor_type, actor_id, entity_type, entity_id, ticket_id, action, changes) VALUES ($1, 'system', NULL, 'ticket', $2, $2, 'ticket.updated', $3)",
        [t.org_id, t.id, { status: { from: "solved", to: "closed" }, reason: "auto_close" }],
      )
    }
    return r.rows
  })
  for (const t of closed ?? []) realtime.publish(t.org_id, { type: "ticket.updated", ticketId: t.id, number: t.number, changes: { status: { from: "solved", to: "closed" } } })
  return closed ?? []
}

/** Uploads that were never attached to a message within a day are deleted, row and file. */
export async function cleanupUploads({ db, storage }: Deps, now = new Date()) {
  const gone = await exclusive(db, 71_003, async (q) =>
    (await q<{ storage_key: string }>("DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1::timestamptz - interval '24 hours' RETURNING storage_key", [now])).rows,
  )
  for (const a of gone ?? []) await storage.remove(a.storage_key)
  return gone?.length ?? 0
}
