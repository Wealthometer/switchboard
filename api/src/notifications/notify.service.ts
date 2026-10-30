import { Injectable, Logger } from "@nestjs/common"
import { config } from "../config"
import { Database } from "../database/database.service"
import { portalLink } from "../portal/portal-tokens"
import { RealtimePublisher } from "../realtime/publisher"
import type { TicketRow } from "../tickets/tickets.service"
import { EmailQueue, templates } from "./email"

type Org = { id: string; slug: string; name: string }

/**
 * Side effects that happen after a change commits: emails (queued) and live updates (Redis).
 * Failures here are logged, never surfaced: the change itself already succeeded.
 */
@Injectable()
export class NotifyService {
  private log = new Logger("Notify")

  constructor(
    private db: Database,
    private email: EmailQueue,
    private realtime: RealtimePublisher,
  ) {}

  private ticketUrl = (org: Org, number: number) => `${config().APP_URL}/o/${org.slug}/tickets/${number}`

  private async safely(fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (err) {
      this.log.error(`notification failed: ${(err as Error).message}`)
    }
  }

  async ticketCreated(org: Org, t: TicketRow, contact: { id: string; email: string }) {
    await this.safely(async () => {
      this.realtime.publish(org.id, { type: "ticket.created", ticketId: t.id, number: t.number })
      if (t.channel === "portal" || t.channel === "email") {
        await this.email.send(templates.ticketReceived({ to: contact.email, orgName: org.name, number: t.number, subject: t.subject, portalLink: portalLink(org.slug, t.number, org.id, contact.id) }))
      }
      if (t.assignee_id) await this.assigned(org, t, null)
    })
  }

  async ticketUpdated(org: Org, t: TicketRow, changes: Record<string, { from: unknown; to: unknown }>, actorUserId: string | null) {
    if (!Object.keys(changes).length) return
    await this.safely(async () => {
      this.realtime.publish(org.id, { type: "ticket.updated", ticketId: t.id, number: t.number, changes })
      if (changes.assignee_id && t.assignee_id && t.assignee_id !== actorUserId) await this.assigned(org, t, actorUserId)
    })
  }

  private async assigned(org: Org, t: TicketRow, byUserId: string | null) {
    const people = await this.db.query<{ id: string; email: string; name: string }>("SELECT id, email, name FROM users WHERE id = ANY($1::uuid[])", [[t.assignee_id, byUserId].filter(Boolean)])
    const assignee = people.rows.find((u) => u.id === t.assignee_id)
    const by = people.rows.find((u) => u.id === byUserId)?.name ?? "Switchboard"
    if (assignee) await this.email.send(templates.assigned({ to: assignee.email, orgName: org.name, number: t.number, subject: t.subject, ticketUrl: this.ticketUrl(org, t.number), by }))
  }

  async messageAdded(org: Org, t: TicketRow, m: { id: string; body: string; internal: boolean; authorType: "agent" | "contact"; authorUserId?: string }) {
    await this.safely(async () => {
      this.realtime.publish(org.id, { type: "message.created", ticketId: t.id, number: t.number, messageId: m.id, internal: m.internal })
      if (m.internal) return
      if (m.authorType === "agent") {
        const [contact, agent] = await Promise.all([
          this.db.query<{ id: string; email: string }>("SELECT id, email FROM contacts WHERE id = $1", [t.requester_id]),
          this.db.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [m.authorUserId]),
        ])
        const c = contact.rows[0]
        if (c) await this.email.send(templates.agentReply({ to: c.email, orgName: org.name, number: t.number, subject: t.subject, agent: agent.rows[0]?.name ?? org.name, body: m.body, portalLink: portalLink(org.slug, t.number, org.id, c.id) }))
      } else if (t.assignee_id) {
        const a = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [t.assignee_id])
        if (a.rows[0]) await this.email.send(templates.customerReplied({ to: a.rows[0].email, orgName: org.name, number: t.number, subject: t.subject, body: m.body, ticketUrl: this.ticketUrl(org, t.number) }))
      }
    })
  }
}
