import { createHash, timingSafeEqual } from "node:crypto"
import { mkdirSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { join, normalize, sep } from "node:path"
import { createAdvisor } from "./ai"
import { createAuth } from "./auth"
import type { Config } from "./config"
import { openDb, spendToken } from "./db"
import { type Gate, createGate } from "./gate"
import { HttpError, createLimiter, json, readBytes, readJson } from "./http"
import { createLedger } from "./ledger"
import { createMcp } from "./mcp"
import { log } from "./otel"
import { type Extract, MAX_PDF, pdfText, readStatement } from "./statements"

// Sarasa Mono TC comes from ui.zyx.tw, the design system's font host.
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://ui.zyx.tw; font-src 'self' https://ui.zyx.tw; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const digest = (value: string) => createHash("sha256").update(value).digest()

export function createApp(config: Config, testGate?: Gate, extract: Extract = pdfText, today?: () => string) {
  mkdirSync(config.data, { recursive: true })
  const db = openDb(join(config.data, "finance.db"))
  const gate =
    testGate ??
    createGate({ authOrigin: config.authOrigin, app: "finance", origin: config.origin, publicKey: config.authKey, spend: (jti, expiresAt) => spendToken(db, jti, expiresAt) })
  const auth = createAuth(config, db, gate)
  const ledger = createLedger(db, today)
  const advisor = createAdvisor(config.anthropicKey)
  let sorting: Promise<void> | null = null
  let again = false

  /**
   * Asks the model about merchants with no category and files its answers. One
   * run at a time; a call during a run asks for one more pass, so rows imported
   * meanwhile are not missed. Runs in the background: an import does not wait.
   */
  function sort() {
    if (!advisor) return
    if (sorting) {
      again = true
      return
    }
    sorting = (async () => {
      do {
        again = false
        const asked = ledger.unsorted()
        if (asked.length) log("ai.sorted", { asked: asked.length, rows: ledger.sort(asked, await advisor.suggest(asked)) })
      } while (again)
    })()
      .catch(error => log("ai.error", { error: String(error) }, "ERROR"))
      .finally(() => (sorting = null))
  }
  // Rows left from a run that failed, or from before the model sorted on its own.
  sort()

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
      if (result.inserted > 0) sort()
      return json(result)
    }
    if (path === "/api/v1/statements" && req.method === "POST") {
      const parsed = await readStatement(await readBytes(req, MAX_PDF), config.pdfPassword, extract)
      const result = ledger.importAll(parsed.payload)
      log("statement.imported", { parser: parsed.parser, rows: parsed.payload.transactions.length, inserted: result.inserted, duplicates: result.duplicates })
      if (result.inserted > 0) sort()
      return json({ parser: parsed.parser, check: parsed.check!.label, rows: parsed.payload.transactions.length, ...result })
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
