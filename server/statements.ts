import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checked, parse, type Parsed } from "../ingest/parsers"
import { HttpError } from "./http"

// A statement PDF as the bank sent it: decrypted with a password finance holds
// (FINANCE_PDF_PASSWORD, so a mail relay never needs it), read with pdftotext -layout,
// then the same parsers and the same total check as the CLI. A PDF whose fonts hide
// their text (CTBC) is read by OCR instead, when FINANCE_OCR_KEY is set. The text is
// never stored or logged.

export const MAX_PDF = 10 * 1024 * 1024

/** Statement text from PDF bytes, opened with the first password that works. */
export type Extract = (pdf: Uint8Array, passwords: string[]) => Promise<string>

/** Where OCR runs: an OpenAI style gateway with a `/ocr` route (llm.winlab.tw). */
export type Ocr = { url: string; key: string; model: string }

async function run(cmd: string[], stdin: string, timeoutMs = 20_000) {
  const proc = Bun.spawn(cmd, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  return { out, code }
}

/** Markdown of a PDF from the OCR service, pages in order, embedded images dropped. */
async function ocrText(pdf: Uint8Array, ocr: Ocr): Promise<string> {
  const res = await fetch(`${ocr.url.replace(/\/$/, "")}/ocr`, {
    method: "POST",
    headers: { authorization: `Bearer ${ocr.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: ocr.model, document: { type: "document_url", document_url: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` } }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null)
  // The service reads one document at a time for the whole lab, and answers 429 while busy.
  if (!res?.ok) throw new HttpError(503, res?.status === 429 ? "the OCR service is busy, try again in a minute" : "the OCR service did not answer")
  const body = (await res.json()) as { pages?: { markdown?: string }[] }
  return (body.pages ?? []).map(p => (p.markdown ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")).join("\n")
}

/** qpdf decrypts (the password goes on stdin, never on the command line), pdftotext reads, OCR reads what pdftotext cannot. */
export const pdfReader = (ocr: Ocr | null): Extract => async (pdf, passwords) => {
  const dir = await mkdtemp(join(tmpdir(), "finance-pdf-"))
  try {
    const input = join(dir, "in.pdf")
    const plain = join(dir, "plain.pdf")
    await writeFile(input, pdf, { mode: 0o600 })
    // Banks use different passwords; try each. Exit 3 is "succeeded with warnings", common with bank PDFs.
    let opened = false
    for (const password of passwords.length ? passwords : [""]) {
      const decrypt = await run(["qpdf", "--password-file=-", "--decrypt", input, plain], password)
      if (decrypt.code === 0 || decrypt.code === 3) {
        opened = true
        break
      }
    }
    if (!opened) throw new HttpError(422, "the PDF could not be opened: wrong password or a damaged file")
    const text = await run(["pdftotext", "-layout", plain, "-"], "")
    if (text.code !== 0) throw new HttpError(422, "no text could be read from the PDF")
    if (parse(text.out) || !ocr) return text.out
    return ocrText(new Uint8Array(await Bun.file(plain).arrayBuffer()), ocr)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A statement's payload, only when a parser knows it and its rows add up to its own total. */
export async function readStatement(pdf: Uint8Array, passwords: string[], extract: Extract): Promise<Parsed> {
  if (pdf.byteLength === 0 || pdf.byteLength > MAX_PDF) throw new HttpError(413, "a statement PDF is 10 MB at most")
  if (new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") throw new HttpError(415, "send the statement as a PDF")
  const parsed = parse(await extract(pdf, passwords))
  if (!parsed) throw new HttpError(422, "no parser knows this statement's layout")
  if (!checked(parsed.check)) throw new HttpError(422, parsed.check ? `${parsed.check.label} do not match, so nothing was imported` : "the statement's own total was not found, so nothing was imported")
  return parsed
}
