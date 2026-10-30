import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { api, ApiError, type Attachment, type AuditEvent, type Member, type Message, type Status, type Team, type TicketDetail } from "../api"
import { Avatar, Button, ErrorNote, PriorityMark, SlaChip, StatusPlug, useNow } from "../components/ui"
import { ago, bytes, countdown, NEXT, PRIORITY_LABEL, STATUS_LABEL } from "../format"
import { useOrg, usePresence } from "../session"

export function TicketView({ number, backTo }: { number: number; backTo: string }) {
  const { org, user, can } = useOrg()
  const qc = useQueryClient()
  const key = ["ticket", org.id, number]
  const q = useQuery<TicketDetail>({ queryKey: key, queryFn: () => api(`/orgs/${org.id}/tickets/${number}`) })
  const { viewers, typing } = usePresence(q.data?.ticket.id)
  const others = viewers.filter((v) => v.userId !== user.id)

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<TicketDetail>(`/orgs/${org.id}/tickets/${number}`, { method: "PATCH", body }),
    onSuccess: (d) => {
      qc.setQueryData(key, d)
      qc.invalidateQueries({ queryKey: ["tickets", org.id] })
    },
  })

  if (q.error) return <div className="pad"><Link to={backTo} className="back">Back to tickets</Link><ErrorNote error={q.error} /></div>
  if (!q.data) return <div className="pad muted" aria-busy="true">Loading ticket…</div>
  const { ticket: t, messages, events } = q.data
  const editable = can("tickets.write") && t.status !== "closed"

  return (
    <div className="ticket">
      <div className="ticket-main">
        <header className="ticket-head">
          <Link to={backTo} className="back">Back to tickets</Link>
          <div className="ticket-title">
            <span className={`jack status-${t.status}`}>#{t.number}</span>
            <Subject value={t.subject} editable={editable} onSave={(subject) => patch.mutate({ subject })} />
          </div>
          <div className="ticket-sub">
            <StatusPlug status={t.status} />
            <PriorityMark priority={t.priority} />
            <span className="muted">
              {t.requester.name} via {t.channel === "portal" ? "help center" : t.channel}, {ago(t.createdAt)}
            </span>
          </div>
          {others.length > 0 && (
            <p className={`presence ${others.some((o) => o.typing) ? "is-typing" : ""}`} role="status">
              {others.map((o) => <Avatar key={o.userId} name={o.name} size={22} />)}
              <span>
                {others.find((o) => o.typing) ? `${others.find((o) => o.typing)!.name} is replying…` : `${others.map((o) => o.name).join(", ")} ${others.length > 1 ? "are" : "is"} also viewing`}
              </span>
            </p>
          )}
        </header>
        <ErrorNote error={patch.error} />
        <Timeline messages={messages} events={events} orgId={org.id} />
        {t.status === "closed" ? (
          <p className="closed-note">This ticket is closed. If the customer writes again, a new ticket opens.</p>
        ) : can("tickets.note") || can("tickets.write") ? (
          <Composer number={number} status={t.status} onTyping={typing} />
        ) : null}
      </div>
      <Sidebar detail={q.data} editable={editable} onPatch={(b) => patch.mutate(b)} busy={patch.isPending} />
    </div>
  )
}

function Subject({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  if (!editing)
    return (
      <h1 className="subject" onDoubleClick={() => editable && setEditing(true)} title={editable ? "Double-click to rename" : undefined}>
        {value}
      </h1>
    )
  return (
    <form
      className="subject-form"
      onSubmit={(e) => {
        e.preventDefault()
        const v = String(new FormData(e.currentTarget).get("subject") ?? "").trim()
        if (v && v !== value) onSave(v)
        setEditing(false)
      }}
    >
      <input name="subject" defaultValue={value} autoFocus aria-label="Subject" onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
    </form>
  )
}

type Item = { kind: "message"; at: string; m: Message } | { kind: "event"; at: string; e: AuditEvent }

function Timeline({ messages, events, orgId }: { messages: Message[]; events: AuditEvent[]; orgId: string }) {
  const items: Item[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.createdAt, m })),
    ...events.filter((e) => e.action !== "ticket.created").map((e) => ({ kind: "event" as const, at: e.createdAt, e })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return (
    <ol className="timeline">
      {items.map((it) =>
        it.kind === "message" ? (
          <li key={it.m.id} className={`msg msg-${it.m.authorType} ${it.m.internal ? "msg-note" : ""}`}>
            <div className="msg-head">
              <Avatar name={it.m.authorName} size={26} />
              <strong>{it.m.authorName}</strong>
              {it.m.internal && <span className="note-tag">Internal note</span>}
              <time dateTime={it.m.createdAt} title={new Date(it.m.createdAt).toLocaleString()}>
                {ago(it.m.createdAt)}
              </time>
            </div>
            <div className="msg-body">{it.m.body}</div>
            {it.m.attachments.length > 0 && <Files files={it.m.attachments} href={(a) => `/api/orgs/${orgId}/attachments/${a.id}`} />}
          </li>
        ) : (
          <li key={`e${it.e.id}`} className="event">
            <span>{describe(it.e)}</span>
            <time dateTime={it.e.createdAt}>{ago(it.e.createdAt)}</time>
          </li>
        ),
      )}
    </ol>
  )
}

