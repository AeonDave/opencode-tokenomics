export const money = (n: number, dec = 2) =>
  "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })

export const num = (n: number) => (n || 0).toLocaleString("en-US")

export const compact = (n: number) =>
  (n || 0).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })

export const pct = (n: number) => (100 * (n || 0)).toFixed(1) + "%"

export const dur = (ms: number) => {
  ms = ms || 0
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  if (m < 60) return `${m}m${r ? ` ${r}s` : ""}`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export const shortModel = (m?: string) => {
  if (!m) return "—"
  const parts = m.split("/")
  return parts[parts.length - 1]
}

/** Provider segment of a "provider/model" key (everything before the last "/"). */
export const providerOf = (m?: string) => {
  if (!m || !m.includes("/")) return ""
  const parts = m.split("/")
  return parts.slice(0, -1).join("/")
}

export const clock = (t: number) => {
  const d = new Date(t)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

export const clockDay = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })

export const ago = (t: number) => {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}
