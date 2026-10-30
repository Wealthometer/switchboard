import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clearEmails, createOrg, makeApp, queuedEmails, signUp } from "../app"
import { resetDb } from "../helpers"

let app: INestApplication
beforeAll(async () => {
  await resetDb()
  app = await makeApp()
})
afterAll(() => app.close())

async function invite(owner: Awaited<ReturnType<typeof signUp>>, orgId: string, email: string, role: string) {
  await clearEmails(app)
  const r = await owner.agent.post(`/api/orgs/${orgId}/invitations`).send({ email, role })
  expect(r.status).toBe(201)
  const mail = (await queuedEmails(app)).find((m) => m.to === email)!
  return mail.text.match(/\/invite\/([\w-]+)/)![1]!
}

describe("auth", () => {
  it("registers, signs in and reports memberships", async () => {
    const { agent, user } = await signUp(app, "Grace", "grace@example.com")
    const me = await agent.get("/api/auth/me")
    expect(me.body).toMatchObject({ user: { email: "grace@example.com" }, organizations: [] })
    const login = await request(app.getHttpServer()).post("/api/auth/login").send({ email: "GRACE@example.com", password: "a-long-test-password" })
    expect(login.status).toBe(200)
    expect(login.body.user.id).toBe(user.id)
    expect(String(login.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/)
  })

  it("returns field errors and hides whether an email exists", async () => {
    const bad = await request(app.getHttpServer()).post("/api/auth/register").send({ name: "", email: "nope", password: "short" })
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.fields).sort()).toEqual(["email", "name", "password"])
    const a = await request(app.getHttpServer()).post("/api/auth/login").send({ email: "grace@example.com", password: "wrong" })
    const b = await request(app.getHttpServer()).post("/api/auth/login").send({ email: "nobody@example.com", password: "wrong" })
    expect([a.status, b.status]).toEqual([401, 401])
    expect(a.body.error).toBe(b.body.error)
  })

  it("rejects unknown fields (no mass assignment)", async () => {
    const r = await request(app.getHttpServer()).post("/api/auth/register").send({ name: "X", email: "x@example.com", password: "a-long-test-password", role: "owner" })
    expect(r.status).toBe(400)
  })
})

describe("organizations", () => {
  it("creates an org with owner membership, default SLAs and a Support team", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent, "acme")
    expect((await owner.agent.get(`/api/orgs/${org.id}`)).body.organization).toMatchObject({ slug: "acme", role: "owner" })
    const slas = (await owner.agent.get(`/api/orgs/${org.id}/sla-policies`)).body.policies
    expect(slas.map((p: { priority: string; first_response_minutes: number }) => [p.priority, p.first_response_minutes])).toEqual([["urgent", 60], ["high", 240], ["normal", 480], ["low", 1440]])
    expect((await owner.agent.get(`/api/orgs/${org.id}/teams`)).body.teams.map((t: { name: string }) => t.name)).toEqual(["Support"])
    expect((await owner.agent.post("/api/orgs").send({ name: "Dup", slug: "acme" })).status).toBe(409)
  })

  it("hides organizations from non-members with 404", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent)
    const stranger = await signUp(app, "Mallory")
    expect((await stranger.agent.get(`/api/orgs/${org.id}`)).status).toBe(404)
    expect((await stranger.agent.get(`/api/orgs/${org.id}/members`)).status).toBe(404)
  })
})

describe("invitations and roles", () => {
  it("invites by email; only the invited address can accept, once", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent)
    const token = await invite(owner, org.id, "linus@example.com", "agent")

    const preview = await request(app.getHttpServer()).get(`/api/invitations/${token}`)
    expect(preview.body.invitation).toMatchObject({ email: "linus@example.com", role: "agent", orgName: "Acme Support" })

    const wrong = await signUp(app, "Eve")
    expect((await wrong.agent.post(`/api/invitations/${token}/accept`)).status).toBe(403)

    const linus = await signUp(app, "Linus", "linus@example.com")
    expect((await linus.agent.post(`/api/invitations/${token}/accept`)).body.orgId).toBe(org.id)
    expect((await linus.agent.post(`/api/invitations/${token}/accept`)).status).toBe(410)
    expect((await linus.agent.get(`/api/orgs/${org.id}`)).body.organization.role).toBe("agent")
  })

  it("enforces permissions by role", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent)
    const viewer = await signUp(app, "Vic", "vic@example.com")
    await viewer.agent.post(`/api/invitations/${await invite(owner, org.id, "vic@example.com", "viewer")}/accept`)
    const r = await viewer.agent.post(`/api/orgs/${org.id}/invitations`).send({ email: "x@example.com", role: "agent" })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/viewer/)
    expect((await viewer.agent.post(`/api/orgs/${org.id}/teams`).send({ name: "Ops" })).status).toBe(403)
    expect((await viewer.agent.get(`/api/orgs/${org.id}/members`)).status).toBe(200)
  })

  it("only owners can make owners, and the last owner can't leave", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent)
    const admin = await signUp(app, "Adam", "adam@example.com")
    await admin.agent.post(`/api/invitations/${await invite(owner, org.id, "adam@example.com", "admin")}/accept`)

    expect((await admin.agent.patch(`/api/orgs/${org.id}/members/${admin.user.id}`).send({ role: "owner" })).status).toBe(403)
    const last = await owner.agent.delete(`/api/orgs/${org.id}/members/${owner.user.id}`)
    expect(last.status).toBe(400)
    expect(last.body.error).toMatch(/at least one owner/)

    expect((await owner.agent.patch(`/api/orgs/${org.id}/members/${admin.user.id}`).send({ role: "owner" })).status).toBe(200)
    expect((await owner.agent.delete(`/api/orgs/${org.id}/members/${owner.user.id}`)).status).toBe(204)
  })

  it("records an audit trail", async () => {
    const owner = await signUp(app)
    const org = await createOrg(owner.agent)
    await invite(owner, org.id, "z@example.com", "agent")
    await owner.agent.post(`/api/orgs/${org.id}/teams`).send({ name: "Billing" })
    // Read directly to check the trail exists before the audit endpoint is built.
    const { Database } = await import("../../src/database/database.service")
    const actions = (await app.get(Database).query("SELECT action FROM audit_events WHERE org_id = $1 ORDER BY id", [org.id])).rows.map((r) => r.action)
    expect(actions).toEqual(["organization.created", "member.invited", "team.created"])
  })
})
