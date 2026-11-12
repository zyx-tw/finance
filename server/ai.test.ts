import { expect, test } from "bun:test"
import { redact } from "./ai"

test("redact removes account numbers, masks, dates and amounts", () => {
  expect(redact("跨行轉入 822-12345678901 王小明")).toBe("跨行轉入 王小明")
  expect(redact("轉帳 0000****1234")).toBe("轉帳")
  expect(redact("繳款 12345678XXXX9012 2026/10/05 1,234.00")).toBe("繳款")
  expect(redact("ATM 提款 卡號 ＊＊1234")).toBe("ATM 提款 卡號")
})

test("redact keeps merchant names and short numbers", () => {
  expect(redact("7-ELEVEN 新竹店")).toBe("7-ELEVEN 新竹店")
  expect(redact("85度C")).toBe("85度C")
  expect(redact("Spotify P1A2B3")).toBe("Spotify P1A2B3")
})
