import { hash, verify } from "@node-rs/argon2"
import { Body, ConflictException, Controller, Get, HttpCode, Post, Res, UnauthorizedException, UseGuards } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator"
import type { Response } from "express"
import jwt from "jsonwebtoken"
import { config } from "../config"
import { AuthUser, CurrentUser, Public } from "../common/context"
import { SESSION_COOKIE, signSocketToken } from "../common/guards"
import { ROLE_PERMISSIONS } from "../common/permissions"
import { RateLimit, RateLimitGuard } from "../common/redis"
import { Database } from "../database/database.service"

class RegisterDto {
  @IsString() @MinLength(1, { message: "Enter your name" }) @MaxLength(80) name: string
  @IsEmail({}, { message: "Enter a valid email address" }) @MaxLength(200) email: string
  @IsString() @MinLength(10, { message: "Use at least 10 characters" }) @MaxLength(200) password: string
}
class LoginDto {
  @IsEmail({}, { message: "Enter a valid email address" }) email: string
  @IsString() @MinLength(1, { message: "Enter your password" }) password: string
}

const DAYS = 14
let dummy: Promise<string> | undefined

@ApiTags("auth")
@Controller("auth")
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private db: Database) {}

  private setSession(res: Response, userId: string) {
    const token = jwt.sign({ sub: userId }, config().JWT_SECRET, { algorithm: "HS256", expiresIn: `${DAYS}d` })
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config().COOKIE_SECURE, maxAge: DAYS * 86400_000, path: "/" })
  }

  @Public()
  @Post("register")
  @RateLimit("register", 10, 3600)
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const passwordHash = await hash(dto.password)
    try {
      const r = await this.db.query<AuthUser>("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name", [dto.email.trim(), dto.name.trim(), passwordHash])
      this.setSession(res, r.rows[0]!.id)
      return { user: r.rows[0] }
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictException({ error: "An account with this email already exists", fields: { email: "Already registered" } })
      throw err
    }
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  @RateLimit("login", 10, 60)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.query<AuthUser & { password_hash: string }>("SELECT id, email, name, password_hash FROM users WHERE email = $1", [dto.email.trim()])
    const user = r.rows[0]
    // Verify against a real hash even for unknown emails so response time doesn't reveal accounts.
    const ok = await verify(user?.password_hash ?? (await (dummy ??= hash("timing-equaliser"))), dto.password).catch(() => false)
    if (!user || !ok) throw new UnauthorizedException("Email or password is incorrect")
    this.setSession(res, user.id)
    return { user: { id: user.id, email: user.email, name: user.name } }
  }

  @Public()
  @Post("logout")
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  }

  /** For the live-updates socket when it connects to the API on another origin. */
  @Get("socket-token")
  socketToken(@CurrentUser() user: AuthUser) {
    return { token: signSocketToken(user.id) }
  }

  @Get("me")
  async me(@CurrentUser() user: AuthUser) {
    const orgs = await this.db.query(
      "SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name",
      [user.id],
    )
    return {
      user,
      organizations: orgs.rows.map((o) => ({ ...o, permissions: [...ROLE_PERMISSIONS[o.role as keyof typeof ROLE_PERMISSIONS]] })),
    }
  }
}
