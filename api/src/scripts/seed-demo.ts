import "reflect-metadata"
import { hash } from "@node-rs/argon2"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "../app.module"
import { Database } from "../database/database.service"
import { scanSlaBreaches } from "../jobs/jobs"
import { EmailQueue } from "../notifications/email"
import { OrgsController } from "../orgs/orgs.controller"
import { RealtimePublisher } from "../realtime/publisher"
import { StorageService } from "../tickets/storage.service"
import { TicketsService } from "../tickets/tickets.service"
import type { Priority, Status } from "../tickets/workflow"

/**
 * Demo data for a coffee roaster's help desk: a few people, two teams, and a fortnight of tickets
 * at every stage. Actions run through the real services, then timestamps are moved into the past
 * so SLAs, reports and history look like real use. Safe to re-run: it replaces the demo org.
 *
 *   npm run seed:demo        → sign in as demo@switchboard.dev / switchboard-demo
 */
const SLUG = "northwind"
const PASSWORD = "switchboard-demo"
const PEOPLE = [
  { key: "dana", name: "Dana Whitfield", email: "demo@switchboard.dev", role: "owner" },
  { key: "priya", name: "Priya Raman", email: "priya@northwind.example", role: "agent" },
  { key: "marco", name: "Marco Bellini", email: "marco@northwind.example", role: "agent" },
  { key: "jo", name: "Jo Okafor", email: "jo@northwind.example", role: "admin" },
  { key: "sam", name: "Sam Reyes", email: "sam@northwind.example", role: "viewer" },
] as const
type Who = (typeof PEOPLE)[number]["key"]

type Step = { at: number; by: Who | "customer"; body: string; note?: boolean; status?: Status }
type Scenario = {
  subject: string
  customer: [string, string]
  priority?: Priority
  ageH: number
  team?: "Support" | "Billing"
  assign?: Who
  tags?: string[]
  steps: Step[]
  final?: Status
}

