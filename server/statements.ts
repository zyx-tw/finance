import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checked, parse, type Parsed } from "../ingest/parsers"
import { HttpError } from "./http"

// A statement PDF as the bank sent it: decrypted with the password finance holds
// (FINANCE_PDF_PASSWORD, so a mail relay never needs it), read with pdftotext -layout,
// then the same parsers and the same total check as the CLI. The text never leaves this
// process and is never stored or logged.

export const MAX_PDF = 10 * 1024 * 1024

/** Statement text from PDF bytes. */
export type Extract = (pdf: Uint8Array, password: string | null) => Promise<string>

async function run(cmd: string[], stdin: string, timeoutMs = 20_000) {
  const proc = Bun.spawn(cmd, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  return { out, code }
}

/** qpdf decrypts (the password goes on stdin, never on the command line), pdftotext reads. */
export const pdfText: Extract = async (pdf, password) => {
  const dir = await mkdtemp(join(tmpdir(), "finance-pdf-"))
  try {
    const input = join(dir, "in.pdf")
    const plain = join(dir, "plain.pdf")
    await writeFile(input, pdf, { mode: 0o600 })
    // Exit 3 is "succeeded with warnings", common with bank PDFs.
    const decrypt = await run(["qpdf", "--password-file=-", "--decrypt", input, plain], password ?? "")
    if (decrypt.code !== 0 && decrypt.code !== 3) throw new HttpError(422, "the PDF could not be opened: wrong password or a damaged file")
    const text = await run(["pdftotext", "-layout", plain, "-"], "")
    if (text.code !== 0) throw new HttpError(422, "no text could be read from the PDF")
    return text.out
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A statement's payload, only when a parser knows it and its rows add up to its own total. */
export async function readStatement(pdf: Uint8Array, password: string | null, extract: Extract): Promise<Parsed> {
  if (pdf.byteLength === 0 || pdf.byteLength > MAX_PDF) throw new HttpError(413, "a statement PDF is 10 MB at most")
  if (new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") throw new HttpError(415, "send the statement as a PDF")
  const parsed = parse(await extract(pdf, password))
  if (!parsed) throw new HttpError(422, "no parser knows this statement's layout")
  if (!checked(parsed.check)) throw new HttpError(422, parsed.check ? `${parsed.check.label} do not match, so nothing was imported` : "the statement's own total was not found, so nothing was imported")
  return parsed
}
