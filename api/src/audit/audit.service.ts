import { Injectable } from "@nestjs/common"
import type { Q } from "../database/database.service"

export type Actor = { type: "agent" | "contact" | "system"; id: string | null }

export type AuditEntry = {
  actor: Actor
  entityType: "ticket" | "member" | "team" | "sla_policy" | "invitation" | "organization"
  entityId: string | null
  ticketId?: string | null
  action: string
  changes?: Record<string, unknown>
}

/** Append-only history. Always written in the same transaction as the change it describes. */
@Injectable()
export class AuditService {
  async record(q: Q, orgId: string, e: AuditEntry) {
    await q(
      "INSERT INTO audit_events (org_id, actor_type, actor_id, entity_type, entity_id, ticket_id, action, changes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [orgId, e.actor.type, e.actor.id, e.entityType, e.entityId, e.ticketId ?? null, e.action, e.changes ?? {}],
    )
  }

  /** Field-by-field diff of the keys present in `after`. */
  diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const [k, v] of Object.entries(after)) {
      if (v === undefined) continue
      const prev = before[k]
      if (JSON.stringify(prev) !== JSON.stringify(v)) changes[k] = { from: prev ?? null, to: v }
    }
    return changes
  }
}
