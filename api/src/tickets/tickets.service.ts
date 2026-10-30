import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common"
import { Actor, AuditService } from "../audit/audit.service"
import type { Q } from "../database/database.service"
import { canTransition, dueDates, Priority, slaOnStatusChange, Status, statusAfterReply, transitionError, type SlaFields } from "./workflow"

export type TicketRow = SlaFields & {
  id: string
  org_id: string
  number: number
  subject: string
  status: Status
  priority: Priority
  channel: string
  requester_id: string
  assignee_id: string | null
  team_id: string | null
  tags: string[]
  solved_at: Date | null
  closed_at: Date | null
  first_response_breached: boolean
  resolution_breached: boolean
  updated_at: Date
}

export type TicketPatch = { subject?: string; status?: Status; priority?: Priority; assigneeId?: string | null; teamId?: string | null; tags?: string[] }

const normalizeTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(0, 20).sort()

/**
 * Ticket rules live here, used by agent routes, the customer portal and background jobs alike.
 * Every method takes `q` from a tenant transaction, so row-level security applies throughout.
 */
@Injectable()
export class TicketsService {
  constructor(private audit: AuditService) {}

  private async policy(q: Q, priority: Priority) {
    return (await q("SELECT first_response_minutes, resolution_minutes, enabled FROM sla_policies WHERE priority = $1", [priority])).rows[0] ?? null
  }

  async lockByNumber(q: Q, number: number): Promise<TicketRow> {
    const r = await q<TicketRow>("SELECT * FROM tickets WHERE number = $1 FOR UPDATE", [number])
    if (!r.rows[0]) throw new NotFoundException(`Ticket #${number} not found`)
    return r.rows[0]
  }

  async upsertContact(q: Q, orgId: string, email: string, name?: string): Promise<{ id: string; email: string; name: string }> {
    const r = await q(
      `INSERT INTO contacts (org_id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, email) DO UPDATE SET name = CASE WHEN contacts.name = split_part(contacts.email::text, '@', 1) AND $4 THEN EXCLUDED.name ELSE contacts.name END
       RETURNING id, email, name`,
      [orgId, email.trim(), name?.trim() || email.split("@")[0], Boolean(name?.trim())],
    )
    return r.rows[0]
  }

  async create(
    q: Q,
    orgId: string,
    input: { subject: string; body: string; requester: { email: string; name?: string }; priority?: Priority; channel: "portal" | "agent" | "email" | "api"; assigneeId?: string | null; teamId?: string | null; tags?: string[]; attachmentIds?: string[] },
    actor: Actor,
  ) {
    const contact = await this.upsertContact(q, orgId, input.requester.email, input.requester.name)
    if (input.assigneeId) await this.assertAssignable(q, input.assigneeId)
    if (input.teamId) await this.assertTeam(q, input.teamId)
    const priority = input.priority ?? "normal"
    const n = (await q<{ last_number: number }>("UPDATE ticket_counters SET last_number = last_number + 1 RETURNING last_number")).rows[0]!.last_number
    const now = new Date()
    const due = dueDates({ created_at: now, sla_paused_seconds: 0, first_response_at: null }, await this.policy(q, priority))
    const t = (
      await q<TicketRow>(
        `INSERT INTO tickets (org_id, number, subject, priority, channel, requester_id, assignee_id, team_id, tags, created_at, updated_at, first_response_due_at, resolution_due_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13) RETURNING *`,
        [orgId, n, input.subject.trim(), priority, input.channel, contact.id, input.assigneeId ?? null, input.teamId ?? null, normalizeTags(input.tags ?? []), now, due.first_response_due_at, due.resolution_due_at, input.assigneeId ? "open" : "new"],
      )
    ).rows[0]!
    // The opening message is the customer's request, even when an agent logs it on their behalf.
    const msg = await q<{ id: string }>(
      "INSERT INTO messages (org_id, ticket_id, author_type, author_user_id, author_contact_id, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [orgId, t.id, input.channel === "agent" ? "agent" : "contact", input.channel === "agent" ? actor.id : null, input.channel === "agent" ? null : contact.id, input.body],
    )
    if (input.attachmentIds?.length) await this.linkAttachments(q, t.id, msg.rows[0]!.id, input.attachmentIds)
    await this.audit.record(q, orgId, { actor, entityType: "ticket", entityId: t.id, ticketId: t.id, action: "ticket.created", changes: { channel: input.channel, priority, subject: t.subject } })
    return { ticket: t, contact }
  }

