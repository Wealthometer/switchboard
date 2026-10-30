import "reflect-metadata"
import { createApp } from "./bootstrap"
import { config } from "./config"
import { migrate } from "./database/migrate"
import { startWorker } from "./worker"

async function main() {
  // Hosts without a pre-deploy step or background workers (Render's free plan) run both here.
  if (config().MIGRATE_ON_START) await migrate(config().DATABASE_URL)
  const app = await createApp()
  if (config().RUN_WORKER) {
    const stop = await startWorker()
    process.once("SIGTERM", () => void stop("SIGTERM"))
    process.once("SIGINT", () => void stop("SIGINT"))
  }
  await app.listen(config().PORT, "0.0.0.0")
}
void main()
