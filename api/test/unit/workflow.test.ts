import { describe, expect, it } from "vitest"
import { canTransition, dueDates, slaOnStatusChange, slaState, statusAfterReply, transitionError, type SlaFields, type Status } from "../../src/tickets/workflow"

const T0 = new Date("2026-03-02T09:00:00Z")
const min = (n: number) => new Date(T0.getTime() + n * 60_000)
const policy = { first_response_minutes: 60, resolution_minutes: 240, enabled: true }

describe("status workflow", () => {
  it.each<[Status, Status, boolean]>([
    ["new", "open", true], ["open", "pending", true], ["pending", "open", true], ["open", "solved", true],
    ["solved", "open", true], ["solved", "closed", true], ["new", "closed", false], ["open", "closed", false],
    ["closed", "open", false], ["closed", "solved", false], ["open", "new", false], ["pending", "pending", true],
  ])("%s → %s: %s", (from, to, ok) => expect(canTransition(from, to)).toBe(ok))

  it("explains why a move is not allowed", () => {
    expect(transitionError("closed", "open")).toMatch(/follow-up/)
    expect(transitionError("open", "closed")).toBe("A open ticket can't move to closed")
  })

  it("applies sensible defaults on reply", () => {
    expect(statusAfterReply("new", "agent", false)).toBe("open")
    expect(statusAfterReply("pending", "contact", false)).toBe("open") // customer answered
    expect(statusAfterReply("solved", "contact", false)).toBe("open") // reopens
    expect(statusAfterReply("pending", "agent", true)).toBe("pending") // notes don't move tickets
    expect(statusAfterReply("closed", "contact", false)).toBe("closed")
  })
})

describe("SLA", () => {
  const base: SlaFields = { created_at: T0, first_response_at: null, first_response_due_at: min(60), resolution_due_at: min(240), sla_paused_at: null, sla_paused_seconds: 0 }

  it("computes due times from the policy", () => {
    expect(dueDates({ created_at: T0, sla_paused_seconds: 0, first_response_at: null }, policy)).toEqual({ first_response_due_at: min(60), resolution_due_at: min(240) })
    expect(dueDates({ created_at: T0, sla_paused_seconds: 0, first_response_at: min(5) }, policy).first_response_due_at).toBeNull()
    expect(dueDates({ created_at: T0, sla_paused_seconds: 0, first_response_at: null }, { ...policy, enabled: false })).toEqual({ first_response_due_at: null, resolution_due_at: null })
  })

  it("pauses while waiting on the customer and pushes due times back by the pause", () => {
    const paused = { ...base, ...slaOnStatusChange(base, "open", "pending", min(30)) }
    expect(paused.sla_paused_at).toEqual(min(30))
    const resumed = { ...paused, ...slaOnStatusChange(paused, "pending", "open", min(130)) }
    expect(resumed).toMatchObject({ sla_paused_at: null, sla_paused_seconds: 6000, first_response_due_at: min(160), resolution_due_at: min(340) })
  })

  it("keeps the clock running on hold", () => {
    expect(slaOnStatusChange(base, "open", "on_hold", min(30))).toEqual({})
  })

  it("recomputing after a pause keeps the extension", () => {
    expect(dueDates({ created_at: T0, sla_paused_seconds: 6000, first_response_at: null }, policy).resolution_due_at).toEqual(min(340))
  })

  it.each([
    [{ due: min(60), doneAt: min(30), breached: false }, min(45), "met"],
    [{ due: min(60), doneAt: min(90), breached: false }, min(95), "breached"],
    [{ due: min(60), doneAt: null, breached: false }, min(10), "on_track"],
    [{ due: min(60), doneAt: null, breached: false }, min(50), "at_risk"],
    [{ due: min(60), doneAt: null, breached: false }, min(61), "breached"],
    [{ due: null, doneAt: null, breached: false }, min(1), "none"],
  ] as const)("state %#", (o, now, state) => {
    expect(slaState({ ...o, paused: false, windowSeconds: 3600, now })).toBe(state)
  })

  it("shows paused instead of at-risk while waiting on the customer", () => {
    expect(slaState({ due: min(60), doneAt: null, breached: false, paused: true, windowSeconds: 3600, now: min(55) })).toBe("paused")
  })
})
