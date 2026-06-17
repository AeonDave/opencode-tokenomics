/**
 * Local web server: static dashboard + JSON snapshot + SSE live stream.
 *
 * Only the first opencode instance to bind the port runs a server; later instances get
 * EADDRINUSE and act as data writers only (startServer returns null for them).
 *
 * Routes:
 *   GET /api/health  -> { ok: true }
 *   GET /api/stats   -> GlobalSnapshot (merged across projects)
 *   GET /api/stream  -> text/event-stream pushing GlobalSnapshot on every change
 *   GET /*           -> dashboard/dist static assets (SPA fallback to index.html),
 *                       or a built-in live page when the dashboard isn't built yet
 */

import * as path from "node:path"
import type { Aggregator } from "./aggregator"
import { config } from "./config"
import type { Settings } from "./settings"
import { saveSettings } from "./settings"
import type { Bus } from "./store"
import { deleteAllProjects, deleteProjectFiles, readGlobal, watchProjects } from "./store"
import { FALLBACK_HTML } from "./fallback-page"

const DIST_DIR = path.join(import.meta.dir, "..", "..", "dashboard", "dist")
const SERVICE = "opencode-tokenomics"
const PORT_SCAN = 20

export interface RunningServer {
	stop(): void
	/** The URL the dashboard is actually being served on. */
	url: string
	port: number
	/** Whether any dashboard (SSE) client is currently connected. */
	hasClients(): boolean
}

/** Live count of connected SSE clients, used to detect an already-open dashboard. */
type Clients = { count: number }

/** What, if anything, is listening on a port. */
async function probe(port: number): Promise<"tokenomics" | "foreign" | "free"> {
	try {
		const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(300) })
		if (res.ok) {
			const body = (await res.json().catch(() => null)) as { service?: string } | null
			if (body?.service === SERVICE) return "tokenomics"
		}
		return "foreign"
	} catch {
		return "free"
	}
}

/**
 * Bind the dashboard server, scanning upward from the configured port. A foreign server
 * (another plugin on the same port, e.g. opencode-mem) is skipped; another tokenomics
 * instance already serving means we become a writer-only instance (its server reads our
 * files), so the dashboard stays a single shared page. Returns the bound server, or null
 * when a sibling already serves it.
 */
export async function startServer(bus: Bus, aggregator?: Aggregator, settings?: Settings): Promise<RunningServer | null> {
	for (let port = config.port; port < config.port + PORT_SCAN; port++) {
		const who = await probe(port)
		if (who === "tokenomics") return null // a sibling already serves the dashboard
		if (who === "foreign") continue // someone else (e.g. opencode-mem) — try the next port
		try {
			const clients: Clients = { count: 0 }
			const server = Bun.serve({
				port,
				idleTimeout: 0,
				development: false,
				fetch: (req) => handle(req, bus, clients, aggregator, settings),
			})
			// Another instance's disk writes must also wake our SSE clients.
			const unwatch = watchProjects(() => bus.emit())
			return {
				stop() {
					unwatch()
					server.stop(true)
				},
				url: `http://localhost:${port}`,
				port,
				hasClients: () => clients.count > 0,
			}
		} catch {
			// Lost a race between probe and bind — try the next port.
		}
	}
	return null
}

async function handle(req: Request, bus: Bus, clients: Clients, aggregator?: Aggregator, settings?: Settings): Promise<Response> {
	const url = new URL(req.url)
	const pathname = url.pathname

	if (pathname === "/api/health") {
		return Response.json({ ok: true, service: SERVICE })
	}
	if (pathname === "/api/stats") {
		return Response.json(await readGlobal(), { headers: { "cache-control": "no-store" } })
	}
	if (pathname === "/api/stream") {
		return streamResponse(bus, clients)
	}

	// Card settings: which cards are shown (and computed).
	if (pathname === "/api/config" && req.method === "GET") {
		return Response.json({ cards: settings?.all() ?? {} }, { headers: { "cache-control": "no-store" } })
	}
	if (pathname === "/api/config" && (req.method === "PUT" || req.method === "POST")) {
		if (!settings) return Response.json({ ok: false }, { status: 503 })
		const body = (await req.json().catch(() => null)) as { cards?: Record<string, unknown> } | null
		settings.apply(body?.cards)
		await saveSettings(settings).catch(() => {})
		bus.emit() // recompute/refresh on the next flush with the new gating
		return Response.json({ ok: true, cards: settings.all() })
	}

	// Delete every project's stored data.
	if (pathname === "/api/projects" && req.method === "DELETE") {
		const deleted = await deleteAllProjects()
		aggregator?.forgetAll()
		bus.emit()
		return Response.json({ ok: true, deleted })
	}
	// Delete one project by its key.
	if (pathname.startsWith("/api/projects/") && req.method === "DELETE") {
		const key = decodeURIComponent(pathname.slice("/api/projects/".length))
		const ok = await deleteProjectFiles(key)
		if (ok) {
			aggregator?.forget(key)
			bus.emit()
		}
		return Response.json({ ok }, { status: ok ? 200 : 400 })
	}

	return serveStatic(pathname)
}

function streamResponse(bus: Bus, clients: Clients): Response {
	let unsubscribe = () => {}
	let heartbeat: ReturnType<typeof setInterval> | undefined
	let counted = false
	const encoder = new TextEncoder()

	const stream = new ReadableStream({
		async start(controller) {
			clients.count++
			counted = true
			const send = (payload: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
				} catch {
					// client gone; cancel() will clean up
				}
			}
			send(await readGlobal())
			unsubscribe = bus.subscribe(() => void readGlobal().then(send).catch(() => {}))
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: ping\n\n`))
				} catch {
					/* ignore */
				}
			}, 15_000)
		},
		cancel() {
			if (counted) clients.count--
			unsubscribe()
			if (heartbeat) clearInterval(heartbeat)
		},
	})

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
	})
}

async function serveStatic(pathname: string): Promise<Response> {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
	const filePath = path.join(DIST_DIR, rel)

	// Guard against path traversal escaping the dist dir.
	if (!filePath.startsWith(DIST_DIR)) {
		return new Response("forbidden", { status: 403 })
	}

	const file = Bun.file(filePath)
	if (await file.exists()) {
		return new Response(file)
	}

	// SPA route with no file extension → serve index.html if the dashboard is built.
	if (!path.extname(rel)) {
		const index = Bun.file(path.join(DIST_DIR, "index.html"))
		if (await index.exists()) return new Response(index)
	}

	// Dashboard not built yet → the built-in live page still works.
	return new Response(FALLBACK_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
}
