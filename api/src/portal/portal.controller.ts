import {
  Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiTags } from "@nestjs/swagger"
import { ArrayMaxSize, IsArray, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator"
import type { Request, Response } from "express"
import "multer"
import { Public } from "../common/context"
import { RateLimit, RateLimitGuard } from "../common/redis"
import { config } from "../config"
import { Database, type Q } from "../database/database.service"
import { EmailQueue, templates } from "../notifications/email"
import { NotifyService } from "../notifications/notify.service"
import { StorageService } from "../tickets/storage.service"
import { saveAttachment, sendAttachment } from "../tickets/tickets.controller"
import { ticketDetail } from "../tickets/tickets.queries"
import { TicketsService } from "../tickets/tickets.service"
import { signPortalToken, verifyPortalToken } from "./portal-tokens"

class PortalRequestDto {
  @IsString() @MinLength(1, { message: "Enter your name" }) @MaxLength(120) name: string
  @IsEmail({}, { message: "Enter a valid email" }) @MaxLength(200) email: string
  @IsString() @MinLength(3, { message: "Add a short subject" }) @MaxLength(200) subject: string
  @IsString() @MinLength(10, { message: "Tell us a little more (10+ characters)" }) @MaxLength(20_000) body: string
  /** Honeypot: hidden in the form, so only bots fill it in. */
  @IsOptional() @IsString() @MaxLength(200) website?: string
}
class AccessDto {
  @IsEmail({}, { message: "Enter a valid email" }) email: string
}
class PortalReplyDto {
  @IsString() @MinLength(1, { message: "Write something first" }) @MaxLength(20_000) body: string
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUUID("4", { each: true }) attachmentIds?: string[]
}

type Org = { id: string; slug: string; name: string }

/**
 * The customer-facing side: no account, no password. Customers submit a request and get a signed
 * link by email; the link is the credential. Internal notes and history are never exposed here.
 */
@ApiTags("portal")
@Controller("portal/:slug")
@UseGuards(RateLimitGuard)
@Public()
export class PortalController {
  constructor(
    private db: Database,
    private tickets: TicketsService,
    private notify: NotifyService,
    private email: EmailQueue,
    private storage: StorageService,
  ) {}

  private async org(slug: string): Promise<Org> {
    const r = await this.db.query<Org>("SELECT id, slug, name FROM organizations WHERE slug = $1", [slug.toLowerCase()])
    if (!r.rows[0]) throw new NotFoundException("This help center doesn't exist")
    return r.rows[0]
  }

  /** Resolves the customer from `Authorization: Bearer` or `?token=` (used by file links). */
  private async customer(req: Request, slug: string) {
    const org = await this.org(slug)
    const header = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    const claims = verifyPortalToken(header ?? (typeof req.query.token === "string" ? req.query.token : undefined))
    if (!claims || claims.org !== org.id) throw new UnauthorizedException("This link has expired. Request a new one below.")
    const c = await this.db.tenant({ orgId: org.id }, async (q) => (await q<{ id: string; email: string; name: string }>("SELECT id, email, name FROM contacts WHERE id = $1", [claims.contact])).rows[0])
    if (!c) throw new UnauthorizedException("This link has expired. Request a new one below.")
    return { org, contact: c }
  }

  private async ownTicket(q: Q, number: number, contactId: string) {
    const t = await q<{ id: string }>("SELECT id FROM tickets WHERE number = $1 AND requester_id = $2", [number, contactId])
    if (!t.rows[0]) throw new NotFoundException(`Request #${number} not found`)
    return t.rows[0]
  }

  @Get()
  async info(@Param("slug") slug: string) {
    const org = await this.org(slug)
    return { organization: { name: org.name, slug: org.slug } }
  }

  @Post("requests")
  @RateLimit("portal-request", 5, 600)
  async create(@Param("slug") slug: string, @Body() dto: PortalRequestDto) {
    const org = await this.org(slug)
    // Pretend success to bots without creating anything.
    if (dto.website) return { ok: true }
    const { ticket, contact } = await this.db.tenant({ orgId: org.id }, async (q) => {
      const existing = await q<{ id: string }>("SELECT id FROM contacts WHERE email = $1", [dto.email.trim()])
      return this.tickets.create(
        q,
        org.id,
        { subject: dto.subject, body: dto.body, requester: { email: dto.email, name: dto.name }, channel: "portal" },
        { type: "contact", id: existing.rows[0]?.id ?? null },
      )
    })
    await this.notify.ticketCreated(org, ticket, contact)
    // No token in the response: access is proven by reading the email we just sent.
    return { ok: true, number: ticket.number }
  }

  /** Emails a fresh link listing the address's requests. Same response whether or not it exists. */
  @Post("access")
  @HttpCode(202)
  @RateLimit("portal-access", 5, 600)
  async access(@Param("slug") slug: string, @Body() dto: AccessDto) {
    const org = await this.org(slug)
    const found = await this.db.tenant({ orgId: org.id }, async (q) => {
      const c = (await q<{ id: string; email: string }>("SELECT id, email FROM contacts WHERE email = $1", [dto.email.trim()])).rows[0]
      if (!c) return null
      const t = await q<{ number: number; subject: string }>("SELECT number, subject FROM tickets WHERE requester_id = $1 ORDER BY updated_at DESC LIMIT 20", [c.id])
      return { contact: c, tickets: t.rows }
    })
    if (found?.tickets.length) {
      const token = encodeURIComponent(signPortalToken({ org: org.id, contact: found.contact.id }))
      const links = found.tickets.map((t) => ({ ...t, url: `${config().APP_URL}/portal/${org.slug}/requests/${t.number}?token=${token}` }))
      await this.email.send(templates.portalAccess({ to: found.contact.email, orgName: org.name, links })).catch(() => {})
    }
    return { ok: true }
  }

  @Get("requests")
  async mine(@Param("slug") slug: string, @Req() req: Request) {
    const { org, contact } = await this.customer(req, slug)
    const r = await this.db.tenant({ orgId: org.id }, (q) =>
      q(
        `SELECT number, subject, status, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM tickets WHERE requester_id = $1 ORDER BY updated_at DESC LIMIT 100`,
        [contact.id],
      ),
    )
    return { contact: { name: contact.name, email: contact.email }, requests: r.rows }
  }

  @Get("requests/:number")
  async detail(@Param("slug") slug: string, @Param("number", ParseIntPipe) number: number, @Req() req: Request) {
    const { org, contact } = await this.customer(req, slug)
    return this.db.tenant({ orgId: org.id }, async (q) => {
      await this.ownTicket(q, number, contact.id)
      const d = await ticketDetail(q, number, { includeInternal: false })
      // Customers see their conversation and a friendly status, nothing about SLAs, tags or assignees.
      const status = { new: "open", open: "open", on_hold: "open", pending: "awaiting your reply", solved: "solved", closed: "closed" }[d.ticket.status as string]
      return {
        request: { number: d.ticket.number, subject: d.ticket.subject, status, createdAt: d.ticket.createdAt, agent: d.ticket.assignee?.name ?? null },
        messages: d.messages.map((m: Record<string, unknown>) => ({ id: m.id, body: m.body, fromYou: m.authorType === "contact", authorName: m.authorName, createdAt: m.createdAt, attachments: m.attachments })),
      }
    })
  }

  @Post("requests/:number/messages")
  @RateLimit("portal-reply", 30, 600)
  async reply(@Param("slug") slug: string, @Param("number", ParseIntPipe) number: number, @Body() dto: PortalReplyDto, @Req() req: Request) {
    const { org, contact } = await this.customer(req, slug)
    const r = await this.db.tenant({ orgId: org.id }, async (q) => {
      await this.ownTicket(q, number, contact.id)
      return this.tickets.addMessage(q, org.id, number, { body: dto.body, internal: false, author: { type: "contact", contactId: contact.id }, attachmentIds: dto.attachmentIds })
    })
    await this.notify.messageAdded(org, r.ticket, { id: r.message.id, body: dto.body, internal: false, authorType: "contact" })
    await this.notify.ticketUpdated(org, r.ticket, r.changes, null)
    return { ok: true }
  }

  @Post("requests/:number/attachments")
  @RateLimit("portal-upload", 20, 600)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: config().MAX_UPLOAD_MB * 1024 * 1024, files: 1 } }))
  async upload(@Param("slug") slug: string, @Param("number", ParseIntPipe) number: number, @Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    const { org, contact } = await this.customer(req, slug)
    return this.db.tenant({ orgId: org.id }, async (q) => {
      const t = await this.ownTicket(q, number, contact.id)
      return { attachment: await saveAttachment(q, this.storage, org.id, t.id, file) }
    })
  }

  /** Only files on public messages of the customer's own tickets. */
  @Get("attachments/:id")
  async download(@Param("slug") slug: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response) {
    const { org, contact } = await this.customer(req, slug)
    const a = await this.db.tenant({ orgId: org.id }, async (q) =>
      (
        await q(
          `SELECT a.filename, a.content_type, a.size_bytes, a.storage_key
             FROM attachments a JOIN messages m ON m.id = a.message_id JOIN tickets t ON t.id = a.ticket_id
            WHERE a.id = $1 AND NOT m.internal AND t.requester_id = $2`,
          [id, contact.id],
        )
      ).rows[0],
    )
    if (!a) throw new NotFoundException("File not found")
    await sendAttachment(res, this.storage, a)
  }
}
