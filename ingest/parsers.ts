// Statement text (from `pdftotext -layout`) to an import payload. One parser
// per statement layout. Each one reads the statement's own total and reports
// it beside the sum of the rows it found, so a missed row shows up as a gap.

export type Payload = {
  source: string
  accounts: { id: string; name: string; kind: "deposit" | "investment" | "card" | "loan"; institution: string }[]
  balances: { account: string; date: string; amount: number }[]
  statements: { account: string; period: string; closing_date: string; due_date: string | null; amount_due: number }[]
  transactions: { account: string; date: string; posted_date?: string; amount: number; description: string; kind?: "transfer" }[]
}

/** True when the statement's own total was found and the rows add up to it. */
export const checked = (check: Parsed["check"]) => check !== null && Math.abs(check.expected - check.actual) < 0.005

export type Parsed = { parser: string; payload: Payload; check: { label: string; expected: number; actual: number } | null }

const num = (text: string) => Number(text.replace(/,/g, ""))
const pad = (n: number | string) => String(n).padStart(2, "0")
/** A date in the Republic of China calendar, as the banks print it: year 115 is 2026. */
const roc = (y: string, m: string, d: string) => `${Number(y) + 1911}-${m}-${d}`
/** A month and day with no year belongs to the statement's year, or the one before if it is a later month. */
const near = (year: number, month: number, m: string, d: string) => `${Number(m) > month ? year - 1 : year}-${pad(m)}-${pad(d)}`
const lines = (text: string) => text.split("\n").filter(line => line.trim())

function cathayCard(text: string): Parsed | null {
  const head = /信用卡帳單\s*(\d{3})年\s*(\d{1,2})月/.exec(text)
  if (!head || !text.includes("小樹點")) return null
  const year = Number(head[1]) + 1911
  const month = Number(head[2])
  const account = "cathay-card"
  // The statement's own dates sit alone on a line in the header: closing first, then due when something is owed.
  const dates = lines(text)
    .slice(0, 30)
    .map(line => /^\s*(\d{3})\/(\d\d)\/(\d\d)(\s|$)/.exec(line))
    .filter(match => match !== null)
  if (!dates.length) return null
  const closing = roc(dates[0][1], dates[0][2], dates[0][3])
  const due = dates[1] ? roc(dates[1][1], dates[1][2], dates[1][3]) : null
  const total = /本期應繳總額\s+(-?[\d,]+)/.exec(text)
  const spent = /正卡本期消費\s+(-?[\d,]+)/.exec(text)
  const transactions: Payload["transactions"] = []
  let purchases = 0
  for (const line of lines(text)) {
    // The amount is the number right before the card's last 4 digits; a merchant name can end in a number too.
    const row = /^\s*(\d\d)\/(\d\d)\s+(\d\d)\/(\d\d)\s+(.+?)\s{2,}(-?[\d,]+)(?:\s+\d{4}\b.*)?$/.exec(line)
    if (!row) continue
    const amount = num(row[6])
    const payment = amount < 0 && /繳款/.test(row[5])
    if (!payment) purchases += amount
    transactions.push({ account, date: near(year, month, row[1], row[2]), posted_date: near(year, month, row[3], row[4]), amount: -amount, description: row[5].trim() })
  }
  const amountDue = total ? num(total[1]) : 0
  return {
    parser: "cathay-card",
    payload: {
      source: `cathay-card-${year}-${pad(month)}`,
      accounts: [{ id: account, name: "國泰 CUBE 卡", kind: "card", institution: "Cathay United Bank" }],
      balances: [{ account, date: closing, amount: -amountDue }],
      statements: [{ account, period: `${year}-${pad(month)}`, closing_date: closing, due_date: due, amount_due: amountDue }],
      transactions,
    },
    // Without the amount due the balance would read 0: leave it unchecked so it is not sent.
    check: spent && total ? { label: "purchases", expected: num(spent[1]), actual: purchases } : null,
  }
}

