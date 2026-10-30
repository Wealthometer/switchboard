import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Database } from "../../src/database/database.service"
import { addMember, clearEmails, createOrg, makeApp, queuedEmails, signUp } from "../app"
import { resetDb } from "../helpers"

let app: INestApplication
let owner: Awaited<ReturnType<typeof signUp>>
let org: { id: string; slug: string }
const base = () => `/api/orgs/${org.id}`

beforeAll(async () => {
  await resetDb()
  app = await makeApp()
  owner = await signUp(app, "Olivia")
  org = await createOrg(owner.agent, "acme")
})
afterAll(() => app.close())
beforeEach(() => clearEmails(app))

async function newTicket(over: Record<string, unknown> = {}) {
  const r = await owner.agent.post(`${base()}/tickets`).send({ subject: "Can't log in", body: "The reset email never arrives.", requesterEmail: "sam@customer.io", requesterName: "Sam", ...over })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.ticket as { id: string; number: number; status: string }
}

describe("tickets", () => {
  it("numbers tickets per organization and applies the SLA for its priority", async () => {
    const a = await newTicket()
    const b = await newTicket({ priority: "urgent" })
    expect(b.number).toBe(a.number + 1)
    expect(a.status).toBe("new")

    const d = (await owner.agent.get(`${base()}/tickets/${b.number}`)).body
    expect(d.ticket.requester).toMatchObject({ name: "Sam", email: "sam@customer.io" })
    const due = new Date(d.ticket.sla.firstResponse.dueAt).getTime() - new Date(d.ticket.createdAt).getTime()
    expect(Math.round(due / 60000)).toBe(60) // urgent default: 1h first response
    expect(d.ticket.sla.firstResponse.state).toBe("on_track")
    expect(d.messages).toHaveLength(1)
    expect(d.events[0].action).toBe("ticket.created")

    // A second org starts its own numbering at 1.
    const other = await signUp(app, "Otto")
    const org2 = await createOrg(other.agent)
    const t = await other.agent.post(`/api/orgs/${org2.id}/tickets`).send({ subject: "Hello there", body: "Hi", requesterEmail: "x@y.io" })
    expect(t.body.ticket.number).toBe(1)
    // …and can't see Acme's tickets, even by number.
    expect((await other.agent.get(`/api/orgs/${org.id}/tickets/${a.number}`)).status).toBe(404)
    expect((await other.agent.get(`/api/orgs/${org2.id}/tickets/${a.number + 1}`)).status).toBe(404)
  })

  it("enforces the status workflow and records history", async () => {
    const t = await newTicket()
    const bad = await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "closed" })
    expect(bad.status).toBe(409)
    expect(bad.body.error).toMatch(/new.*closed/i)

    expect((await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "solved" })).body.ticket.status).toBe("solved")
    const closed = await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "closed" })
    expect(closed.body.ticket.status).toBe("closed")
    expect((await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ priority: "high" })).status).toBe(409)
    expect((await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "hello?" })).status).toBe(409)

    const actions = closed.body.events.map((e: { action: string; changes: Record<string, { to: unknown }> }) => e.changes.status?.to ?? e.action)
    expect(actions).toEqual(["ticket.created", "solved", "closed"])
  })

  it("an agent reply opens the ticket, records first response and emails the customer", async () => {
    const t = await newTicket()
    const r = await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "Try the link I just sent." })
    expect(r.status).toBe(201)
    expect(r.body.ticket.status).toBe("open")
    const d = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body
    expect(d.ticket.sla.firstResponse.state).toBe("met")
    const mail = (await queuedEmails(app)).find((m) => m.tag === "agent_reply")!
    expect(mail).toMatchObject({ to: "sam@customer.io" })
    expect(mail.text).toContain("Try the link I just sent.")
    expect(mail.text).toMatch(/\/portal\/acme\/requests\/\d+\?token=/)
  })

  it("internal notes never email the customer and don't count as a first response", async () => {
    const t = await newTicket()
    await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "Looks like a bounce, checking SES", internal: true })
    expect((await queuedEmails(app)).filter((m) => m.tag === "agent_reply")).toHaveLength(0)
    const d = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body
    expect(d.ticket.status).toBe("new")
    expect(d.ticket.sla.firstResponse.at).toBeNull()
    expect(d.messages[1]).toMatchObject({ internal: true })
    expect((await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "x", internal: true, status: "solved" })).status).toBe(400)
  })

  it("pending pauses the SLA clock and resuming pushes the due dates out", async () => {
    const t = await newTicket()
    const before = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body.ticket.sla
    await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "Can you send a screenshot?", status: "pending" })
    const paused = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body.ticket
    expect(paused.status).toBe("pending")
    expect(paused.sla.paused).toBe(true)
    expect(paused.sla.resolution.state).toBe("paused")

    // Pretend the pause started an hour ago, then resume.
    await app.get(Database).query("UPDATE tickets SET sla_paused_at = sla_paused_at - interval '1 hour' WHERE id = $1", [t.id])
    await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "open" })
    const resumed = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body.ticket.sla
    const shift = new Date(resumed.resolution.dueAt).getTime() - new Date(before.resolution.dueAt).getTime()
    expect(Math.round(shift / 60000)).toBe(60)
    expect(resumed.paused).toBe(false)
  })

  it("assignment: members only, viewers can't be assigned, the assignee is emailed", async () => {
    const agent = await addMember(app, owner.agent, org.id, "agent", "Alan")
    const viewer = await addMember(app, owner.agent, org.id, "viewer", "Vera")
    const t = await newTicket()
    const outsider = await signUp(app, "Mallory")

    expect((await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ assigneeId: outsider.user.id })).body.fields.assigneeId).toMatch(/not a member/i)
    expect((await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ assigneeId: viewer.user.id })).body.fields.assigneeId).toMatch(/viewers/i)

    await clearEmails(app)
    const ok = await owner.agent.patch(`${base()}/tickets/${t.number}`).send({ assigneeId: agent.user.id })
    expect(ok.body.ticket).toMatchObject({ status: "open", assignee: { id: agent.user.id } })
    expect((await queuedEmails(app)).find((m) => m.tag === "assigned")?.to).toBe(agent.user.email)

    // The customer replies → the assignee hears about it.
    // (Customer replies arrive through the portal; tested there. Here: viewers are read-only.)
    expect((await viewer.agent.get(`${base()}/tickets/${t.number}`)).status).toBe(200)
    expect((await viewer.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "hi" })).status).toBe(403)
    expect((await viewer.agent.patch(`${base()}/tickets/${t.number}`).send({ status: "solved" })).status).toBe(403)
  })

  it("lists with views, counts, filters and full-text search", async () => {
    await resetDb()
    owner = await signUp(app, "Olivia")
    org = await createOrg(owner.agent, "acme")
    const a = await newTicket({ subject: "Invoice shows the wrong VAT number", tags: ["Billing"] })
    await newTicket({ subject: "Export to CSV is slow", priority: "high" })
    const c = await newTicket({ subject: "Feature request: dark mode" })
    await owner.agent.post(`${base()}/tickets/${c.number}/messages`).send({ body: "Noted, the eclipse theme ships next month", internal: true })
    await owner.agent.patch(`${base()}/tickets/${c.number}`).send({ assigneeId: owner.user.id })

    const open = (await owner.agent.get(`${base()}/tickets`)).body
    expect(open.tickets).toHaveLength(3)
    expect(open.counts).toMatchObject({ open: 3, mine: 1, unassigned: 2, pending: 0 })

    const mine = (await owner.agent.get(`${base()}/tickets?view=mine`)).body
    expect(mine.tickets.map((t: { number: number }) => t.number)).toEqual([c.number])

    expect((await owner.agent.get(`${base()}/tickets?priority=high`)).body.tickets).toHaveLength(1)
    expect((await owner.agent.get(`${base()}/tickets?tag=billing`)).body.tickets[0].number).toBe(a.number)

    const vat = (await owner.agent.get(`${base()}/tickets?q=vat%20invoice`)).body.tickets
    expect(vat.map((t: { number: number }) => t.number)).toEqual([a.number])
    // Matches inside message bodies, internal notes included, with a highlighted snippet.
    const eclipse = (await owner.agent.get(`${base()}/tickets?q=eclipse`)).body.tickets
    expect(eclipse[0].number).toBe(c.number)
    expect(eclipse[0].snippet).toContain("<<eclipse>>")
    expect((await owner.agent.get(`${base()}/tickets?q=%23${a.number}`)).body.tickets[0].number).toBe(a.number)
    expect((await owner.agent.get(`${base()}/tickets?q=sam%40customer`)).body.tickets).toHaveLength(3)

    const paged = (await owner.agent.get(`${base()}/tickets?limit=2`)).body
    expect(paged).toMatchObject({ hasMore: true, page: 1 })
    expect((await owner.agent.get(`${base()}/tickets?limit=2&page=2`)).body.tickets).toHaveLength(1)
    expect((await owner.agent.get(`${base()}/tickets?view=nonsense`)).status).toBe(400)
  })
})

