import { expect, test } from "bun:test"
import { checked, parse } from "./parsers"

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

const TAISHIN_BANK = `
                                                資料期間：2026/09/01~2026/09/30
新臺幣帳戶概要區                                                                  現值參考日:2026/09/30
   帳號類別             帳戶號碼             定存/專案起迄日         定存/專案利率%        帳戶餘額           備註
新臺幣活存            288810****1111                                            $1,500        Richart
新臺幣活存            288817****2222                                            $8,000        Richart
合計                                                                                  $9,500
     帳號            日期          摘要       支票號碼   支出金額        存入金額        帳戶餘額                   備註
288810****1111   2026/09/01   刷卡消費                 $200                  $500 連支＊某超市
288810****1111   2026/09/07   轉帳存入                           $1,000      $1,500 轉出288817****2222
288817****2222   2026/09/02   轉帳支取                 $100                  $9,000 街口支付扣款
288817****2222   2026/09/07   轉帳支取               $1,000                  $8,000 轉入288810****1111
`

const SINOPAC_BANK = `
                                                對帳單期間：2026/09/01~2026/09/30
  永豐銀行
  幣別              存款種類              帳號                   外幣餘額                臺幣餘額             透支/質借額度
新臺幣          活期儲蓄存款          123-01*-**00000-*                                     5,065                   0
  交易日              摘要         支出                 存入                 餘額                      備註/資金用途
2026/09/10   股票款                   1,000                                 5,000
2026/09/19   利息存入                                        65               5,065
`

const FUBON_BANK = `
                                              對帳單期間：2026/09/01~2026/09/30
     帳戶種類       分行          帳號           幣別    存單號碼            餘額              起存日
     活期存款      營業部     12345678****00    TWD                          301.00
        貸款類型                  貸款帳號                    原貸金額                每月應繳月付金
                                                      貸款餘額                  適用利率             已繳期數
        就學貸款               87654321****00                 10,000.00           次月不須繳款          1日
                               112下學期                     10,000.00            0.000000%
        就學貸款               87654321****00                 20,000.00           次月不須繳款          1日
                               113上學期                     20,000.00            0.000000%
貸款餘額總計                              30,000.00
台幣活存
          帳號             日期              摘要               支出                         收入                         餘額
     12345678****00   2026/09/01        承轉結餘                                                                                 1.00
     12345678****00   2026/09/20        利息存入                                                    300.00                    301.00
`

const SECURITIES = `
                                                                                                                                  成交年月： 202609
                                                                                                     證券電子對帳單
    現股           0050         元大台灣50                 100                 100.00            10,000           110.00       11,000         1,000       10.00%
                               小計                    100                                   10,000                        11,000         1,000       10.00%
幣別：臺幣
2026/09/08 櫃買        元大台灣50                10   100.0000         1,000              1
`

test("taishin bank: one statement, several accounts, each checked against its own balance", () => {
  const { parser, payload, check } = parse(TAISHIN_BANK)!
  expect(parser).toBe("taishin-bank")
  expect(check).toEqual({ label: "closing balances", expected: 9500, actual: 9500 })
  expect(payload.accounts.map(a => a.id)).toEqual(["taishin-1111", "taishin-2222"])
  expect(payload.transactions.map(t => [t.account, t.amount])).toEqual([
    ["taishin-1111", -200],
    ["taishin-1111", 1000],
    ["taishin-2222", -100],
    ["taishin-2222", -1000],
  ])
  expect(payload.transactions[0].description).toBe("刷卡消費 連支＊某超市")
})

test("sinopac bank", () => {
  const { parser, payload, check } = parse(SINOPAC_BANK)!
  expect(parser).toBe("sinopac-bank")
  expect(payload.transactions.map(t => t.amount)).toEqual([-1000, 65])
  expect(check).toEqual({ label: "closing balance", expected: 5065, actual: 5065 })
})

test("fubon bank: the student loan is a debt", () => {
  const { parser, payload, check } = parse(FUBON_BANK)!
  expect(parser).toBe("fubon-bank")
  expect(payload.balances).toEqual([
    { account: "fubon", date: "2026-09-30", amount: 301 },
    { account: "fubon-loan", date: "2026-09-30", amount: -30000 },
  ])
  expect(payload.transactions.map(t => t.amount)).toEqual([300])
  expect(check).toEqual({ label: "savings and loan balances", expected: 30301, actual: 30301 })
})

test("securities: the holdings' value is the balance, and a buy arrives as a transfer", () => {
  const { parser, payload, check } = parse(SECURITIES)!
  expect(parser).toBe("sinopac-securities")
  expect(payload.balances).toEqual([{ account: "sinopac-securities", date: "2026-09-30", amount: 11000 }])
  expect(payload.transactions).toEqual([{ account: "sinopac-securities", date: "2026-09-08", amount: 1001, description: "股票款 元大台灣50", kind: "transfer" }])
  expect(check).toEqual({ label: "holdings value", expected: 11000, actual: 11000 })
  expect(parse(SECURITIES.replace("櫃買", "櫃賣"))!.check!.label).toBe("sells not read yet")
})

test("a statement whose own total is missing is not checked, so the cli does not send it", () => {
  expect(checked(parse(CATHAY)!.check)).toBe(true)
  const cut = parse(CATHAY.replace(/本期應繳總額.*\n/, "\n"))!
  expect(cut.check).toBeNull()
  expect(checked(cut.check)).toBe(false)
})
