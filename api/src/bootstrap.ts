import { INestApplication, ValidationPipe } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { RedisIoAdapter } from "./realtime/gateway"
import { NestExpressApplication } from "@nestjs/platform-express"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import { AppModule } from "./app.module"
import { validationFactory } from "./common/errors"
import { config } from "./config"

/** Shared by main.ts and the tests so both run the exact same middleware stack. */
export async function createApp(opts: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: opts.logger ?? ["error", "warn", "log"], bufferLogs: false })
  app.set("trust proxy", config().TRUST_PROXY)
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cookieParser())
  app.enableCors({ origin: config().CORS_ORIGIN.split(",").map((s) => s.trim()), credentials: true })
  app.setGlobalPrefix("api", { exclude: ["health", "health/ready"] })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationFactory }))
  app.enableShutdownHooks()
  app.useWebSocketAdapter(new RedisIoAdapter(app))

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Switchboard API").setDescription("Multi-tenant support desk. Org-scoped routes live under /api/orgs/{orgId}.").setVersion("1.0").addCookieAuth("sb_session").build(),
  )
  SwaggerModule.setup("api/docs", app, doc)
  return app
}
