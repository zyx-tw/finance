import { createHash, timingSafeEqual } from "node:crypto"
import { mkdirSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { join, normalize, sep } from "node:path"
import { createAuth } from "./auth"
import type { Config } from "./config"
import { openDb, spendToken } from "./db"
import { type Gate, createGate } from "./gate"
import { HttpError, createLimiter, json, readJson } from "./http"
import { createLedger } from "./ledger"
import { createMcp } from "./mcp"
import { log } from "./otel"

// Sarasa Mono TC comes from ui.zyx.tw, the design system's font host.
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://ui.zyx.tw; font-src 'self' https://ui.zyx.tw; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const digest = (value: string) => createHash("sha256").update(value).digest()

export function createApp(config: Config, testGate?: Gate) {
  mkdirSync(config.data, { recursive: true })
  const db = openDb(join(config.data, "finance.db"))
  const gate =
    testGate ??
    createGate({ authOrigin: config.authOrigin, app: "finance", origin: config.origin, publicKey: config.authKey, spend: (jti, expiresAt) => spendToken(db, jti, expiresAt) })
  const auth = createAuth(config, db, gate)
  const ledger = createLedger(db)
  const mcp = createMcp(ledger)
  const host = new URL(config.origin).host
  const wrongToken = createLimiter(20)

  /** True when the request carries the importer token. Wrong guesses from one address stop after 20 an hour. */
  function bearer(req: Request, ip: string) {
    const header = req.headers.get("authorization")
    if (!header?.startsWith("Bearer ") || !config.token) return false
    if (wrongToken.blocked(ip)) throw new HttpError(429)
    if (timingSafeEqual(digest(header.slice(7)), digest(config.token))) return true
    wrongToken.miss(ip)
    log("auth.bad_token", {}, "WARN")
    return false
  }

  async function serveStatic(pathname: string) {
    let rel: string
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "")
    } catch {
      throw new HttpError(400, "bad path")
    }
    const asset = rel.startsWith(`assets${sep}`) || /^[\w.-]+\.(ico|png|svg|webmanifest)$/.test(rel)
    const path = asset ? join(config.dist, rel) : join(config.dist, "index.html")
    if (!path.startsWith(config.dist + sep) || !(await lstat(path).then(s => s.isFile(), () => false))) throw new HttpError(404)
    return new Response(Bun.file(path), {
      headers: {
        "content-security-policy": APP_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": asset && rel.startsWith("assets") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    })
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname
    const q = (name: string) => url.searchParams.get(name) || undefined
    if (req.method === "GET") {
      if (path === "/api/v1/summary") return json(ledger.summary(q("month")))
      if (path === "/api/v1/accounts") return json(ledger.accounts())
      if (path === "/api/v1/recurring") return json(ledger.recurring())
      if (path === "/api/v1/cards") return json(ledger.cards())
      if (path === "/api/v1/transactions")
        return json(ledger.transactions({ month: q("month"), account: q("account"), category: q("category"), q: q("q"), inbox: q("inbox") === "1", limit: q("limit") ? Number(q("limit")) : undefined }))
    }
    if (path === "/api/v1/import" && req.method === "POST") {
      const result = ledger.importAll(await readJson(req))
      log("import.done", result)
      return json(result)
    }
    const row = /^\/api\/v1\/transactions\/(\d+)$/.exec(path)
    if (row && req.method === "PATCH") return json(ledger.setCategory(Number(row[1]), await readJson(req)))
    throw new HttpError(404)
  }

  async function route(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url)
    if (req.headers.get("host") !== host) throw new HttpError(421)
    if (url.pathname === "/healthz") return json({ ok: true })

    // Sign-in at auth.zyx.tw; the callback checks its own Origin (auth.zyx.tw).
    if (url.pathname === "/auth/start" && req.method === "GET") return auth.start()
    if (url.pathname === "/auth/callback") return auth.callback(req, ip)

    // Machines: the token only, never a cookie, so a page cannot drive MCP.
    if (url.pathname === "/mcp") {
      if (!bearer(req, ip)) throw new HttpError(401)
      return mcp.handle(req)
    }

    if (url.pathname.startsWith("/api/")) {
      const machine = bearer(req, ip)
      // Cookies are SameSite=Strict; the Origin check covers older browsers.
      if (!machine && req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== config.origin) throw new HttpError(403)
      if (url.pathname === "/api/auth/me" && req.method === "GET") return json({ authenticated: machine || (await auth.session(req)) })
      if (url.pathname.startsWith("/api/auth/")) return auth.handle(req, url.pathname)
      if (!machine && !(await auth.session(req))) throw new HttpError(401)
      return api(req, url)
    }
    return serveStatic(url.pathname)
  }

  async function fetch(req: Request, ip = "unknown"): Promise<Response> {
    const started = performance.now()
    let response: Response
    try {
      response = await route(req, ip)
    } catch (error) {
      if (error instanceof HttpError) {
        response = json({ error: error.message || String(error.status) }, { status: error.status })
      } else {
        log("http.error", { error: String(error) }, "ERROR")
        response = json({ error: "internal" }, { status: 500 })
      }
    }
    if (response.status >= 500) log("http.5xx", { status: response.status, ms: Math.round(performance.now() - started) }, "ERROR")
    return response
  }

  return { fetch, db, ledger }
}
