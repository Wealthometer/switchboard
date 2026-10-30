import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { Readable } from "node:stream"
import { config } from "../config"

/**
 * Attachment storage: local disk (a mounted volume in Docker) or an S3-compatible bucket
 * (STORAGE=s3), for hosts like Render whose disks don't survive a deploy. Keys are random, so
 * file names from users never become paths.
 */
@Injectable()
export class StorageService {
  private root = resolve(config().UPLOAD_DIR)
  private bucket = config().S3_BUCKET!
  private s3 =
    config().STORAGE === "s3"
      ? new S3Client({
          region: config().S3_REGION,
          endpoint: config().S3_ENDPOINT,
          forcePathStyle: Boolean(config().S3_ENDPOINT),
          credentials: config().S3_ACCESS_KEY_ID ? { accessKeyId: config().S3_ACCESS_KEY_ID!, secretAccessKey: config().S3_SECRET_ACCESS_KEY ?? "" } : undefined,
        })
      : undefined

  async put(orgId: string, data: Buffer): Promise<string> {
    const key = `${orgId}/${randomUUID()}`
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: "application/octet-stream" }))
      return key
    }
    await mkdir(join(this.root, orgId), { recursive: true })
    await writeFile(join(this.root, key), data, { flag: "wx" })
    return key
  }

  async read(key: string): Promise<Readable> {
    if (this.s3) {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return out.Body as Readable
    }
    const path = resolve(this.root, key)
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid storage key")
    return createReadStream(path)
  }

  async remove(key: string) {
    if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => {})
    else await unlink(resolve(this.root, key)).catch(() => {})
  }
}

/** Types we accept. Anything executable or scriptable in a browser (HTML, SVG, JS) is refused. */
export const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/csv", "application/json",
  "application/zip", "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword", "application/vnd.ms-excel",
])

/** Checks magic bytes for common types so a renamed .html can't pose as a .png. */
export function sniffMatches(contentType: string, data: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b)
  switch (contentType) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47)
    case "image/jpeg": return starts(0xff, 0xd8, 0xff)
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38)
    case "image/webp": return starts(0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString() === "WEBP"
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46)
    case "application/zip":
    case "application/x-zip-compressed":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return starts(0x50, 0x4b, 0x03, 0x04)
    case "text/plain":
    case "text/csv":
    case "application/json":
      return !data.subarray(0, 1024).toString("utf8").match(/<\s*(script|html|svg|iframe)/i)
    default:
      return true
  }
}
