import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import jwt from "jsonwebtoken"
import { config } from "../config"
import { Database } from "../database/database.service"
import { AppRequest, PERMISSION_KEY, PUBLIC_KEY } from "./context"
import { can, Permission, Role } from "./permissions"

export const SESSION_COOKIE = "sb_session"

export function readSession(token: string | undefined): { sub: string } | null {
  if (!token) return null
  try {
    const payload = jwt.verify(token, config().JWT_SECRET, { algorithms: ["HS256"] }) as { sub?: string; aud?: string }
    // Portal magic-link tokens carry an audience; they must never count as an agent session.
    if (!payload.sub || payload.aud) return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}

const SOCKET_AUDIENCE = "socket"

/**
 * Short-lived proof of a session for the WebSocket handshake, for when the socket connects to the
 * API directly (Vercel can't proxy WebSockets) and the session cookie isn't sent there.
 */
export function signSocketToken(userId: string) {
  return jwt.sign({ sub: userId }, config().JWT_SECRET, { algorithm: "HS256", audience: SOCKET_AUDIENCE, expiresIn: "2m" })
}

export function readSocketToken(token: unknown): { sub: string } | null {
  if (typeof token !== "string" || !token) return null
  try {
    const payload = jwt.verify(token, config().JWT_SECRET, { algorithms: ["HS256"], audience: SOCKET_AUDIENCE }) as { sub?: string }
    return payload.sub ? { sub: payload.sub } : null
  } catch {
    return null
  }
}

/** Global: every route needs a session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private db: Database,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    // WebSocket connections authenticate once on connect (see RealtimeGateway).
    if (ctx.getType() !== "http") return true
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    const req = ctx.switchToHttp().getRequest<AppRequest>()
    const session = readSession(req.cookies?.[SESSION_COOKIE])
    if (session) {
      const res = await this.db.query("SELECT id, email, name FROM users WHERE id = $1", [session.sub])
      if (res.rows[0]) req.user = res.rows[0]
    }
    if (!req.user && !isPublic) throw new UnauthorizedException("Sign in to continue")
    return true
  }
}

/**
 * For routes under /orgs/:orgId: loads the caller's membership and enforces @Requires().
 * Non-members get 404 rather than 403 so organization ids can't be probed.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private db: Database,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>()
    const orgId = String(req.params.orgId ?? "")
    if (!req.user) throw new UnauthorizedException("Sign in to continue")
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new NotFoundException("Organization not found")
    const res = await this.db.query<{ id: string; slug: string; name: string; role: Role }>(
      "SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN memberships m ON m.org_id = o.id AND m.user_id = $2 WHERE o.id = $1",
      [orgId, req.user.id],
    )
    const org = res.rows[0]
    if (!org) throw new NotFoundException("Organization not found")
    req.org = org
    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()])
    if (needed && !can(org.role, needed)) throw new ForbiddenException(`Your role (${org.role}) can't do this`)
    return true
  }
}
