import type { INestApplication } from "@nestjs/common"
import type { AddressInfo } from "node:net"
import { io, type Socket } from "socket.io-client"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Database } from "../../src/database/database.service"
import { autoClose, cleanupUploads, scanSlaBreaches } from "../../src/jobs/jobs"
import { EmailQueue } from "../../src/notifications/email"
import { RealtimePublisher } from "../../src/realtime/publisher"
import { StorageService } from "../../src/tickets/storage.service"
import { addMember, clearEmails, createOrg, makeApp, queuedEmails, signUp } from "../app"
import { resetDb } from "../helpers"

let app: INestApplication
let owner: Awaited<ReturnType<typeof signUp>>
let org: { id: string; slug: string }
let url: string
const deps = () => ({ db: app.get(Database), realtime: app.get(RealtimePublisher), email: app.get(EmailQueue), storage: app.get(StorageService) })
const base = () => `/api/orgs/${org.id}`

beforeAll(async () => {
  await resetDb()
  app = await makeApp()
  await app.listen(0, "127.0.0.1")
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  owner = await signUp(app, "Olivia")
  org = await createOrg(owner.agent, "umbrella")
})
afterAll(() => app.close())
beforeEach(() => clearEmails(app))

async function newTicket(priority = "normal") {
  const r = await owner.agent.post(`${base()}/tickets`).send({ subject: "Printer on fire", body: "Literally", requesterEmail: "bo@client.io", priority })
  return r.body.ticket as { id: string; number: number }
}
const hours = (h: number) => new Date(Date.now() + h * 3600_000)

describe("SLA breach scan", () => {
  it("flags each target once, audits it and emails the admins when unassigned", async () => {
    const t = await newTicket("urgent") // 1h first response, 4h resolution
    expect(await scanSlaBreaches(deps())).toHaveLength(0)

    const first = await scanSlaBreaches(deps(), hours(2))
    expect(first.map((b) => [b.number, b.kind])).toEqual([[t.number, "first_response"]])
    expect(await scanSlaBreaches(deps(), hours(2))).toHaveLength(0) // idempotent
    const mail = (await queuedEmails(app)).find((m) => m.tag === "sla_breached")
    expect(mail).toMatchObject({ to: owner.user.email })

    const both = await scanSlaBreaches(deps(), hours(5))
    expect(both.map((b) => b.kind)).toEqual(["resolution"])
    const d = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body
    expect(d.events.filter((e: { action: string }) => e.action === "sla.breached")).toHaveLength(2)
    expect(d.events.find((e: { action: string }) => e.action === "sla.breached").actorName).toBe("System")
  })

  it("paused (pending) tickets don't breach; solved ones neither", async () => {
    const pending = await newTicket("urgent")
    await owner.agent.post(`${base()}/tickets/${pending.number}/messages`).send({ body: "Need more info", status: "pending" })
    const solved = await newTicket("urgent")
    await owner.agent.patch(`${base()}/tickets/${solved.number}`).send({ status: "solved" })
    const hits = await scanSlaBreaches(deps(), hours(10))
    expect(hits.map((h) => h.number)).not.toContain(pending.number)
    expect(hits.map((h) => h.number)).not.toContain(solved.number)
  })

  it("emails the assignee instead when there is one", async () => {
    const agent = await addMember(app, owner.agent, org.id, "agent", "Ari")
    const t = await newTicket("urgent")
    await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ assigneeId: agent.user.id })
    await scanSlaBreaches(deps(), hours(10)) // clear the backlog from earlier tests
    await clearEmails(app)
    const t2 = await newTicket("urgent")
    await owner.agent.patch(`${base()}/tickets/${t2.number}`).send({ assigneeId: agent.user.id })
    await clearEmails(app)
    await scanSlaBreaches(deps(), hours(2))
    expect((await queuedEmails(app)).filter((m) => m.tag === "sla_breached").map((m) => m.to)).toEqual([agent.user.email])
  })
})

describe("auto close and cleanup", () => {
  it("closes tickets solved more than AUTO_CLOSE_HOURS ago", async () => {
    const t = await newTicket()
    await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "solved" })
    expect(await autoClose(deps(), hours(24))).toHaveLength(0)
    const closed = await autoClose(deps(), hours(24 * 8))
    expect(closed.map((c) => c.number)).toContain(t.number)
    expect((await owner.agent.get(`${base()}/tickets/${t.number}`)).body.ticket.status).toBe("closed")
  })

  it("removes uploads that were never attached to a message", async () => {
    const t = await newTicket()
    const png = Buffer.from("89504e470d0a1a0a", "hex")
    const up = await owner.agent.post(`${base()}/tickets/${t.number}/attachments`).attach("file", png, { filename: "a.png", contentType: "image/png" })
    expect(up.status).toBe(201)
    expect(await cleanupUploads(deps())).toBe(0)
    expect(await cleanupUploads(deps(), hours(25))).toBeGreaterThanOrEqual(1)
    expect((await owner.agent.get(`${base()}/attachments/${up.body.attachment.id}`)).status).toBe(404)
  })
})

