import {
  BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiTags } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf,
} from "class-validator"
import type { Response } from "express"
import "multer"
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Requires } from "../common/context"
import { OrgGuard } from "../common/guards"
import { can } from "../common/permissions"
import { config } from "../config"
import { Database } from "../database/database.service"
import { NotifyService } from "../notifications/notify.service"
import { ALLOWED_TYPES, sniffMatches, StorageService } from "./storage.service"
import { listTickets, ticketDetail, type ListFilters } from "./tickets.queries"
import { TicketsService } from "./tickets.service"
import type { Priority, Status } from "./workflow"

const STATUSES = ["new", "open", "pending", "on_hold", "solved", "closed"]
const PRIORITIES = ["low", "normal", "high", "urgent"]
const csv = ({ value }: { value: unknown }) => (typeof value === "string" ? value.split(",").filter(Boolean) : value)

class CreateTicketDto {
  @IsString() @MinLength(3, { message: "Subject is too short" }) @MaxLength(200) subject: string
  @IsString() @MinLength(1, { message: "Describe the request" }) @MaxLength(50_000) body: string
  @IsEmail({}, { message: "Enter a valid email" }) requesterEmail: string
  @IsOptional() @IsString() @MaxLength(120) requesterName?: string
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority
  @IsOptional() @IsUUID() assigneeId?: string
  @IsOptional() @IsUUID() teamId?: string
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[]
}

class UpdateTicketDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) subject?: string
  @IsOptional() @IsIn(STATUSES) status?: Status
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() assigneeId?: string | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() teamId?: string | null
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[]
}

class MessageDto {
  @IsString() @MinLength(1, { message: "Write something first" }) @MaxLength(50_000) body: string
  @IsOptional() @IsBoolean() internal?: boolean
  @IsOptional() @IsIn(STATUSES) status?: Status
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID("4", { each: true }) attachmentIds?: string[]
}

class ListQuery {
  @IsOptional() @IsIn(["mine", "unassigned", "open", "pending", "solved", "breaching", "all"]) view?: ListFilters["view"]
  @IsOptional() @Transform(csv) @IsArray() @IsIn(STATUSES, { each: true }) status?: Status[]
  @IsOptional() @Transform(csv) @IsArray() @IsIn(PRIORITIES, { each: true }) priority?: string[]
  @IsOptional() @IsUUID() assigneeId?: string
  @IsOptional() @IsUUID() teamId?: string
  @IsOptional() @IsUUID() requesterId?: string
  @IsOptional() @IsString() @MaxLength(40) tag?: string
  @IsOptional() @IsString() @MaxLength(200) q?: string
  @IsOptional() @IsIn(["updated", "created", "priority", "due"]) sort?: ListFilters["sort"]
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(10_000) page?: number
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100) limit?: number
}

@ApiTags("tickets")
@Controller("orgs/:orgId/tickets")
@UseGuards(OrgGuard)
export class TicketsController {
  constructor(
    private db: Database,
    private tickets: TicketsService,
    private notify: NotifyService,
    private storage: StorageService,
  ) {}

