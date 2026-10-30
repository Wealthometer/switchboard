import "reflect-metadata"
import { createApp } from "./bootstrap"
import { config } from "./config"

async function main() {
  const app = await createApp()
  await app.listen(config().PORT, "0.0.0.0")
}
void main()