describe("realtime", () => {
  const connect = (cookie?: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = io(url, { path: "/socket.io", transports: ["websocket"], extraHeaders: cookie ? { Cookie: cookie } : {}, reconnection: false })
      s.on("connect", () => setTimeout(() => (s.connected ? resolve(s) : reject(new Error("kicked"))), 100))
      s.on("connect_error", reject)
      s.on("disconnect", () => reject(new Error("disconnected")))
    })
  const cookieOf = async (agent: typeof owner.agent) => {
    const r = await agent.post("/api/auth/login").send({ email: (await agent.get("/api/auth/me")).body.user.email, password: "a-long-test-password" })
    return String(r.headers["set-cookie"]).split(";")[0]!
  }
  const next = <T>(s: Socket, event: string, pred: (x: T) => boolean = () => true) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 3000)
      const h = (x: T) => {
        if (!pred(x)) return
        clearTimeout(timer)
        s.off(event, h)
        resolve(x)
      }
      s.on(event, h)
    })

  it("rejects anonymous sockets and non-members", async () => {
    await expect(connect()).rejects.toThrow()
    const stranger = await signUp(app, "Sid")
    const s = await connect(await cookieOf(stranger.agent))
    expect(await s.emitWithAck("subscribe", { orgId: org.id })).toMatchObject({ ok: false })
    s.disconnect()
  })

  it("pushes ticket events to the org and presence + typing to viewers", async () => {
    const colleague = await addMember(app, owner.agent, org.id, "agent", "Cy")
    const a = await connect(await cookieOf(owner.agent))
    const b = await connect(await cookieOf(colleague.agent))
    expect(await a.emitWithAck("subscribe", { orgId: org.id })).toEqual({ ok: true })
    expect(await b.emitWithAck("subscribe", { orgId: org.id })).toEqual({ ok: true })

    const created = next<{ type: string; number: number }>(b, "event", (e) => e.type === "ticket.created")
    const t = await newTicket()
    expect((await created).number).toBe(t.number)

    const replied = next<{ type: string; internal: boolean }>(b, "event", (e) => e.type === "message.created")
    await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "On it" })
    expect((await replied).internal).toBe(false)

    expect(await a.emitWithAck("ticket:view", { orgId: org.id, ticketId: t.id })).toEqual({ ok: true })
    const both = next<{ viewers: { name: string }[] }>(a, "presence", (p) => p.viewers.length === 2)
    await b.emitWithAck("ticket:view", { orgId: org.id, ticketId: t.id })
    expect((await both).viewers.map((v) => v.name).sort()).toEqual(["Cy", "Olivia"])

    const typing = next<{ viewers: { name: string; typing: boolean }[] }>(a, "presence", (p) => p.viewers.some((v) => v.typing))
    await b.emitWithAck("ticket:typing", { ticketId: t.id, typing: true })
    expect((await typing).viewers.find((v) => v.typing)?.name).toBe("Cy")

    const gone = next<{ viewers: unknown[] }>(a, "presence", (p) => p.viewers.length === 1)
    b.disconnect()
    await gone
    a.disconnect()
  })

  it("can't watch a ticket from another org", async () => {
    const other = await signUp(app, "Zed")
    const org2 = await createOrg(other.agent)
    const foreign = (await other.agent.post(`/api/orgs/${org2.id}/tickets`).send({ subject: "Secret thing", body: "x", requesterEmail: "q@q.io" })).body.ticket
    const s = await connect(await cookieOf(owner.agent))
    await s.emitWithAck("subscribe", { orgId: org.id })
    expect(await s.emitWithAck("ticket:view", { orgId: org.id, ticketId: foreign.id })).toMatchObject({ ok: false })
    expect(await s.emitWithAck("ticket:view", { orgId: org2.id, ticketId: foreign.id })).toMatchObject({ ok: false })
    s.disconnect()
  })
})

describe("reports", () => {
  it("summarises volume, backlog, SLA compliance and per-agent work", async () => {
    const r = await owner.agent.get(`${base()}/reports/overview?days=7&tz=Europe/Berlin`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.daily).toHaveLength(7)
    expect(r.body.daily.at(-1).created).toBeGreaterThan(0)
    expect(r.body.totals.created).toBe(r.body.daily.reduce((n: number, d: { created: number }) => n + d.created, 0))
    expect(r.body.totals.firstResponseSla).toBeGreaterThanOrEqual(0)
    expect(r.body.totals.firstResponseSla).toBeLessThanOrEqual(100)
    expect(r.body.agents.map((a: { name: string }) => a.name)).toContain("Olivia")
    expect(r.body.byPriority.urgent).toBeGreaterThan(0)
    expect((await owner.agent.get(`${base()}/reports/overview?tz=Mars/Olympus`)).status).toBe(400)
  })
})
