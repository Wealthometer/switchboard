import type { Priority, SlaState, Status } from "./api"

export const STATUS_LABEL: Record<Status, string> = { new: "New", open: "Open", pending: "Waiting on customer", on_hold: "On hold", solved: "Solved", closed: "Closed" }
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" }

/** Which statuses each status may move to (mirrors the API workflow). */
export const NEXT: Record<Status, Status[]> = {
  new: ["open", "pending", "on_hold", "solved"],
  open: ["pending", "on_hold", "solved"],
  pending: ["open", "on_hold", "solved"],
  on_hold: ["open", "pending", "solved"],
  solved: ["open", "closed"],
  closed: [],
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" })
export function ago(iso: string, now = Date.now()) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000)
  const a = Math.abs(s)
  if (a < 45) return "just now"
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute")
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour")
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), "day")
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "2h 05m left" / "40m over" */
export function countdown(iso: string, now = Date.now()) {
  const ms = new Date(iso).getTime() - now
  const m = Math.floor(Math.abs(ms) / 60000)
  const text = m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`
  return ms >= 0 ? `${text} left` : `${text} over`
}

export const SLA_LABEL: Record<SlaState, string> = { met: "Met", breached: "Missed", paused: "Paused", at_risk: "Due soon", on_track: "On track", none: "No target" }

export const minutes = (m: number | null | undefined) => {
  if (m == null) return "–"
  if (m < 60) return `${Math.round(m)}m`
  if (m < 1440) return `${(m / 60).toFixed(1)}h`
  return `${(m / 1440).toFixed(1)}d`
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