export function Files({ files, href }: { files: Attachment[]; href: (a: Attachment) => string }) {
  return (
    <ul className="files">
      {files.map((a) => (
        <li key={a.id}>
          <a href={href(a)} target="_blank" rel="noreferrer">
            {a.contentType.startsWith("image/") ? <img src={href(a)} alt="" loading="lazy" /> : <span className="file-icon" aria-hidden>{a.filename.split(".").pop()?.slice(0, 4)}</span>}
            <span>
              {a.filename} <span className="muted">{bytes(a.size)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function describe(e: AuditEvent): ReactNode {
  const who = e.actorName
  if (e.action === "sla.breached") return `Missed the ${e.changes.kind === "first_response" ? "first response" : "resolution"} target`
  if (e.changes.reason === "auto_close") return "Closed automatically after a week with no reply"
  const parts: string[] = []
  const c = e.changes
  if (c.status) parts.push(`set status to ${STATUS_LABEL[c.status.to as Status].toLowerCase()}`)
  if (c.priority) parts.push(`changed priority to ${PRIORITY_LABEL[c.priority.to as keyof typeof PRIORITY_LABEL].toLowerCase()}`)
  if (c.assignee_id) parts.push(c.assignee_id.to ? "reassigned the ticket" : "unassigned the ticket")
  if (c.team_id) parts.push(c.team_id.to ? "moved it to another team" : "removed the team")
  if (c.tags) parts.push(`updated tags`)
  if (c.subject) parts.push(`renamed it to “${c.subject.to}”`)
  return `${who} ${parts.join(", ") || e.action}`
}

function Composer({ number, status, onTyping }: { number: number; status: Status; onTyping: () => void }) {
  const { org, can } = useOrg()
  const qc = useQueryClient()
  const [mode, setMode] = useState<"reply" | "note">(can("tickets.write") ? "reply" : "note")
  const [body, setBody] = useState("")
  const [after, setAfter] = useState<Status | "">("")
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const send = useMutation({
    mutationFn: (sendStatus?: Status) =>
      api(`/orgs/${org.id}/tickets/${number}/messages`, { body: { body, internal: mode === "note", status: sendStatus, attachmentIds: files.map((f) => f.id) } }),
    onSuccess: () => {
      setBody("")
      setFiles([])
      setAfter("")
      qc.invalidateQueries({ queryKey: ["ticket", org.id, number] })
      qc.invalidateQueries({ queryKey: ["tickets", org.id] })
    },
  })

  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setUploading(true)
    setUploadError(null)
    try {
      for (const f of Array.from(list)) {
        const fd = new FormData()
        fd.append("file", f)
        const r = await api<{ attachment: Attachment }>(`/orgs/${org.id}/tickets/${number}/attachments`, { body: fd })
        setFiles((prev) => [...prev, r.attachment])
      }
    } catch (e) {
      setUploadError((e as ApiError).message)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const options = NEXT[status].filter((s) => s !== "open" || status !== "new")
  return (
    <form
      className={`composer composer-${mode}`}
      onSubmit={(e) => {
        e.preventDefault()
        send.mutate(mode === "reply" ? after || undefined : undefined)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        upload(e.dataTransfer.files)
      }}
    >
      <div className="composer-tabs" role="tablist">
        {can("tickets.write") && (
          <button type="button" role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")}>
            Reply to customer
          </button>
        )}
        {can("tickets.note") && (
          <button type="button" role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")}>
            Internal note
          </button>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          if (mode === "reply") onTyping()
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && body.trim()) send.mutate(mode === "reply" ? after || undefined : undefined)
        }}
        placeholder={mode === "reply" ? "Write a reply. The customer gets it by email." : "Only your team sees notes."}
        aria-label={mode === "reply" ? "Reply" : "Internal note"}
        rows={5}
      />
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f) => (
            <li key={f.id}>
              {f.filename} <span className="muted">{bytes(f.size)}</span>
              <button type="button" className="link" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.filename}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploadError && <p className="error-note">{uploadError}</p>}
      <ErrorNote error={send.error} />
      <div className="composer-actions">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <button type="button" className="btn btn-quiet" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "Attach files"}
        </button>
        <span className="spacer" />
        {mode === "reply" && options.length > 0 && (
          <label className="then">
            <span>Then</span>
            <select value={after} onChange={(e) => setAfter(e.target.value as Status | "")} aria-label="Status after sending">
              <option value="">{status === "new" ? "Mark open" : `Keep ${STATUS_LABEL[status].toLowerCase()}`}</option>
              {options.map((s) => (
                <option key={s} value={s}>
                  Mark {STATUS_LABEL[s].toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button busy={send.isPending} disabled={!body.trim()}>
          {mode === "reply" ? "Send reply" : "Add note"}
        </Button>
      </div>
    </form>
  )
}

function Sidebar({ detail, editable, onPatch, busy }: { detail: TicketDetail; editable: boolean; onPatch: (b: Record<string, unknown>) => void; busy: boolean }) {
  const { org, user, can } = useOrg()
  const t = detail.ticket
  const now = useNow(15_000)
  const members = useQuery<{ members: Member[] }>({ queryKey: ["members", org.id], queryFn: () => api(`/orgs/${org.id}/members`), staleTime: 60_000 })
  const teams = useQuery<{ teams: Team[] }>({ queryKey: ["teams", org.id], queryFn: () => api(`/orgs/${org.id}/teams`), staleTime: 60_000 })
  const [tag, setTag] = useState("")
  const assignable = (members.data?.members ?? []).filter((m) => m.role !== "viewer")
  const canAssignOthers = can("tickets.assign")

  return (
    <aside className="side" aria-label="Ticket details" aria-busy={busy}>
      <section>
        <h2>Status</h2>
        <select value={t.status} disabled={!editable} onChange={(e) => onPatch({ status: e.target.value })} aria-label="Status">
          <option value={t.status}>{STATUS_LABEL[t.status]}</option>
          {NEXT[t.status].map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {t.status === "solved" && can("tickets.write") && (
          <button className="link" onClick={() => onPatch({ status: "open" })}>
            Reopen
          </button>
        )}
      </section>
      <section>
        <h2>Priority</h2>
        <div className="seg" role="radiogroup" aria-label="Priority">
          {(["low", "normal", "high", "urgent"] as const).map((p) => (
            <button key={p} role="radio" aria-checked={t.priority === p} disabled={!editable} className={`seg-${p}`} onClick={() => onPatch({ priority: p })}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2>Assignee</h2>
        {canAssignOthers ? (
          <select value={t.assignee?.id ?? ""} disabled={!editable} onChange={(e) => onPatch({ assigneeId: e.target.value || null })} aria-label="Assignee">
            <option value="">Unassigned</option>
            {assignable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.id === user.id ? " (you)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <p>{t.assignee?.name ?? "Unassigned"}</p>
        )}
        {editable && t.assignee?.id !== user.id && can("tickets.write") && (
          <button className="link" onClick={() => onPatch({ assigneeId: user.id })}>
            Take it
          </button>
        )}
      </section>
      <section>
        <h2>Team</h2>
        <select value={t.team?.id ?? ""} disabled={!editable} onChange={(e) => onPatch({ teamId: e.target.value || null })} aria-label="Team">
          <option value="">No team</option>
          {teams.data?.teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
      </section>
      <section>
        <h2>Tags</h2>
        <ul className="tags">
          {t.tags.map((g) => (
            <li key={g}>
              {g}
              {editable && (
                <button aria-label={`Remove tag ${g}`} onClick={() => onPatch({ tags: t.tags.filter((x) => x !== g) })}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {editable && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (tag.trim()) onPatch({ tags: [...t.tags, tag] })
              setTag("")
            }}
          >
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add a tag" aria-label="Add a tag" />
          </form>
        )}
      </section>
      <section>
        <h2>Response targets</h2>
        <Target label="First reply" target={t.sla.firstResponse} now={now} />
        <Target label="Resolution" target={t.sla.resolution} now={now} />
        {t.sla.paused && <p className="muted small">The clock is paused while you wait on the customer.</p>}
      </section>
      <section>
        <h2>Customer</h2>
        <p className="customer">
          <Avatar name={t.requester.name} size={30} />
          <span>
            <strong>{t.requester.name}</strong>
            <br />
            <a href={`mailto:${t.requester.email}`}>{t.requester.email}</a>
          </span>
        </p>
        {can("contacts.read") && (
          <Link to={`/o/${org.slug}/contacts?id=${t.requester.id}`} className="link">
            Other requests from {t.requester.name.split(" ")[0]}
          </Link>
        )}
      </section>
    </aside>
  )
}

function Target({ label, target, now }: { label: string; target: TicketDetail["ticket"]["sla"]["firstResponse"]; now: number }) {
  const text =
    target.state === "met" ? "Met" : target.state === "breached" ? (target.at ? "Missed" : target.dueAt ? `Missed, ${countdown(target.dueAt, now)}` : "Missed") : target.dueAt && target.state !== "paused" ? countdown(target.dueAt, now) : undefined
  return (
    <div className="target">
      <span>{label}</span>
      <SlaChip state={target.state} text={text} />
    </div>
  )
}
