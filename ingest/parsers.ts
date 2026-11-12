// Statement text (from `pdftotext -layout`) to an import payload. One parser
// per statement layout. Each one reads the statement's own total and reports
// it beside the sum of the rows it found, so a missed row shows up as a gap.

export type Payload = {
  source: string
  accounts: { id: string; name: string; kind: "deposit" | "card"; institution: string }[]
  balances: { account: string; date: string; amount: number }[]
  statements: { account: string; period: string; closing_date: string; due_date: string | null; amount_due: number }[]
  transactions: { account: string; date: string; posted_date?: string; amount: number; description: string }[]
}

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
      accounts: [{ id: account, name: "Cathay CUBE", kind: "card", institution: "Cathay United Bank" }],
      balances: [{ account, date: closing, amount: -amountDue }],
      statements: [{ account, period: `${year}-${pad(month)}`, closing_date: closing, due_date: due, amount_due: amountDue }],
      transactions,
    },
    check: spent ? { label: "purchases", expected: num(spent[1]), actual: purchases } : null,
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
  for (const [i, line] of all.entries()) {
    const row = dated.exec(line)
    if (!row) continue
    let description = row[7]?.trim() ?? ""
    // A long merchant name wraps: the name sits on the line above and the city on the line below.
    if (!description) {
      const above = all[i - 1]?.trim() ?? ""
      const below = all[i + 1]?.trim() ?? ""
      description = /^[A-Za-z ]{2,12}$/.test(below) ? `${above} ${below}` : above
    }
    const amount = num(row[8])
    // A phone bill paid by card also carries the payment word; only money coming back to the card is a payment.
    const payment = amount < 0 && /繳款/.test(description)
    if (!payment) purchases += amount
    transactions.push({ account, date: roc(row[1], row[2], row[3]), posted_date: roc(row[4], row[5], row[6]), amount: -amount, description })
  }
  const amountDue = total ? num(total[1]) : 0
  const closingDate = roc(closing[1], closing[2], closing[3])
  return {
    parser: "taishin-card",
    payload: {
      source: `taishin-card-${year}-${pad(month)}`,
      accounts: [{ id: account, name: "Taishin Richart", kind: "card", institution: "Taishin Bank" }],
      balances: [{ account, date: closingDate, amount: -amountDue }],
      statements: [{ account, period: `${year}-${pad(month)}`, closing_date: closingDate, due_date: due ? roc(due[1], due[2], due[3]) : null, amount_due: amountDue }],
      transactions,
    },
    check: added ? { label: "new charges", expected: num(added[1]), actual: purchases } : null,
  }
}

/**
 * Rows of a savings account. The layout prints one amount and the balance
 * after it, so the balance tells whether the amount came in or went out.
 */
function byBalance(rows: { date: string; description: string; amount: number; balance: number }[], opening: number | null, account: string) {
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
      accounts: [{ id: account, name: "E.SUN savings", kind: "deposit", institution: "E.SUN Bank" }],
      balances: [{ account, date: closing, amount: num(balance[1]) }],
      statements: [],
      transactions,
    },
    check: opening === null ? null : { label: "closing balance", expected: num(balance[1]), actual: Math.round((opening + net) * 100) / 100 },
  }
}

/** The withdrawal column sits left of the deposit column: the first amount's place on the line names its column. */
function guessOpening(text: string, first: { amount: number; balance: number }) {
  const header = lines(text).find(line => line.includes("提款") && line.includes("存款"))
  const line = lines(text).find(l => /^\s*\d{3}\/\d\d\/\d\d\s/.test(l))
  if (!header || !line) return first.balance - first.amount
  const amountEnd = line.search(/[\d,]+\.\d\d/) + (/[\d,]+\.\d\d/.exec(line)?.[0].length ?? 0)
  const withdrawal = Math.abs(amountEnd - (header.indexOf("提款") + 2)) < Math.abs(amountEnd - (header.indexOf("存款") + 2))
  return withdrawal ? first.balance + first.amount : first.balance - first.amount
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
      accounts: [{ id: account, name: "Next Bank savings", kind: "deposit", institution: "Next Bank" }],
      balances: [{ account, date: closing, amount: num(balance[1]) }],
      statements: [],
      transactions,
    },
    check: opening ? { label: "closing balance", expected: num(balance[1]), actual: num(opening[1]) + transactions.reduce((sum, t) => sum + t.amount, 0) } : null,
  }
}

const PARSERS = [cathayCard, taishinCard, esunBank, nextBank]

/** The first parser that knows the layout, or null when none does. */
export function parse(text: string): Parsed | null {
  for (const parser of PARSERS) {
    const parsed = parser(text)
    if (parsed) return parsed
  }
  return null
}
