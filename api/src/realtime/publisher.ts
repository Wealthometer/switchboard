import { Injectable, OnModuleDestroy } from "@nestjs/common"
import { Emitter } from "@socket.io/redis-emitter"
import { createRedis } from "../common/redis"

export const orgRoom = (orgId: string) => `org:${orgId}`
export const ticketRoom = (orgId: string, ticketId: string) => `ticket:${orgId}:${ticketId}`

export type RealtimeEvent =
  | { type: "ticket.created"; ticketId: string; number: number }
  | { type: "ticket.updated"; ticketId: string; number: number; changes: Record<string, unknown> }
  | { type: "message.created"; ticketId: string; number: number; messageId: string; internal: boolean }
  | { type: "sla.breached"; ticketId: string; number: number; kind: "first_response" | "resolution" }

/**
 * Publishes through Redis using the Socket.IO emitter protocol, so any process (API replica or
 * worker) can notify every connected browser regardless of which API instance holds its socket.
 */
@Injectable()
export class RealtimePublisher implements OnModuleDestroy {
  private redis = createRedis("realtime-publisher", { maxRetriesPerRequest: null })
  private emitter = new Emitter(this.redis)

  publish(orgId: string, event: RealtimeEvent) {
    this.emitter.to(orgRoom(orgId)).emit("event", event)
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {})
  }
}
