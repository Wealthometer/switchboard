import { useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { Button, ErrorNote, Field } from "../components/ui"

export function AuthFrame({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <main className="auth">
      <section className="auth-panel">
        <Link to="/" className="wordmark" aria-label="Switchboard home">
          <Logo /> Switchboard
        </Link>
        <h1>{title}</h1>
        {children}
      </section>
      <aside className="auth-art" aria-hidden>
        <Patchbay />
        {aside}
      </aside>
    </main>
  )
}

export const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
    <circle cx="10" cy="11" r="3.4" fill="currentColor" />
    <circle cx="22" cy="21" r="3.4" fill="currentColor" />
    <path d="M10 11c0 8 12 2 12 10" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" />
  </svg>
)

/** The sign-in illustration: a patch panel with a few live cords. */
function Patchbay() {
  const cols = 6
  const rows = 5
  const jack = (c: number, r: number) => ({ x: 40 + c * 56, y: 50 + r * 64 })
  const cords: [number, number, number, number, string][] = [
    [0, 0, 3, 2, "var(--c-open)"],
    [1, 3, 4, 0, "var(--c-new)"],
    [2, 1, 5, 4, "var(--c-pending)"],
    [0, 4, 2, 2, "var(--c-solved)"],
    [3, 4, 5, 1, "var(--brass)"],
  ]
  return (
    <svg viewBox="0 0 360 360" className="patchbay">
      {Array.from({ length: cols * rows }, (_, i) => {
        const p = jack(i % cols, Math.floor(i / cols))
        return <circle key={i} cx={p.x} cy={p.y} r="9" className="jack" />
      })}
      {cords.map(([c1, r1, c2, r2, color], i) => {
        const a = jack(c1, r1)
        const b = jack(c2, r2)
        const sag = 60 + i * 12
        return (
          <g key={i} className="cord" style={{ animationDelay: `${i * 140}ms` }}>
            <path d={`M${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`} stroke={color} />
            <circle cx={a.x} cy={a.y} r="6" fill={color} />
            <circle cx={b.x} cy={b.y} r="6" fill={color} />
          </g>
        )
      })}
    </svg>
  )
}

function useAuthSubmit(path: string) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(path, { body: Object.fromEntries(new FormData(e.currentTarget)) })
      await qc.invalidateQueries({ queryKey: ["me"] })
      const next = params.get("next")
      nav(next?.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }
  return { submit, busy, error, params }
}

export function Login() {
  const { submit, busy, error, params } = useAuthSubmit("/auth/login")
  return (
    <AuthFrame title="Sign in to your help desk">
      <form onSubmit={submit} className="stack">
        <Field label="Work email" name="email" type="email" autoComplete="email" required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        {error && !Object.keys(error.fields).length && <ErrorNote error={error} />}
        <Button busy={busy}>Sign in</Button>
      </form>
      <p className="muted">
        New here? <Link to={`/register${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}>Create an account</Link>
      </p>
    </AuthFrame>
  )
}

export function Register() {
  const { submit, busy, error, params } = useAuthSubmit("/auth/register")
  return (
    <AuthFrame title="Set up your help desk">
      <form onSubmit={submit} className="stack">
        <Field label="Your name" name="name" autoComplete="name" required autoFocus error={error?.fields.name} />
        <Field label="Work email" name="email" type="email" autoComplete="email" required error={error?.fields.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} error={error?.fields.password} hint="At least 10 characters" />
        {error && !Object.keys(error.fields).length && <ErrorNote error={error} />}
        <Button busy={busy}>Create account</Button>
      </form>
      <p className="muted">
        Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}>Sign in</Link>
      </p>
    </AuthFrame>
  )
}