function taishinCard(text: string): Parsed | null {
  const head = /(\d{3})年\s*(\d{1,2})月\s*信用卡電子帳單/.exec(text)
  if (!head || !text.includes("台新")) return null
  const year = Number(head[1]) + 1911
  const month = Number(head[2])
  const account = "taishin-card"
  const closing = /帳單結帳日\s+(\d{3})\/(\d\d)\/(\d\d)/.exec(text)
  const due = /繳款截止日\s+(\d{3})\/(\d\d)\/(\d\d)/.exec(text)
  const total = /本期累計應繳金額\s+(-?[\d,]+)/.exec(text)
  const added = /本期新增款項\s+(-?[\d,]+)/.exec(text)
  if (!closing) return null
  const all = lines(text)
  const dated = /^\s*(\d{3})\/(\d\d)\/(\d\d)\s+(\d{3})\/(\d\d)\/(\d\d)\s+(?:(.+?)\s{2,})?(-?[\d,]+)\s*(?:(?:\d\d\/?\d\d\s+)?[A-Z]{2}\b.*)?$/
  const transactions: Payload["transactions"] = []
  let purchases = 0
  const closingDay = roc(closing[1], closing[2], closing[3])
  for (const [i, line] of all.entries()) {
    // Interest and fees have no date: they belong to the closing day.
    const fee = /^\s*(循環信用利息|違約金|\S*手續費)\s+(-?[\d,]+)\s*$/.exec(line)
    if (fee) {
      purchases += num(fee[2])
      transactions.push({ account, date: closingDay, amount: -num(fee[2]), description: fee[1] })
      continue
    }
    const row = dated.exec(line)
    if (!row) continue
    let description = row[7]?.trim() ?? ""
    // A long merchant name wraps: the name sits on the line above and the city on the line below.
    if (!description) {
      const above = all[i - 1]?.trim() ?? ""
      const below = all[i + 1]?.trim() ?? ""
      description = /^[A-Za-z ]{2,12}$|^卡款$/.test(below) ? `${above} ${below}` : above
    }
    const amount = num(row[8])
    // A phone bill paid by card also carries the payment word; only money coming back to the card is a payment.
    const payment = amount < 0 && /繳款|扣繳/.test(description)
    if (!payment) purchases += amount
    transactions.push({ account, date: roc(row[1], row[2], row[3]), posted_date: roc(row[4], row[5], row[6]), amount: -amount, description })
  }
  const amountDue = total ? num(total[1]) : 0
  const closingDate = closingDay
  return {
    parser: "taishin-card",
    payload: {
      source: `taishin-card-${year}-${pad(month)}`,
      accounts: [{ id: account, name: "台新 Richart 卡", kind: "card", institution: "Taishin Bank" }],
      balances: [{ account, date: closingDate, amount: -amountDue }],
      statements: [{ account, period: `${year}-${pad(month)}`, closing_date: closingDate, due_date: due ? roc(due[1], due[2], due[3]) : null, amount_due: amountDue }],
      transactions,
    },
    // Without the amount due the balance would read 0: leave it unchecked so it is not sent.
    check: added && total ? { label: "new charges", expected: num(added[1]), actual: purchases } : null,
  }
}

/**
 * Rows of a savings account. The layout prints one amount and the balance
 * after it, so the balance tells whether the amount came in or went out.
 */
function byBalance(rows: { date: string; description: string; amount: number; balance: number }[], opening: number | null, account: string): Payload["transactions"] {
  const transactions: Payload["transactions"] = []
  let before = opening
  for (const row of rows) {
    const sign = before === null ? 0 : Math.abs(before + row.amount - row.balance) < 0.005 ? 1 : Math.abs(before - row.amount - row.balance) < 0.005 ? -1 : 0
    if (sign) transactions.push({ account, date: row.date, amount: sign * row.amount, description: row.description })
    before = row.balance
  }
  return transactions
}

function esunBank(text: string): Parsed | null {
  const flat = text.replace(/[ \t]+/g, "")
  const asOf = /資料參考日[:：](\d{4})\/(\d\d)\/(\d\d)/.exec(flat)
  if (!asOf || !flat.includes("玉山")) return null
  const account = "esun"
  const closing = `${asOf[1]}-${asOf[2]}-${asOf[3]}`
  const balance = /臺幣活存\s+\S+\s+TWD\s+([\d,.]+)/.exec(text)
  if (!balance) return null
  const rows = []
  for (const line of lines(text)) {
    const row = /^\s*(\d{3})\/(\d\d)\/(\d\d)\s+(\S+)\s+([\d,]+\.\d\d)\s+(.*?)\s*([\d,]+\.\d\d)\s*$/.exec(line)
    if (row) rows.push({ date: roc(row[1], row[2], row[3]), description: `${row[4]} ${row[6].replace(/\s+/g, " ")}`.trim(), amount: num(row[5]), balance: num(row[7]) })
  }
  // Every row after the first is known by the balance before it. The first row
  // has no balance before it, so its column on the page decides.
  const first = rows[0]
  const opening = first ? guessOpening(text, first) : null
  const transactions = byBalance(rows, opening, account)
  const net = transactions.reduce((sum, t) => sum + t.amount, 0)
  return {
    parser: "esun-bank",
    payload: {
      source: `esun-${closing.slice(0, 7)}`,
      accounts: [{ id: account, name: "玉山存款", kind: "deposit", institution: "E.SUN Bank" }],
      balances: [{ account, date: closing, amount: num(balance[1]) }],
      statements: [],
      transactions,
    },
    check: opening === null ? (rows.length ? null : { label: "closing balance, no rows", expected: 0, actual: 0 }) : { label: "closing balance", expected: num(balance[1]), actual: Math.round((opening + net) * 100) / 100 },
  }
}

