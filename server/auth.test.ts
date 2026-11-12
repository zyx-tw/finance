import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuth } from "./auth"
import { loadConfig } from "./config"
import { openDb } from "./db"
import type { Gate, Grant } from "./gate"
import { HttpError } from "./http"

const dir = mkdtempSync(join(tmpdir(), "finance-auth-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const DAY = 86_400_000
const config = loadConfig({ FINANCE_DATA: dir, FINANCE_ORIGIN: "https://finance.test" })
const db = openDb(join(dir, "finance.db"))
let grant: Grant
const gate = { callback: async () => grant, live: async () => true, clearState: "" } as unknown as Gate
const auth = createAuth(config, db, gate)
const callback = () => auth.callback(new Request("https://finance.test/auth/callback", { method: "POST" }), "1.1.1.1")
const maxAge = (res: Response) => Number(/Max-Age=(\d+)/.exec(res.headers.get("set-cookie") ?? "")?.[1])

test("a session ends 7 days after the passkey, not 7 days after the callback", async () => {
  const now = Date.now()
  grant = { sid: "a", authTime: now - 6 * DAY, expiresAt: now + 30 * DAY }
  const age = maxAge(await callback())
  expect(age).toBeLessThanOrEqual(DAY / 1000)
  expect(age).toBeGreaterThan(DAY / 1000 - 60)
})

test("a passkey older than 7 days is refused", async () => {
  const now = Date.now()
  grant = { sid: "b", authTime: now - 8 * DAY, expiresAt: now + 30 * DAY }
  const error = await callback().catch(e => e)
  expect(error).toBeInstanceOf(HttpError)
  expect((error as HttpError).status).toBe(403)
})
