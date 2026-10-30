import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate, useLocation, useParams } from "react-router-dom"
import { io, type Socket } from "socket.io-client"
import { api, ApiError, type Org, type User } from "./api"

type Me = { user: User; organizations: Org[] }

/** API origin for live updates when it differs from the app's (e.g. https://switchboard-api.onrender.com). */
const SOCKET_URL: string | undefined = import.meta.env.VITE_SOCKET_URL || undefined

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    queryFn: () => api<Me>("/auth/me").catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: 60_000,
  })
}

/** Gate for signed-in pages. Remembers where you were going. */
export function RequireUser({ children }: { children: ReactNode }) {
  const me = useMe()
  const loc = useLocation()
  if (me.isLoading) return <div className="boot" aria-busy="true" />
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

type OrgCtx = { org: Org; user: User; can: (p: string) => boolean; socket: Socket | null }
const Ctx = createContext<OrgCtx | null>(null)
export const useOrg = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error("useOrg outside OrgProvider")
  return c
}

export type LiveEvent =
  | { type: "ticket.created"; ticketId: string; number: number }
  | { type: "ticket.updated"; ticketId: string; number: number; changes: Record<string, unknown> }
  | { type: "message.created"; ticketId: string; number: number; messageId: string; internal: boolean }
  | { type: "sla.breached"; ticketId: string; number: number; kind: string }

/**
 * Resolves the org from the URL slug and opens one socket for it. Live events invalidate the
 * matching queries, so every open screen refreshes itself without polling.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams()
  const me = useMe()
  const qc = useQueryClient()
  const org = me.data?.organizations.find((o) => o.slug === slug)
  const [socket, setSocket] = useState<Socket | null>(null)
  const orgId = org?.id

  useEffect(() => {
    if (!orgId) return
    const opts = { path: "/socket.io", withCredentials: true, transports: ["websocket", "polling"] }
    // On Vercel the socket goes straight to the API (rewrites can't carry WebSockets), so it
    // authenticates with a short-lived token instead of the cookie. Fetched on every reconnect.
    const s = SOCKET_URL
      ? io(SOCKET_URL, { ...opts, auth: (cb) => void api<{ token: string }>("/auth/socket-token").then(({ token }) => cb({ token }), () => cb({})) })
      : io(opts)
    const subscribe = () => s.emit("subscribe", { orgId })
    s.on("connect", subscribe)
    s.on("event", (e: LiveEvent) => {
      qc.invalidateQueries({ queryKey: ["tickets", orgId] })
      qc.invalidateQueries({ queryKey: ["ticket", orgId, e.number] })
      if (e.type === "ticket.created" || e.type === "sla.breached") qc.invalidateQueries({ queryKey: ["reports", orgId] })
    })
    setSocket(s)
    return () => {
      s.disconnect()
      setSocket(null)
    }
  }, [orgId, qc])

  if (me.isLoading) return <div className="boot" aria-busy="true" />
  if (!me.data || !org) return <Navigate to="/" replace />
  return <Ctx.Provider value={{ org, user: me.data.user, can: (p) => org.permissions.includes(p), socket }}>{children}</Ctx.Provider>
}

export type Viewer = { userId: string; name: string; typing: boolean }

/** Who else has this ticket open, and whether they're typing. */
export function usePresence(ticketId: string | undefined) {
  const { org, socket } = useOrg()
  const [viewers, setViewers] = useState<Viewer[]>([])
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const typingNow = useRef(false)

  useEffect(() => {
    if (!socket || !ticketId) return
    const join = () => socket.emit("ticket:view", { orgId: org.id, ticketId })
    const onPresence = (p: { ticketId: string; viewers: Viewer[] }) => p.ticketId === ticketId && setViewers(p.viewers)
    if (socket.connected) join()
    socket.on("connect", join)
    socket.on("presence", onPresence)
    // Presence entries expire server-side; refresh while the ticket is open.
    const keepAlive = setInterval(join, 60_000)
    return () => {
      clearInterval(keepAlive)
      socket.off("connect", join)
      socket.off("presence", onPresence)
      socket.emit("ticket:leave", { ticketId })
      setViewers([])
    }
  }, [socket, ticketId, org.id])

  const typing = () => {
    if (!socket || !ticketId) return
    if (!typingNow.current) {
      typingNow.current = true
      socket.emit("ticket:typing", { ticketId, typing: true })
    }
    clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => {
      typingNow.current = false
      socket.emit("ticket:typing", { ticketId, typing: false })
    }, 3000)
  }
  return { viewers, typing }
}
