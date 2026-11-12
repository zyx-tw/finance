import { expect, test } from "bun:test"
import { parse } from "./parsers"

// Made-up statements in each bank's layout. Real statements never go in git.

const CATHAY = `
                                 信用卡帳單 115年10月
                             115/10/18                                                  20,000
                             115/11/02
 小樹點(信用卡)                1,000
 10/07   10/08   ＣＵＢＥＡｐｐ轉帳繳款                                      -5,000
                 繳款小計                                             -5,000
 09/16   09/18   OPENAI *CHATGPT SUBSCR                              690    1234       4321   US   TWD              690.00     09/16
 09/16   10/16   國外交易手續費 -OPENAI                                      10    1234
 09/20   09/22   SOME SHOP       8932               3,775    1234       5678   KR   KRW         164,500.00      09/19
 11/30   12/02   去年的店                                              100    1234              TW   TWD
                 正卡本期消費                                            4,575
                 本期應繳總額                                            4,575
`

const TAISHIN = `
                                               115年 10月 信用卡電子帳單
  台新銀行
帳單結帳日                115/10/18
繳款截止日                115/11/02
+本期新增款項                    3,082
=本期累計應繳金額                  3,082
115/10/02 115/10/02 Richart Life繳款            -12,854
                    優步－某某小吃 某某路A4782
115/09/15 115/09/18                             1,633     TW
                    TAIPEI
115/10/02 115/10/06 台哥大帳單－網路／語音繳款Taipei         1,206     TW
115/08/15 115/08/20 SOMEPAY*MetroA4782 SEOUL           48 0814   KR    USD    1.49
115/10/01 115/10/05 連支＊咖啡Taipei                        195     TW
`

const ESUN = `
                                                                 資 料 參 考 日 ：2026/09/30
  玉山銀行
臺幣活存                         1234567***890                       TWD                                  40,000.00
交易日期               摘要         提款               存款        轉入帳戶/備註            對方帳號                            餘額
115/09/05          轉帳                         8,777.00    11112222                                     48,777.00
115/09/14    行銀非約跨優         10,000.00                       一*         007 0000012345***678            38,777.00
115/09/25          轉帳                         1,223.00    11112222                                     40,000.00
`

const NEXT = `
將來銀行，開啟你的將來
                                             帳單期間 2026/09/01~2026/09/30
帳號：123456****7890 ｜ TWD ｜ 新臺幣餘額：NT$1,002
             上期餘額                                     1,000
  9/21       利息存入                2                    1,002   REF0001
`

test("cathay card: the amount sits before the card digits, dates take the statement's year", () => {
  const { parser, payload, check } = parse(CATHAY)!
  expect(parser).toBe("cathay-card")
  expect(check).toEqual({ label: "purchases", expected: 4575, actual: 4575 })
  expect(payload.statements[0]).toEqual({ account: "cathay-card", period: "2026-10", closing_date: "2026-10-18", due_date: "2026-11-02", amount_due: 4575 })
  expect(payload.transactions.find(t => t.description.startsWith("SOME SHOP"))!.amount).toBe(-3775)
  expect(payload.transactions.find(t => t.description === "去年的店")!.date).toBe("2025-11-30")
  expect(payload.transactions[0]).toMatchObject({ amount: 5000, date: "2026-10-07" })
  expect(payload.balances[0].amount).toBe(-4575)
})

test("taishin card: wrapped names, foreign rows and a bill that carries the payment word", () => {
  const { parser, payload, check } = parse(TAISHIN)!
  expect(parser).toBe("taishin-card")
  expect(check).toEqual({ label: "new charges", expected: 3082, actual: 3082 })
  expect(payload.transactions.map(t => t.description)).toEqual(["Richart Life繳款", "優步－某某小吃 某某路A4782 TAIPEI", "台哥大帳單－網路／語音繳款Taipei", "SOMEPAY*MetroA4782 SEOUL", "連支＊咖啡Taipei"])
  expect(payload.statements[0].due_date).toBe("2026-11-02")
})

test("esun bank: the balance tells deposits from withdrawals", () => {
  const { parser, payload, check } = parse(ESUN)!
  expect(parser).toBe("esun-bank")
  expect(payload.transactions.map(t => t.amount)).toEqual([8777, -10000, 1223])
  expect(check).toEqual({ label: "closing balance", expected: 40000, actual: 40000 })
  expect(payload.balances[0]).toEqual({ account: "esun", date: "2026-09-30", amount: 40000 })
})

test("next bank", () => {
  const { parser, payload, check } = parse(NEXT)!
  expect(parser).toBe("next-bank")
  expect(payload.transactions).toEqual([{ account: "nextbank", date: "2026-09-21", amount: 2, description: "利息存入" }])
  expect(check!.actual).toBe(1002)
})

test("an unknown layout has no parser", () => {
  expect(parse("hello")).toBeNull()
})
