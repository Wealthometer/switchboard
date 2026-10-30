import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react"
import type { Priority, SlaState, Status } from "../api"
import { initials, PRIORITY_LABEL, SLA_LABEL, STATUS_LABEL } from "../format"

export function Button({ variant = "primary", busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" | "danger"; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  )
}

type FieldProps = { label: string; error?: string; hint?: ReactNode }
export function Field({ label, error, hint, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input {...rest} aria-invalid={error ? true : undefined} />
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}
export function TextArea({ label, error, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea {...rest} aria-invalid={error ? true : undefined} />
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}
export function Select({ label, children, ...rest }: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select {...rest}>{children}</select>
    </label>
  )
}

/** A status "patch cord": the coloured plug that runs through the whole app. */
export function StatusPlug({ status, label = true }: { status: Status; label?: boolean }) {
  return (
    <span className={`plug plug-${status}`}>
      <span className="plug-dot" aria-hidden />
      {label ? STATUS_LABEL[status] : <span className="sr-only">{STATUS_LABEL[status]}</span>}
    </span>
  )
}

export function PriorityMark({ priority }: { priority: Priority }) {
  if (priority === "normal") return null
  return <span className={`prio prio-${priority}`}>{PRIORITY_LABEL[priority]}</span>
}

export function SlaChip({ state, text }: { state: SlaState; text?: string }) {
  if (state === "none") return null
  return <span className={`sla sla-${state}`}>{text ?? SLA_LABEL[state]}</span>
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  // Stable hue per person so colleagues are recognisable at a glance.
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 45% 88%)`, color: `hsl(${h} 50% 28%)` }} aria-hidden>
      {initials(name)}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <svg width="56" height="40" viewBox="0 0 56 40" aria-hidden>
        <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="46" cy="30" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 16c0 16 36 0 36 8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 4" />
      </svg>
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="error-note" role="alert">{error instanceof Error ? error.message : String(error)}</p>
}

/** Re-renders every `ms` so countdowns stay fresh. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
