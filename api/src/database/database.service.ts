import { Injectable, OnModuleDestroy } from "@nestjs/common"
import pg from "pg"
import { config } from "../config"

pg.types.setTypeParser(20, (v) => Number(v))

export type Q = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => Promise<pg.QueryResult<T>>

/** Who is acting inside a tenant transaction. */
export type TenantContext = { orgId: string; userId?: string | null }

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: config().DATABASE_URL, max: config().DB_POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })

  constructor() {
    // An idle connection closed by the server or a pooler (e.g. Supabase) emits here; without a
    // listener it would crash the process. The pool discards that connection and opens a new one.
    this.pool.on("error", (err) => console.error(`database: idle connection error: ${err.message}`))
  }

  /** Unscoped query as the owner role. Only for global tables and background jobs. */
  query: Q = (text, params) => this.pool.query(text, params as unknown[])

  async tx<T>(fn: (q: Q, client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    // The pool only listens for errors on idle connections. If this one drops between queries,
    // the next query fails (and the transaction rolls back) instead of the process crashing.
    let broken: Error | undefined
    const onError = (err: Error) => {
      broken = err
      console.error(`database: connection error during transaction: ${err.message}`)
    }
    client.on("error", onError)
    try {
      await client.query("BEGIN")
      const out = await fn((t, p) => client.query(t, p as unknown[]), client)
      await client.query("COMMIT")
      return out
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.off("error", onError)
      // Passing the error makes the pool discard the connection rather than reuse it.
      client.release(broken)
    }
  }

  /**
   * Runs `fn` in a transaction scoped to one organization. The role switch makes PostgreSQL's
   * row-level security policies apply, so every query inside only sees this org's rows.
   */
  tenant<T>(ctx: TenantContext, fn: (q: Q) => Promise<T>): Promise<T> {
    return this.tx(async (q) => {
      await q("SET LOCAL ROLE switchboard_tenant")
      await q("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ctx.orgId, ctx.userId ?? ""])
      return fn(q)
    })
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
