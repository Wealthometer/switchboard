import { NotFoundException } from "@nestjs/common"
import type { Q } from "../database/database.service"
import { slaState, type Status } from "./workflow"

export type ListFilters = {
  view?: "mine" | "unassigned" | "open" | "pending" | "solved" | "breaching" | "all"
  status?: Status[]
  priority?: string[]
  assigneeId?: string
  teamId?: string
  tag?: string
  requesterId?: string
  q?: string
  sort?: "updated" | "created" | "priority" | "due"
  page?: number
  limit?: number
}

const ACTIVE = "('new','open','pending','on_hold')"

/** Builds the inbox query. Values are always bound parameters; only fixed fragments are concatenated. */
export async function listTickets(q: Q, userId: string, f: ListFilters) {
  const where: string[] = []
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }

  switch (f.view ?? "open") {
    case "mine": where.push(`t.assignee_id = ${p(userId)}`, `t.status IN ${ACTIVE}`); break
    case "unassigned": where.push("t.assignee_id IS NULL", `t.status IN ${ACTIVE}`); break
    case "open": where.push("t.status IN ('new','open','on_hold')"); break
    case "pending": where.push("t.status = 'pending'"); break
    case "solved": where.push("t.status IN ('solved','closed')"); break
    case "breaching":
      where.push(`t.status IN ${ACTIVE}`, "t.sla_paused_at IS NULL", "(t.first_response_breached OR t.resolution_breached OR LEAST(t.first_response_due_at, t.resolution_due_at) < now() + interval '1 hour')")
      break
  }
  if (f.status?.length) where.push(`t.status = ANY(${p(f.status)}::ticket_status[])`)
  if (f.priority?.length) where.push(`t.priority = ANY(${p(f.priority)}::ticket_priority[])`)
  if (f.assigneeId) where.push(`t.assignee_id = ${p(f.assigneeId)}`)
  if (f.teamId) where.push(`t.team_id = ${p(f.teamId)}`)
  if (f.tag) where.push(`${p(f.tag.toLowerCase())} = ANY(t.tags)`)
  if (f.requesterId) where.push(`t.requester_id = ${p(f.requesterId)}`)

  let rank = "0"
  let snippet = "NULL"
  if (f.q?.trim()) {
    const text = f.q.trim()
    const num = text.match(/^#?(\d+)$/)
    if (num) {
      where.push(`t.number = ${p(Number(num[1]))}`)
    } else {
      // Subject and every message body (including internal notes, since this is the agent view).
      const tsq = `websearch_to_tsquery('english', ${p(text)})`
      where.push(`(t.search @@ ${tsq} OR EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.search @@ ${tsq}) OR c.email ILIKE ${p(`%${text}%`)})`)
      rank = `ts_rank(t.search, ${tsq}) * 2 + COALESCE((SELECT max(ts_rank(m.search, ${tsq})) FROM messages m WHERE m.ticket_id = t.id), 0)`
      snippet = `(SELECT ts_headline('english', m.body, ${tsq}, 'MaxWords=18, MinWords=6, StartSel=<<, StopSel=>>') FROM messages m WHERE m.ticket_id = t.id AND m.search @@ ${tsq} ORDER BY m.created_at LIMIT 1)`
    }
  }

  const order = {
    updated: "t.updated_at DESC",
    created: "t.created_at DESC",
    priority: "array_position(ARRAY['urgent','high','normal','low']::ticket_priority[], t.priority), t.updated_at DESC",
    due: "LEAST(t.first_response_due_at, t.resolution_due_at) ASC NULLS LAST",
  }[f.sort ?? "updated"]
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 100)
  const page = Math.max(f.page ?? 1, 1)
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = await q(
    `SELECT t.id, t.number, t.subject, t.status, t.priority, t.tags, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
            t.first_response_due_at AS "firstResponseDueAt", t.resolution_due_at AS "resolutionDueAt", t.sla_paused_at IS NOT NULL AS "slaPaused",
            t.first_response_breached OR t.resolution_breached AS "slaBreached",
            json_build_object('id', c.id, 'name', c.name, 'email', c.email) AS requester,
            CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS assignee,
            CASE WHEN tm.id IS NULL THEN NULL ELSE json_build_object('id', tm.id, 'name', tm.name) END AS team,
            (SELECT count(*)::int FROM messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS replies,
            ${snippet} AS snippet
       FROM tickets t
       JOIN contacts c ON c.id = t.requester_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN teams tm ON tm.id = t.team_id
       ${whereSql}
      ORDER BY ${f.q && !/^#?\d+$/.test(f.q.trim()) ? `${rank} DESC, ` : ""}${order}
      LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`,
    params,
  )
  const counts = await q(
    `SELECT count(*) FILTER (WHERE assignee_id = $1 AND status IN ${ACTIVE})::int AS mine,
            count(*) FILTER (WHERE assignee_id IS NULL AND status IN ${ACTIVE})::int AS unassigned,
            count(*) FILTER (WHERE status IN ('new','open','on_hold'))::int AS open,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status IN ${ACTIVE} AND sla_paused_at IS NULL AND (first_response_breached OR resolution_breached OR LEAST(first_response_due_at, resolution_due_at) < now() + interval '1 hour'))::int AS breaching
       FROM tickets`,
    [userId],
  )
  return { tickets: rows.rows.slice(0, limit), page, hasMore: rows.rows.length > limit, counts: counts.rows[0] }
}

