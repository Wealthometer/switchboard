import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom"
import { api, ApiError, type Member, type Role, type Team } from "../api"
import { Avatar, Button, Empty, ErrorNote, Field } from "../components/ui"
import { ago, minutes } from "../format"
import { useOrg } from "../session"

export function Settings() {
  const { can } = useOrg()
  return (
    <div className="page">
      <h1>Settings</h1>
      <nav className="tabs" aria-label="Settings">
        <NavLink to="people">People</NavLink>
        <NavLink to="teams">Teams</NavLink>
        <NavLink to="targets">Response targets</NavLink>
        {can("settings.manage") && <NavLink to="general">Help desk</NavLink>}
        {can("audit.read") && <NavLink to="activity">Activity log</NavLink>}
      </nav>
      <Routes>
        <Route index element={<Navigate to="people" replace />} />
        <Route path="people" element={<People />} />
        <Route path="teams" element={<Teams />} />
        <Route path="targets" element={<Targets />} />
        <Route path="general" element={<General />} />
        <Route path="activity" element={<Activity />} />
      </Routes>
    </div>
  )
}

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including billing-level changes and other owners",
  admin: "Manages people, teams and targets",
  agent: "Works tickets and customers",
  viewer: "Reads tickets and reports",
}

function People() {
  const { org, user, can } = useOrg()
  const qc = useQueryClient()
  const nav = useNavigate()
  const manage = can("members.manage")
  const members = useQuery<{ members: Member[] }>({ queryKey: ["members", org.id], queryFn: () => api(`/orgs/${org.id}/members`) })
  const invites = useQuery<{ invitations: { id: string; email: string; role: Role; expiresAt: string }[] }>({ queryKey: ["invites", org.id], queryFn: () => api(`/orgs/${org.id}/invitations`), enabled: manage })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["members", org.id] })
    qc.invalidateQueries({ queryKey: ["invites", org.id] })
  }
  const invite = useMutation({ mutationFn: (b: { email: string; role: string }) => api(`/orgs/${org.id}/invitations`, { body: b }), onSuccess: refresh })
  const setRole = useMutation({ mutationFn: (v: { id: string; role: Role }) => api(`/orgs/${org.id}/members/${v.id}`, { method: "PATCH", body: { role: v.role } }), onSuccess: refresh })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/orgs/${org.id}/members/${id}`, { method: "DELETE" }),
    onSuccess: async (_, id) => {
      if (id === user.id) {
        await qc.invalidateQueries({ queryKey: ["me"] })
        nav("/")
      } else refresh()
    },
  })
  const revoke = useMutation({ mutationFn: (id: string) => api(`/orgs/${org.id}/invitations/${id}`, { method: "DELETE" }), onSuccess: refresh })
  const err = invite.error as ApiError | null
  const roles: Role[] = org.role === "owner" ? ["owner", "admin", "agent", "viewer"] : ["admin", "agent", "viewer"]

  return (
    <div className="stack-lg">
      {manage && (
        <section className="card">
          <h2>Invite someone</h2>
          <form
            className="invite-form"
            onSubmit={(e) => {
              e.preventDefault()
              const f = e.currentTarget
              invite.mutate(Object.fromEntries(new FormData(f)) as { email: string; role: string }, { onSuccess: () => f.reset() })
            }}
          >
            <Field label="Email" name="email" type="email" required error={err?.fields.email} />
            <label className="field">
              <span className="field-label">Role</span>
              <select name="role" defaultValue="agent">
                {(["admin", "agent", "viewer"] as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {r[0]!.toUpperCase() + r.slice(1)}: {ROLE_HELP[r].toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <Button busy={invite.isPending}>Send invitation</Button>
          </form>
          {err && !Object.keys(err.fields).length && <ErrorNote error={err} />}
          {invite.isSuccess && <p className="ok-note">Invitation sent.</p>}
          {(invites.data?.invitations.length ?? 0) > 0 && (
            <ul className="people">
              {invites.data!.invitations.map((i) => (
                <li key={i.id}>
                  <span className="avatar-ghost" aria-hidden />
                  <span className="grow">
                    {i.email} <span className="muted">invited as {i.role}, expires {ago(i.expiresAt)}</span>
                  </span>
                  <button className="link" onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="card">
        <h2>People in {org.name}</h2>
        <ErrorNote error={setRole.error || remove.error} />
        <ul className="people">
          {members.data?.members.map((m) => (
            <li key={m.id}>
              <Avatar name={m.name} />
              <span className="grow">
                <strong>{m.name}</strong> {m.id === user.id && <span className="muted">(you)</span>}
                <span className="muted block">
                  {m.email}
                  {m.teams.length ? `, ${m.teams.join(", ")}` : ""}
                </span>
              </span>
              {manage && (m.role !== "owner" || org.role === "owner") ? (
                <select aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as Role })}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {r[0]!.toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="role">{m.role}</span>
              )}
              {(manage || m.id === user.id) && (m.role !== "owner" || org.role === "owner") && (
                <button className="link danger" onClick={() => confirm(m.id === user.id ? `Leave ${org.name}?` : `Remove ${m.name}? Their open tickets become unassigned.`) && remove.mutate(m.id)}>
                  {m.id === user.id ? "Leave" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Teams() {
  const { org, can } = useOrg()
  const qc = useQueryClient()
  const manage = can("teams.manage")
  const teams = useQuery<{ teams: Team[] }>({ queryKey: ["teams", org.id], queryFn: () => api(`/orgs/${org.id}/teams`) })
  const members = useQuery<{ members: Member[] }>({ queryKey: ["members", org.id], queryFn: () => api(`/orgs/${org.id}/members`) })
  const refresh = () => qc.invalidateQueries({ queryKey: ["teams", org.id] })
  const create = useMutation({ mutationFn: (name: string) => api(`/orgs/${org.id}/teams`, { body: { name } }), onSuccess: refresh })
  const setMembers = useMutation({ mutationFn: (v: { id: string; userIds: string[] }) => api(`/orgs/${org.id}/teams/${v.id}/members`, { method: "PUT", body: { userIds: v.userIds } }), onSuccess: refresh })
  const del = useMutation({ mutationFn: (id: string) => api(`/orgs/${org.id}/teams/${id}`, { method: "DELETE" }), onSuccess: refresh })
  const [name, setName] = useState("")
  return (
    <div className="stack-lg">
      {manage && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate(name, { onSuccess: () => setName("") })
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New team name, e.g. Billing" aria-label="New team name" required />
          <Button busy={create.isPending}>Add team</Button>
        </form>
      )}
      <ErrorNote error={create.error || setMembers.error || del.error} />
      {teams.data?.teams.length === 0 && <Empty title="No teams">Teams let you route tickets to the right people.</Empty>}
      {teams.data?.teams.map((t) => (
        <section key={t.id} className="card">
          <div className="page-head">
            <h2>{t.name}</h2>
            <span className="muted">{t.openTickets} open tickets</span>
          </div>
          <div className="chips">
            {(members.data?.members ?? [])
              .filter((m) => m.role !== "viewer")
              .map((m) => {
                const on = t.members.some((x) => x.id === m.id)
                return (
                  <label key={m.id} className={`chip ${on ? "is-on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!manage}
                      onChange={() => setMembers.mutate({ id: t.id, userIds: on ? t.members.filter((x) => x.id !== m.id).map((x) => x.id) : [...t.members.map((x) => x.id), m.id] })}
                    />
                    {m.name}
                  </label>
                )
              })}
          </div>
          {manage && (
            <button className="link danger" onClick={() => confirm(`Delete ${t.name}? Its tickets keep their history but lose the team.`) && del.mutate(t.id)}>
              Delete team
            </button>
          )}
        </section>
      ))}
    </div>
  )
}

