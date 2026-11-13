import { createHash } from "node:crypto"
import { CATEGORIES, categorize, merchantOf, normalize } from "./categories"
import type { Placed, Unsorted } from "./ai"
import type { Db } from "./db"
import { HttpError } from "./http"

/** Words a bank or card prints on a row that moves money between accounts. */
const TRANSFER_WORDS = /轉帳|轉入|轉出|跨行|匯款|繳款|扣繳|卡費|信用卡|提款|存入|儲值|加值|交割|證券|自動扣款|自扣|TRANSFER|PAYMENT/i

const KINDS = ["deposit", "investment", "card", "loan"] as const
const TX_KINDS = ["expense", "income", "transfer", "fee"] as const
type TxKind = (typeof TX_KINDS)[number]

export type Tx = {
  id: number
  account_id: string
  date: string
  posted_date: string | null
  amount: number
  description: string
  merchant: string
  kind: TxKind
  category: string | null
  category_source: string | null
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const cents = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e11) throw new HttpError(422, `${field} must be a number`)
  return Math.round(value * 100)
}
const text = (value: unknown, field: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(422, `${field} must be text of 1 to ${max} characters`)
  return value.trim()
}
const date = (value: unknown, field: string) => {
  if (typeof value !== "string" || !DATE.test(value)) throw new HttpError(422, `${field} must be YYYY-MM-DD`)
  return value
}
const list = (value: unknown, field: string) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20_000) throw new HttpError(422, `${field} must be a list`)
  return value as Record<string, unknown>[]
}
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
const iso = (days: number) => new Date(days * 86_400_000).toISOString().slice(0, 10)
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const money = (value: number) => value / 100
/** The first date on or after `from` that falls on this day of the month, or on the month's last day when it is shorter. */
function nextOn(on: number, from: string) {
  const [y, m] = from.split("-").map(Number)
  for (let i = m - 1; ; i++) {
    const found = iso(Date.UTC(y, i, Math.min(on, new Date(Date.UTC(y, i + 1, 0)).getUTCDate())) / 86_400_000)
    if (found >= from) return found
  }
}
const later = (a: string, b: string) => (a > b ? a : b)

/** What a row is when the importer does not say: a card payment moves money, it does not spend it. */
function kindOf(accountKind: string, amount: number, description: string): TxKind {
  const name = normalize(description)
  if (accountKind === "card" && amount > 0 && /繳款|PAYMENT|扣繳/.test(name)) return "transfer"
  if (accountKind !== "card" && /信用卡款|卡費|繳卡|信用卡費/.test(name)) return "transfer"
  if (amount < 0 && /手續費|年費|違約金/.test(name)) return "fee"
  if (accountKind === "card") return "expense"
  return amount > 0 ? "income" : "expense"
}

