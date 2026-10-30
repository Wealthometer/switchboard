import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { api, ApiError, type Attachment } from "../api"
import { Button, ErrorNote, Field, TextArea } from "../components/ui"
import { ago } from "../format"
import { Files } from "./TicketView"

/**
 * The customer's side. The emailed link carries a token; we move it out of the address bar into
 * session storage so it isn't left in history or shared by accident when copying the URL.
 */
function usePortalToken(slug: string) {
  const [params, setParams] = useSearchParams()
  const key = `sb:portal:${slug}`
  const fromUrl = params.get("token")
  const [token, setToken] = useState<string | null>(() => {
    try {
      return fromUrl ?? sessionStorage.getItem(key)
    } catch {
      return fromUrl
    }
  })
  useEffect(() => {
    if (!fromUrl) return
    try {
      sessionStorage.setItem(key, fromUrl)
    } catch {}
    setToken(fromUrl)
    const next = new URLSearchParams(params)
    next.delete("token")
    setParams(next, { replace: true })
  }, [fromUrl])
  const forget = () => {
    try {
      sessionStorage.removeItem(key)
    } catch {}
    setToken(null)
  }
  return { token, forget }
}

function PortalFrame({ name, children }: { name?: string; children: ReactNode }) {
  const { slug } = useParams()
  return (
    <div className="portal">
      <header className="portal-head">
        <Link to={`/portal/${slug}`} className="portal-name">
          {name ?? "Help center"}
        </Link>
      </header>
      <main className="portal-main">{children}</main>
      <footer className="portal-foot">Support by Switchboard</footer>
    </div>
  )
}

const useOrgInfo = (slug: string) => useQuery<{ organization: { name: string } }>({ queryKey: ["portal", slug], queryFn: () => api(`/portal/${slug}`), retry: false })