type Policy = { id: string; priority: string; first_response_minutes: number; resolution_minutes: number; enabled: boolean }

function Targets() {
  const { org, can } = useOrg()
  const qc = useQueryClient()
  const manage = can("sla.manage")
  const q = useQuery<{ policies: Policy[] }>({ queryKey: ["sla", org.id], queryFn: () => api(`/orgs/${org.id}/sla-policies`) })
  const save = useMutation({
    mutationFn: (p: Policy) => api(`/orgs/${org.id}/sla-policies/${p.priority}`, { method: "PUT", body: { first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, enabled: p.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sla", org.id] }),
  })
  return (
    <section className="card">
      <p className="muted">How quickly your team aims to reply and solve, by priority. New targets apply to tickets created from now on. Time spent waiting on the customer doesn't count.</p>
      <ErrorNote error={save.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Priority</th>
              <th scope="col">First reply within</th>
              <th scope="col">Solve within</th>
              <th scope="col">Track</th>
              {manage && <th scope="col"><span className="sr-only">Save</span></th>}
            </tr>
          </thead>
          <tbody>
            {q.data?.policies.map((p) => (
              <PolicyRow key={p.id} p={p} manage={manage} onSave={(v) => save.mutate(v)} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PolicyRow({ p, manage, onSave }: { p: Policy; manage: boolean; onSave: (p: Policy) => void }) {
  const [fr, setFr] = useState(String(p.first_response_minutes / 60))
  const [res, setRes] = useState(String(p.resolution_minutes / 60))
  const [enabled, setEnabled] = useState(p.enabled)
  const dirty = Number(fr) * 60 !== p.first_response_minutes || Number(res) * 60 !== p.resolution_minutes || enabled !== p.enabled
  return (
    <tr>
      <th scope="row">
        <span className={`prio prio-${p.priority}`}>{p.priority[0]!.toUpperCase() + p.priority.slice(1)}</span>
      </th>
      <td>{manage ? <span className="unit"><input type="number" min="0.05" step="0.25" value={fr} onChange={(e) => setFr(e.target.value)} aria-label={`First reply hours for ${p.priority}`} /> hours</span> : minutes(p.first_response_minutes)}</td>
      <td>{manage ? <span className="unit"><input type="number" min="0.05" step="0.5" value={res} onChange={(e) => setRes(e.target.value)} aria-label={`Solve hours for ${p.priority}`} /> hours</span> : minutes(p.resolution_minutes)}</td>
      <td>
        <input type="checkbox" checked={enabled} disabled={!manage} onChange={(e) => setEnabled(e.target.checked)} aria-label={`Track ${p.priority}`} />
      </td>
      {manage && (
        <td>
          <button className="btn btn-quiet" disabled={!dirty} onClick={() => onSave({ ...p, first_response_minutes: Math.round(Number(fr) * 60), resolution_minutes: Math.round(Number(res) * 60), enabled })}>
            Save
          </button>
        </td>
      )}
    </tr>
  )
}

function General() {
  const { org } = useOrg()
  const qc = useQueryClient()
  const save = useMutation({ mutationFn: (name: string) => api(`/orgs/${org.id}`, { method: "PATCH", body: { name } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) })
  const portal = `${location.origin}/portal/${org.slug}`
  return (
    <section className="card stack narrow">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(String(new FormData(e.currentTarget).get("name")))
        }}
      >
        <Field label="Help desk name" name="name" defaultValue={org.name} required hint="Shown to customers in emails and on your help center" />
        <div>
          <Button busy={save.isPending}>Save name</Button>
        </div>
        {save.isSuccess && <p className="ok-note">Saved.</p>}
        <ErrorNote error={save.error} />
      </form>
      <div className="field">
        <span className="field-label">Help center</span>
        <p>
          Customers file and follow requests at <a href={portal} target="_blank" rel="noreferrer">{portal}</a>. Link to it from your site or email footer.
        </p>
      </div>
    </section>
  )
}

function Activity() {
  const { org } = useOrg()
  const [pages, setPages] = useState<(number | null)[]>([null])
  return (
    <section className="card">
      <ol className="activity">
        {pages.map((before, i) => (
          <ActivityPage key={i} orgId={org.id} slug={org.slug} before={before} onMore={i === pages.length - 1 ? (next) => setPages((p) => [...p, next]) : undefined} />
        ))}
      </ol>
    </section>
  )
}

function ActivityPage({ orgId, slug, before, onMore }: { orgId: string; slug: string; before: number | null; onMore?: (next: number) => void }) {
  const q = useQuery<{ events: { id: number; action: string; actorName: string; createdAt: string; ticketNumber: number | null; changes: Record<string, unknown> }[]; next: number | null }>({
    queryKey: ["audit", orgId, before],
    queryFn: () => api(`/orgs/${orgId}/audit${before ? `?before=${before}` : ""}`),
  })
  return (
    <>
      {q.data?.events.map((e) => (
        <li key={e.id}>
          <span className="grow">
            <strong>{e.actorName}</strong> {e.action.replace(/[._]/g, " ")}
            {e.ticketNumber && (
              <>
                {" "}
                on <a href={`/o/${slug}/tickets/${e.ticketNumber}`}>#{e.ticketNumber}</a>
              </>
            )}
          </span>
          <time dateTime={e.createdAt} className="muted">
            {new Date(e.createdAt).toLocaleString()}
          </time>
        </li>
      ))}
      {q.data?.next && onMore && (
        <li>
          <button className="btn btn-quiet" onClick={() => onMore(q.data!.next!)}>
            Show older
          </button>
        </li>
      )}
    </>
  )
}