/** The withdrawal column sits left of the deposit column: the first amount's place on the line names its column. */
function guessOpening(text: string, first: { amount: number; balance: number }) {
  const header = lines(text).find(line => line.includes("提款") && line.includes("存款"))
  const line = lines(text).find(l => /^\s*\d{3}\/\d\d\/\d\d\s/.test(l))
  if (!header || !line) return first.balance - first.amount
  const amountEnd = line.search(/[\d,]+\.\d\d/) + (/[\d,]+\.\d\d/.exec(line)?.[0].length ?? 0)
  return openingByColumn(header, "提款", "存款", amountEnd, first)
}

/** The balance before a first row: the end of its amount sits under the withdrawal or the deposit heading. */
function openingByColumn(header: string, out: string, into: string, amountEnd: number, first: { amount: number; balance: number }) {
  const withdrawal = Math.abs(amountEnd - (header.indexOf(out) + out.length)) < Math.abs(amountEnd - (header.indexOf(into) + into.length))
  return withdrawal ? first.balance + first.amount : first.balance - first.amount
}

type Row = { date: string; description: string; amount: number; balance: number; amountEnd: number }

/** Rows of one savings account to transactions, checked against the balance the statement prints for it. */
function savings(account: string, rows: Row[], header: string | undefined, out: string, into: string, closing: number) {
  const first = rows[0]
  if (!first) return { transactions: [], actual: closing }
  const opening = header ? openingByColumn(header, out, into, first.amountEnd, first) : first.balance - first.amount
  const transactions = byBalance(rows, opening, account)
  return { transactions, actual: Math.round((opening + transactions.reduce((sum, t) => sum + t.amount, 0)) * 100) / 100 }
}