  @Get()
  @Requires("tickets.read")
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query() query: ListQuery) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, (q) => listTickets(q, user.id, query))
  }

  @Post()
  @Requires("tickets.write")
  async create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    if (dto.assigneeId && dto.assigneeId !== user.id && !can(org.role, "tickets.assign")) throw new ForbiddenException("Your role can't assign tickets to others")
    const { ticket, contact } = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      this.tickets.create(
        q,
        org.id,
        { subject: dto.subject, body: dto.body, requester: { email: dto.requesterEmail, name: dto.requesterName }, priority: dto.priority, channel: "agent", assigneeId: dto.assigneeId, teamId: dto.teamId, tags: dto.tags },
        { type: "agent", id: user.id },
      ),
    )
    await this.notify.ticketCreated(org, ticket, contact)
    return { ticket: { id: ticket.id, number: ticket.number, status: ticket.status } }
  }

  @Get(":number")
  @Requires("tickets.read")
  detail(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("number", ParseIntPipe) number: number) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, (q) => ticketDetail(q, number))
  }

  @Patch(":number")
  @Requires("tickets.write")
  async update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("number", ParseIntPipe) number: number, @Body() dto: UpdateTicketDto) {
    // Agents may take a ticket themselves or drop it; reassigning someone else's needs tickets.assign.
    if (dto.assigneeId !== undefined && dto.assigneeId !== user.id && dto.assigneeId !== null && !can(org.role, "tickets.assign")) {
      throw new ForbiddenException("Your role can't assign tickets to others")
    }
    const { ticket, changes } = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) => this.tickets.update(q, org.id, number, dto, { type: "agent", id: user.id }))
    await this.notify.ticketUpdated(org, ticket, changes, user.id)
    return this.db.tenant({ orgId: org.id, userId: user.id }, (q) => ticketDetail(q, number))
  }

  @Post(":number/messages")
  @Requires("tickets.read")
  async reply(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("number", ParseIntPipe) number: number, @Body() dto: MessageDto) {
    const internal = Boolean(dto.internal)
    if (!can(org.role, internal ? "tickets.note" : "tickets.write")) throw new ForbiddenException(`Your role (${org.role}) can't ${internal ? "add notes" : "reply to customers"}`)
    if (internal && dto.status) throw new BadRequestException("Internal notes can't change status. Update the ticket instead.")
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      this.tickets.addMessage(q, org.id, number, { body: dto.body, internal, author: { type: "agent", userId: user.id }, status: dto.status, attachmentIds: dto.attachmentIds }),
    )
    await this.notify.messageAdded(org, r.ticket, { id: r.message.id, body: dto.body, internal, authorType: "agent", authorUserId: user.id })
    await this.notify.ticketUpdated(org, r.ticket, r.changes, user.id)
    return { message: { id: r.message.id, createdAt: r.message.created_at }, ticket: { status: r.ticket.status } }
  }

  /** Upload first, then reference the returned id in a reply. Unused uploads are removed after a day. */
  @Post(":number/attachments")
  @Requires("tickets.write")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: config().MAX_UPLOAD_MB * 1024 * 1024, files: 1 } }))
  async upload(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("number", ParseIntPipe) number: number, @UploadedFile() file?: Express.Multer.File) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const t = await q<{ id: string }>("SELECT id FROM tickets WHERE number = $1", [number])
      if (!t.rows[0]) throw new NotFoundException(`Ticket #${number} not found`)
      return { attachment: await saveAttachment(q, this.storage, org.id, t.rows[0].id, file) }
    })
  }
}

/** Shared by agent and portal uploads. */
export async function saveAttachment(q: import("../database/database.service").Q, storage: StorageService, orgId: string, ticketId: string, file?: Express.Multer.File) {
  if (!file) throw new BadRequestException("Attach a file in the 'file' field")
  const type = file.mimetype.toLowerCase()
  if (!ALLOWED_TYPES.has(type)) throw new BadRequestException(`Files of type ${type} aren't allowed`)
  if (!sniffMatches(type, file.buffer)) throw new BadRequestException("The file's contents don't match its type")
  const filename = file.originalname.replace(/[\u0000-\u001f"\\/]/g, "_").slice(0, 200) || "file"
  const key = await storage.put(orgId, file.buffer)
  try {
    const r = await q("INSERT INTO attachments (org_id, ticket_id, filename, content_type, size_bytes, storage_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, filename, content_type AS \"contentType\", size_bytes AS size", [orgId, ticketId, filename, type, file.size, key])
    return r.rows[0]
  } catch (err) {
    await storage.remove(key)
    throw err
  }
}

/** Sends a stored file with headers that stop browsers from rendering it as a page. */
export async function sendAttachment(res: Response, storage: StorageService, a: { filename: string; content_type: string; size_bytes: number; storage_key: string }) {
  const body = await storage.read(a.storage_key).catch(() => null)
  if (!body) throw new NotFoundException("Attachment not found")
  const inline = a.content_type.startsWith("image/") || a.content_type === "application/pdf"
  res.setHeader("Content-Type", a.content_type)
  res.setHeader("Content-Length", String(a.size_bytes))
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader("Cache-Control", "private, max-age=3600")
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
  body.on("error", () => res.destroy()).pipe(res)
}

@ApiTags("tickets")
@Controller("orgs/:orgId/attachments")
@UseGuards(OrgGuard)
export class AttachmentsController {
  constructor(
    private db: Database,
    private storage: StorageService,
  ) {}

  @Get(":id")
  @Requires("tickets.read")
  async download(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const a = await this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => (await q("SELECT filename, content_type, size_bytes, storage_key FROM attachments WHERE id = $1", [id])).rows[0])
    if (!a) throw new NotFoundException("Attachment not found")
    await sendAttachment(res, this.storage, a)
  }
}
