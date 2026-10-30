import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"

const DIR = join(__dirname, "..", "..", "migrations")
const LOCK = 919_003

export async function migrate(databaseUrl: string, log: (m: string) => void = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK])
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name))
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue
      await client.query("BEGIN")
      try {
        await client.query(readFileSync(join(DIR, file), "utf8"))
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file])
        await client.query("COMMIT")
        log(`applied ${file}`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {})
    await client.end()
  }
}

if (require.main === module) {
  migrate(process.env.DATABASE_URL ?? "").catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