/** Taishin and Richart: several savings accounts in one statement, each with its own rows. */
function taishinBank(text: string): Parsed | null {
  const period = /資料期間[:：](\d{4})\/(\d\d)\/(\d\d)~(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  if (!period || !text.includes("新臺幣帳戶概要區")) return null
  const closing = `${period[4]}-${period[5]}-${period[6]}`
  const all = lines(text)
  const header = all.find(line => line.includes("支出金額") && line.includes("存入金額"))
  const accounts: Payload["accounts"] = []
  const balances: Payload["balances"] = []
  const transactions: Payload["transactions"] = []
  let expected = 0
  let actual = 0
  for (const line of all) {
    const summary = /^\s*新臺幣活存\s+\d+\*+(\d{4})\s+\$([\d,]+)/.exec(line)
    if (!summary) continue
    const last4 = summary[1]
    const id = `taishin-${last4}`
    const rows: Row[] = []
    for (const row of all) {
      const match = new RegExp(`^\\s*\\d+\\*+${last4}\\s+(\\d{4})/(\\d\\d)/(\\d\\d)\\s+(\\S+)\\s+\\$([\\d,]+)\\s+\\$([\\d,]+)\\s*(.*)$`).exec(row)
      if (!match) continue
      const amountEnd = row.indexOf(`$${match[5]}`) + match[5].length + 1
      rows.push({ date: `${match[1]}-${match[2]}-${match[3]}`, description: `${match[4]} ${match[7].trim()}`.trim(), amount: num(match[5]), balance: num(match[6]), amountEnd })
    }
    const result = savings(id, rows, header, "支出金額", "存入金額", num(summary[2]))
    accounts.push({ id, name: `台新 Richart ${last4}`, kind: "deposit", institution: "Taishin Bank" })
    balances.push({ account: id, date: closing, amount: num(summary[2]) })
    transactions.push(...result.transactions)
    expected += num(summary[2])
    actual += result.actual
  }
  if (!accounts.length) return null
  return {
    parser: "taishin-bank",
    payload: { source: `taishin-bank-${closing.slice(0, 7)}`, accounts, balances, statements: [], transactions },
    check: { label: "closing balances", expected, actual },
  }
}

function sinopacBank(text: string): Parsed | null {
  const period = /對帳單期間[:：](\d{4})\/(\d\d)\/(\d\d)~(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  if (!period || !text.includes("永豐")) return null
  const balance = /新臺幣\s+活期儲蓄存款\s+\S+\s+([\d,]+)/.exec(text)
  if (!balance) return null
  const account = "sinopac"
  const closing = `${period[4]}-${period[5]}-${period[6]}`
  const all = lines(text)
  const header = all.find(line => /交易日\s+摘要\s+支出\s+存入\s+餘額/.test(line))
  const rows: Row[] = []
  for (const line of all) {
    const match = /^\s*(\d{4})\/(\d\d)\/(\d\d)\s+(\S+)\s+([\d,]+)\s+([\d,]+)(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const amountEnd = line.indexOf(match[5], line.indexOf(match[4]) + match[4].length) + match[5].length
    rows.push({ date: `${match[1]}-${match[2]}-${match[3]}`, description: `${match[4]} ${match[7]?.trim() ?? ""}`.trim(), amount: num(match[5]), balance: num(match[6]), amountEnd })
  }
  const result = savings(account, rows, header, "支出", "存入", num(balance[1]))
  return {
    parser: "sinopac-bank",
    payload: {
      source: `sinopac-${closing.slice(0, 7)}`,
      accounts: [{ id: account, name: "永豐存款", kind: "deposit", institution: "Bank SinoPac" }],
      balances: [{ account, date: closing, amount: num(balance[1]) }],
      statements: [],
      transactions: result.transactions,
    },
    check: { label: "closing balance", expected: num(balance[1]), actual: result.actual },
  }
}

/** Fubon: a savings account and the loans the bank holds, such as a student loan. */
function fubonBank(text: string): Parsed | null {
  const period = /對帳單期間[:：](\d{4})\/(\d\d)\/(\d\d)~(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  if (!period || !/台幣活存/.test(text) || !/活期存款\s+\S+\s+\d+\*+\d+\s+TWD/.test(text)) return null
  const closing = `${period[4]}-${period[5]}-${period[6]}`
  const all = lines(text)
  const balance = /活期存款\s+\S+\s+\d+\*+\d+\s+TWD\s+([\d,.]+)/.exec(text)!
  const header = all.find(line => /日期\s+摘要\s+支出\s+收入\s+餘額/.test(line))
  const rows: Row[] = []
  for (const line of all) {
    const match = /^\s*\d+\*+\d+\s+(\d{4})\/(\d\d)\/(\d\d)\s+(\S+)\s+([\d,]+\.\d\d)\s+([\d,]+\.\d\d)\s*(.*)$/.exec(line)
    if (!match) continue
    const amountEnd = line.indexOf(match[5]) + match[5].length
    rows.push({ date: `${match[1]}-${match[2]}-${match[3]}`, description: `${match[4]} ${match[7].trim()}`.trim(), amount: num(match[5]), balance: num(match[6]), amountEnd })
  }
  const result = savings("fubon", rows, header, "支出", "收入", num(balance[1]))
  const accounts: Payload["accounts"] = [{ id: "fubon", name: "富邦存款", kind: "deposit", institution: "Taipei Fubon Bank" }]
  const balances: Payload["balances"] = [{ account: "fubon", date: closing, amount: num(balance[1]) }]
  // The loan total is the debt; each loan prints its own balance on a second line.
  const loans = /貸款餘額總計\s+([\d,.]+)/.exec(text)
  let loanCheck = 0
  if (loans) {
    accounts.push({ id: "fubon-loan", name: "富邦學貸", kind: "loan", institution: "Taipei Fubon Bank" })
    balances.push({ account: "fubon-loan", date: closing, amount: -num(loans[1]) })
    for (const [i, line] of all.entries()) {
      if (!/^\s*就學貸款|^\s*\S*貸款\s+\d+\*+\d+\s+[\d,]+\.\d\d/.test(line)) continue
      const next = /^\s*\S+\s+([\d,]+\.\d\d)\s+[\d.]+%/.exec(all[i + 1] ?? "")
      if (next) loanCheck += num(next[1])
    }
  }
  return {
    parser: "fubon-bank",
    payload: { source: `fubon-${closing.slice(0, 7)}`, accounts, balances, statements: [], transactions: result.transactions },
    check: { label: "savings and loan balances", expected: num(balance[1]) + (loans ? num(loans[1]) : 0), actual: result.actual + loanCheck },
  }
}

/**
 * SinoPac Securities: the market value of the holdings is the balance, and each
 * buy is money arriving from the bank, which pairs with the bank's 股票款 row.
 */
function sinopacSecurities(text: string): Parsed | null {
  const month = /成交年月[:：]\s*(\d{4})(\d\d)/.exec(text)
  if (!month || !text.includes("證券電子對帳單")) return null
  const account = "sinopac-securities"
  const year = Number(month[1])
  const end = new Date(Date.UTC(year, Number(month[2]), 0)).toISOString().slice(0, 10)
  const all = lines(text)
  const total = all.map(line => /^\s*小計\s+[\d,]+\s+[\d,]+\s+([\d,]+)\s+-?[\d,]+/.exec(line)).find(Boolean)
  let held = 0
  for (const line of all) {
    const row = /^\s*(現股|融資|融券)\s+\S+\s+\S+\s+[\d,]+\s+[\d,.]+\s+[\d,]+\s+[\d,.]+\s+([\d,]+)\s/.exec(line)
    if (row) held += num(row[2])
  }
  const transactions: Payload["transactions"] = []
  let sells = 0
  for (const line of all) {
    const trade = /^\s*(\d{4})\/(\d\d)\/(\d\d)\s+(\S+)\s+(\S+)\s+([\d,]+)\s+[\d,.]+\s+([\d,]+)\s+([\d,]+)/.exec(line)
    if (!trade) continue
    if (!/買$/.test(trade[4])) {
      sells++
      continue
    }
    transactions.push({ account, date: `${trade[1]}-${trade[2]}-${trade[3]}`, amount: num(trade[7]) + num(trade[8]), description: `股票款 ${trade[5]}`, kind: "transfer" })
  }
  const value = total ? num(total[1]) : held
  return {
    parser: "sinopac-securities",
    payload: {
      source: `sinopac-securities-${month[1]}-${month[2]}`,
      accounts: [{ id: account, name: "永豐金證券", kind: "investment", institution: "SinoPac Securities" }],
      balances: [{ account, date: end, amount: value }],
      statements: [],
      transactions,
    },
    // A sell also pays a tax this parser does not read yet, so a statement with a sell does not pass.
    check: sells ? { label: "sells not read yet", expected: 0, actual: sells } : { label: "holdings value", expected: value, actual: held },
  }
}

function nextBank(text: string): Parsed | null {
  const period = /帳單期間\s*(\d{4})\/(\d\d)\/(\d\d)~(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  if (!period || !text.includes("將來銀行")) return null
  const account = "nextbank"
  const year = Number(period[4])
  const closing = `${period[4]}-${period[5]}-${period[6]}`
  const balance = /新臺幣餘額[:：]\s*NT\$([\d,]+)/.exec(text)
  const opening = /上期餘額\s+([\d,]+)/.exec(text)
  if (!balance) return null
  const rows = []
  for (const line of lines(text)) {
    const row = /^\s*(\d{1,2})\/(\d{1,2})\s+(\S+)\s+([\d,]+)\s+([\d,]+)(?:\s+(.*))?$/.exec(line)
    if (row) rows.push({ date: `${year}-${pad(row[1])}-${pad(row[2])}`, description: row[3], amount: num(row[4]), balance: num(row[5]) })
  }
  const transactions = byBalance(rows, opening ? num(opening[1]) : null, account)
  return {
    parser: "next-bank",
    payload: {
      source: `nextbank-${closing.slice(0, 7)}`,
      accounts: [{ id: account, name: "將來銀行存款", kind: "deposit", institution: "Next Bank" }],
      balances: [{ account, date: closing, amount: num(balance[1]) }],
      statements: [],
      transactions,
    },
    check: opening ? { label: "closing balance", expected: num(balance[1]), actual: num(opening[1]) + transactions.reduce((sum, t) => sum + t.amount, 0) } : null,
  }
}

/**
 * CTBC: its fonts hide the Chinese from pdftotext, so this reads the OCR's
 * markdown (digits read the same either way). OCR may put a row's amounts on the
 * line above its date, so a line with amounts but no date waits for the next date.
 */
function ctbcBank(text: string): Parsed | null {
  const period = /對帳單期間[:：]?\s*(\d{4})\/(\d\d)\/(\d\d)\s*[-~]\s*(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  const start = text.indexOf("台幣無摺帳戶交易明細")
  if (!period || start < 0 || !/中國信託|ctbcbank/i.test(text)) return null
  const account = "ctbc"
  const closing = `${period[4]}-${period[5]}-${period[6]}`
  const block = text.slice(start)
  const opening = /上期結餘\s+([\d,]+)/.exec(block)
  const end = /本期結餘([^\n]*)/.exec(block)
  if (!opening || !end) return null
  const amounts = (line: string) => line.split(/\s+/).filter(t => /^[\d,]+(\.\d\d)?$/.test(t) && !/^\d{4}\/\d\d\/\d\d$/.test(t)).map(num)
  const words = (line: string) => line.replace(/\d{4}\/\d\d\/\d\d/, "").split(/\s+/).filter(t => t && !/\d/.test(t) && !t.startsWith("`"))
  const closingBalance = amounts(end[1]).at(-1)
  if (closingBalance === undefined) return null
  const rows: { date: string; description: string; amount: number; balance: number }[] = []
  let current: { date: string; words: string[]; nums: number[] } | null = null
  let waiting: { words: string[]; nums: number[] } | null = null
  const flush = () => {
    if (current && current.nums.length >= 2) rows.push({ date: current.date, description: [...new Set(current.words)].join(" "), amount: current.nums.at(-2)!, balance: current.nums.at(-1)! })
    current = null
  }
  const stop = block.search(/本次合計|本期結餘/)
  for (const line of lines(block.slice(opening.index + opening[0].length, stop))) {
    const date = /(\d{4})\/(\d\d)\/(\d\d)/.exec(line)
    const nums = amounts(line)
    if (date) {
      flush()
      current = { date: `${date[1]}-${date[2]}-${date[3]}`, words: words(line), nums }
      if (!nums.length && waiting) {
        current.words.push(...waiting.words)
        current.nums = waiting.nums
      }
      waiting = null
    } else if (nums.length >= 2) {
      if (current && !(current as { nums: number[] }).nums.length) {
        current.nums = nums
        current.words.push(...words(line))
      } else {
        flush()
        waiting = { words: words(line), nums }
      }
    } else if (current) current.words.push(...words(line))
  }
  flush()
  const transactions = byBalance(rows, num(opening[1]), account)
  return {
    parser: "ctbc-bank",
    payload: {
      source: `ctbc-${closing.slice(0, 7)}`,
      accounts: [{ id: account, name: "中信存款", kind: "deposit", institution: "CTBC Bank" }],
      balances: [{ account, date: closing, amount: closingBalance }],
      statements: [],
      transactions,
    },
    check: { label: "closing balance", expected: closingBalance, actual: num(opening[1]) + transactions.reduce((sum, t) => sum + t.amount, 0) },
  }
}

/**
 * Taishin's debit card statement repeats rows of a Richart account that the
 * Taishin statement already brings, so it adds nothing: its purchases are only
 * checked against its own total.
 */
function taishinDebit(text: string): Parsed | null {
  const period = /對帳單期間[:：]\s*(\d{4})\/(\d\d)\/(\d\d)\s*~\s*(\d{4})\/(\d\d)\/(\d\d)/.exec(text)
  const total = /本月消費金額共計\s*NT\$\s*([\d,]+)/.exec(text)
  if (!period || !total || !text.includes("簽帳金融卡") || !text.includes("台新")) return null
  let sum = 0
  for (const line of lines(text)) {
    const row = /^\s*\d{4}\/\d\d\/\d\d\s+\d{4}\/\d\d\/\d\d\b.*\s([\d,]+)\s*$/.exec(line)
    if (row) sum += num(row[1])
  }
  return {
    parser: "taishin-debit",
    payload: { source: `taishin-debit-${period[4]}-${period[5]}`, accounts: [], balances: [], statements: [], transactions: [] },
    check: { label: "purchases", expected: num(total[1]), actual: sum },
  }
}

const PARSERS = [cathayCard, taishinCard, esunBank, nextBank, taishinBank, sinopacBank, fubonBank, sinopacSecurities, ctbcBank, taishinDebit]

/** The first parser that knows the layout, or null when none does. */
export function parse(text: string): Parsed | null {
  for (const parser of PARSERS) {
    const parsed = parser(text)
    if (parsed) return parsed
  }
  return null
}
