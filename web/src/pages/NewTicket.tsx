import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { api, ApiError, type Member } from "../api"
import { Button, ErrorNote, Field, Select, TextArea } from "../components/ui"
import { useOrg } from "../session"

/** For requests that come in by phone or chat: log them on the customer's behalf. */
export function NewTicket() {
  const { org, user, can } = useOrg()
  const nav = useNavigate()
  const [assigneeId, setAssigneeId] = useState(user.id)
  const members = useQuery<{ members: Member[] }>({ queryKey: ["members", org.id], queryFn: () => api(`/orgs/${org.id}/members`) })
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/orgs/${org.id}/tickets`, { body }),
    onSuccess: (r) => nav(`/o/${org.slug}/tickets/${r.ticket.number}`),
  })
  const err = create.error as ApiError | null
  return (
    <div className="page narrow">
      <Link to={`/o/${org.slug}/tickets`} className="back">Back to tickets</Link>
      <h1>Log a request</h1>
      <p className="muted">For requests that arrive by phone or chat. The customer won't be emailed until you reply.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
          create.mutate({ ...f, requesterName: f.requesterName || undefined, assigneeId: assigneeId || undefined, tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined })
        }}
      >
        <div className="grid2">
          <Field label="Customer email" name="requesterEmail" type="email" required error={err?.fields.requesterEmail} autoFocus />
          <Field label="Customer name" name="requesterName" hint="Optional" />
        </div>
        <Field label="Subject" name="subject" required error={err?.fields.subject} />
        <TextArea label="What do they need?" name="body" rows={7} required error={err?.fields.body} />
        <div className="grid3">
          <Select label="Priority" name="priority" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
          <Select label="Assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {(members.data?.members ?? [])
              .filter((m) => m.role !== "viewer" && (can("tickets.assign") || m.id === user.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </Select>
          <Field label="Tags" name="tags" hint="Comma separated" />
        </div>
        {err && !Object.keys(err.fields).length && <ErrorNote error={err} />}
        <div>
          <Button busy={create.isPending}>Create ticket</Button>
        </div>
      </form>
    </div>
  )
}
