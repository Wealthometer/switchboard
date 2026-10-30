import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Query, UseGuards } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator"
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Requires } from "../common/context"
import { OrgGuard } from "../common/guards"
import { Database } from "../database/database.service"

class ContactQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(10_000) page?: number
}
class ContactDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string
}
class AuditQuery {
  @IsOptional() @IsIn(["ticket", "member", "team", "sla_policy", "invitation", "organization"]) entityType?: string
  @IsOptional() @IsUUID() actorId?: string
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) before?: number
}

@ApiTags("contacts")
@Controller("orgs/:orgId/contacts")
@UseGuards(OrgGuard)
export class ContactsController {
  constructor(private db: Database) {}

  @Get()
  @Requires("contacts.read")
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query() query: ContactQuery) {
    const page = query.page ?? 1
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q(
        `SELECT c.id, c.name, c.email, c.created_at AS "createdAt",
                count(t.id)::int AS tickets, count(t.id) FILTER (WHERE t.status IN ('new','open','pending','on_hold'))::int AS "openTickets",
                max(t.updated_at) AS "lastActivity"
           FROM contacts c LEFT JOIN tickets t ON t.requester_id = c.id
          WHERE ($1::text IS NULL OR c.email ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%')
          GROUP BY c.id ORDER BY max(t.updated_at) DESC NULLS LAST, c.created_at DESC
          LIMIT 51 OFFSET $2`,
        [query.q?.trim() || null, (page - 1) * 50],
      )
      return { contacts: r.rows.slice(0, 50), page, hasMore: r.rows.length > 50 }
    })
  }

  @Get(":id")
  @Requires("contacts.read")
  detail(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const c = (await q(`SELECT id, name, email, created_at AS "createdAt" FROM contacts WHERE id = $1`, [id])).rows[0]
      if (!c) throw new NotFoundException("Contact not found")
      const tickets = await q(`SELECT number, subject, status, priority, updated_at AS "updatedAt" FROM tickets WHERE requester_id = $1 ORDER BY updated_at DESC LIMIT 100`, [id])
      return { contact: c, tickets: tickets.rows }
    })
  }

  @Patch(":id")
  @Requires("contacts.write")
  rename(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ContactDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q(`UPDATE contacts SET name = $1 WHERE id = $2 RETURNING id, name, email`, [dto.name.trim(), id])
      if (!r.rowCount) throw new NotFoundException("Contact not found")
      return { contact: r.rows[0] }
    })
  }
}

@ApiTags("audit")
@Controller("orgs/:orgId/audit")
@UseGuards(OrgGuard)
export class AuditController {
  constructor(private db: Database) {}

  /** Keyset pagination on the bigserial id: pass the last id as `before` for the next page. */
  @Get()
  @Requires("audit.read")
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query() query: AuditQuery) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q(
        `SELECT e.id::int, e.action, e.entity_type AS "entityType", e.entity_id AS "entityId", e.changes, e.created_at AS "createdAt",
                e.actor_type AS "actorType", COALESCE(u.name, c.name, 'System') AS "actorName", t.number AS "ticketNumber"
           FROM audit_events e
           LEFT JOIN users u ON u.id = e.actor_id AND e.actor_type = 'agent'
           LEFT JOIN contacts c ON c.id = e.actor_id AND e.actor_type = 'contact'
           LEFT JOIN tickets t ON t.id = e.ticket_id
          WHERE ($1::text IS NULL OR e.entity_type = $1) AND ($2::uuid IS NULL OR e.actor_id = $2) AND ($3::bigint IS NULL OR e.id < $3)
          ORDER BY e.id DESC LIMIT 51`,
        [query.entityType ?? null, query.actorId ?? null, query.before ?? null],
      )
      const events = r.rows.slice(0, 50)
      return { events, next: r.rows.length > 50 ? events[events.length - 1].id : null }
    })
  }
}
