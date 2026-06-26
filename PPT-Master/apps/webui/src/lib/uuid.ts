// Browsers only expose crypto.randomUUID() in a "secure context" (HTTPS,
// localhost, file://). When the WebUI is served over plain HTTP from a LAN
// IP — typical for Docker / intranet deployments — randomUUID is undefined
// and any caller crashes the React render. This wrapper degrades gracefully:
// native API first, then a v4 built from crypto.getRandomValues, then a
// Math.random fallback (UI-only IDs, not cryptographic).

export function randomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID()
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
