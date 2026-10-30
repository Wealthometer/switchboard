/** Thin fetch wrapper. The session is an httpOnly cookie, so requests just include credentials. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message)
  }
}

type Options = { method?: string; body?: unknown; token?: string; signal?: AbortSignal }

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.body instanceof FormData) body = opts.body
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(opts.body)
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`/api${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, credentials: "include", signal: opts.signal })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : Array.isArray(data.message) ? data.message[0] : data.message ?? `Request failed (${res.status})`
    throw new ApiError(res.status, msg, data.fields ?? {})
  }
  return data as T
}

export type Role = "owner" | "admin" | "agent" | "viewer"
export type Org = { id: string; name: string; slug: string; role: Role; permissions: string[] }
export type User = { id: string; name: string; email: string }
export type Status = "new" | "open" | "pending" | "on_hold" | "solved" | "closed"
export type Priority = "low" | "normal" | "high" | "urgent"
export type SlaState = "met" | "breached" | "paused" | "at_risk" | "on_track" | "none"

export type TicketListItem = {
  id: string
  number: number
  subject: string
  status: Status
  priority: Priority
  tags: string[]
  createdAt: string
  updatedAt: string
  firstResponseDueAt: string | null
  resolutionDueAt: string | null
  slaPaused: boolean
  slaBreached: boolean
  requester: { id: string; name: string; email: string }
  assignee: { id: string; name: string } | null
  team: { id: string; name: string } | null
  replies: number
  snippet: string | null
}
export type ViewCounts = { mine: number; unassigned: number; open: number; pending: number; breaching: number }

export type Attachment = { id: string; filename: string; contentType: string; size: number }
export type Message = { id: string; body: string; internal: boolean; authorType: "agent" | "contact" | "system"; authorName: string; createdAt: string; attachments: Attachment[] }
export type AuditEvent = { id: number; action: string; changes: Record<string, any>; createdAt: string; actorType: string; actorName: string }
export type SlaTarget = { dueAt: string | null; at: string | null; state: SlaState }
export type TicketDetail = {
  ticket: {
    id: string
    number: number
    subject: string
    status: Status
    priority: Priority
    channel: string
    tags: string[]
    requester: { id: string; name: string; email: string }
    assignee: { id: string; name: string } | null
    team: { id: string; name: string } | null
    createdAt: string
    updatedAt: string
    solvedAt: string | null
    sla: { firstResponse: SlaTarget; resolution: SlaTarget; paused: boolean }
  }
  messages: Message[]
  events: AuditEvent[]
}
export type Member = { id: string; name: string; email: string; role: Role; joinedAt: string; teams: string[] }
export type Team = { id: string; name: string; members: { id: string; name: string }[]; openTickets: number }
