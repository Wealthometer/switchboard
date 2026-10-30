import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator"
import { AuditService } from "../audit/audit.service"
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Requires } from "../common/context"
import { OrgGuard } from "../common/guards"
import { Database } from "../database/database.service"

class TeamDto {
  @IsString() @MinLength(1, { message: "Give the team a name" }) @MaxLength(60) name: string
}
class TeamMembersDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID("4", { each: true }) userIds: string[]
}
class SlaDto {
  @IsInt() @Min(1) @Max(60 * 24 * 30) first_response_minutes: number
  @IsInt() @Min(1) @Max(60 * 24 * 90) resolution_minutes: number
  @IsOptional() @IsBoolean() enabled?: boolean
}

@ApiTags("teams")
@Controller("orgs/:orgId/teams")
@UseGuards(OrgGuard)
export class TeamsController {
  constructor(
    private db: Database,
    private audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      q(
        `SELECT t.id, t.name,
                COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name) FILTER (WHERE u.id IS NOT NULL), '[]') AS members,
                (SELECT count(*)::int FROM tickets tk WHERE tk.team_id = t.id AND tk.status NOT IN ('solved', 'closed')) AS "openTickets"
           FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id LEFT JOIN users u ON u.id = tm.user_id
          GROUP BY t.id ORDER BY t.name`,
      ),
    )
    return { teams: r.rows }
  }

  @Post()
  @Requires("teams.manage")
  async create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body() dto: TeamDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q("INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id, name", [org.id, dto.name.trim()])
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "team", entityId: r.rows[0].id, action: "team.created", changes: { name: dto.name } })
      return { team: r.rows[0] }
    })
  }

  @Patch(":id")
  @Requires("teams.manage")
  async rename(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() dto: TeamDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q("UPDATE teams SET name = $1 WHERE id = $2 RETURNING id, name", [dto.name.trim(), id])
      if (!r.rowCount) throw new NotFoundException("Team not found")
      return { team: r.rows[0] }
    })
  }

  @Put(":id/members")
  @Requires("teams.manage")
  async setMembers(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string, @Body() dto: TeamMembersDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      if (!(await q("SELECT 1 FROM teams WHERE id = $1", [id])).rowCount) throw new NotFoundException("Team not found")
      const valid = await q<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE user_id = ANY($1::uuid[])", [dto.userIds])
      if (valid.rows[0]!.n !== new Set(dto.userIds).size) throw new BadRequestException("Some people aren't members of this organization")
      await q("DELETE FROM team_members WHERE team_id = $1", [id])
      for (const uid of new Set(dto.userIds)) await q("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1, $2, $3)", [org.id, id, uid])
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "team", entityId: id, action: "team.members_changed", changes: { userIds: dto.userIds } })
      return { ok: true }
    })
  }

  @Delete(":id")
  @Requires("teams.manage")
  @HttpCode(204)
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q("DELETE FROM teams WHERE id = $1 RETURNING name", [id])
      if (!r.rowCount) throw new NotFoundException("Team not found")
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "team", entityId: id, action: "team.deleted", changes: { name: r.rows[0].name } })
    })
  }
}

@ApiTags("sla")
@Controller("orgs/:orgId/sla-policies")
@UseGuards(OrgGuard)
export class SlaPoliciesController {
  constructor(
    private db: Database,
    private audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      q("SELECT id, priority, first_response_minutes, resolution_minutes, enabled FROM sla_policies ORDER BY array_position(ARRAY['urgent','high','normal','low']::ticket_priority[], priority)"),
    )
    return { policies: r.rows }
  }

  @Put(":priority")
  @Requires("sla.manage")
  async update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("priority") priority: string, @Body() dto: SlaDto) {
    if (!["urgent", "high", "normal", "low"].includes(priority)) throw new NotFoundException("Unknown priority")
    if (dto.resolution_minutes < dto.first_response_minutes) throw new BadRequestException({ error: "Some fields are invalid", fields: { resolution_minutes: "Must be at least the first-response target" } })
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const before = (await q("SELECT first_response_minutes, resolution_minutes, enabled FROM sla_policies WHERE priority = $1", [priority])).rows[0]
      const r = await q(
        `INSERT INTO sla_policies (org_id, priority, first_response_minutes, resolution_minutes, enabled) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, priority) DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes, resolution_minutes = EXCLUDED.resolution_minutes, enabled = EXCLUDED.enabled
         RETURNING id, priority, first_response_minutes, resolution_minutes, enabled`,
        [org.id, priority, dto.first_response_minutes, dto.resolution_minutes, dto.enabled ?? true],
      )
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "sla_policy", entityId: r.rows[0].id, action: "sla.updated", changes: { priority, before, after: dto } })
      return { policy: r.rows[0] }
    })
  }
}

