import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api"
import { ErrorNote } from "../components/ui"
import { minutes } from "../format"
import { useOrg } from "../session"

type Overview = {
  days: number
  daily: { day: string; created: number; solved: number }[]
  totals: { created: number; solved: number; medianFirstResponseMinutes: number | null; medianResolutionMinutes: number | null; firstResponseSla: number | null; resolutionSla: number | null }
  backlog: { new: number; open: number; pending: number; onHold: number; unassigned: number; breached: number; medianAgeHours: number | null }
  agents: { id: string; name: string; role: string; open: number; solved: number; replies: number; medianResolutionMinutes: number | null }[]
  byPriority: Record<string, number>
  byChannel: Record<string, number>
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

export function Reports() {
  const { org } = useOrg()
  const [days, setDays] = useState(30)
  const r = useQuery<Overview>({ queryKey: ["reports", org.id, days], queryFn: () => api(`/orgs/${org.id}/reports/overview?days=${days}&tz=${encodeURIComponent(tz)}`) })
  const d = r.data
  return (
    <div className="page">
      <div className="page-head">
        <h1>Reports</h1>
        <div className="seg" role="radiogroup" aria-label="Period">
          {[7, 30, 90].map((n) => (
            <button key={n} role="radio" aria-checked={days === n} onClick={() => setDays(n)}>
              {n} days
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={r.error} />
      {d && (
        <>
          <dl className="stats">
            <Stat label="Requests received" value={d.totals.created} />
            <Stat label="Solved" value={d.totals.solved} />
            <Stat label="Typical first reply" value={minutes(d.totals.medianFirstResponseMinutes)} note="median" />
            <Stat label="Typical time to solve" value={minutes(d.totals.medianResolutionMinutes)} note="median, excluding time waiting on customers" />
            <Stat label="First replies on time" value={pct(d.totals.firstResponseSla)} tone={tone(d.totals.firstResponseSla)} />
            <Stat label="Solved on time" value={pct(d.totals.resolutionSla)} tone={tone(d.totals.resolutionSla)} />
          </dl>

          <section className="card">
            <h2>Received and solved per day</h2>
            <Bars daily={d.daily} />
          </section>

          <div className="grid2">
            <section className="card">
              <h2>Right now</h2>
              <ul className="backlog">
                <li><span className="plug plug-new"><span className="plug-dot" />New</span><b>{d.backlog.new}</b></li>
                <li><span className="plug plug-open"><span className="plug-dot" />Open</span><b>{d.backlog.open}</b></li>
                <li><span className="plug plug-pending"><span className="plug-dot" />Waiting on customer</span><b>{d.backlog.pending}</b></li>
                <li><span className="plug plug-on_hold"><span className="plug-dot" />On hold</span><b>{d.backlog.onHold}</b></li>
                <li><span>Unassigned</span><b>{d.backlog.unassigned}</b></li>
                <li><span>Past a target</span><b className={d.backlog.breached ? "is-late" : ""}>{d.backlog.breached}</b></li>
                <li><span>Typical age of open tickets</span><b>{d.backlog.medianAgeHours == null ? "–" : `${d.backlog.medianAgeHours}h`}</b></li>
              </ul>
            </section>
            <section className="card">
              <h2>Where requests come from</h2>
              <Breakdown data={d.byChannel} labels={{ portal: "Help center", agent: "Logged by team", email: "Email", api: "API" }} />
              <h2>Priority</h2>
              <Breakdown data={d.byPriority} labels={{ urgent: "Urgent", high: "High", normal: "Normal", low: "Low" }} />
            </section>
          </div>

          <section className="card">
            <h2>Team</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Open now</th>
                    <th scope="col">Solved</th>
                    <th scope="col">Replies sent</th>
                    <th scope="col">Typical time to solve</th>
                  </tr>
                </thead>
                <tbody>
                  {d.agents.map((a) => (
                    <tr key={a.id}>
                      <th scope="row">{a.name}</th>
                      <td>{a.open}</td>
                      <td>{a.solved}</td>
                      <td>{a.replies}</td>
                      <td>{minutes(a.medianResolutionMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v)}%`)
const tone = (v: number | null) => (v == null ? undefined : v >= 90 ? "good" : v >= 75 ? "warn" : "bad")

function Stat({ label, value, note, tone }: { label: string; value: string | number; note?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <dd className="stat-note">{note}</dd>}
    </div>
  )
}

function Bars({ daily }: { daily: Overview["daily"] }) {
  const max = Math.max(1, ...daily.flatMap((d) => [d.created, d.solved]))
  const w = 100 / daily.length
  const [hover, setHover] = useState<number | null>(null)
  const h = hover == null ? null : daily[hover]
  return (
    <figure className="bars">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`Requests per day over ${daily.length} days`} onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => (
          <g key={d.day} onMouseEnter={() => setHover(i)}>
            <rect x={i * w} y={0} width={w} height={40} fill="transparent" />
            <rect x={i * w + w * 0.12} y={40 - (d.created / max) * 38} width={w * 0.36} height={(d.created / max) * 38} className="bar-created" />
            <rect x={i * w + w * 0.52} y={40 - (d.solved / max) * 38} width={w * 0.36} height={(d.solved / max) * 38} className="bar-solved" />
          </g>
        ))}
      </svg>
      <figcaption>
        <span><i className="key key-created" /> Received</span>
        <span><i className="key key-solved" /> Solved</span>
        <span className="muted">{h ? `${new Date(h.day + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${h.created} received, ${h.solved} solved` : `Peak day: ${max}`}</span>
      </figcaption>
    </figure>
  )
}

function Breakdown({ data, labels }: { data: Record<string, number>; labels: Record<string, string> }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0) || 1
  return (
    <ul className="breakdown">
      {Object.entries(labels).map(([k, label]) => (
        <li key={k}>
          <span>{label}</span>
          <span className="meter"><span style={{ width: `${((data[k] ?? 0) / total) * 100}%` }} /></span>
          <b>{data[k] ?? 0}</b>
        </li>
      ))}
    </ul>
  )
}
