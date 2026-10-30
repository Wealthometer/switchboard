import jwt from "jsonwebtoken"
import { config } from "../config"

/**
 * Magic links for customers: signed, scoped to one contact in one organization, 7-day expiry.
 * A separate audience means a portal token can never be used as an agent session.
 */
type PortalClaims = { org: string; contact: string; ticket?: number }
const AUDIENCE = "switchboard-portal"

export function signPortalToken(c: PortalClaims): string {
  return jwt.sign(c, config().JWT_SECRET, { algorithm: "HS256", audience: AUDIENCE, expiresIn: "7d" })
}

export function verifyPortalToken(token: string | undefined): PortalClaims | null {
  if (!token) return null
  try {
    return jwt.verify(token, config().JWT_SECRET, { algorithms: ["HS256"], audience: AUDIENCE }) as PortalClaims
  } catch {
    return null
  }
}

export function portalLink(slug: string, number: number, orgId: string, contactId: string) {
  return `${config().APP_URL}/portal/${slug}/requests/${number}?token=${encodeURIComponent(signPortalToken({ org: orgId, contact: contactId, ticket: number }))}`
}