export function createLedger(db: Db, today = () => new Date().toISOString().slice(0, 10)) {
  /**
   * Takes accounts, balances, statements and transactions in one call. Sending
   * the same payload again changes nothing: a transaction is known by its
   * account and external id.
   */
  function importAll(body: Record<string, unknown>) {
    const source = body.source === undefined ? "" : text(body.source, "source")
    const now = Date.now()
    const result = { accounts: 0, balances: 0, statements: 0, inserted: 0, duplicates: 0, transfers: 0 }
    const kinds = new Map<string, string>()
    const accountKind = (id: string) => {
      if (!kinds.has(id)) {
        const row = db.query("select kind from accounts where id = ?").get(id) as { kind: string } | null
        if (!row) throw new HttpError(422, `unknown account ${id}`)
        kinds.set(id, row.kind)
      }
      return kinds.get(id)!
    }

    db.transaction(() => {
      for (const [i, a] of list(body.accounts, "accounts").entries()) {
        const id = text(a.id, `accounts[${i}].id`, 64)
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError(422, `accounts[${i}].id must be lower case letters, digits and hyphens`)
        if (!KINDS.includes(a.kind as (typeof KINDS)[number])) throw new HttpError(422, `accounts[${i}].kind must be one of ${KINDS.join(", ")}`)
        db.query(
          "insert into accounts (id, name, kind, institution, currency, created_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do update set name = excluded.name, kind = excluded.kind, institution = excluded.institution",
        ).run(id, text(a.name, `accounts[${i}].name`), a.kind as string, a.institution === undefined ? "" : text(a.institution, `accounts[${i}].institution`), "TWD", now)
        result.accounts++
      }
      for (const [i, b] of list(body.balances, "balances").entries()) {
        const account = text(b.account, `balances[${i}].account`, 64)
        accountKind(account)
        db.query("insert into balances (account_id, date, amount) values (?, ?, ?) on conflict(account_id, date) do update set amount = excluded.amount").run(
          account,
          date(b.date, `balances[${i}].date`),
          cents(b.amount, `balances[${i}].amount`),
        )
        result.balances++
      }
      for (const [i, s] of list(body.statements, "statements").entries()) {
        const account = text(s.account, `statements[${i}].account`, 64)
        accountKind(account)
        const period = text(s.period, `statements[${i}].period`, 7)
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(422, `statements[${i}].period must be YYYY-MM`)
        db.query(
          "insert into statements (account_id, period, closing_date, due_date, amount_due) values (?, ?, ?, ?, ?) on conflict(account_id, period) do update set closing_date = excluded.closing_date, due_date = excluded.due_date, amount_due = excluded.amount_due",
        ).run(account, period, date(s.closing_date, `statements[${i}].closing_date`), s.due_date == null ? null : date(s.due_date, `statements[${i}].due_date`), cents(s.amount_due, `statements[${i}].amount_due`))
        result.statements++
      }
      // Two equal purchases on one day are two rows: the nth equal row in a payload gets n in its id.
      const seen = new Map<string, number>()
      const insert = db.query(
        "insert or ignore into transactions (account_id, date, posted_date, amount, description, merchant, kind, category, category_source, external_id, source, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      for (const [i, t] of list(body.transactions, "transactions").entries()) {
        const account = text(t.account, `transactions[${i}].account`, 64)
        const on = date(t.date, `transactions[${i}].date`)
        const amount = cents(t.amount, `transactions[${i}].amount`)
        if (amount === 0) continue
        const description = text(t.description, `transactions[${i}].description`)
        const key = `${account}|${on}|${amount}|${description}`
        const nth = seen.get(key) ?? 0
        seen.set(key, nth + 1)
        const externalId = t.external_id === undefined ? createHash("sha256").update(`${key}|${nth}`).digest("hex").slice(0, 32) : text(t.external_id, `transactions[${i}].external_id`, 128)
        if (t.kind !== undefined && !TX_KINDS.includes(t.kind as TxKind)) throw new HttpError(422, `transactions[${i}].kind must be one of ${TX_KINDS.join(", ")}`)
        const kind = (t.kind as TxKind | undefined) ?? kindOf(accountKind(account), amount, description)
        const category = kind === "transfer" ? null : kind === "fee" ? "Fees" : categorize(description)
        const changes = insert.run(
          account,
          on,
          t.posted_date == null ? null : date(t.posted_date, `transactions[${i}].posted_date`),
          amount,
          description,
          merchantOf(description),
          kind,
          category,
          category ? "rule" : null,
          externalId,
          source,
          now,
        ).changes
        if (changes) result.inserted++
        else result.duplicates++
      }
      follow()
      result.transfers = pairTransfers()
    })()
    return result
  }

  /** A new row of a merchant someone placed by hand takes that choice, so the model is not asked and cannot undo it. */
  function follow() {
    const HAND = "from transactions u where u.merchant = transactions.merchant and u.category_source = 'user'"
    const NEW = "kind in ('expense', 'income') and category is null and category_source is null"
    db.query(`update transactions set category = (select u.category ${HAND} and u.category is not null order by u.id desc limit 1), category_source = 'merchant' where ${NEW} and exists (select 1 ${HAND} and u.category is not null)`).run()
    db.query(`update transactions set kind = 'transfer', category_source = 'merchant' where ${NEW} and exists (select 1 ${HAND} and u.kind = 'transfer')`).run()
  }

  /**
   * Money that leaves one account and reaches another within 3 days, same
   * amount, is one transfer, not a cost and an income, when one side says it
   * moves money (TRANSFER_WORDS). Equal sums alone are not enough: a 1,000
   * purchase and a 1,000 refund or bonus must stay what they are. Each row pairs once.
   */
  function pairTransfers() {
    const rows = db
      .query("select id, account_id, date, amount, kind, description from transactions where category_source is not 'user' and kind in ('expense', 'income', 'transfer') order by date, id")
      .all() as Pick<Tx, "id" | "account_id" | "date" | "amount" | "kind" | "description">[]
    const ins = rows.filter(r => r.amount > 0)
    const used = new Set<number>()
    let paired = 0
    for (const out of rows) {
      if (out.amount >= 0) continue
      const match = ins.find(r => !used.has(r.id) && r.account_id !== out.account_id && r.amount === -out.amount && Math.abs(day(r.date) - day(out.date)) <= 3 && (TRANSFER_WORDS.test(normalize(out.description)) || TRANSFER_WORDS.test(normalize(r.description))))
      if (!match) continue
      used.add(match.id)
      for (const row of [out, match]) {
        if (row.kind === "transfer") continue
        db.query("update transactions set kind = 'transfer', category = null, category_source = null where id = ?").run(row.id)
        paired++
      }
    }
    return paired
  }

  function accounts() {
    return (
      db
        .query(
          `select a.id, a.name, a.kind, a.institution, b.amount as balance, b.date as balance_date
           from accounts a left join balances b on b.account_id = a.id and b.date = (select max(date) from balances where account_id = a.id)
           order by a.kind, a.name`,
        )
        .all() as { id: string; name: string; kind: string; institution: string; balance: number | null; balance_date: string | null }[]
    ).map(a => ({ ...a, balance: a.balance === null ? null : money(a.balance) }))
  }

  /** Money in, money out and what is left, month by month, with the numbers that read them. */
  function summary(month?: string) {
    const rows = db
      .query(
        `select substr(date, 1, 7) as month,
                sum(case when kind = 'income' then amount else 0 end) as income,
                -sum(case when kind in ('expense', 'fee') then amount else 0 end) as spending
         from transactions group by 1 order by 1`,
      )
      .all() as { month: string; income: number; spending: number }[]
    const worth = db.query("select account_id, date, amount from balances order by date").all() as { account_id: string; date: string; amount: number }[]
    const worthAt = (end: string) => {
      const latest = new Map<string, number>()
      for (const b of worth) if (b.date <= end) latest.set(b.account_id, b.amount)
      return latest.size ? [...latest.values()].reduce((sum, value) => sum + value, 0) : null
    }
    const months = rows.map(r => ({ month: r.month, income: money(r.income), spending: money(r.spending), net: money(r.income - r.spending), net_worth: (w => (w === null ? null : money(w)))(worthAt(`${r.month}-31`)) }))
    // A month still running reads as a cheap month, so the default is the last month that reached its 25th.
    const lastDay = (db.query("select max(date) as d from transactions").get() as { d: string | null }).d
    const whole = lastDay && Number(lastDay.slice(8)) < 25 && months.length > 1 ? months.at(-2)!.month : months.at(-1)?.month
    const current = month && months.some(m => m.month === month) ? month : whole
    const at = months.findIndex(m => m.month === current)
    const now = at < 0 ? null : months[at]
    const before = at < 0 ? [] : months.slice(Math.max(0, at - 6), at)
    const usual = before.length ? before.reduce((sum, m) => sum + m.spending, 0) / before.length : null
    const liquid = accounts().filter(a => a.kind === "deposit" && a.balance !== null).reduce((sum, a) => sum + a.balance!, 0)
    const pace = [...before.slice(-3), ...(now ? [now] : [])].slice(-3)
    const monthly = pace.length ? pace.reduce((sum, m) => sum + m.spending, 0) / pace.length : 0
    const categories = current
      ? (
          db
            .query(`select coalesce(category, 'Uncategorized') as category, -sum(amount) as amount, count(*) as count from transactions where kind in ('expense', 'fee') and substr(date, 1, 7) = ? group by 1 order by 2 desc`)
            .all(current) as { category: string; amount: number; count: number }[]
        ).map(c => ({ ...c, amount: money(c.amount) }))
      : []
    const all = accounts()
    const known = all.filter(a => a.balance !== null)
    return {
      month: current ?? null,
      net_worth: known.length ? known.reduce((sum, a) => sum + a.balance!, 0) : null,
      assets: known.filter(a => a.balance! > 0).reduce((sum, a) => sum + a.balance!, 0),
      liabilities: -known.filter(a => a.balance! < 0).reduce((sum, a) => sum + a.balance!, 0),
      income: now?.income ?? 0,
      spending: now?.spending ?? 0,
      saved: now?.net ?? 0,
      // Below -100% the rate says nothing a person can read.
      savings_rate: now && now.income > 0 && now.net / now.income >= -1 ? now.net / now.income : null,
      usual_spending: usual,
      versus_usual: usual && now ? now.spending / usual - 1 : null,
      runway_months: monthly > 0 && liquid > 0 ? liquid / monthly : null,
      months,
      categories,
      accounts: all,
    }
  }

  function transactions(filter: { month?: string; account?: string; category?: string; q?: string; inbox?: boolean; limit?: number }) {
    const where: string[] = []
    const args: (string | number)[] = []
    const add = (clause: string, ...values: string[]) => {
      where.push(clause)
      args.push(...values)
    }
    if (filter.month) add("substr(date, 1, 7) = ?", filter.month)
    if (filter.account) add("account_id = ?", filter.account)
    if (filter.category) add("category = ?", filter.category)
    if (filter.q) add("(merchant like ? or description like ?)", `%${normalize(filter.q)}%`, `%${filter.q}%`)
    if (filter.inbox) where.push("kind in ('expense', 'income') and category is null")
    const rows = db
      .query(`select id, account_id, date, posted_date, amount, description, merchant, kind, category, category_source from transactions ${where.length ? `where ${where.join(" and ")}` : ""} order by date desc, id desc limit ?`)
      .all(...args, Math.min(Math.max(filter.limit ?? 500, 1), 2000)) as Tx[]
    return rows.map(r => ({ ...r, amount: money(r.amount) }))
  }

  /** A choice made by hand: it holds for this row, and for the merchant's other rows nobody chose. */
  function setCategory(id: number, patch: { category?: unknown; kind?: unknown }) {
    const row = db.query("select id, merchant, kind, amount from transactions where id = ?").get(id) as { id: number; merchant: string; kind: TxKind; amount: number } | null
    if (!row) throw new HttpError(404)
    // What a hand-set row may change on the merchant's other rows: anything a person did not set.
    const OTHERS = "merchant = ? and id != ? and (category_source is null or category_source != 'user')"
    let same = 0
    if (patch.kind !== undefined) {
      if (!TX_KINDS.includes(patch.kind as TxKind)) throw new HttpError(422, `kind must be one of ${TX_KINDS.join(", ")}`)
      db.query("update transactions set kind = ?, category = case when ? = 'transfer' then null else category end, category_source = 'user' where id = ?").run(patch.kind as string, patch.kind as string, id)
      // A merchant can be both a cost and a transfer (a landlord, a friend): only rows nobody and no rule placed, or the model placed, follow.
      if (patch.kind === "transfer")
        same = db.query(`update transactions set kind = 'transfer', category = null, category_source = 'merchant' where merchant = ? and id != ? and kind in ('expense', 'income') and (category_source is null or category_source = 'model')`).run(row.merchant, id).changes
    }
    if (patch.category !== undefined) {
      if (!CATEGORIES.includes(patch.category as (typeof CATEGORIES)[number])) throw new HttpError(422, `category must be one of ${CATEGORIES.join(", ")}`)
      // A category on a transfer says it was a cost or an income after all.
      const kind = row.kind === "transfer" && patch.kind === undefined ? (row.amount > 0 ? "income" : "expense") : null
      db.query("update transactions set category = ?, kind = coalesce(?, kind), category_source = 'user' where id = ?").run(patch.category as string, kind, id)
      // The merchant's other rows follow, and so do its transfers that the model or this merchant's rule made, each back to a cost or an income by its sign.
      same = db
        .query(
          `update transactions set category = ?, category_source = 'merchant',
             kind = case when kind = 'transfer' then (case when amount > 0 then 'income' else 'expense' end) else kind end
           where ${OTHERS} and kind != 'fee' and (kind != 'transfer' or category_source in ('model', 'merchant'))`,
        )
        .run(patch.category as string, row.merchant, id).changes
    }
    return { ok: true, same_merchant: same }
  }

  const UNSORTED = "kind in ('expense', 'income') and category is null and category_source is null"

  /** Merchants with no category that the model has not been asked about, one sample row each. */
  function unsorted(): Unsorted[] {
    return (
      db
        .query(
          `select t.merchant, min(t.description) as description, case when sum(t.amount) > 0 then 'in' else 'out' end as direction, min(a.kind) as account_kind
           from transactions t join accounts a on a.id = t.account_id
           where t.kind in ('expense', 'income') and t.category is null and t.category_source is null group by t.merchant order by t.merchant`,
        )
        .all() as Unsorted[]
    )
  }

  /**
   * Files the model's answers: a category, or a transfer, for every row of the
   * merchant nobody has placed. A merchant the model answered null for is
   * marked as asked and stays uncategorized, so it is not asked again. A
   * merchant with no answer (the call failed) is left to be asked again.
   */
  function sort(placed: Placed[]) {
    let rows = 0
    db.transaction(() => {
      for (const { merchant, category } of placed) {
        if (category === "Transfer") rows += db.query(`update transactions set kind = 'transfer', category_source = 'model' where merchant = ? and ${UNSORTED}`).run(merchant).changes
        else if (category) rows += db.query(`update transactions set category = ?, category_source = 'model' where merchant = ? and ${UNSORTED}`).run(category, merchant).changes
        else db.query(`update transactions set category_source = 'model' where merchant = ? and ${UNSORTED}`).run(merchant)
      }
    })()
    return rows
  }

  /**
   * Charges that come back: one merchant, about once a month, about the same
   * amount. A delivery app charges many times a month, so it never qualifies.
   */
  function recurring(on = today()) {
    const rows = db.query("select merchant, date, amount, category from transactions where kind = 'expense' and amount < 0 order by merchant, date").all() as Pick<Tx, "merchant" | "date" | "amount" | "category">[]
    const latest = (db.query("select max(date) as d from transactions").get() as { d: string | null }).d
    // One merchant can bill two plans: charges within 3 days of the same day of month are one plan.
    const groups: { merchant: string; anchor: number; charges: typeof rows }[] = []
    for (const row of rows) {
      const on = Number(row.date.slice(8))
      const near = (anchor: number) => Math.min(Math.abs(on - anchor), 31 - Math.abs(on - anchor)) <= 3
      const group = groups.find(g => g.merchant === row.merchant && near(g.anchor))
      if (group) group.charges.push(row)
      else groups.push({ merchant: row.merchant, anchor: on, charges: [row] })
    }
    // A shop someone visits many times a month has no plan, whatever days the visits fall on.
    const busy = new Set<string>()
    const perMerchant = new Map<string, typeof rows>()
    for (const row of rows) perMerchant.set(row.merchant, [...(perMerchant.get(row.merchant) ?? []), row])
    for (const [merchant, all] of perMerchant) if (all.length / new Set(all.map(r => r.date.slice(0, 7))).size > 2.5) busy.add(merchant)
    const found = []
    for (const { merchant, charges } of groups) {
      if (charges.length < 3 || !latest || busy.has(merchant)) continue
      const days = charges.map(c => day(c.date))
      const gaps = days.slice(1).map((d, i) => d - days[i])
      const monthly = gaps.filter(g => g >= 24 && g <= 37).length
      if (monthly < gaps.length * 0.75) continue
      const amounts = charges.map(c => -c.amount)
      const typical = median(amounts)
      // A foreign charge moves with the exchange rate, so allow 15% around the usual amount.
      if (amounts.filter(a => Math.abs(a - typical) <= typical * 0.15).length < amounts.length * 0.75) continue
      const gap = median(gaps)
      const last = days.at(-1)!
      const dayOfMonth = Math.round(median(charges.map(c => Number(c.date.slice(8)))))
      found.push({
        merchant,
        category: charges.at(-1)!.category,
        amount: money(amounts.at(-1)!),
        usual_amount: money(typical),
        day_of_month: dayOfMonth,
        charges: charges.length,
        first_date: charges[0].date,
        last_date: charges.at(-1)!.date,
        // Never a day that has passed: the plan's day of the month, after today and after the last charge.
        next_date: nextOn(dayOfMonth, later(on, iso(last + 15))),
        // No charge for a month and a half past the usual gap means it stopped.
        active: day(latest) - last <= gap + 14,
      })
    }
    found.sort((a, b) => Number(b.active) - Number(a.active) || b.usual_amount - a.usual_amount)
    const active = found.filter(f => f.active)
    return { monthly_total: active.reduce((sum, f) => sum + f.usual_amount, 0), yearly_total: active.reduce((sum, f) => sum + f.usual_amount, 0) * 12, items: found }
  }

  /** Each card's cycle, read from its statements and from when its payments arrive. */
  function cards(on = today()) {
    const all = accounts().filter(a => a.kind === "card")
    return all.map(card => {
      const statements = db.query("select period, closing_date, due_date, amount_due from statements where account_id = ? order by period").all(card.id) as { period: string; closing_date: string; due_date: string | null; amount_due: number }[]
      const payments = db.query("select date, amount from transactions where account_id = ? and kind = 'transfer' and amount > 0 order by date").all(card.id) as { date: string; amount: number }[]
      const closingDay = statements.length ? Math.round(median(statements.map(s => Number(s.closing_date.slice(8))))) : null
      const due = statements.filter(s => s.due_date)
      const dueDay = due.length ? Math.round(median(due.map(s => Number(s.due_date!.slice(8))))) : null
      const dueGap = due.length ? Math.round(median(due.map(s => day(s.due_date!) - day(s.closing_date)))) : null
      const last = statements.at(-1)
      // The next closing date: the usual day, after the last statement and never a day that has passed.
      const closing = last && closingDay !== null ? nextOn(closingDay, later(on, iso(day(last.closing_date) + 1))) : null
      return {
        id: card.id,
        name: card.name,
        institution: card.institution,
        closing_day: closingDay,
        due_day: dueDay,
        payment_day: payments.length ? Math.round(median(payments.map(p => Number(p.date.slice(8))))) : null,
        payments: payments.length,
        last_statement: last ? { period: last.period, closing_date: last.closing_date, due_date: last.due_date, amount_due: money(last.amount_due) } : null,
        next_closing_date: closing,
        // A month with nothing owed prints no due date, so count from the closing date instead.
        next_due_date: closing && dueGap !== null ? iso(day(closing) + dueGap) : null,
        average_statement: statements.length ? money(statements.reduce((sum, s) => sum + s.amount_due, 0) / statements.length) : null,
      }
    })
  }

  return { importAll, accounts, summary, transactions, setCategory, recurring, cards, unsorted, sort }
}

export type Ledger = ReturnType<typeof createLedger>
