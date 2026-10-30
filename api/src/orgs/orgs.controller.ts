import { createHash, randomBytes } from "node:crypto"
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, GoneException, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from "class-validator"
import { AuditService } from "../audit/audit.service"
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public, Requires } from "../common/context"
import { OrgGuard } from "../common/guards"
import { canAssignRole, Role, ROLE_PERMISSIONS } from "../common/permissions"
import { RateLimit, RateLimitGuard } from "../common/redis"
import { Database } from "../database/database.service"
import { EmailQueue, templates } from "../notifications/email"

class CreateOrgDto {
  @IsString() @MinLength(2, { message: "Use at least 2 characters" }) @MaxLength(80) name: string
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, { message: "3–40 characters: lowercase letters, numbers and dashes" }) slug: string
}
class UpdateOrgDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string
}
class RoleDto {
  @IsIn(["owner", "admin", "agent", "viewer"]) role: Role
}
class InviteDto {
  @IsEmail({}, { message: "Enter a valid email address" }) email: string
  @IsIn(["admin", "agent", "viewer"], { message: "Choose admin, agent or viewer" }) role: Role
}

/** Defaults every new organization starts with. Times are in minutes. */
const DEFAULT_SLAS = [
  ["urgent", 60, 240],
  ["high", 240, 1440],
  ["normal", 480, 2880],
  ["low", 1440, 7200],
] as const

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex")

@ApiTags("organizations")
@Controller("orgs")
export class OrgsController {
  constructor(
    private db: Database,
    private audit: AuditService,
    private email: EmailQueue,
  ) {}

  @Post()
  async create(@Body() dto: CreateOrgDto, @CurrentUser() user: AuthUser) {
    try {
      return await this.db.tx(async (q) => {
        const org = (await q<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug", [dto.name.trim(), dto.slug])).rows[0]!
        await q("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org.id, user.id])
        await q("INSERT INTO ticket_counters (org_id) VALUES ($1)", [org.id])
        for (const [priority, first, resolution] of DEFAULT_SLAS) {
          await q("INSERT INTO sla_policies (org_id, priority, first_response_minutes, resolution_minutes) VALUES ($1, $2, $3, $4)", [org.id, priority, first, resolution])
        }
        await q("INSERT INTO teams (org_id, name) VALUES ($1, 'Support')", [org.id])
        await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "organization", entityId: org.id, action: "organization.created", changes: { name: dto.name } })
        return { organization: { ...org, role: "owner", permissions: [...ROLE_PERMISSIONS.owner] } }
      })
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictException({ error: "That address is taken", fields: { slug: "Already in use" } })
      throw err
    }
  }

  @Get(":orgId")
  @UseGuards(OrgGuard)
  get(@CurrentOrg() org: OrgContext) {
    return { organization: { ...org, permissions: [...ROLE_PERMISSIONS[org.role]] } }
  }

