import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { api, type TicketListItem, type ViewCounts } from "../api"
import { Avatar, Empty, ErrorNote, PriorityMark, StatusPlug, useNow } from "../components/ui"
import { ago, countdown } from "../format"
import { useOrg } from "../session"
import { TicketView } from "./TicketView"

const VIEWS: { key: string; label: string; count?: keyof ViewCounts }[] = [
  { key: "mine", label: "Assigned to me", count: "mine" },
  { key: "unassigned", label: "Unassigned", count: "unassigned" },
  { key: "open", label: "All open", count: "open" },
  { key: "pending", label: "Waiting on customer", count: "pending" },
  { key: "breaching", label: "At risk", count: "breaching" },
  { key: "solved", label: "Solved" },
  { key: "all", label: "Everything" },
]

type ListResponse = { tickets: TicketListItem[]; page: number; hasMore: boolean; counts: ViewCounts }

export function Inbox() {
  const { org, can } = useOrg()
  const { number } = useParams()
  const [params, setParams] = useSearchParams()
  const view = params.get("view") ?? "open"
  const sort = params.get("sort") ?? "updated"
  const q = params.get("q") ?? ""
  const page = Number(params.get("page") ?? 1)
  const [search, setSearch] = useState(q)
  const now = useNow()

  // Debounce typing into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) update({ q: search || null, page: null })
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v)
    setParams(next, { replace: true })
  }

  const qs = new URLSearchParams({ view: q ? "all" : view, sort, page: String(page), ...(q ? { q } : {}) })
  const list = useQuery<ListResponse>({
    queryKey: ["tickets", org.id, qs.toString()],
    queryFn: () => api(`/orgs/${org.id}/tickets?${qs}`),
    placeholderData: keepPreviousData,
  })
  const keep = params.toString() ? `?${params}` : ""

  return (
    <div className={`inbox ${number ? "has-detail" : ""}`}>
      <aside className="views" aria-label="Views">
        {can("tickets.write") && (
          <Link to={`/o/${org.slug}/tickets/new`} className="btn btn-primary btn-block">
            New ticket
          </Link>
        )}
        <ul>
          {VIEWS.map((v) => (
            <li key={v.key}>
              <button className={`view ${view === v.key && !q ? "is-active" : ""} ${v.key === "breaching" && list.data?.counts.breaching ? "is-hot" : ""}`} onClick={() => { setSearch(""); update({ view: v.key, q: null, page: null }) }}>
                <span>{v.label}</span>
                {v.count && list.data && <span className="count">{list.data.counts[v.count]}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="list" aria-label="Tickets">
        <div className="list-head">
          <input type="search" className="search" placeholder="Search tickets, messages or #number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tickets" />
          <select aria-label="Sort" value={sort} onChange={(e) => update({ sort: e.target.value, page: null })}>
            <option value="updated">Recently updated</option>
            <option value="due">Due soonest</option>
            <option value="priority">Priority</option>
            <option value="created">Newest</option>
          </select>
        </div>
        <ErrorNote error={list.error} />
        {list.data && list.data.tickets.length === 0 && (
          <Empty title={q ? `Nothing matches “${q}”` : "No tickets here"}>
            <p>{q ? "Try fewer words, or search by customer email." : view === "mine" ? "Pick one up from Unassigned." : "New requests from your help center land here."}</p>
          </Empty>
        )}
        <ol className="rows" aria-busy={list.isFetching}>
          {list.data?.tickets.map((t) => {
            const due = !t.slaPaused && ["new", "open", "on_hold"].includes(t.status) ? [t.firstResponseDueAt, t.resolutionDueAt].filter(Boolean).sort()[0] : null
            const late = due && new Date(due).getTime() < now
            return (
              <li key={t.id}>
                <Link to={`/o/${org.slug}/tickets/${t.number}${keep}`} className={`row-link status-${t.status} ${String(t.number) === number ? "is-current" : ""}`} aria-current={String(t.number) === number ? "page" : undefined}>
                  <span className="row-top">
                    <span className="num">#{t.number}</span>
                    <span className="row-subject">{t.subject}</span>
                    <span className="row-time">{ago(t.updatedAt, now)}</span>
                  </span>
                  {t.snippet && <span className="row-snippet" dangerouslySetInnerHTML={{ __html: highlight(t.snippet) }} />}
                  <span className="row-meta">
                    <StatusPlug status={t.status} />
                    <PriorityMark priority={t.priority} />
                    <span className="row-who">{t.requester.name}</span>
                    {(t.slaBreached || due) && <span className={`row-due ${t.slaBreached || late ? "is-late" : ""}`}>{t.slaBreached ? "SLA missed" : countdown(due!, now)}</span>}
                    {t.assignee ? <Avatar name={t.assignee.name} size={22} /> : <span className="row-unassigned">Unassigned</span>}
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
        {list.data && (page > 1 || list.data.hasMore) && (
          <div className="pager">
            <button className="btn btn-quiet" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              Previous
            </button>
            <span>Page {page}</span>
            <button className="btn btn-quiet" disabled={!list.data.hasMore} onClick={() => update({ page: String(page + 1) })}>
              Next
            </button>
          </div>
        )}
      </section>

      <section className="detail" aria-label="Ticket">
        {number ? <TicketView key={number} number={Number(number)} backTo={`/o/${org.slug}/tickets${keep}`} /> : <Empty title="Pick a ticket">Choose one from the list to read and reply.</Empty>}
      </section>
    </div>
  )
}

/** Server marks matches with << >>; escape everything else before adding <mark>. */
function highlight(s: string) {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return esc.replace(/&lt;&lt;(.*?)&gt;&gt;/g, "<mark>$1</mark>")
}
