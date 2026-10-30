import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Logger, ValidationError } from "@nestjs/common"
import type { Response } from "express"

/** class-validator errors → { error, fields: { "contact.email": "must be an email" } } */
export function validationFactory(errors: ValidationError[]) {
  const fields: Record<string, string> = {}
  const walk = (errs: ValidationError[], prefix = "") => {
    for (const e of errs) {
      const key = prefix ? `${prefix}.${e.property}` : e.property
      if (e.constraints) fields[key] = Object.values(e.constraints)[0]!
      if (e.children?.length) walk(e.children, key)
    }
  }
  walk(errors)
  return new BadRequestException({ error: "Some fields are invalid", fields })
}

/** Consistent error bodies, readable messages for common database errors, no stack traces leaked. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger("Error")

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    if (err instanceof HttpException) {
      const status = err.getStatus()
      const body = err.getResponse()
      if (typeof body === "object" && body && "error" in body && "fields" in body) return res.status(status).json(body)
      const message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? err.message)
      return res.status(status).json({ error: Array.isArray(message) ? message[0] : message })
    }
    const pg = err as { code?: string; constraint?: string; detail?: string }
    if (pg.code === "23505") return res.status(409).json({ error: "That already exists", constraint: pg.constraint })
    if (pg.code === "23503") return res.status(400).json({ error: "A referenced record doesn't exist" })
    if (pg.code === "22P02") return res.status(400).json({ error: "Invalid identifier" })
    this.log.error(err)
    return res.status(500).json({ error: "Something went wrong on our side. Try again in a moment." })
  }
}