describe("attachments", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082", "hex")

  it("uploads, links to a reply and downloads with safe headers", async () => {
    const t = await newTicket()
    const up = await owner.agent.post(`${base()}/tickets/${t.number}/attachments`).attach("file", png, { filename: "screen shot.png", contentType: "image/png" })
    expect(up.status, JSON.stringify(up.body)).toBe(201)
    const id = up.body.attachment.id
    const reply = await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "See attached", attachmentIds: [id] })
    expect(reply.status).toBe(201)
    // Reusing it is refused.
    expect((await owner.agent.post(`${base()}/tickets/${t.number}/messages`).send({ body: "again", attachmentIds: [id] })).status).toBe(400)

    const d = (await owner.agent.get(`${base()}/tickets/${t.number}`)).body
    expect(d.messages[1].attachments[0]).toMatchObject({ id, filename: "screen shot.png", contentType: "image/png" })

    const dl = await owner.agent.get(`${base()}/attachments/${id}`).buffer(true)
    expect(dl.status).toBe(200)
    expect(dl.headers["x-content-type-options"]).toBe("nosniff")
    expect(dl.headers["content-disposition"]).toContain("screen%20shot.png")
    expect(Buffer.compare(dl.body, png)).toBe(0)

    const stranger = await signUp(app, "Eve")
    expect((await stranger.agent.get(`${base()}/attachments/${id}`)).status).toBe(404)
  })

  it("refuses scriptable types and files whose contents don't match", async () => {
    const t = await newTicket()
    const html = await owner.agent.post(`${base()}/tickets/${t.number}/attachments`).attach("file", Buffer.from("<html><script>alert(1)</script>"), { filename: "x.html", contentType: "text/html" })
    expect(html.status).toBe(400)
    const fake = await owner.agent.post(`${base()}/tickets/${t.number}/attachments`).attach("file", Buffer.from("<svg onload=alert(1)>"), { filename: "x.png", contentType: "image/png" })
    expect(fake.body.error).toMatch(/don't match/)
    const sneaky = await owner.agent.post(`${base()}/tickets/${t.number}/attachments`).attach("file", Buffer.from("hi <script>x</script>"), { filename: "x.txt", contentType: "text/plain" })
    expect(sneaky.status).toBe(400)
    expect((await owner.agent.post(`${base()}/tickets/${t.number}/attachments`)).status).toBe(400)
  })
})

describe("contacts and audit", () => {
  it("lists contacts with ticket counts and shows the org's audit log to admins only", async () => {
    await newTicket({ requesterEmail: "lee@client.dev", requesterName: "Lee" })
    const list = (await owner.agent.get(`${base()}/contacts?q=lee`)).body.contacts
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: "Lee", tickets: 1, openTickets: 1 })
    const detail = (await owner.agent.get(`${base()}/contacts/${list[0].id}`)).body
    expect(detail.tickets).toHaveLength(1)

    const audit = (await owner.agent.get(`${base()}/audit`)).body
    expect(audit.events.length).toBeGreaterThan(0)
    expect(audit.events[0]).toHaveProperty("actorName")
    const agent = await addMember(app, owner.agent, org.id, "agent", "Ann")
    expect((await agent.agent.get(`${base()}/audit`)).status).toBe(403)
    expect((await agent.agent.get(`${base()}/contacts`)).status).toBe(200)
  })
})
