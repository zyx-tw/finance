import { resolve } from "node:path"
import type { JWK } from "jose"
import authKey from "./auth-key.json"

export type Config = {
  port: number
  data: string
  dist: string
  origin: string
  /** Where sign-in happens. */
  authOrigin: string
  /** auth.zyx.tw's public key, pinned in auth-key.json. */
  authKey: JWK
  /** The bearer token for importers and MCP clients. Off when unset. */
  token: string | null
  /** Anthropic API key for category suggestions. Off when unset. */
  anthropicKey: string | null
  /** The password of the banks' statement PDFs (POST /api/v1/statements). */
  pdfPassword: string | null
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const token = env.FINANCE_TOKEN?.trim() || null
  if (token && token.length < 32) throw new Error("FINANCE_TOKEN must be at least 32 characters")
  return {
    port: Number(env.FINANCE_PORT ?? 8080),
    data: resolve(env.FINANCE_DATA ?? "./data"),
    dist: resolve(env.FINANCE_DIST ?? "./dist"),
    origin: (env.FINANCE_ORIGIN ?? "http://localhost:8080").replace(/\/$/, ""),
    authOrigin: env.FINANCE_AUTH_ORIGIN ?? "https://auth.zyx.tw",
    authKey: authKey as JWK,
    token,
    anthropicKey: env.FINANCE_ANTHROPIC_KEY?.trim() || null,
    pdfPassword: env.FINANCE_PDF_PASSWORD?.trim() || null,
  }
}
