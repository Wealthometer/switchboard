import { Injectable, OnModuleDestroy } from "@nestjs/common"
import { Queue } from "bullmq"
import { createRedis } from "../common/redis"
import { config } from "../config"

export type Email = { to: string; subject: string; text: string; replyTo?: string; tag: string }
export const EMAIL_QUEUE = "switchboard-emails"

/** Emails go through a queue: requests never wait on SMTP, and failures retry with backoff. */
@Injectable()
export class EmailQueue implements OnModuleDestroy {
  private connection = createRedis("email-queue", { maxRetriesPerRequest: null })
  readonly queue = new Queue<Email>(EMAIL_QUEUE, {
    connection: this.connection,
    defaultJobOptions: { attempts: 6, backoff: { type: "exponential", delay: 15_000 }, removeOnComplete: { count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  })

  async send(email: Email) {
    await this.queue.add(email.tag, email)
  }

  async onModuleDestroy() {
    await this.queue.close()
    await this.connection.quit().catch(() => {})
  }
}

const app = () => config().APP_URL

/** Plain-text templates: deliverable everywhere and easy to test. */
export const templates = {
  invitation: (p: { to: string; orgName: string; inviter: string; role: string; token: string }): Email => ({
    tag: "invitation",
    to: p.to,
    subject: `${p.inviter} invited you to ${p.orgName} on Switchboard`,
    text: `${p.inviter} invited you to join ${p.orgName} as ${p.role === "viewer" ? "a viewer" : `an ${p.role}`}.\n\nAccept the invitation: ${app()}/invite/${p.token}\n\nThis link expires in 7 days.`,
  }),
  ticketReceived: (p: { to: string; orgName: string; number: number; subject: string; portalLink: string }): Email => ({
    tag: "ticket_received",
    to: p.to,
    subject: `[${p.orgName} #${p.number}] We've received your request: ${p.subject}`,
    text: `Thanks for getting in touch. Your request #${p.number} ("${p.subject}") is with the ${p.orgName} team.\n\nView it or add details any time: ${p.portalLink}\n`,
  }),
  agentReply: (p: { to: string; orgName: string; number: number; subject: string; agent: string; body: string; portalLink: string }): Email => ({
    tag: "agent_reply",
    to: p.to,
    subject: `[${p.orgName} #${p.number}] Re: ${p.subject}`,
    text: `${p.agent} replied:\n\n${p.body}\n\n—\nReply or view the conversation: ${p.portalLink}\n`,
  }),
  portalAccess: (p: { to: string; orgName: string; links: { number: number; subject: string; url: string }[] }): Email => ({
    tag: "portal_access",
    to: p.to,
    subject: `Your ${p.orgName} support requests`,
    text: p.links.length
      ? `Here are links to your requests with ${p.orgName}. Each link works for 7 days.\n\n${p.links.map((l) => `#${l.number} ${l.subject}\n${l.url}`).join("\n\n")}\n`
      : `We couldn't find any requests for this email address at ${p.orgName}.\n`,
  }),
  assigned: (p: { to: string; orgName: string; number: number; subject: string; ticketUrl: string; by: string }): Email => ({
    tag: "assigned",
    to: p.to,
    subject: `[${p.orgName}] #${p.number} assigned to you: ${p.subject}`,
    text: `${p.by} assigned ticket #${p.number} to you.\n\n${p.ticketUrl}\n`,
  }),
  customerReplied: (p: { to: string; orgName: string; number: number; subject: string; body: string; ticketUrl: string }): Email => ({
    tag: "customer_replied",
    to: p.to,
    subject: `[${p.orgName}] Customer replied on #${p.number}: ${p.subject}`,
    text: `${p.body}\n\n${p.ticketUrl}\n`,
  }),
  slaBreached: (p: { to: string; orgName: string; number: number; subject: string; kind: string; ticketUrl: string }): Email => ({
    tag: "sla_breached",
    to: p.to,
    subject: `[${p.orgName}] SLA breached on #${p.number}: ${p.kind}`,
    text: `Ticket #${p.number} ("${p.subject}") missed its ${p.kind} target.\n\n${p.ticketUrl}\n`,
  }),
}