  @Patch(":orgId")
  @UseGuards(OrgGuard)
  @Requires("settings.manage")
  async update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body() dto: UpdateOrgDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const r = await q("UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name, slug", [dto.name.trim(), org.id])
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "organization", entityId: org.id, action: "organization.renamed", changes: { name: { from: org.name, to: dto.name } } })
      return { organization: r.rows[0] }
    })
  }

  // ── Members ────────────────────────────────────────────────────────────────

  @Get(":orgId/members")
  @UseGuards(OrgGuard)
  async members(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      q(
        `SELECT u.id, u.name, u.email, m.role, m.created_at AS "joinedAt",
                COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = u.id), '{}') AS teams
           FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.name`,
      ),
    )
    return { members: r.rows }
  }

  @Patch(":orgId/members/:userId")
  @UseGuards(OrgGuard)
  @Requires("members.manage")
  async changeRole(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("userId", ParseUUIDPipe) userId: string, @Body() dto: RoleDto) {
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const current = (await q<{ role: Role }>("SELECT role FROM memberships WHERE user_id = $1 FOR UPDATE", [userId])).rows[0]
      if (!current) throw new NotFoundException("Member not found")
      if (!canAssignRole(org.role, dto.role) || !canAssignRole(org.role, current.role)) throw new ForbiddenException("Only owners can change owners")
      if (current.role === "owner" && dto.role !== "owner") await this.assertAnotherOwner(q, userId)
      await q("UPDATE memberships SET role = $1 WHERE user_id = $2", [dto.role, userId])
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "member", entityId: userId, action: "member.role_changed", changes: { role: { from: current.role, to: dto.role } } })
      return { ok: true }
    })
  }

  @Delete(":orgId/members/:userId")
  @UseGuards(OrgGuard)
  @HttpCode(204)
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("userId", ParseUUIDPipe) userId: string) {
    const leaving = userId === user.id
    if (!leaving && !ROLE_PERMISSIONS[org.role].has("members.manage")) throw new ForbiddenException(`Your role (${org.role}) can't do this`)
    await this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const current = (await q<{ role: Role }>("SELECT role FROM memberships WHERE user_id = $1 FOR UPDATE", [userId])).rows[0]
      if (!current) throw new NotFoundException("Member not found")
      if (!leaving && !canAssignRole(org.role, current.role)) throw new ForbiddenException("Only owners can remove owners")
      if (current.role === "owner") await this.assertAnotherOwner(q, userId)
      // Their open tickets go back to the queue rather than pointing at someone who left.
      await q("UPDATE tickets SET assignee_id = NULL, updated_at = now() WHERE assignee_id = $1 AND status NOT IN ('solved', 'closed')", [userId])
      await q("DELETE FROM memberships WHERE user_id = $1", [userId])
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "member", entityId: userId, action: leaving ? "member.left" : "member.removed" })
    })
  }

  private async assertAnotherOwner(q: Parameters<Parameters<Database["tenant"]>[1]>[0], exceptUserId: string) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE role = 'owner' AND user_id <> $1", [exceptUserId])
    if (r.rows[0]!.n === 0) throw new BadRequestException("An organization needs at least one owner. Make someone else an owner first.")
  }

  // ── Invitations ──────────────────────────────────────────────────────────

  @Get(":orgId/invitations")
  @UseGuards(OrgGuard)
  @Requires("members.manage")
  async invitations(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) =>
      q(`SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt" FROM invitations WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`),
    )
    return { invitations: r.rows }
  }

  @Post(":orgId/invitations")
  @UseGuards(OrgGuard, RateLimitGuard)
  @Requires("members.manage")
  @RateLimit("invite", 30, 3600)
  async invite(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body() dto: InviteDto) {
    if (!canAssignRole(org.role, dto.role)) throw new ForbiddenException("You can't invite someone with that role")
    const token = randomBytes(32).toString("base64url")
    const invitation = await this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      const member = await q("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [dto.email])
      if (member.rowCount) throw new ConflictException({ error: "That person is already a member", fields: { email: "Already a member" } })
      await q("DELETE FROM invitations WHERE email = $1 AND accepted_at IS NULL", [dto.email]) // re-inviting replaces the old link
      const r = await q(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
         RETURNING id, email, role, expires_at AS "expiresAt"`,
        [org.id, dto.email, dto.role, tokenHash(token), user.id],
      )
      await this.audit.record(q, org.id, { actor: { type: "agent", id: user.id }, entityType: "invitation", entityId: r.rows[0].id, action: "member.invited", changes: { email: dto.email, role: dto.role } })
      return r.rows[0]
    })
    await this.email.send(templates.invitation({ to: dto.email, orgName: org.name, inviter: user.name, role: dto.role, token }))
    return { invitation }
  }

  @Delete(":orgId/invitations/:id")
  @UseGuards(OrgGuard)
  @Requires("members.manage")
  @HttpCode(204)
  async revoke(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    const r = await this.db.tenant({ orgId: org.id, userId: user.id }, (q) => q("DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL", [id]))
    if (!r.rowCount) throw new NotFoundException("Invitation not found")
  }
}

/** Accepting happens outside any org context: the invitee isn't a member yet. */
@ApiTags("organizations")
@Controller("invitations")
export class InvitationsController {
  constructor(private db: Database) {}

  @Public()
  @Get(":token")
  async preview(@Param("token") token: string) {
    const r = await this.db.query(
      `SELECT i.email, i.role, i.expires_at < now() AS expired, i.accepted_at IS NOT NULL AS accepted, o.name AS "orgName"
         FROM invitations i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = $1`,
      [tokenHash(token)],
    )
    if (!r.rows[0]) throw new NotFoundException("This invitation link isn't valid")
    return { invitation: r.rows[0] }
  }

  @Post(":token/accept")
  @HttpCode(200)
  async accept(@Param("token") token: string, @CurrentUser() user: AuthUser) {
    return this.db.tx(async (q) => {
      const inv = (await q("SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE", [tokenHash(token)])).rows[0]
      if (!inv) throw new NotFoundException("This invitation link isn't valid")
      if (inv.accepted_at) throw new GoneException("This invitation has already been used")
      if (new Date(inv.expires_at) < new Date()) throw new GoneException("This invitation has expired. Ask for a new one.")
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw new ForbiddenException(`This invitation is for ${inv.email}. Sign in with that email to accept it.`)
      await q("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [inv.org_id, user.id, inv.role])
      await q("UPDATE invitations SET accepted_at = now() WHERE id = $1", [inv.id])
      await q("INSERT INTO audit_events (org_id, actor_type, actor_id, entity_type, entity_id, action, changes) VALUES ($1, 'agent', $2, 'member', $2, 'member.joined', $3)", [inv.org_id, user.id, { role: inv.role }])
      return { orgId: inv.org_id }
    })
  }
}
