import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { loadConfig } from "./config"
import type { Gate } from "./gate"

const ORIGIN = "http://finance.test"
const TOKEN = "t".repeat(40)
let dir: string
let app: ReturnType<typeof createApp>

const req = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers = new Headers(init.headers)
  headers.set("host", new URL(ORIGIN).host)
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`)
  return app.fetch(new Request(ORIGIN + path, { ...init, headers }), "1.1.1.1")
}
const send = (payload: unknown) => req("/api/v1/import", { method: "POST", body: JSON.stringify(payload) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response | Promise<Response>): Promise<any> => (await res).json()
const mcp = (method: string, params?: unknown) => body(req("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }))

const months = ["03", "04", "05", "06", "07"]
const PAYLOAD = {
  source: "test",
  accounts: [
    { id: "card", name: "Card", kind: "card" },
    { id: "bank", name: "Bank", kind: "deposit" },
  ],
  balances: [
    { account: "bank", date: "2026-07-31", amount: 50000 },
    { account: "card", date: "2026-07-18", amount: -3000 },
  ],
  statements: [
    { account: "card", period: "2026-06", closing_date: "2026-06-18", due_date: "2026-07-03", amount_due: 4000 },
    { account: "card", period: "2026-07", closing_date: "2026-07-18", due_date: null, amount_due: 3000 },
  ],
  transactions: [
    // One merchant, two plans: day 9 in a foreign currency, day 16 at a fixed price.
    ...months.map((m, i) => ({ account: "card", date: `2026-${m}-09`, amount: -(660 + i * 4), description: "OPENAI *CHATGPT SUBSCR" })),
    ...months.map(m => ({ account: "card", date: `2026-${m}-16`, amount: -690, description: "OPENAI *CHATGPT SUBSCR" })),
    // A delivery app: many charges a month, never a subscription.
    ...months.flatMap(m => ["03", "11", "19", "27"].map(d => ({ account: "card", date: `2026-${m}-${d}`, amount: -200, description: `優步－店${d}` }))),
    // Two equal purchases on one day are two rows.
    { account: "card", date: "2026-07-01", amount: -125, description: "連支＊咖啡店Taipei" },
    { account: "card", date: "2026-07-01", amount: -125, description: "連支＊咖啡店Taipei" },
    // A phone bill paid by card is a cost; a payment to the card is a transfer.
    { account: "card", date: "2026-07-02", amount: -1206, description: "台哥大帳單－網路／語音繳款" },
    { account: "card", date: "2026-07-05", amount: 4000, description: "ＣＵＢＥＡｐｐ轉帳繳款" },
    { account: "bank", date: "2026-07-04", amount: -4000, description: "行銀跨轉" },
    { account: "bank", date: "2026-07-10", amount: -9000, description: "行銀跨轉" },
    { account: "bank", date: "2026-07-21", amount: 2, description: "利息存入" },
    // Equal sums with no transfer word: a purchase and a bonus, not a transfer.
    { account: "card", date: "2026-07-12", amount: -1500, description: "家具店" },
    { account: "bank", date: "2026-07-13", amount: 1500, description: "獎金" },
  ],
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "finance-test-"))
  mkdirSync(join(dir, "dist"))
  writeFileSync(join(dir, "dist/index.html"), "<html></html>")
  const gate = { start: () => new Response(null, { status: 302 }), callback: async () => { throw new Error("unused") }, live: async () => false, clearState: "" } as unknown as Gate
  app = createApp(loadConfig({ FINANCE_DATA: join(dir, "data"), FINANCE_DIST: join(dir, "dist"), FINANCE_ORIGIN: ORIGIN, FINANCE_TOKEN: TOKEN }), gate)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("the api and mcp need the token; the page does not", async () => {
  expect((await req("/api/v1/summary", { token: null })).status).toBe(401)
  expect((await req("/api/v1/summary", { token: "wrong" })).status).toBe(401)
  expect((await req("/mcp", { method: "POST", token: null, body: "{}" })).status).toBe(401)
  expect((await req("/api/v1/import", { method: "POST", token: null, headers: { origin: ORIGIN }, body: "{}" })).status).toBe(401)
  expect((await req("/", { token: null })).status).toBe(200)
  expect(await body(req("/api/auth/me", { token: null }))).toEqual({ authenticated: false })
})

test("an import counts every row once, however often it is sent", async () => {
  const first = await body(send(PAYLOAD))
  expect(first.inserted).toBe(PAYLOAD.transactions.length)
  expect(first.duplicates).toBe(0)
  const second = await body(send(PAYLOAD))
  expect(second.inserted).toBe(0)
  expect(second.duplicates).toBe(PAYLOAD.transactions.length)
  const coffee = await body(req("/api/v1/transactions?q=咖啡店"))
  expect(coffee.length).toBe(2)
  expect(coffee[0].merchant).toBe("咖啡店")
})

test("a bad payload changes nothing", async () => {
  const res = await send({ accounts: [{ id: "x", name: "X", kind: "deposit" }], transactions: [{ account: "x", date: "2026/07/01", amount: 1, description: "a" }] })
  expect(res.status).toBe(422)
  expect((await body(req("/api/v1/accounts"))).some((a: { id: string }) => a.id === "x")).toBe(false)
  expect((await send({ transactions: [{ account: "nope", date: "2026-07-01", amount: 1, description: "a" }] })).status).toBe(422)
})

test("a card payment and the bank row behind it are one transfer", async () => {
  const july = await body(req("/api/v1/transactions?month=2026-07"))
  const kind = (description: string) => july.find((t: { description: string }) => t.description === description).kind
  expect(kind("ＣＵＢＥＡｐｐ轉帳繳款")).toBe("transfer")
  expect(july.filter((t: { amount: number }) => t.amount === -4000)[0].kind).toBe("transfer")
  expect(kind("台哥大帳單－網路／語音繳款")).toBe("expense")
  expect(kind("家具店")).toBe("expense")
  expect(kind("獎金")).toBe("income")
})

test("the summary leaves out transfers and bank rows nobody reviewed", async () => {
  const s = await body(req("/api/v1/summary?month=2026-07"))
  // 664+12 and 690 for the plans, 4 deliveries, 2 coffees, the phone bill, the furniture.
  expect(s.spending).toBe(676 + 690 + 800 + 250 + 1206 + 1500)
  expect(s.income).toBe(2 + 1500)
  expect(s.unreviewed).toEqual({ count: 1, inflow: 0, outflow: 9000 })
  expect(s.net_worth).toBe(47000)
  expect(s.liabilities).toBe(3000)
  expect(s.categories.find((c: { category: string }) => c.category === "Telecom").amount).toBe(1206)
})

test("recurring finds both plans of one merchant and skips the delivery app", async () => {
  const r = await body(req("/api/v1/recurring"))
  const plans = r.items.filter((i: { merchant: string }) => i.merchant === "OPENAI*CHATGPT SUBSCR")
  expect(plans.map((p: { day_of_month: number }) => p.day_of_month).sort()).toEqual([16, 9])
  expect(plans.find((p: { day_of_month: number }) => p.day_of_month === 16).next_date).toBe("2026-08-16")
  expect(r.items.some((i: { merchant: string }) => i.merchant === "優步")).toBe(false)
  expect(r.items.every((i: { active: boolean }) => i.active)).toBe(true)
})

test("a card's next due date comes from its closing date when the last statement owed nothing", async () => {
  const [card] = await body(req("/api/v1/cards"))
  expect(card.closing_day).toBe(18)
  expect(card.next_closing_date).toBe("2026-08-18")
  expect(card.next_due_date).toBe("2026-09-02")
  expect(card.payment_day).toBe(5)
})

test("a category set by hand follows to the merchant's other rows", async () => {
  const [row] = await body(req("/api/v1/transactions?q=咖啡店"))
  const res = await body(req(`/api/v1/transactions/${row.id}`, { method: "PATCH", body: JSON.stringify({ category: "Other" }) }))
  expect(res.same_merchant).toBe(1)
  expect((await body(req("/api/v1/transactions?q=咖啡店"))).every((t: { category: string }) => t.category === "Other")).toBe(true)
  expect((await req(`/api/v1/transactions/${row.id}`, { method: "PATCH", body: JSON.stringify({ category: "Nope" }) })).status).toBe(422)
})

test("mcp lists its tools and answers a call", async () => {
  expect((await mcp("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name).toBe("finance")
  expect((await mcp("tools/list")).result.tools.map((t: { name: string }) => t.name)).toContain("get_recurring")
  const cards = JSON.parse((await mcp("tools/call", { name: "get_cards", arguments: {} })).result.content[0].text)
  expect(cards[0].id).toBe("card")
  expect((await mcp("tools/call", { name: "set_category", arguments: { id: 999999 } })).result.isError).toBe(true)
})

test("a model's guess waits in the inbox until a person accepts it", async () => {
  // No key in the test config, so asking the model is off.
  expect((await req("/api/v1/suggestions", { method: "POST" })).status).toBe(503)
  const unsorted = app.ledger.unsorted()
  expect(unsorted.map(u => u.merchant)).toContain("行銀跨轉")
  expect(unsorted.every(u => !("amount" in u))).toBe(true)
  expect(app.ledger.saveSuggestions([{ merchant: "行銀跨轉", category: "Transfer" }])).toBe(1)
  // The guess alone changes no number.
  expect((await body(req("/api/v1/summary?month=2026-07"))).unreviewed.count).toBe(1)
  expect(app.ledger.unsorted().some(u => u.merchant === "行銀跨轉")).toBe(false)
  expect((await req("/api/v1/suggestions/accept", { method: "POST", body: JSON.stringify({ ids: ["x"] }) })).status).toBe(422)
  expect(await body(req("/api/v1/suggestions/accept", { method: "POST", body: "{}" }))).toEqual({ accepted: 1 })
  const s = await body(req("/api/v1/summary?month=2026-07"))
  expect(s.unreviewed.count).toBe(0)
  expect(s.spending).toBe(676 + 690 + 800 + 250 + 1206 + 1500)
})
