import { Controller, Get, Module } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { AuditService } from "./audit/audit.service"
import { AuthController } from "./auth/auth.controller"
import { Public } from "./common/context"
import { ErrorFilter } from "./common/errors"
import { AuthGuard } from "./common/guards"
import { RedisModule, RedisService } from "./common/redis"
import { Database } from "./database/database.service"
import { DatabaseModule } from "./database/database.module"
import { EmailQueue } from "./notifications/email"
import { InvitationsController, OrgsController } from "./orgs/orgs.controller"
import { SlaPoliciesController, TeamsController } from "./orgs/teams.controller"
import { NotifyService } from "./notifications/notify.service"
import { RealtimeGateway } from "./realtime/gateway"
import { RealtimePublisher } from "./realtime/publisher"
import { PortalController } from "./portal/portal.controller"
import { ReportsController } from "./reports/reports.controller"
import { AuditController, ContactsController } from "./tickets/contacts.controller"
import { StorageService } from "./tickets/storage.service"
import { AttachmentsController, TicketsController } from "./tickets/tickets.controller"
import { TicketsService } from "./tickets/tickets.service"

@Controller("health")
class HealthController {
  constructor(
    private db: Database,
    private redis: RedisService,
  ) {}

  @Public()
  @Get()
  live() {
    return { ok: true }
  }

  @Public()
  @Get("ready")
  async ready() {
    const [pg, rd] = await Promise.allSettled([this.db.query("SELECT 1"), this.redis.client.ping()])
    const ok = pg.status === "fulfilled" && rd.status === "fulfilled"
    if (!ok) throw Object.assign(new Error("not ready"), { status: 503 })
    return { ok, postgres: true, redis: true }
  }
}

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [
    HealthController, AuthController, OrgsController, InvitationsController, TeamsController, SlaPoliciesController,
    TicketsController, AttachmentsController, ContactsController, AuditController, PortalController, ReportsController,
  ],
  providers: [
    AuditService, EmailQueue, RealtimePublisher, RealtimeGateway, NotifyService, StorageService, TicketsService,
    { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
