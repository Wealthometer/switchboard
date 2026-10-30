import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { NavLink, Outlet, useNavigate } from "react-router-dom"
import { api } from "../api"
import { Avatar } from "../components/ui"
import { useMe, useOrg } from "../session"
import { Logo } from "./Auth"

export function Shell() {
  const { org, user, can } = useOrg()
  const me = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  useEffect(() => {
    try {
      localStorage.setItem("sb:lastOrg", org.slug)
    } catch {}
  }, [org.slug])

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" })
    qc.clear()
    nav("/login")
  }

  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <header className="rail">
        <div className="rail-brand">
          <Logo />
          {(me.data?.organizations.length ?? 0) > 1 ? (
            <select aria-label="Switch help desk" value={org.slug} onChange={(e) => nav(`/o/${e.target.value}/tickets`)}>
              {me.data!.organizations.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="rail-org">{org.name}</span>
          )}
        </div>
        <nav className="rail-nav" aria-label="Main">
          <NavLink to="tickets" end={false}>Tickets</NavLink>
          {can("contacts.read") && <NavLink to="contacts">Customers</NavLink>}
          {can("reports.read") && <NavLink to="reports">Reports</NavLink>}
          <NavLink to="settings">Settings</NavLink>
        </nav>
        <div className="rail-foot">
          <a href={`/portal/${org.slug}`} target="_blank" rel="noreferrer" className="rail-link">
            Help center
          </a>
          <div className="rail-user">
            <Avatar name={user.name} size={30} />
            <div>
              <div className="rail-user-name">{user.name}</div>
              <button className="link" onClick={signOut}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  )
}
