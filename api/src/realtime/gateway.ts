import { INestApplicationContext, Logger } from "@nestjs/common"
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayInit, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets"
import { IoAdapter } from "@nestjs/platform-socket.io"
import { createAdapter } from "@socket.io/redis-adapter"
import type { Server, ServerOptions, Socket } from "socket.io"
import { SESSION_COOKIE, readSession, readSocketToken } from "../common/guards"
import { createRedis, RedisService, watchRedis } from "../common/redis"
import { config } from "../config"
import { Database } from "../database/database.service"
import { orgRoom, ticketRoom } from "./publisher"

/** Socket.IO across replicas: rooms and broadcasts go through Redis pub/sub. */
export class RedisIoAdapter extends IoAdapter {
  private pub = createRedis("socket.io-pub", { lazyConnect: true })
  private sub = watchRedis("socket.io-sub", this.pub.duplicate())

  constructor(app: INestApplicationContext) {
    super(app)
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, { ...options, cors: { origin: config().CORS_ORIGIN.split(",").map((s) => s.trim()), credentials: true } })
    server.adapter(createAdapter(this.pub, this.sub))
    return server
  }

  override async dispose() {
    await super.dispose()
    await Promise.allSettled([this.pub.quit(), this.sub.quit()])
  }
}

type Viewer = { userId: string; name: string; typing: boolean; at: number }
type Data = { user: { id: string; name: string }; orgs: Set<string>; viewing: Map<string, string> /* ticketId → orgId */ }

const cookie = (header: string | undefined, name: string) =>
  header?.split(";").map((p) => p.trim().split("=")).find(([k]) => k === name)?.[1]

/**
 * Live updates for the agent app.
 *  - `subscribe {orgId}`: receive ticket/message/SLA events for that org (members only).
 *  - `ticket:view / ticket:leave / ticket:typing`: who is looking at a ticket and who is typing,
 *    so two agents don't answer the same customer at once. Presence lives in Redis so it works
 *    across API replicas; entries expire if a replica dies without cleaning up.
 */
@WebSocketGateway({ path: "/socket.io" })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server
  private log = new Logger("Realtime")
  private static PRESENCE_TTL = 120

  constructor(
    private db: Database,
    private redis: RedisService,
  ) {}

  /**
   * Authenticates during the handshake, before any event handler can run. (Doing it in
   * handleConnection races with events the client sends immediately after connecting.)
   */
  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const session = readSocketToken(socket.handshake.auth?.token) ?? readSession(decodeURIComponent(cookie(socket.handshake.headers.cookie, SESSION_COOKIE) ?? ""))
        const user = session && (await this.db.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = $1", [session.sub])).rows[0]
        if (!user) return next(new Error("Sign in to continue"))
        socket.data = { user, orgs: new Set(), viewing: new Map() } satisfies Data
        next()
      } catch (err) {
        this.log.error(`socket auth failed: ${(err as Error).message}`)
        next(new Error("Couldn't connect, try again"))
      }
    })
  }

  handleConnection() {}

  async handleDisconnect(socket: Socket) {
    const data = socket.data as Data | undefined
    if (!data?.viewing) return
    for (const [ticketId, orgId] of data.viewing) await this.leave(socket, orgId, ticketId)
  }

  private async isMember(userId: string, orgId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) return false
    return Boolean((await this.db.query("SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, userId])).rowCount)
  }

  @SubscribeMessage("subscribe")
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { orgId?: string }) {
    const data = socket.data as Data
    const orgId = String(body?.orgId ?? "")
    if (!(await this.isMember(data.user.id, orgId))) return { ok: false, error: "Not a member of this organization" }
    data.orgs.add(orgId)
    await socket.join(orgRoom(orgId))
    return { ok: true }
  }

  private presenceKey = (orgId: string, ticketId: string) => `presence:${orgId}:${ticketId}`

  private async broadcastPresence(orgId: string, ticketId: string) {
    const key = this.presenceKey(orgId, ticketId)
    const raw = await this.redis.client.hgetall(key)
    const cutoff = Date.now() - RealtimeGateway.PRESENCE_TTL * 1000
    const viewers = Object.values(raw).map((v) => JSON.parse(v) as Viewer).filter((v) => v.at > cutoff)
    // Merge multiple tabs of the same person.
    const byUser = new Map<string, Viewer>()
    for (const v of viewers) byUser.set(v.userId, { ...v, typing: v.typing || byUser.get(v.userId)?.typing === true })
    this.server.to(ticketRoom(orgId, ticketId)).emit("presence", { ticketId, viewers: [...byUser.values()].map(({ userId, name, typing }) => ({ userId, name, typing })) })
  }

  private async setPresence(socket: Socket, orgId: string, ticketId: string, typing: boolean) {
    const data = socket.data as Data
    const key = this.presenceKey(orgId, ticketId)
    await this.redis.client.multi().hset(key, socket.id, JSON.stringify({ userId: data.user.id, name: data.user.name, typing, at: Date.now() } satisfies Viewer)).expire(key, RealtimeGateway.PRESENCE_TTL).exec()
  }

  @SubscribeMessage("ticket:view")
  async view(@ConnectedSocket() socket: Socket, @MessageBody() body: { orgId?: string; ticketId?: string }) {
    const data = socket.data as Data
    const orgId = String(body?.orgId ?? "")
    const ticketId = String(body?.ticketId ?? "")
    if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return { ok: false, error: "Ticket not found" }
    // Clients often send subscribe and ticket:view back to back on connect; don't depend on order.
    if (!data.orgs.has(orgId)) {
      const sub = await this.subscribe(socket, { orgId })
      if (!sub.ok) return sub
    }
    const exists = await this.db.tenant({ orgId, userId: data.user.id }, async (q) => (await q("SELECT 1 FROM tickets WHERE id = $1", [ticketId])).rowCount)
    if (!exists) return { ok: false, error: "Ticket not found" }
    data.viewing.set(ticketId, orgId)
    await socket.join(ticketRoom(orgId, ticketId))
    await this.setPresence(socket, orgId, ticketId, false)
    await this.broadcastPresence(orgId, ticketId)
    return { ok: true }
  }

  @SubscribeMessage("ticket:typing")
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: { ticketId?: string; typing?: boolean }) {
    const data = socket.data as Data
    const orgId = data.viewing.get(String(body?.ticketId ?? ""))
    if (!orgId) return { ok: false }
    await this.setPresence(socket, orgId, body.ticketId!, Boolean(body.typing))
    await this.broadcastPresence(orgId, body.ticketId!)
    return { ok: true }
  }

  @SubscribeMessage("ticket:leave")
  async leaveMsg(@ConnectedSocket() socket: Socket, @MessageBody() body: { ticketId?: string }) {
    const data = socket.data as Data
    const orgId = data.viewing.get(String(body?.ticketId ?? ""))
    if (orgId) await this.leave(socket, orgId, body.ticketId!)
    return { ok: true }
  }

  private async leave(socket: Socket, orgId: string, ticketId: string) {
    ;(socket.data as Data).viewing.delete(ticketId)
    await socket.leave(ticketRoom(orgId, ticketId))
    try {
      await this.redis.client.hdel(this.presenceKey(orgId, ticketId), socket.id)
      await this.broadcastPresence(orgId, ticketId)
    } catch (err) {
      this.log.warn(`presence cleanup failed: ${(err as Error).message}`)
    }
  }
}