  async update(q: Q, orgId: string, number: number, patch: TicketPatch, actor: Actor, now = new Date()) {
    const t = await this.lockByNumber(q, number)
    const next: Partial<TicketRow> = {}

    if (patch.status && patch.status !== t.status) {
      if (!canTransition(t.status, patch.status)) throw new ConflictException(transitionError(t.status, patch.status))
      Object.assign(next, { status: patch.status }, slaOnStatusChange(t, t.status, patch.status, now))
      if (patch.status === "solved") next.solved_at = now
      if (patch.status === "closed") next.closed_at = now
      if (t.status === "solved" && patch.status === "open") next.solved_at = null
    } else if (t.status === "closed" && Object.keys(patch).length) {
      throw new ConflictException(transitionError("closed", "open"))
    }
    if (patch.priority && patch.priority !== t.priority) {
      next.priority = patch.priority
      // New priority → new targets, keeping any time already paused.
      const merged = { ...t, ...next }
      Object.assign(next, dueDates({ created_at: t.created_at, sla_paused_seconds: merged.sla_paused_seconds, first_response_at: t.first_response_at }, await this.policy(q, patch.priority)))
      // If currently paused, the eventual resume adds the ongoing pause on top of these.
      // A first response that already happened keeps its verdict; open targets are re-evaluated.
      if (!t.first_response_at) next.first_response_breached = false
      next.resolution_breached = false
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== t.assignee_id) {
      if (patch.assigneeId) await this.assertAssignable(q, patch.assigneeId)
      next.assignee_id = patch.assigneeId
      if (t.status === "new" && patch.assigneeId && !patch.status) next.status = "open"
    }
    if (patch.teamId !== undefined && patch.teamId !== t.team_id) {
      if (patch.teamId) await this.assertTeam(q, patch.teamId)
      next.team_id = patch.teamId
    }
    if (patch.tags) {
      const tags = normalizeTags(patch.tags)
      if (JSON.stringify(tags) !== JSON.stringify(t.tags)) next.tags = tags
    }
    if (patch.subject !== undefined && patch.subject.trim() !== t.subject) next.subject = patch.subject.trim()

    if (!Object.keys(next).length) return { ticket: t, changes: {} as Record<string, { from: unknown; to: unknown }> }

    const cols = Object.keys(next)
    const updated = (
      await q<TicketRow>(`UPDATE tickets SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [t.id, ...cols.map((c) => (next as Record<string, unknown>)[c])])
    ).rows[0]!

    // History records what people care about, not internal SLA bookkeeping.
    const visible = Object.fromEntries(Object.entries(next).filter(([k]) => ["status", "priority", "assignee_id", "team_id", "tags", "subject"].includes(k)))
    const changes = this.audit.diff(t as unknown as Record<string, unknown>, visible)
    if (Object.keys(changes).length) await this.audit.record(q, orgId, { actor, entityType: "ticket", entityId: t.id, ticketId: t.id, action: "ticket.updated", changes })
    return { ticket: updated, changes }
  }

  /**
   * Adds a public reply or an internal note. Handles first-response time, default status moves
   * (an agent reply opens a new ticket; a customer reply reopens a pending or solved one), and
   * an explicit "send and set status" from the agent.
   */
  async addMessage(
    q: Q,
    orgId: string,
    number: number,
    input: { body: string; internal: boolean; author: { type: "agent"; userId: string } | { type: "contact"; contactId: string }; status?: Status; attachmentIds?: string[] },
  ) {
    const t = await this.lockByNumber(q, number)
    if (input.author.type === "contact" && input.internal) throw new BadRequestException("Customers can't add internal notes")
    if (t.status === "closed") throw new ConflictException(input.author.type === "contact" ? "This request is closed. Please open a new one." : transitionError("closed", "open"))
    const now = new Date()

    const msg = (
      await q<{ id: string; created_at: Date }>(
        "INSERT INTO messages (org_id, ticket_id, author_type, author_user_id, author_contact_id, body, internal) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at",
        [orgId, t.id, input.author.type, input.author.type === "agent" ? input.author.userId : null, input.author.type === "contact" ? input.author.contactId : null, input.body, input.internal],
      )
    ).rows[0]!
    if (input.attachmentIds?.length) await this.linkAttachments(q, t.id, msg.id, input.attachmentIds)

    const actor: Actor = input.author.type === "agent" ? { type: "agent", id: input.author.userId } : { type: "contact", id: input.author.contactId }
    const target = input.status ?? statusAfterReply(t.status, input.author.type, input.internal)
    let ticket = t
    let changes: Record<string, { from: unknown; to: unknown }> = {}
    if (target !== t.status) ({ ticket, changes } = await this.update(q, orgId, number, { status: target }, actor, now))

    if (input.author.type === "agent" && !input.internal && !t.first_response_at) {
      ticket = (await q<TicketRow>("UPDATE tickets SET first_response_at = $2, first_response_due_at = NULL, updated_at = now() WHERE id = $1 RETURNING *", [t.id, now])).rows[0]!
      const breached = t.first_response_due_at && now > t.first_response_due_at
      if (breached && !t.first_response_breached) await q("UPDATE tickets SET first_response_breached = true WHERE id = $1", [t.id])
    } else {
      await q("UPDATE tickets SET updated_at = now() WHERE id = $1", [t.id])
    }
    return { message: msg, ticket, changes, previous: t }
  }

  private async linkAttachments(q: Q, ticketId: string, messageId: string, ids: string[]) {
    const r = await q("UPDATE attachments SET message_id = $1 WHERE id = ANY($2::uuid[]) AND ticket_id = $3 AND message_id IS NULL", [messageId, ids, ticketId])
    if (r.rowCount !== new Set(ids).size) throw new BadRequestException("Some attachments don't belong to this ticket or are already used")
  }

  private async assertAssignable(q: Q, userId: string) {
    const r = await q<{ role: string }>("SELECT role FROM memberships WHERE user_id = $1", [userId])
    if (!r.rows[0]) throw new BadRequestException({ error: "Some fields are invalid", fields: { assigneeId: "Not a member of this organization" } })
    if (r.rows[0].role === "viewer") throw new BadRequestException({ error: "Some fields are invalid", fields: { assigneeId: "Viewers can't be assigned tickets" } })
  }

  private async assertTeam(q: Q, teamId: string) {
    if (!(await q("SELECT 1 FROM teams WHERE id = $1", [teamId])).rowCount) throw new BadRequestException({ error: "Some fields are invalid", fields: { teamId: "Team not found" } })
  }
}