const H = 1
const D = 24
const S: Scenario[] = [
  {
    subject: "Subscription charged twice this month",
    customer: ["Helen Marsh", "helen.marsh@fastmail.example"],
    priority: "high", ageH: 3 * H, team: "Billing", assign: "priya", tags: ["billing", "refund"],
    steps: [
      { at: 0, by: "customer", body: "Hi, my card was charged £18.50 twice on the 1st for my monthly Ethiopia Guji subscription. Can you refund one of them?" },
      { at: 0.4, by: "priya", body: "Duplicate confirmed in Stripe, looks like the retry fired after a timeout. Refunding now.", note: true },
      { at: 0.5, by: "priya", body: "Hi Helen, sorry about that. I can see the duplicate charge and have refunded £18.50 to your card. It usually shows within 3 to 5 working days." },
    ],
  },
  {
    subject: "Grinder burr replacement for the Encore",
    customer: ["Tomás Ortega", "tomas.ortega@example.net"],
    ageH: 50 * H, assign: "marco", tags: ["equipment"],
    steps: [
      { at: 0, by: "customer", body: "Do you sell replacement conical burrs for the Baratza Encore? Mine are 4 years old and the grind is getting inconsistent." },
      { at: 2, by: "marco", body: "We do! The M2 burr set fits the Encore. Want me to add one to your next subscription box so you save on shipping?", status: "pending" },
      { at: 26, by: "customer", body: "Yes please, that would be perfect." },
      { at: 27, by: "marco", body: "Done, it'll ship with Thursday's box. Enjoy the sharper grind." , status: "solved" },
    ],
  },
  {
    subject: "Order #NW-20931 arrived with a split bag",
    customer: ["Aisha Bello", "aisha.b@example.org"],
    priority: "high", ageH: 26 * H, team: "Support", assign: "priya", tags: ["shipping", "damaged"],
    steps: [
      { at: 0, by: "customer", body: "The 1kg bag of house espresso came split down the side, about a third spilled in the box. Photo attached on request." },
      { at: 5, by: "priya", body: "That's not the welcome we want for your beans. A replacement bag is on its way today, no need to send anything back.", status: "solved" },
    ],
  },
  {
    subject: "Wholesale pricing for a small café",
    customer: ["Ruth Kim", "ruth@littlecornercafe.example"],
    ageH: 6 * D, assign: "jo", tags: ["wholesale"],
    steps: [
      { at: 0, by: "customer", body: "We're opening a 20-seat café in March and would love to use your Brazil Cerrado as our house espresso. Do you have wholesale pricing?" },
      { at: 3, by: "jo", body: "Congratulations on the café! I've attached our wholesale sheet. For 10kg a week you'd be on tier 2. Happy to send a 1kg sample first?", status: "pending" },
      { at: 30, by: "customer", body: "A sample would be great. Can you also include the Colombia decaf?" },
      { at: 31, by: "jo", body: "Both samples ship tomorrow.", status: "on_hold" },
      { at: 32, by: "jo", body: "On hold until Ruth confirms the opening date, then set up the account.", note: true },
    ],
  },
  {
    subject: "Can't log in after password reset",
    customer: ["Ben Carter", "ben.carter@example.com"],
    priority: "urgent", ageH: 0.8 * H, tags: ["account"],
    steps: [{ at: 0, by: "customer", body: "I reset my password and now the login page just reloads. I need to change my delivery address before tomorrow's dispatch." }],
  },
  {
    subject: "Pause subscription while travelling",
    customer: ["Lena Fischer", "lena.f@example.de"],
    priority: "low", ageH: 9 * D, assign: "marco", tags: ["subscription"],
    steps: [
      { at: 0, by: "customer", body: "I'm away for six weeks from the 10th. Can I pause rather than cancel?" },
      { at: 20, by: "marco", body: "Of course. I've paused deliveries from the 10th and set them to resume automatically on the 22nd of next month.", status: "solved" },
    ],
    final: "closed",
  },
  {
    subject: "Tasting notes don't match the Kenya AA",
    customer: ["Chris Doyle", "cdoyle@example.com"],
    ageH: 4 * D, assign: "priya", tags: ["product"],
    steps: [
      { at: 0, by: "customer", body: "The card says blackcurrant and grapefruit but mine tastes quite roasty and flat. Is it possible I got a different coffee?" },
      { at: 9, by: "priya", body: "Checking the batch log for that week.", note: true },
      { at: 10, by: "priya", body: "Good catch. That week's Kenya was roasted a touch darker than our profile. We're sending a fresh bag from the new batch, and thanks for telling us.", status: "solved" },
      { at: 60, by: "customer", body: "The new bag is spot on. Thanks!" },
      { at: 61, by: "priya", body: "Brilliant, glad it's back to what it should be.", status: "solved" },
    ],
  },
  {
    subject: "Gift card code not accepted at checkout",
    customer: ["Olu Adeyemi", "olu.a@example.com"],
    priority: "high", ageH: 7 * H, team: "Billing", tags: ["checkout"],
    steps: [{ at: 0, by: "customer", body: "Code NW-GIFT-77Q2 says invalid. It was a birthday present, bought last week." }],
  },
  {
    subject: "Request: compostable pods",
    customer: ["Grace Liu", "grace.liu@example.com"],
    priority: "low", ageH: 12 * D, assign: "jo", tags: ["feature-request"],
    steps: [
      { at: 0, by: "customer", body: "Any plans for compostable Nespresso-compatible pods? I'd switch my whole office over." },
      { at: 30, by: "jo", body: "Not yet, but it's on our list for next year. I've noted your office's interest so we can let you know first.", status: "solved" },
    ],
    final: "closed",
  },
  {
    subject: "Invoice needs our VAT number",
    customer: ["Mark Ellis", "accounts@ellisarchitects.example"],
    ageH: 2 * D, team: "Billing", assign: "jo", tags: ["billing", "invoice"],
    steps: [
      { at: 0, by: "customer", body: "Could you reissue invoice INV-4410 with our VAT number GB 123 4567 89 on it?" },
      { at: 30, by: "jo", body: "Here's the corrected invoice with your VAT number. Sorry for the slow reply, we were short-staffed on Monday.", status: "solved" },
    ],
  },
  {
    subject: "Which grind for an AeroPress?",
    customer: ["Noah Brooks", "noah.brooks@example.com"],
    priority: "low", ageH: 20 * H, assign: "marco", tags: ["brewing"],
    steps: [
      { at: 0, by: "customer", body: "New to this. What grind setting should I pick when ordering for an AeroPress?" },
      { at: 1, by: "marco", body: "Pick \"Fine filter\". It's a little coarser than espresso and works with most AeroPress recipes. If it tastes bitter, go one step coarser next time.", status: "pending" },
    ],
  },
  {
    subject: "Delivery left at the wrong address",
    customer: ["Fatima Noor", "fatima.noor@example.com"],
    priority: "high", ageH: 30 * H, team: "Support", tags: ["shipping"],
    steps: [
      { at: 0, by: "customer", body: "Tracking says delivered but it's not here. The photo shows a blue door, mine is green. Number 14, not 41." },
      { at: 0.2, by: "customer", body: "Just checked with the neighbours at 41, nobody's home." },
    ],
  },
  {
    subject: "Change roast preference to lighter",
    customer: ["Ivan Petrov", "ivan.p@example.com"],
    priority: "low", ageH: 5 * D, assign: "priya", tags: ["subscription"],
    steps: [
      { at: 0, by: "customer", body: "Can my subscription switch to light roasts only?" },
      { at: 4, by: "priya", body: "Done. From the next box you'll only get light and medium-light roasts.", status: "solved" },
    ],
    final: "closed",
  },
  {
    subject: "Espresso machine descaling question",
    customer: ["Maya Johnson", "maya.j@example.com"],
    ageH: 11 * H, assign: "marco",
    steps: [
      { at: 0, by: "customer", body: "How often should I descale with hard London water? The manual says monthly, which seems a lot." },
      { at: 3, by: "marco", body: "With London water, monthly is about right if you pull 2 or more shots a day. A BWT filter jug would stretch it to every 2 to 3 months." },
    ],
  },
  {
    subject: "Bulk order for a team offsite",
    customer: ["Hannah Scott", "hannah@brightlabs.example"],
    priority: "normal", ageH: 1.5 * H, tags: ["wholesale"],
    steps: [{ at: 0, by: "customer", body: "We need 5kg of whole bean for a 60-person offsite on the 20th. Do you offer discounts and can you deliver by the 18th?" }],
  },
]

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] })
  const db = app.get(Database)
  const tickets = app.get(TicketsService)
  const orgs = app.get(OrgsController)

  await db.query("DELETE FROM organizations WHERE slug = $1", [SLUG])
  await db.query("DELETE FROM users WHERE email = ANY($1::citext[])", [PEOPLE.map((p) => p.email)])
  const passwordHash = await hash(PASSWORD)
  const ids = {} as Record<Who, string>
  for (const p of PEOPLE) ids[p.key] = (await db.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [p.email, p.name, passwordHash])).rows[0].id

  const owner = PEOPLE[0]
  const { organization } = await orgs.create({ name: "Northwind Coffee Roasters", slug: SLUG }, { id: ids.dana, name: owner.name, email: owner.email })
  const orgId = organization.id
  for (const p of PEOPLE.slice(1)) await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [orgId, ids[p.key], p.role])

  const teamIds = await db.tenant({ orgId }, async (q) => {
    const support = (await q("SELECT id FROM teams WHERE name = 'Support'")).rows[0].id
    const billing = (await q("INSERT INTO teams (org_id, name) VALUES ($1, 'Billing') RETURNING id", [orgId])).rows[0].id
    for (const [team, who] of [[support, "priya"], [support, "marco"], [support, "dana"], [billing, "jo"], [billing, "priya"]] as const) {
      await q("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1, $2, $3)", [orgId, team, ids[who]])
    }
    return { Support: support, Billing: billing }
  })

  const policies = (await db.query<{ priority: Priority; first_response_minutes: number; resolution_minutes: number }>("SELECT priority, first_response_minutes, resolution_minutes FROM sla_policies WHERE org_id = $1", [orgId])).rows
  const now = Date.now()

  // Oldest first, so ticket numbers follow creation order.
  for (const s of [...S].sort((a, b) => b.ageH - a.ageH)) {
    const created = now - s.ageH * 3600_000
    const marks: { real: number; planned: number }[] = [{ real: Date.now(), planned: created }]
    // Steps run milliseconds apart; a short gap keeps their real timestamps unambiguous.
    const mark = async (atH: number) => {
      await new Promise((r) => setTimeout(r, 25))
      marks.push({ real: Date.now(), planned: Math.min(created + atH * 3600_000, now - 60_000) })
    }
    const actor = (w: Who) => ({ type: "agent" as const, id: ids[w] })

    const [first, ...rest] = s.steps
    const { ticket } = await db.tenant({ orgId, userId: ids.dana }, (q) =>
      tickets.create(q, orgId, { subject: s.subject, body: first!.body, requester: { email: s.customer[1], name: s.customer[0] }, priority: s.priority, channel: "portal", tags: s.tags, teamId: s.team ? teamIds[s.team] : null }, { type: "contact", id: null }),
    )
    if (s.assign) {
      await mark(Math.min(0.1, rest[0]?.at ?? 0.1))
      await db.tenant({ orgId, userId: ids[s.assign] }, (q) => tickets.update(q, orgId, ticket.number, { assigneeId: ids[s.assign!] }, actor(s.assign!)))
    }
    const contactId = (await db.query("SELECT requester_id FROM tickets WHERE id = $1", [ticket.id])).rows[0].requester_id
    for (const step of rest) {
      await mark(step.at)
      await db.tenant({ orgId }, (q) =>
        tickets.addMessage(q, orgId, ticket.number, {
          body: step.body,
          internal: Boolean(step.note),
          author: step.by === "customer" ? { type: "contact", contactId } : { type: "agent", userId: ids[step.by] },
          status: step.status,
        }),
      )
    }
    if (s.final) {
      await mark((rest.at(-1)?.at ?? 0) + 7 * 24 + 1)
      await db.tenant({ orgId }, (q) => tickets.update(q, orgId, ticket.number, { status: s.final }, { type: "system", id: null }))
    }

    // Map each real timestamp onto the planned timeline.
    const shift = (d: Date | null) => {
      if (!d) return null
      const t = d.getTime()
      const m = [...marks].reverse().find((x) => x.real <= t) ?? marks[0]!
      return new Date(m.planned + Math.max(0, t - m.real))
    }
    await db.tx(async (q) => {
      for (const m of (await q("SELECT id, created_at FROM messages WHERE ticket_id = $1", [ticket.id])).rows) await q("UPDATE messages SET created_at = $2 WHERE id = $1", [m.id, shift(m.created_at)])
      for (const e of (await q("SELECT id, created_at FROM audit_events WHERE ticket_id = $1", [ticket.id])).rows) await q("UPDATE audit_events SET created_at = $2 WHERE id = $1", [e.id, shift(e.created_at)])
      const t = (await q("SELECT * FROM tickets WHERE id = $1", [ticket.id])).rows[0]
      const p = policies.find((x) => x.priority === t.priority)!
      const createdAt = new Date(created)
      const fr = shift(t.first_response_at)
      const solved = shift(t.solved_at)
      const frDue = new Date(created + p.first_response_minutes * 60_000)
      const resDue = new Date(created + p.resolution_minutes * 60_000)
      const pausedAt = shift(t.sla_paused_at)
      await q(
        `UPDATE tickets SET created_at = $2, updated_at = $3, first_response_at = $4, solved_at = $5, closed_at = $6, sla_paused_at = $7, sla_paused_seconds = 0,
                first_response_due_at = $8, resolution_due_at = $9, first_response_breached = $10, resolution_breached = $11
          WHERE id = $1`,
        [ticket.id, createdAt, shift(t.updated_at), fr, solved, shift(t.closed_at), pausedAt, fr ? null : frDue, resDue, Boolean(fr && fr > frDue), Boolean(solved && solved > resDue)],
      )
    })
  }

  // Flag anything that's overdue right now, the same way the worker does.
  await scanSlaBreaches({ db, realtime: app.get(RealtimePublisher), email: app.get(EmailQueue), storage: app.get(StorageService) })
  await app.get(EmailQueue).queue.obliterate({ force: true }).catch(() => {})
  await app.close()
  console.log(`Seeded "Northwind Coffee Roasters" with ${S.length} tickets.\nSign in as ${owner.email} / ${PASSWORD} (others: ${PEOPLE.slice(1).map((p) => `${p.email} as ${p.role}`).join(", ")}).`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
