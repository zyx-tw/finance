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
  app = createApp(loadConfig({ FINANCE_DATA: join(dir, "data"), FINANCE_DIST: join(dir, "dist"), FINANCE_ORIGIN: ORIGIN, FINANCE_TOKEN: TOKEN }), gate, undefined, () => "2026-07-20")
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

test("the summary leaves out transfers and counts every other row", async () => {
  const s = await body(req("/api/v1/summary?month=2026-07"))
  // 664+12 and 690 for the plans, 4 deliveries, 2 coffees, the phone bill, the furniture, and a bank row with no category.
  expect(s.spending).toBe(676 + 690 + 800 + 250 + 1206 + 1500 + 9000)
  expect(s.income).toBe(2 + 1500)
  expect(s.net_worth).toBe(47000)
  expect(s.liabilities).toBe(3000)
  expect(s.categories.find((c: { category: string }) => c.category === "Telecom").amount).toBe(1206)
  expect(s.categories.find((c: { category: string }) => c.category === "Uncategorized").amount).toBe(9000 + 1500)
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

test("next dates never fall in the past when the statements are old", () => {
  const plan = app.ledger.recurring("2026-11-13").items.find(i => i.day_of_month === 16)!
  expect(plan.next_date).toBe("2026-11-16")
  const [card] = app.ledger.cards("2026-11-19")
  expect(card.next_closing_date).toBe("2026-12-18")
  expect(card.next_due_date).toBe("2027-01-02")
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

test("the model's answer counts at once, and a person can still change it", async () => {
  const unsorted = app.ledger.unsorted()
  expect(unsorted.map(u => u.merchant)).toContain("行銀跨轉")
  expect(unsorted.every(u => !("amount" in u))).toBe(true)
  // A merchant with no answer, as after a failed call, is asked again; a null answer is not.
  expect(app.ledger.sort([])).toBe(0)
  expect(app.ledger.unsorted().length).toBe(unsorted.length)
  const others = unsorted.filter(u => u.merchant !== "行銀跨轉").map(u => ({ merchant: u.merchant, category: null }))
  // A null answer files Income or Other by the row's sign: the furniture and the bonus here.
  expect(app.ledger.sort([{ merchant: "行銀跨轉", category: "Transfer" }, ...others])).toBe(1 + others.length)
  expect((await body(req("/api/v1/transactions?inbox=1"))).length).toBe(0)
  expect((await body(req("/api/v1/transactions?q=獎金")))[0].category).toBe("Income")
  expect(app.ledger.unsorted()).toEqual([])
  // The transfer left spending.
  expect((await body(req("/api/v1/summary?month=2026-07"))).spending).toBe(676 + 690 + 800 + 250 + 1206 + 1500)
  expect((await req("/api/v1/suggestions", { method: "POST" })).status).toBe(404)
})

test("money sent from a bank to an account number is spent, and old rows settle at start", async () => {
  await send({ source: "to-account", transactions: [
    { account: "bank", date: "2026-06-02", amount: -5000, description: "行銀非約跨轉 國＊銀 013 0000699517***924" },
    { account: "bank", date: "2026-06-03", amount: -80, description: "轉帳支取 街口支付扣款" },
  ] })
  const june = await body(req("/api/v1/transactions?month=2026-06"))
  expect(june.find((t: { amount: number }) => t.amount === -5000).kind).toBe("expense")
  expect(june.find((t: { amount: number }) => t.amount === -80).kind).toBe("expense")
  // As the old rule left it: a transfer. And a row the model once left open.
  app.db.exec("update transactions set kind = 'transfer', category = null, category_source = 'rule' where amount = -500000")
  app.db.exec("update transactions set category_source = 'model' where amount = -8000")
  expect(app.ledger.settle()).toBe(2)
  const sent = (await body(req("/api/v1/transactions?month=2026-06"))).find((t: { amount: number }) => t.amount === -5000)
  expect([sent.kind, sent.category]).toEqual(["expense", "Other"])
  expect((await body(req("/api/v1/transactions?month=2026-06"))).find((t: { amount: number }) => t.amount === -80).category).toBe("Other")
  expect(app.ledger.settle()).toBe(0)
})

test("a category on one transfer the model made brings back the merchant's others", async () => {
  await send({ source: "more", transactions: [{ account: "bank", date: "2026-07-22", amount: -700, description: "行銀跨轉" }] })
  app.ledger.sort([{ merchant: "行銀跨轉", category: "Transfer" }])
  const rows = await body(req("/api/v1/transactions?q=行銀跨轉"))
  const [first] = rows.filter((t: { amount: number }) => t.amount === -9000)
  expect(rows.filter((t: { amount: number; kind: string }) => [-9000, -700].includes(t.amount)).every((t: { kind: string }) => t.kind === "transfer")).toBe(true)
  const res = await body(req(`/api/v1/transactions/${first.id}`, { method: "PATCH", body: JSON.stringify({ category: "Housing" }) }))
  expect(res.same_merchant).toBe(1)
  const s = await body(req("/api/v1/summary?month=2026-07"))
  expect(s.spending).toBe(676 + 690 + 800 + 250 + 1206 + 1500 + 9000 + 700)
  expect(s.categories.find((c: { category: string }) => c.category === "Housing").amount).toBe(9700)
  // Next month's row of the merchant takes the hand-set category without asking the model.
  await send({ source: "august", transactions: [{ account: "bank", date: "2026-08-10", amount: -9000, description: "行銀跨轉" }] })
  expect(app.ledger.unsorted().some(u => u.merchant === "行銀跨轉")).toBe(false)
  expect((await body(req("/api/v1/transactions?month=2026-08&q=行銀跨轉")))[0].category).toBe("Housing")
  // The row paired with the card payment was never the model's: it stays a transfer.
  expect((await body(req("/api/v1/transactions?q=行銀跨轉"))).find((t: { amount: number }) => t.amount === -4000).kind).toBe("transfer")
  // One row marked a transfer by hand leaves the merchant's rows that already have a category alone.
  const [small] = (await body(req("/api/v1/transactions?q=行銀跨轉"))).filter((t: { amount: number }) => t.amount === -700)
  await req(`/api/v1/transactions/${small.id}`, { method: "PATCH", body: JSON.stringify({ kind: "transfer" }) })
  const after = await body(req("/api/v1/transactions?q=行銀跨轉"))
  expect(after.find((t: { amount: number }) => t.amount === -700).kind).toBe("transfer")
  expect(after.find((t: { amount: number; date: string }) => t.amount === -9000 && t.date === "2026-07-10").category).toBe("Housing")
  expect(after.find((t: { amount: number; date: string }) => t.amount === -9000 && t.date === "2026-08-10").category).toBe("Housing")
})

test("the old suggestion column is applied once and never over a hand-set row", async () => {
  const { openDb } = await import("./db")
  const path = join(dir, "old.db")
  const old = openDb(path)
  old.exec("alter table transactions add column suggestion text")
  old.exec("insert into accounts (id, name, kind, created_at) values ('bank', 'Bank', 'deposit', 0)")
  const add = old.query("insert into transactions (account_id, date, amount, description, merchant, kind, category, category_source, external_id, created_at, suggestion) values ('bank', '2026-07-01', -100, ?, ?, 'expense', ?, ?, ?, 0, ?)")
  add.run("a", "a", null, null, "1", "Transfer")
  add.run("b", "b", null, null, "2", "Food")
  add.run("c", "c", null, "user", "3", "Transfer")
  add.run("d", "d", "Other", "user", "4", "Food")
  old.close()
  const db = openDb(path)
  const rows = db.query("select merchant, kind, category, category_source from transactions order by merchant").all()
  expect(rows).toEqual([
    { merchant: "a", kind: "transfer", category: null, category_source: "model" },
    { merchant: "b", kind: "expense", category: "Food", category_source: "model" },
    { merchant: "c", kind: "expense", category: null, category_source: "user" },
    { merchant: "d", kind: "expense", category: "Other", category_source: "user" },
  ])
  db.close()
  expect(() => openDb(path).close()).not.toThrow()
})
