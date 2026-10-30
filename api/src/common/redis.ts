import { CanActivate, ExecutionContext, Global, HttpException, Injectable, Module, OnModuleDestroy, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { Redis, type RedisOptions } from "ioredis"
import { config } from "../config"
import type { AppRequest } from "./context"

/**
 * Every Redis connection goes through here. ioredis reconnects by itself, but a connection without
 * an "error" listener logs a stack trace on every failed attempt; log one line instead.
 */
export function createRedis(name: string, opts: RedisOptions = {}) {
  return watchRedis(name, new Redis(config().REDIS_URL, opts))
}

export function watchRedis(name: string, client: Redis) {
  let last = ""
  client.on("error", (err: Error) => {
    if (err.message !== last) console.error(`redis (${name}): ${err.message}`)
    last = err.message
  })
  client.on("ready", () => (last = ""))
  return client
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = createRedis("app", { maxRetriesPerRequest: null, lazyConnect: false })
  async onModuleDestroy() {
    await this.client.quit().catch(() => this.client.disconnect())
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}

const RATE_KEY = "rate_limit"
/** Fixed-window limit per IP (and user, if signed in), shared across API instances via Redis. */
export const RateLimit = (name: string, limit: number, windowSeconds: number) => SetMetadata(RATE_KEY, { name, limit, windowSeconds })

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const rule = this.reflector.get<{ name: string; limit: number; windowSeconds: number } | undefined>(RATE_KEY, ctx.getHandler())
    if (!rule || !config().RATE_LIMIT) return true
    const req = ctx.switchToHttp().getRequest<AppRequest>()
    const key = `rl:${rule.name}:${req.user?.id ?? req.ip}:${Math.floor(Date.now() / 1000 / rule.windowSeconds)}`
    const n = await this.redis.client.incr(key)
    if (n === 1) await this.redis.client.expire(key, rule.windowSeconds)
    if (n > rule.limit) throw new HttpException("Too many requests. Wait a moment and try again.", 429)
    return true
  }
}
