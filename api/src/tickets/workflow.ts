/**
 * Ticket status rules and SLA arithmetic. Pure functions, unit-tested exhaustively.
 *
 * new ─▶ open ◀──▶ pending (waiting on customer: SLA clock paused)
 *          │ ▲  ╲
 *          ▼ │   ▶ on_hold (waiting on a third party: clock keeps running)
 *        solved ─▶ closed (final; automatic after AUTO_CLOSE_HOURS)
 */
export type Status = "new" | "open" | "pending" | "on_hold" | "solved" | "closed"
export type Priority = "low" | "normal" | "high" | "urgent"

export const ACTIVE: Status[] = ["new", "open", "pending", "on_hold"]

const TRANSITIONS: Record<Status, Status[]> = {
  new: ["open", "pending", "on_hold", "solved"],
  open: ["pending", "on_hold", "solved"],
  pending: ["open", "on_hold", "solved"],
  on_hold: ["open", "pending", "solved"],
  solved: ["open", "closed"],
  closed: [],
}

export function canTransition(from: Status, to: Status): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export function transitionError(from: Status, to: Status): string {
  if (from === "closed") return "Closed tickets can't be changed. Create a follow-up ticket instead."
  return `A ${label(from)} ticket can't move to ${label(to)}`
}

export const label = (s: Status) => s.replace("_", " ")

/** What a reply does to the status when the caller doesn't choose one. */
export function statusAfterReply(current: Status, by: "agent" | "contact", internal: boolean): Status {
  if (internal) return current
  if (by === "contact") return current === "new" ? "new" : current === "closed" ? "closed" : "open" // a customer reply reopens
  return current === "new" ? "open" : current
}

export type SlaPolicy = { first_response_minutes: number; resolution_minutes: number; enabled: boolean }

export type SlaFields = {
  created_at: Date
  first_response_at: Date | null
  first_response_due_at: Date | null
  resolution_due_at: Date | null
  sla_paused_at: Date | null
  sla_paused_seconds: number
}

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000)

/** Due times = created + target + time spent paused (waiting on the customer). */
export function dueDates(t: Pick<SlaFields, "created_at" | "sla_paused_seconds" | "first_response_at">, policy: SlaPolicy | null) {
  if (!policy?.enabled) return { first_response_due_at: null, resolution_due_at: null }
  return {
    first_response_due_at: t.first_response_at ? null : addSeconds(t.created_at, policy.first_response_minutes * 60 + t.sla_paused_seconds),
    resolution_due_at: addSeconds(t.created_at, policy.resolution_minutes * 60 + t.sla_paused_seconds),
  }
}

/** Entering "pending" pauses the clock; leaving it pushes every due time back by the pause. */
export function slaOnStatusChange(t: SlaFields, from: Status, to: Status, now: Date): Partial<SlaFields> {
  if (to === "pending" && from !== "pending") return { sla_paused_at: now }
  if (from === "pending" && to !== "pending" && t.sla_paused_at) {
    const paused = Math.max(0, Math.round((now.getTime() - t.sla_paused_at.getTime()) / 1000))
    return {
      sla_paused_at: null,
      sla_paused_seconds: t.sla_paused_seconds + paused,
      first_response_due_at: t.first_response_due_at ? addSeconds(t.first_response_due_at, paused) : null,
      resolution_due_at: t.resolution_due_at ? addSeconds(t.resolution_due_at, paused) : null,
    }
  }
  return {}
}

export type SlaState = "met" | "breached" | "paused" | "at_risk" | "on_track" | "none"

/** Display state for one SLA target. "At risk" = under 25% of the target window left. */
export function slaState(opts: { due: Date | null; doneAt: Date | null; breached: boolean; paused: boolean; windowSeconds: number | null; now: Date }): SlaState {
  const { due, doneAt, breached, paused, windowSeconds, now } = opts
  if (doneAt) return breached || (due && doneAt > due) ? "breached" : "met"
  if (!due) return "none"
  if (breached || due < now) return "breached"
  if (paused) return "paused"
  const left = (due.getTime() - now.getTime()) / 1000
  return windowSeconds && left < windowSeconds * 0.25 ? "at_risk" : "on_track"
}
