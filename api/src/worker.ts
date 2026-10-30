import "reflect-metadata"
import { Worker } from "bullmq"
import nodemailer from "nodemailer"
import { createRedis } from "./common/redis"
import { config } from "./config"
import { Database } from "./database/database.service"
import { autoClose, cleanupUploads, scanSlaBreaches } from "./jobs/jobs"
import { EMAIL_QUEUE, EmailQueue, type Email } from "./notifications/email"
import { RealtimePublisher } from "./realtime/publisher"
import { StorageService } from "./tickets/storage.service"

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), service: "worker", msg, ...extra }))

/** SMTP when configured (Mailpit in docker-compose); otherwise emails are logged as JSON. */
export function createMailer() {
  const url = config().SMTP_URL
  return url ? nodemailer.createTransport(url) : nodemailer.createTransport({ jsonTransport: true })
}

export async function deliver(mailer: ReturnType<typeof createMailer>, email: Email) {
  const info = await mailer.sendMail({ from: config().MAIL_FROM, to: email.to, subject: email.subject, text: email.text, replyTo: email.replyTo, headers: { "X-Switchboard-Tag": email.tag } })
  return info.messageId
}

/** Starts the email queue consumer and the scheduled jobs; returns a function that stops them. */
export async function startWorker() {
  const db = new Database()
  const realtime = new RealtimePublisher()
  const email = new EmailQueue()
  const storage = new StorageService()
  const deps = { db, realtime, email, storage }
  const mailer = createMailer()
  const connection = createRedis("email-worker", { maxRetriesPerRequest: null })

  const worker = new Worker<Email>(
    EMAIL_QUEUE,
    async (job) => {
      const id = await deliver(mailer, job.data)
      log("email sent", { tag: job.data.tag, to: job.data.to, messageId: id, attempt: job.attemptsMade + 1 })
    },
    { connection, concurrency: 5 },
  )
  worker.on("failed", (job, err) => log("email failed", { tag: job?.data.tag, attempt: job?.attemptsMade, error: err.message }))

  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        const out = await fn()
        if ((Array.isArray(out) && out.length) || (typeof out === "number" && out)) log(`${name} done`, { count: Array.isArray(out) ? out.length : out })
      } catch (err) {
        log(`${name} failed`, { error: (err as Error).message })
      } finally {
        running = false
      }
    }
    void tick()
    return setInterval(tick, ms)
  }
  const timers = [
    every("sla-scan", 30_000, () => scanSlaBreaches(deps)),
    every("auto-close", 10 * 60_000, () => autoClose(deps)),
    every("upload-cleanup", 60 * 60_000, () => cleanupUploads(deps)),
  ]
  log("worker started", { smtp: Boolean(config().SMTP_URL) })

  return async (signal: string) => {
    log("shutting down", { signal })
    timers.forEach(clearInterval)
    await worker.close()
    await Promise.allSettled([email.onModuleDestroy(), realtime.onModuleDestroy(), db.onModuleDestroy(), connection.quit()])
  }
}

async function main() {
  const stop = await startWorker()
  const exit = async (signal: string) => {
    await stop(signal)
    process.exit(0)
  }
  process.on("SIGTERM", () => void exit("SIGTERM"))
  process.on("SIGINT", () => void exit("SIGINT"))
}

if (require.main === module) void main()
