import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { signPortalToken } from "../../src/portal/portal-tokens"
import { addMember, clearEmails, createOrg, makeApp, queuedEmails, signUp } from "../app"
import { resetDb } from "../helpers"

let app: INestApplication
let owner: Awaited<ReturnType<typeof signUp>>
let org: { id: string; slug: string }
const http = () => request(app.getHttpServer())

beforeAll(async () => {
  await resetDb()
  app = await makeApp()
  owner = await signUp(app, "Olivia")
  org = await createOrg(owner.agent, "globex")
})
afterAll(() => app.close())
beforeEach(() => clearEmails(app))

/** Submits a request and returns the token from the confirmation email, as a customer would. */
async function submit(email = "kim@buyer.com", subject = "Order never arrived") {
  const r = await http().post("/api/portal/globex/requests").send({ name: "Kim", email, subject, body: "Ordered two weeks ago, tracking is stuck." })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body).not.toHaveProperty("token")
  const mail = (await queuedEmails(app)).find((m) => m.tag === "ticket_received" && m.to === email)!
  const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]!)
  return { number: r.body.number as number, token }
}

describe("customer portal", () => {
  it("shows the help center and 404s unknown ones", async () => {
    expect((await http().get("/api/portal/globex")).body.organization.name).toBe("Acme Support")
    expect((await http().get("/api/portal/nope")).status).toBe(404)
  })

  it("submits a request, then views and replies through the emailed link", async () => {
    const { number, token } = await submit()
    const auth = { Authorization: `Bearer ${token}` }

    const list = await http().get("/api/portal/globex/requests").set(auth)
    expect(list.body.requests.map((r: { number: number }) => r.number)).toEqual([number])

    // The agent adds a note and a public reply asking for details.
    await owner.agent.post(`/api/orgs/${org.id}/tickets/${number}/messages`).send({ body: "Courier is DPD, ring them", internal: true })
    await owner.agent.post(`/api/orgs/${org.id}/tickets/${number}/messages`).send({ body: "What's your order number?", status: "pending" })

    const view = (await http().get(`/api/portal/globex/requests/${number}`).set(auth)).body
    expect(view.request.status).toBe("awaiting your reply")
    expect(view.messages.map((m: { body: string }) => m.body)).toEqual(["Ordered two weeks ago, tracking is stuck.", "What's your order number?"])
    expect(JSON.stringify(view)).not.toContain("DPD")
    expect(view).not.toHaveProperty("events")

    // Customer replies → ticket goes back to open and the agent's inbox.
    expect((await http().post(`/api/portal/globex/requests/${number}/messages`).set(auth).send({ body: "It's #A-1009" })).status).toBe(201)
    const agentView = (await owner.agent.get(`/api/orgs/${org.id}/tickets/${number}`)).body
    expect(agentView.ticket.status).toBe("open")
    expect(agentView.messages.at(-1)).toMatchObject({ authorType: "contact", authorName: "Kim" })
  })

  it("emails the assignee when the customer replies", async () => {
    const agent = await addMember(app, owner.agent, org.id, "agent", "Aiko")
    const { number, token } = await submit("ravi@buyer.com", "Refund please")
    await owner.agent.patch(`/api/orgs/${org.id}/tickets/${number}`).send({ assigneeId: agent.user.id })
    await clearEmails(app)
    await http().post(`/api/portal/globex/requests/${number}/messages`).set({ Authorization: `Bearer ${token}` }).send({ body: "Any update?" })
    const mail = (await queuedEmails(app)).find((m) => m.tag === "customer_replied")
    expect(mail?.to).toBe(agent.user.email)
  })

  it("a link only opens its own customer's requests, in its own org", async () => {
    const kim = await submit("kim2@buyer.com")
    const lee = await submit("lee@buyer.com")
    expect((await http().get(`/api/portal/globex/requests/${lee.number}`).set({ Authorization: `Bearer ${kim.token}` })).status).toBe(404)
    expect((await http().post(`/api/portal/globex/requests/${lee.number}/messages`).set({ Authorization: `Bearer ${kim.token}` }).send({ body: "hi" })).status).toBe(404)

    const other = await signUp(app, "Hank")
    await createOrg(other.agent, "initech")
    expect((await http().get("/api/portal/initech/requests").set({ Authorization: `Bearer ${kim.token}` })).status).toBe(401)
    expect((await http().get("/api/portal/globex/requests").set({ Authorization: "Bearer junk" })).status).toBe(401)
    expect((await http().get("/api/portal/globex/requests")).status).toBe(401)
  })

  it("a portal token is never accepted as an agent session", async () => {
    const { token } = await submit("sly@buyer.com")
    const r = await http().get("/api/auth/me").set("Cookie", `sb_session=${token}`)
    expect(r.status).toBe(401)
  })

  it("expired links are refused", async () => {
    const { number } = await submit("old@buyer.com")
    const jwt = await import("jsonwebtoken")
    const contact = JSON.parse(Buffer.from(signPortalToken({ org: org.id, contact: "x" }).split(".")[1]!, "base64url").toString())
    expect(contact.aud).toBe("switchboard-portal")
    const expired = jwt.default.sign({ org: org.id, contact: "00000000-0000-0000-0000-000000000000", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!, { audience: "switchboard-portal" })
    expect((await http().get(`/api/portal/globex/requests/${number}`).set({ Authorization: `Bearer ${expired}` })).status).toBe(401)
  })

  it("access links: emailed only for known addresses, same response either way", async () => {
    await submit("pat@buyer.com", "Where is my parcel")
    await clearEmails(app)
    const known = await http().post("/api/portal/globex/access").send({ email: "PAT@buyer.com" })
    const unknown = await http().post("/api/portal/globex/access").send({ email: "nobody@buyer.com" })
    expect([known.status, unknown.status]).toEqual([202, 202])
    expect(known.body).toEqual(unknown.body)
    const mails = await queuedEmails(app)
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ tag: "portal_access", to: "pat@buyer.com" })
    expect(mails[0].text).toContain("Where is my parcel")
  })

  it("the honeypot silently drops bot submissions", async () => {
    const r = await http().post("/api/portal/globex/requests").send({ name: "Bot", email: "bot@spam.io", subject: "Buy now", body: "Cheap stuff for sale here", website: "http://spam.io" })
    expect(r.status).toBe(201)
    expect(r.body.number).toBeUndefined()
    const list = (await owner.agent.get(`/api/orgs/${org.id}/tickets?q=bot%40spam.io&view=all`)).body.tickets
    expect(list).toHaveLength(0)
  })

  it("customers can attach files and download only public ones from their requests", async () => {
    const { number, token } = await submit("fay@buyer.com")
    const auth = { Authorization: `Bearer ${token}` }
    const pdf = Buffer.from("%PDF-1.4\n%fake\n")
    const up = await http().post(`/api/portal/globex/requests/${number}/attachments`).set(auth).attach("file", pdf, { filename: "receipt.pdf", contentType: "application/pdf" })
    expect(up.status, JSON.stringify(up.body)).toBe(201)
    await http().post(`/api/portal/globex/requests/${number}/messages`).set(auth).send({ body: "Receipt attached", attachmentIds: [up.body.attachment.id] })
    expect((await http().get(`/api/portal/globex/attachments/${up.body.attachment.id}?token=${encodeURIComponent(token)}`)).status).toBe(200)

    // A file on an internal note stays internal.
    const internal = await owner.agent.post(`/api/orgs/${org.id}/tickets/${number}/attachments`).attach("file", pdf, { filename: "notes.pdf", contentType: "application/pdf" })
    await owner.agent.post(`/api/orgs/${org.id}/tickets/${number}/messages`).send({ body: "internal", internal: true, attachmentIds: [internal.body.attachment.id] })
    expect((await http().get(`/api/portal/globex/attachments/${internal.body.attachment.id}`).set(auth)).status).toBe(404)
  })
})
