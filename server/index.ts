import { createApp } from "./app"
import { loadConfig } from "./config"
import { flush, log } from "./otel"

const config = loadConfig()
const app = createApp(config)

// Caddy sets X-Forwarded-For to the real client; the last entry is the one it added.
function clientIp(req: Request, peer: string) {
  const forwarded = req.headers.get("x-forwarded-for")
  return forwarded ? forwarded.split(",").pop()!.trim() : peer
}

const server = Bun.serve({
  port: config.port,
  hostname: process.env.FINANCE_HOSTNAME ?? "0.0.0.0",
  maxRequestBodySize: 8 * 1024 * 1024,
  fetch(req, srv) {
    // Asking the model takes longer than Bun's 10 second idle limit.
    if (new URL(req.url).pathname === "/api/v1/suggestions") srv.timeout(req, 0)
    return app.fetch(req, clientIp(req, srv.requestIP(req)?.address ?? "unknown"))
  },
})

log("server.start", { port: server.port })

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.stop()
    await flush()
    process.exit(0)
  })
}
