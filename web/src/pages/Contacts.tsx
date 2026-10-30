import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { api, type Status } from "../api"
import { Avatar, Empty, ErrorNote, StatusPlug } from "../components/ui"
import { ago } from "../format"
import { useOrg } from "../session"

type Contact = { id: string; name: string; email: string; tickets: number; openTickets: number; lastActivity: string | null }

export function Contacts() {
  const { org } = useOrg()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState("")
  const selected = params.get("id")
  const list = useQuery<{ contacts: Contact[] }>({ queryKey: ["contacts", org.id, q], queryFn: () => api(`/orgs/${org.id}/contacts?q=${encodeURIComponent(q)}`), placeholderData: keepPreviousData })
  const detail = useQuery<{ contact: Contact; tickets: { number: number; subject: string; status: Status; updatedAt: string }[] }>({
    queryKey: ["contact", org.id, selected],
    queryFn: () => api(`/orgs/${org.id}/contacts/${selected}`),
    enabled: Boolean(selected),
  })
  return (
    <div className="page">
      <h1>Customers</h1>
      <div className="split">
        <section>
          <input type="search" className="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
          <ErrorNote error={list.error} />
          {list.data?.contacts.length === 0 && <Empty title="No customers yet">Everyone who files a request shows up here.</Empty>}
          <ul className="contact-list">
            {list.data?.contacts.map((c) => (
              <li key={c.id}>
                <button className={selected === c.id ? "is-active" : ""} onClick={() => setParams({ id: c.id })}>
                  <Avatar name={c.name} />
                  <span className="grow">
                    <strong>{c.name}</strong>
                    <span className="muted">{c.email}</span>
                  </span>
                  <span className="contact-stats">
                    {c.openTickets > 0 ? `${c.openTickets} open` : `${c.tickets} total`}
                    {c.lastActivity && <span className="muted">{ago(c.lastActivity)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          {!selected && <Empty title="Choose a customer">See every request they've made.</Empty>}
          {detail.data && (
            <>
              <h2>{detail.data.contact.name}</h2>
              <p>
                <a href={`mailto:${detail.data.contact.email}`}>{detail.data.contact.email}</a>
              </p>
              <ol className="mini-tickets">
                {detail.data.tickets.map((t) => (
                  <li key={t.number}>
                    <Link to={`/o/${org.slug}/tickets/${t.number}`}>
                      <span className="num">#{t.number}</span>
                      <span className="grow">{t.subject}</span>
                      <StatusPlug status={t.status} />
                      <span className="muted">{ago(t.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
