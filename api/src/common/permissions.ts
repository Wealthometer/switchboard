export const PERMISSIONS = [
  "tickets.read",
  "tickets.write", // reply, change status/priority/tags
  "tickets.assign",
  "tickets.note", // internal notes
  "contacts.read",
  "contacts.write",
  "reports.read",
  "teams.manage",
  "members.manage",
  "settings.manage",
  "sla.manage",
  "audit.read",
] as const
export type Permission = (typeof PERMISSIONS)[number]
export type Role = "owner" | "admin" | "agent" | "viewer"

const AGENT: Permission[] = ["tickets.read", "tickets.write", "tickets.assign", "tickets.note", "contacts.read", "contacts.write", "reports.read"]

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS),
  agent: new Set(AGENT),
  viewer: new Set(["tickets.read", "contacts.read", "reports.read"]),
}

export const can = (role: Role, p: Permission) => ROLE_PERMISSIONS[role].has(p)

/** Who may grant which role. Only owners can create or remove owners. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === "owner") return actor === "owner"
  return actor === "owner" || actor === "admin"
}
