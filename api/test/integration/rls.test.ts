import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Database } from "../../src/database/database.service"
import { resetDb } from "../helpers"

/**
 * Proves tenant isolation is enforced by PostgreSQL itself, independent of application code:
 * queries below deliberately have no org filter.
 */
let db: Database
let orgA: string
let orgB: string

beforeAll(async () => {
  await resetDb()
  db = new Database()
  const ids = await db.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme'), ('Globex', 'globex') RETURNING id")
  ;[orgA, orgB] = ids.rows.map((r) => r.id)
  for (const [org, n] of [[orgA, 3], [orgB, 2]] as const) {
    const c = await db.query<{ id: string }>("INSERT INTO contacts (org_id, email, name) VALUES ($1, 'c@x.com', 'C') RETURNING id", [org])
    for (let i = 1; i <= n; i++) {
      await db.query("INSERT INTO tickets (org_id, number, subject, channel, requester_id) VALUES ($1, $2, $3, 'agent', $4)", [org, i, `Ticket ${i}`, c.rows[0]!.id])
    }
  }
})
afterAll(() => db.onModuleDestroy())

describe("row-level security", () => {
  it("shows each tenant only its own rows, even with no WHERE clause", async () => {
    const a = await db.tenant({ orgId: orgA }, (q) => q("SELECT org_id FROM tickets"))
    const b = await db.tenant({ orgId: orgB }, (q) => q("SELECT org_id FROM tickets"))
    expect(a.rows).toHaveLength(3)
    expect(b.rows).toHaveLength(2)
    expect(new Set(a.rows.map((r) => r.org_id))).toEqual(new Set([orgA]))
  })

  it("blocks reads by id across tenants", async () => {
    const foreign = (await db.query("SELECT id FROM tickets WHERE org_id = $1 LIMIT 1", [orgB])).rows[0].id
    const res = await db.tenant({ orgId: orgA }, (q) => q("SELECT * FROM tickets WHERE id = $1", [foreign]))
    expect(res.rows).toHaveLength(0)
  })

  it("blocks writes into another tenant", async () => {
    const contactB = (await db.query("SELECT id FROM contacts WHERE org_id = $1", [orgB])).rows[0].id
    await expect(
      db.tenant({ orgId: orgA }, (q) => q("INSERT INTO tickets (org_id, number, subject, channel, requester_id) VALUES ($1, 99, 'x', 'agent', $2)", [orgB, contactB])),
    ).rejects.toThrow(/row-level security/)
  })

  it("makes cross-tenant updates and deletes silently affect nothing", async () => {
    const res = await db.tenant({ orgId: orgA }, async (q) => {
      const u = await q("UPDATE tickets SET subject = 'pwned' WHERE org_id = $1", [orgB])
      const d = await q("DELETE FROM tickets WHERE org_id = $1", [orgB])
      return [u.rowCount, d.rowCount]
    })
    expect(res).toEqual([0, 0])
    expect((await db.query("SELECT count(*)::int n FROM tickets WHERE org_id = $1 AND subject <> 'pwned'", [orgB])).rows[0].n).toBe(2)
  })

  it("shows nothing when no tenant is set", async () => {
    const res = await db.tx(async (q) => {
      await q("SET LOCAL ROLE switchboard_tenant")
      return q("SELECT * FROM tickets")
    })
    expect(res.rows).toHaveLength(0)
  })

  it("never exposes password hashes to the tenant role", async () => {
    await db.query("INSERT INTO users (email, name, password_hash) VALUES ('u@x.com', 'U', 'secret-hash')")
    const ok = await db.tenant({ orgId: orgA }, (q) => q("SELECT id, name, email FROM users"))
    expect(ok.rows.length).toBeGreaterThan(0)
    await expect(db.tenant({ orgId: orgA }, (q) => q("SELECT password_hash FROM users"))).rejects.toThrow(/permission denied/)
  })
})
