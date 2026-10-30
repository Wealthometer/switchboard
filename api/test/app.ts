import type { INestApplication } from "@nestjs/common"
import request from "supertest"
import { createApp } from "../src/bootstrap"
import { EmailQueue } from "../src/notifications/email"
import { RedisService } from "../src/common/redis"

export async function makeApp(): Promise<INestApplication> {
  const app = await createApp({ logger: false })
  await app.init()
  await app.get(RedisService).client.flushdb()
  return app
}

/** A logged-in browser: supertest agent keeps the session cookie. */
export async function signUp(app: INestApplication, name = "Ada", email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const agent = request.agent(app.getHttpServer())
  const r = await agent.post("/api/auth/register").send({ name, email, password: "a-long-test-password" })
  if (r.status !== 201) throw new Error(`signUp: ${JSON.stringify(r.body)}`)
  return { agent, user: r.body.user as { id: string; email: string; name: string } }
}

export async function createOrg(agent: ReturnType<typeof request.agent>, slug = `org-${Math.random().toString(36).slice(2, 8)}`) {
  const r = await agent.post("/api/orgs").send({ name: "Acme Support", slug })
  if (r.status !== 201) throw new Error(`createOrg: ${JSON.stringify(r.body)}`)
  return r.body.organization as { id: string; slug: string }
}

/** Emails waiting in the queue (the worker isn't running in tests). */
export async function queuedEmails(app: INestApplication) {
  const jobs = await app.get(EmailQueue).queue.getJobs(["waiting", "delayed", "prioritized"])
  return jobs.map((j) => j.data)
}

export async function clearEmails(app: INestApplication) {
  await app.get(EmailQueue).queue.obliterate({ force: true })
}

type Agent = ReturnType<typeof request.agent>

/** Owner invites a new person with a role; returns that person signed in as a member. */
export async function addMember(app: INestApplication, owner: Agent, orgId: string, role: "admin" | "agent" | "viewer", name = role[0]!.toUpperCase() + role.slice(1)) {
  const person = await signUp(app, name)
  const r = await owner.post(`/api/orgs/${orgId}/invitations`).send({ email: person.user.email, role })
  if (r.status !== 201) throw new Error(`invite: ${JSON.stringify(r.body)}`)
  const mail = (await queuedEmails(app)).find((m) => m.to === person.user.email)!
  const token = mail.text.match(/\/invite\/([\w-]+)/)![1]!
  const a = await person.agent.post(`/api/invitations/${token}/accept`)
  if (a.status !== 201 && a.status !== 200) throw new Error(`accept: ${JSON.stringify(a.body)}`)
  return person
}
