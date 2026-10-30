import { z } from "zod"

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"))

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  COOKIE_SECURE: bool(false),
  APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Express "trust proxy": a hop count (e.g. "2" behind Vercel → Render) or a list of subnets. */
  TRUST_PROXY: z
    .string()
    .default("loopback, uniquelocal")
    .transform((v) => (/^\d+$/.test(v) ? Number(v) : v)),
  /** Connections per process. Keep API + worker under your database's limit (Supabase pooler: ~15 on the free plan). */
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),
  /** Where attachments live: "local" disk (UPLOAD_DIR) or any S3-compatible bucket. */
  STORAGE: z.enum(["local", "s3"]).default("local"),
  UPLOAD_DIR: z.string().default("./uploads"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  /** For R2, Supabase Storage, MinIO and other non-AWS providers. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(100).default(10),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Switchboard <support@switchboard.local>"),
  /** Solved tickets close automatically after this many hours without a reply. */
  AUTO_CLOSE_HOURS: z.coerce.number().int().min(1).default(168),
  RATE_LIMIT: bool(true),
  /** Run the email worker and scheduled jobs inside the API process instead of a separate worker. */
  RUN_WORKER: bool(false),
  /** Apply pending migrations when the API starts, for hosts without a pre-deploy step. */
  MIGRATE_ON_START: bool(false),
}).superRefine((c, ctx) => {
  if (c.STORAGE === "s3" && !c.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "Required when STORAGE=s3" })
})

export type Config = z.infer<typeof schema>
let cached: Config | undefined

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env)
    if (!parsed.success) throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`)
    cached = parsed.data
  }
  return cached
}

export function resetConfig() {
  cached = undefined
}
