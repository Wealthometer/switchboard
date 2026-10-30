import { describe, expect, it } from "vitest"
import { templates } from "../../src/notifications/email"
import { createMailer, deliver } from "../../src/worker"

describe("mail delivery", () => {
  it("renders a template into a message with the tag header", async () => {
    const mailer = createMailer() // no SMTP_URL in tests → JSON transport
    const email = templates.invitation({ to: "new@x.io", orgName: "Acme", inviter: "Ada", role: "viewer", token: "abc" })
    expect(email.text).toContain("as a viewer")
    expect(email.text).toContain("http://switchboard.test/invite/abc")
    const info = await mailer.sendMail({ from: "a@b.c", to: email.to, subject: email.subject, text: email.text, headers: { "X-Switchboard-Tag": email.tag } })
    const msg = JSON.parse((info as unknown as { message: string }).message)
    expect(msg.to[0].address).toBe("new@x.io")
    expect(await deliver(mailer, email)).toBeTruthy()
  })
})