/** Everything the ticket view needs, with history merged into one timeline. */
export async function ticketDetail(q: Q, number: number, opts: { includeInternal: boolean } = { includeInternal: true }) {
  const t = (
    await q(
      `SELECT t.*, json_build_object('id', c.id, 'name', c.name, 'email', c.email) AS requester,
              CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name) END AS assignee,
              CASE WHEN tm.id IS NULL THEN NULL ELSE json_build_object('id', tm.id, 'name', tm.name) END AS team,
              sp.first_response_minutes, sp.resolution_minutes
         FROM tickets t JOIN contacts c ON c.id = t.requester_id
         LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN teams tm ON tm.id = t.team_id
         LEFT JOIN sla_policies sp ON sp.priority = t.priority AND sp.enabled
        WHERE t.number = $1`,
      [number],
    )
  ).rows[0]
  if (!t) throw new NotFoundException(`Ticket #${number} not found`)

  const messages = await q(
    `SELECT m.id, m.body, m.internal, m.author_type AS "authorType", m.created_at AS "createdAt",
            COALESCE(u.name, c.name, 'System') AS "authorName",
            COALESCE((SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'contentType', a.content_type, 'size', a.size_bytes) ORDER BY a.created_at)
                        FROM attachments a WHERE a.message_id = m.id), '[]') AS attachments
       FROM messages m LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN contacts c ON c.id = m.author_contact_id
      WHERE m.ticket_id = $1 ${opts.includeInternal ? "" : "AND NOT m.internal"}
      ORDER BY m.created_at, m.id`,
    [t.id],
  )
  const events = opts.includeInternal
    ? await q(
        `SELECT e.id, e.action, e.changes, e.created_at AS "createdAt", e.actor_type AS "actorType", COALESCE(u.name, c.name, 'System') AS "actorName"
           FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id AND e.actor_type = 'agent' LEFT JOIN contacts c ON c.id = e.actor_id AND e.actor_type = 'contact'
          WHERE e.ticket_id = $1 ORDER BY e.created_at, e.id`,
        [t.id],
      )
    : { rows: [] }

  const now = new Date()
  const sla = {
    firstResponse: { dueAt: t.first_response_due_at, at: t.first_response_at, state: slaState({ due: t.first_response_due_at ?? null, doneAt: t.first_response_at, breached: t.first_response_breached, paused: Boolean(t.sla_paused_at), windowSeconds: t.first_response_minutes ? t.first_response_minutes * 60 : null, now }) },
    resolution: { dueAt: t.resolution_due_at, at: t.solved_at, state: slaState({ due: t.resolution_due_at, doneAt: t.solved_at, breached: t.resolution_breached, paused: Boolean(t.sla_paused_at), windowSeconds: t.resolution_minutes ? t.resolution_minutes * 60 : null, now }) },
    paused: Boolean(t.sla_paused_at),
  }
  return {
    ticket: {
      id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, channel: t.channel, tags: t.tags,
      requester: t.requester, assignee: t.assignee, team: t.team, createdAt: t.created_at, updatedAt: t.updated_at, solvedAt: t.solved_at, sla,
    },
    messages: messages.rows,
    events: events.rows,
  }
}
