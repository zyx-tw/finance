import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CATHAY } from "../ingest/fixtures"
import { createApp } from "./app"
import { loadConfig } from "./config"
import type { Gate } from "./gate"

const ORIGIN = "http://finance.test"
const TOKEN = "s".repeat(40)
let dir: string
let app: ReturnType<typeof createApp>
let text = CATHAY
let seenPasswords: string[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "finance-statements-"))
  mkdirSync(join(dir, "dist"))
  writeFileSync(join(dir, "dist/index.html"), "<html></html>")
  const gate = { live: async () => false, clearState: "" } as unknown as Gate
  const config = loadConfig({ FINANCE_DATA: join(dir, "data"), FINANCE_DIST: join(dir, "dist"), FINANCE_ORIGIN: ORIGIN, FINANCE_TOKEN: TOKEN, FINANCE_PDF_PASSWORD: "pw-test, pw-card" })
  app = createApp(config, gate, async (_pdf, passwords) => {
    seenPasswords = passwords
    return text
  })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PDF = new TextEncoder().encode("%PDF-1.4 made up")
const post = (body: Uint8Array, token: string | null = TOKEN) =>
  app.fetch(new Request(`${ORIGIN}/api/v1/statements`, { method: "POST", body, headers: { host: "finance.test", "content-type": "application/pdf", ...(token ? { authorization: `Bearer ${token}` } : {}) } }), "1.1.1.1")

test("a statement PDF needs the token", async () => {
  // Without the token the request is a browser's, and a cross-origin POST stops at the Origin check.
  expect((await post(PDF, null)).status).toBe(403)
})

test("a checked statement is imported once, with finance's own PDF passwords", async () => {
  const first = (await (await post(PDF)).json()) as Record<string, number | string>
  expect(first).toMatchObject({ parser: "cathay-card", check: "purchases" })
  expect(Number(first.inserted)).toBeGreaterThan(0)
  expect(seenPasswords).toEqual(["pw-test", "pw-card"])
  const again = (await (await post(PDF)).json()) as Record<string, number | string>
  expect(again.inserted).toBe(0)
  expect(again.duplicates).toBe(first.inserted)
})

test("a statement whose total is missing, an unknown layout or a non-PDF is refused", async () => {
  text = CATHAY.replace(/本期應繳總額.*\n/, "\n")
  expect((await post(PDF)).status).toBe(422)
  text = "nothing a parser knows"
  expect((await post(PDF)).status).toBe(422)
  expect((await post(new TextEncoder().encode("hello"))).status).toBe(415)
  text = CATHAY
})
