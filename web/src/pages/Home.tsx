import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { Button, ErrorNote, Field } from "../components/ui"
import { useMe } from "../session"
import { AuthFrame } from "./Auth"

/** Sends you to your last organization, or to set one up. */
export function Home() {
  const me = useMe()
  const orgs = me.data?.organizations ?? []
  let last: string | null = null
  try {
    last = localStorage.getItem("sb:lastOrg")
  } catch {}
  const target = orgs.find((o) => o.slug === last) ?? orgs[0]
  return <Navigate to={target ? `/o/${target.slug}/tickets` : "/new-org"} replace />
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)

export function Onboarding() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [touched, setTouched] = useState(false)
  const create = useMutation({
    mutationFn: () => api("/orgs", { body: { name, slug: slug || slugify(name) } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["me"] })
      nav(`/o/${r.organization.slug}/tickets`)
    },
  })
  const err = create.error as ApiError | null
  const effective = touched ? slug : slugify(name)
  return (
    <AuthFrame title="Name your help desk">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <Field label="Company or team name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus error={err?.fields.name} />
        <Field
          label="Help center address"
          value={effective}
          onChange={(e) => {
            setTouched(true)
            setSlug(e.target.value)
          }}
          error={err?.fields.slug}
          hint={`Customers file requests at ${location.host}/portal/${effective || "your-team"}`}
        />
        {err && !Object.keys(err.fields).length && <ErrorNote error={err} />}
        <Button busy={create.isPending}>Create help desk</Button>
      </form>
      <p className="muted">We'll add a Support team and sensible response targets you can change later.</p>
    </AuthFrame>
  )
}

export function Invite() {
  const { token } = useParams()
  const me = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const inv = useQuery({ queryKey: ["invite", token], queryFn: () => api(`/invitations/${token}`), retry: false })
  const accept = useMutation({
    mutationFn: () => api(`/invitations/${token}/accept`, { method: "POST" }),
    onSuccess: async () => {
      const fresh = await qc.fetchQuery({ queryKey: ["me"], queryFn: () => api("/auth/me") })
      const org = fresh.organizations.find((o: { name: string }) => o.name === inv.data?.invitation.orgName)
      nav(org ? `/o/${org.slug}/tickets` : "/")
    },
  })
  const i = inv.data?.invitation
  const next = `/invite/${token}`
  return (
    <AuthFrame title={i ? `Join ${i.orgName}` : "Invitation"}>
      {inv.isLoading && <p className="muted">Checking your invitation…</p>}
      {inv.error && <ErrorNote error={inv.error} />}
      {i && (i.accepted || i.expired) && <p>This invitation has {i.accepted ? "already been used" : "expired"}. Ask an admin to send a new one.</p>}
      {i && !i.accepted && !i.expired && (
        <div className="stack">
          <p>
            You've been invited as {i.role === "viewer" ? "a viewer" : `an ${i.role}`}. The invitation is for <strong>{i.email}</strong>.
          </p>
          {me.data ? (
            me.data.user.email.toLowerCase() === i.email.toLowerCase() ? (
              <>
                <Button busy={accept.isPending} onClick={() => accept.mutate()}>
                  Join {i.orgName}
                </Button>
                <ErrorNote error={accept.error} />
              </>
            ) : (
              <p className="error-note">You're signed in as {me.data.user.email}. Sign out and sign in as {i.email} to accept.</p>
            )
          ) : (
            <div className="row">
              <Link className="btn btn-primary" to={`/register?next=${encodeURIComponent(next)}`}>
                Create account
              </Link>
              <Link className="btn btn-quiet" to={`/login?next=${encodeURIComponent(next)}`}>
                Sign in
              </Link>
            </div>
          )}
        </div>
      )}
    </AuthFrame>
  )
}
