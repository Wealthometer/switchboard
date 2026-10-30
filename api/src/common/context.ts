import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common"
import type { Request } from "express"
import type { Permission, Role } from "./permissions"

export type AuthUser = { id: string; email: string; name: string }
export type OrgContext = { id: string; slug: string; name: string; role: Role }

export type AppRequest = Request & { user?: AuthUser; org?: OrgContext }

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => (ctx.switchToHttp().getRequest() as AppRequest).user!)
export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext) => (ctx.switchToHttp().getRequest() as AppRequest).org!)

export const PERMISSION_KEY = "permission"
/** Requires the current member's role to include this permission (checked by OrgGuard). */
export const Requires = (p: Permission) => SetMetadata(PERMISSION_KEY, p)

export const PUBLIC_KEY = "public"
export const Public = () => SetMetadata(PUBLIC_KEY, true)