export function PortalHome() {
  const { slug = "" } = useParams()
  const info = useOrgInfo(slug)
  const { token } = usePortalToken(slug)
  const mine = useQuery<{ contact: { name: string }; requests: { number: number; subject: string; status: string; updatedAt: string }[] }>({
    queryKey: ["portal-mine", slug, token],
    queryFn: () => api(`/portal/${slug}/requests`, { token: token! }),
    enabled: Boolean(token),
    retry: false,
  })
  const [sent, setSent] = useState<number | null>(null)
  const submit = useMutation({ mutationFn: (b: Record<string, string>) => api(`/portal/${slug}/requests`, { body: b }), onSuccess: (r) => setSent(r.number ?? 0) })
  const access = useMutation({ mutationFn: (email: string) => api(`/portal/${slug}/access`, { body: { email } }) })
  const err = submit.error as ApiError | null

  if (info.error) return <PortalFrame><h1>This help center doesn't exist</h1><p>Check the link you were given.</p></PortalFrame>
  const orgName = info.data?.organization.name
  return (
    <PortalFrame name={orgName}>
      <section className="portal-intro">
        <h1>How can {orgName ?? "we"} help?</h1>
        <p>Tell us what's going on. We reply by email, and you can follow the conversation here.</p>
      </section>

      {mine.data && mine.data.requests.length > 0 && (
        <section className="card">
          <h2>Your requests</h2>
          <ol className="mini-tickets">
            {mine.data.requests.map((r) => (
              <li key={r.number}>
                <Link to={`/portal/${slug}/requests/${r.number}`}>
                  <span className="num">#{r.number}</span>
                  <span className="grow">{r.subject}</span>
                  <span className="muted">{r.status.replace("_", " ")}, {ago(r.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {sent !== null ? (
        <section className="card portal-done" role="status">
          <h2>{sent ? `Request #${sent} received` : "Request received"}</h2>
          <p>We've emailed you a confirmation with a link to follow it. Reply to us there any time.</p>
          <button className="link" onClick={() => setSent(null)}>Send another request</button>
        </section>
      ) : (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault()
            submit.mutate(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>)
          }}
        >
          <div className="grid2">
            <Field label="Your name" name="name" autoComplete="name" required error={err?.fields.name} />
            <Field label="Email" name="email" type="email" autoComplete="email" required error={err?.fields.email} />
          </div>
          <Field label="Subject" name="subject" required error={err?.fields.subject} />
          <TextArea label="Details" name="body" rows={6} required error={err?.fields.body} placeholder="What happened, and what did you expect?" />
          {/* Honeypot for bots: hidden from people and assistive tech. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hp" aria-hidden />
          {err && !Object.keys(err.fields).length && <ErrorNote error={err} />}
          <div>
            <Button busy={submit.isPending}>Send request</Button>
          </div>
        </form>
      )}

      <section className="portal-access">
        <h2>Already wrote to us?</h2>
        {access.isSuccess ? (
          <p role="status">If that address has requests with us, a link to them is on its way.</p>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              access.mutate(String(new FormData(e.currentTarget).get("email")))
            }}
          >
            <input type="email" name="email" placeholder="you@example.com" aria-label="Your email" required />
            <Button variant="quiet" busy={access.isPending}>Email me a link</Button>
          </form>
        )}
        <ErrorNote error={access.error} />
      </section>
    </PortalFrame>
  )
}

type PortalDetail = {
  request: { number: number; subject: string; status: string; createdAt: string; agent: string | null }
  messages: { id: string; body: string; fromYou: boolean; authorName: string; createdAt: string; attachments: Attachment[] }[]
}

export function PortalRequest() {
  const { slug = "", number } = useParams()
  const info = useOrgInfo(slug)
  const { token, forget } = usePortalToken(slug)
  const qc = useQueryClient()
  const key = ["portal-request", slug, number, token]
  const q = useQuery<PortalDetail>({ queryKey: key, queryFn: () => api(`/portal/${slug}/requests/${number}`, { token: token! }), enabled: Boolean(token), retry: false })
  const [body, setBody] = useState("")
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const reply = useMutation({
    mutationFn: () => api(`/portal/${slug}/requests/${number}/messages`, { body: { body, attachmentIds: files.map((f) => f.id) }, token: token! }),
    onSuccess: () => {
      setBody("")
      setFiles([])
      qc.invalidateQueries({ queryKey: key })
    },
  })
  const expired = !token || (q.error instanceof ApiError && q.error.status === 401)

  if (expired)
    return (
      <PortalFrame name={info.data?.organization.name}>
        <section className="card">
          <h1>This link has expired</h1>
          <p>Links last a week. Enter your email on the help center and we'll send a fresh one.</p>
          <Link to={`/portal/${slug}`} className="btn btn-primary" onClick={forget}>Go to the help center</Link>
        </section>
      </PortalFrame>
    )
  const d = q.data
  return (
    <PortalFrame name={info.data?.organization.name}>
      <ErrorNote error={q.error} />
      {d && (
        <>
          <header className="portal-request-head">
            <span className="num">#{d.request.number}</span>
            <h1>{d.request.subject}</h1>
            <p className="muted">
              {d.request.status[0]!.toUpperCase() + d.request.status.slice(1)}
              {d.request.agent ? `. ${d.request.agent} is looking after this.` : "."}
            </p>
          </header>
          <ol className="timeline portal-timeline">
            {d.messages.map((m) => (
              <li key={m.id} className={`msg ${m.fromYou ? "msg-contact" : "msg-agent"}`}>
                <div className="msg-head">
                  <strong>{m.fromYou ? "You" : m.authorName}</strong>
                  <time dateTime={m.createdAt}>{ago(m.createdAt)}</time>
                </div>
                <div className="msg-body">{m.body}</div>
                {m.attachments.length > 0 && <Files files={m.attachments} href={(a) => `/api/portal/${slug}/attachments/${a.id}?token=${encodeURIComponent(token!)}`} />}
              </li>
            ))}
          </ol>
          {d.request.status === "closed" ? (
            <p className="closed-note">This request is closed. <Link to={`/portal/${slug}`}>Start a new one</Link> if you need more help.</p>
          ) : (
            <form
              className="composer composer-reply"
              onSubmit={(e) => {
                e.preventDefault()
                reply.mutate()
              }}
            >
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Add a reply" aria-label="Your reply" />
              {files.length > 0 && <ul className="pending-files">{files.map((f) => <li key={f.id}>{f.filename}</li>)}</ul>}
              {uploadErr && <p className="error-note">{uploadErr}</p>}
              <ErrorNote error={reply.error} />
              <div className="composer-actions">
                <label className="btn btn-quiet">
                  Attach a file
                  <input
                    type="file"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      setUploadErr(null)
                      const fd = new FormData()
                      fd.append("file", f)
                      try {
                        const r = await api<{ attachment: Attachment }>(`/portal/${slug}/requests/${number}/attachments`, { body: fd, token: token! })
                        setFiles((p) => [...p, r.attachment])
                      } catch (err) {
                        setUploadErr((err as Error).message)
                      }
                      e.target.value = ""
                    }}
                  />
                </label>
                <span className="spacer" />
                <Button busy={reply.isPending} disabled={!body.trim()}>Send reply</Button>
              </div>
            </form>
          )}
        </>
      )}
    </PortalFrame>
  )
}
