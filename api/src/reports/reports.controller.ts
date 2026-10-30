import { Controller, Get, Query, UseGuards } from "@nestjs/common"
import { ApiTags } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsInt, IsOptional, IsString, Max, Min, Validate, ValidatorConstraint, type ValidatorConstraintInterface } from "class-validator"
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Requires } from "../common/context"
import { OrgGuard } from "../common/guards"
import { Database } from "../database/database.service"

@ValidatorConstraint({ name: "timezone" })
class IsTimeZone implements ValidatorConstraintInterface {
  validate(v: unknown) {
    try {
      return typeof v === "string" && Boolean(new Intl.DateTimeFormat("en", { timeZone: v }))
    } catch {
      return false
    }
  }
  defaultMessage() {
    return "Unknown time zone"
  }
}

class ReportQuery {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(365) days?: number
  @IsOptional() @IsString() @Validate(IsTimeZone) tz?: string
}

/** Working time = wall-clock time minus time spent waiting on the customer (pending). */
const WORK_SECONDS = "(extract(epoch FROM (t.solved_at - t.created_at)) - t.sla_paused_seconds)"

@ApiTags("reports")
@Controller("orgs/:orgId/reports")
@UseGuards(OrgGuard)
export class ReportsController {
  constructor(private db: Database) {}

  @Get("overview")
  @Requires("reports.read")
  overview(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query() query: ReportQuery) {
    const days = query.days ?? 30
    return this.db.tenant({ orgId: org.id, userId: user.id }, async (q) => {
      // Browsers sometimes report legacy zone aliases PostgreSQL doesn't know; fall back to UTC.
      const tz = query.tz && (await q("SELECT 1 FROM pg_timezone_names WHERE name = $1", [query.tz])).rowCount ? query.tz : "UTC"
      const since = `(date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AT TIME ZONE $1`
      const [daily, totals, backlog, agents, breakdown] = await Promise.all([
        q(
          `WITH d AS (SELECT generate_series(date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1), date_trunc('day', now() AT TIME ZONE $1), interval '1 day')::date AS day)
           SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  (SELECT count(*)::int FROM tickets t WHERE (t.created_at AT TIME ZONE $1)::date = d.day) AS created,
                  (SELECT count(*)::int FROM tickets t WHERE (t.solved_at AT TIME ZONE $1)::date = d.day) AS solved
             FROM d ORDER BY d.day`,
          [tz, days],
        ),
        q(
          `SELECT count(*)::int AS created,
                  count(*) FILTER (WHERE t.solved_at IS NOT NULL)::int AS solved,
                  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.first_response_at - t.created_at))) / 60)::numeric, 1)::float AS "medianFirstResponseMinutes",
                  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WORK_SECONDS}) FILTER (WHERE t.solved_at IS NOT NULL) / 60)::numeric, 1)::float AS "medianResolutionMinutes",
                  -- Compliance counts only tickets whose outcome is decided (met or missed), not ones still running.
                  round(100.0 * count(*) FILTER (WHERE t.first_response_at IS NOT NULL AND NOT t.first_response_breached)
                        / NULLIF(count(*) FILTER (WHERE t.first_response_at IS NOT NULL OR t.first_response_breached), 0), 1)::float AS "firstResponseSla",
                  round(100.0 * count(*) FILTER (WHERE t.solved_at IS NOT NULL AND NOT t.resolution_breached)
                        / NULLIF(count(*) FILTER (WHERE t.solved_at IS NOT NULL OR t.resolution_breached), 0), 1)::float AS "resolutionSla"
             FROM tickets t WHERE t.created_at >= ${since}`,
          [tz, days],
        ),
        q(
          `SELECT count(*) FILTER (WHERE status = 'new')::int AS new, count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'on_hold')::int AS "onHold",
                  count(*) FILTER (WHERE status IN ('new','open','on_hold') AND assignee_id IS NULL)::int AS unassigned,
                  count(*) FILTER (WHERE status IN ('new','open','pending','on_hold') AND (first_response_breached OR resolution_breached))::int AS breached,
                  round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY now() - created_at) FILTER (WHERE status IN ('new','open','pending','on_hold'))) / 3600)::numeric, 1)::float AS "medianAgeHours"
             FROM tickets`,
        ),
        q(
          `SELECT u.id, u.name, m.role,
                  (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('new','open','pending','on_hold')) AS open,
                  (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = u.id AND t.solved_at >= ${since}) AS solved,
                  (SELECT count(*)::int FROM messages ms WHERE ms.author_user_id = u.id AND NOT ms.internal AND ms.created_at >= ${since}) AS replies,
                  (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WORK_SECONDS}) / 60)::numeric, 1)::float FROM tickets t WHERE t.assignee_id = u.id AND t.solved_at >= ${since}) AS "medianResolutionMinutes"
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.role <> 'viewer' ORDER BY solved DESC, u.name`,
          [tz, days],
        ),
        q(
          `SELECT 'priority' AS kind, priority::text AS key, count(*)::int AS n FROM tickets t WHERE t.created_at >= ${since} GROUP BY priority
           UNION ALL
           SELECT 'channel', channel::text, count(*)::int FROM tickets t WHERE t.created_at >= ${since} GROUP BY channel`,
          [tz, days],
        ),
      ])
      const group = (kind: string) => Object.fromEntries(breakdown.rows.filter((r) => r.kind === kind).map((r) => [r.key, r.n]))
      return { days, tz, daily: daily.rows, totals: totals.rows[0], backlog: backlog.rows[0], agents: agents.rows, byPriority: group("priority"), byChannel: group("channel") }
    })
  }
}
