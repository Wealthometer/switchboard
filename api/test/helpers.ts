import pg from "pg"
import { migrate } from "../src/database/migrate"

export async function resetDb() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
  await c.end()
  await migrate(process.env.DATABASE_URL!, () => {})
}
