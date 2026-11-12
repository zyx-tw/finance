export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message = "") {
    super(message)
    this.status = status
  }
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> | Headers } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { ...init, headers })
}

// A year of statements from every account fits well inside 4 MB.
const MAX_JSON = 4 * 1024 * 1024

/** The raw body, refused past max bytes. */
export async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new HttpError(413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > max) throw new HttpError(413)
      chunks.push(chunk)
    }
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON) throw new HttpError(413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_JSON) throw new HttpError(413)
      chunks.push(chunk)
    }
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpError(400, "bad json")
}

/** Counts misses per key in a sliding hour and blocks a key past the limit. */
export function createLimiter(limit: number, windowMs = 3_600_000) {
  const misses = new Map<string, number[]>()
  const recent = (key: string) => (misses.get(key) ?? []).filter(at => at > Date.now() - windowMs)
  return {
    blocked: (key: string) => recent(key).length >= limit,
    miss(key: string) {
      misses.set(key, [...recent(key), Date.now()])
      if (misses.size > 10_000) misses.clear()
    },
  }
}
