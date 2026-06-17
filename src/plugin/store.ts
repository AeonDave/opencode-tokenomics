/**
 * Disk persistence + change bus.
 *
 * Each plugin instance owns the data for the project(s) it sees. It writes two files
 * per project:
 *   records/<key>.json  - raw UsageRecords (reloaded on restart for history continuity)
 *   projects/<key>.json - the computed ProjectSnapshot (what the web server reads)
 *
 * The web server (whichever instance grabbed the port) reads + watches projects/ and
 * merges every project file into one GlobalSnapshot. Cross-instance updates therefore
 * reach the dashboard through the filesystem; same-instance updates also fire the Bus
 * directly for snappy SSE.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { config, projectKey } from "./config"
import { emptyTotals, type GlobalSnapshot, type ProjectSnapshot, type UsageRecord } from "./types"

export async function ensureDirs(): Promise<void> {
	await fsp.mkdir(config.projectsDir, { recursive: true })
	await fsp.mkdir(config.recordsDir, { recursive: true })
}

function snapshotPath(root: string): string {
	return path.join(config.projectsDir, `${projectKey(root)}.json`)
}
function recordsPath(root: string): string {
	return path.join(config.recordsDir, `${projectKey(root)}.json`)
}

/** Atomic-ish write: write to a temp file then rename over the target. */
async function writeJson(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.tmp`
	await fsp.writeFile(tmp, JSON.stringify(value), "utf8")
	await fsp.rename(tmp, file)
}

export async function writeSnapshot(snapshot: ProjectSnapshot): Promise<void> {
	await writeJson(snapshotPath(snapshot.projectRoot), snapshot)
}

export async function writeRecords(root: string, records: UsageRecord[]): Promise<void> {
	await writeJson(recordsPath(root), records)
}

export async function loadRecords(root: string): Promise<UsageRecord[]> {
	try {
		const raw = await fsp.readFile(recordsPath(root), "utf8")
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as UsageRecord[]) : []
	} catch {
		return []
	}
}

/**
 * A snapshot file can be valid JSON yet not a snapshot (null, [], a number — from manual
 * corruption, an old format, or a truncated write that still parses). Such a value passes
 * JSON.parse, so the try/catch around the read does NOT skip it; mergeGlobal would then
 * throw on `p.totals.cost`. Require the object shape mergeGlobal depends on before trusting it.
 */
function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const totals = (value as { totals?: unknown }).totals
	return typeof totals === "object" && totals !== null
}

/** Read every persisted project snapshot. Skips unreadable/partial/malformed files. */
export async function readAllSnapshots(): Promise<ProjectSnapshot[]> {
	let names: string[]
	try {
		names = await fsp.readdir(config.projectsDir)
	} catch {
		return []
	}
	const out: ProjectSnapshot[] = []
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(".tmp")) continue
		try {
			const raw = await fsp.readFile(path.join(config.projectsDir, name), "utf8")
			const parsed: unknown = JSON.parse(raw)
			// Skip valid-JSON-but-wrong-shape files so one bad snapshot can't crash readGlobal.
			if (isProjectSnapshot(parsed)) out.push(parsed)
		} catch {
			// partial write mid-rename; next tick will have it
		}
	}
	return out
}

/** Merge per-project snapshots into the cross-project view the dashboard consumes. */
export function mergeGlobal(projects: ProjectSnapshot[]): GlobalSnapshot {
	const totals = emptyTotals()
	let apiCalls = 0
	let updatedAt = 0
	for (const p of projects) {
		totals.cost += p.totals.cost
		totals.estimatedCost += p.totals.estimatedCost
		totals.tokens += p.totals.tokens
		totals.input += p.totals.input
		totals.output += p.totals.output
		totals.reasoning += p.totals.reasoning
		totals.cacheRead += p.totals.cacheRead
		totals.cacheWrite += p.totals.cacheWrite
		totals.messages += p.totals.messages
		totals.sessions += p.totals.sessions
		totals.errors += p.totals.errors
		totals.retries += p.totals.retries
		apiCalls += p.apiCalls
		updatedAt = Math.max(updatedAt, p.updatedAt)
	}
	const sorted = [...projects].sort((a, b) => b.totals.cost - a.totals.cost)
	return { updatedAt, totals, apiCalls, projects: sorted }
}

export async function readGlobal(): Promise<GlobalSnapshot> {
	return mergeGlobal(await readAllSnapshots())
}

/** Where the live web server records its actual URL/port, so it stays discoverable even
 * when it drifts off the preferred port (and even with startup logs silenced to debug). */
const serverInfoPath = path.join(config.dataDir, "server.json")

export interface ServerInfo {
	url: string
	port: number
	pid: number
	startedAt: number
}

/** Publish the live server's address. Best-effort: a failure here must never break serving. */
export async function writeServerInfo(info: ServerInfo): Promise<void> {
	try {
		await writeJson(serverInfoPath, info)
	} catch {
		// non-fatal — the server still works, it's just not discoverable via the file
	}
}

/** Read the recorded server address, or null if none/unreadable. */
export async function readServerInfo(): Promise<ServerInfo | null> {
	try {
		const parsed = JSON.parse(await fsp.readFile(serverInfoPath, "utf8"))
		if (parsed && typeof parsed.url === "string" && typeof parsed.port === "number") return parsed as ServerInfo
	} catch {
		// missing or malformed — caller falls back to port scanning
	}
	return null
}

/** Remove the recorded address when this server stops, so stale pointers don't linger. */
export async function clearServerInfo(): Promise<void> {
	try {
		await fsp.rm(serverInfoPath, { force: true })
	} catch {
		// ignore
	}
}

/** Project keys are 16-hex sha256 slices — validating defends the delete routes from path traversal. */
const KEY_RE = /^[0-9a-f]{16}$/

/** Delete a single project's persisted snapshot + records. Returns false for an invalid key. */
export async function deleteProjectFiles(key: string): Promise<boolean> {
	if (!KEY_RE.test(key)) return false
	await Promise.all([
		fsp.rm(path.join(config.projectsDir, `${key}.json`), { force: true }),
		fsp.rm(path.join(config.projectsDir, `${key}.json.tmp`), { force: true }),
		fsp.rm(path.join(config.recordsDir, `${key}.json`), { force: true }),
		fsp.rm(path.join(config.recordsDir, `${key}.json.tmp`), { force: true }),
	])
	return true
}

/** Delete every persisted project (snapshots + records). Returns the number of projects removed. */
export async function deleteAllProjects(): Promise<number> {
	let removed = 0
	for (const [dir, countsAsProject] of [
		[config.projectsDir, true],
		[config.recordsDir, false],
	] as const) {
		let names: string[]
		try {
			names = await fsp.readdir(dir)
		} catch {
			continue
		}
		for (const name of names) {
			if (!name.endsWith(".json") && !name.endsWith(".json.tmp")) continue
			await fsp.rm(path.join(dir, name), { force: true })
			if (countsAsProject && name.endsWith(".json")) removed++
		}
	}
	return removed
}

/** Minimal pub/sub for "data changed" notifications, debounced. */
export class Bus {
	private listeners = new Set<() => void>()
	private timer: ReturnType<typeof setTimeout> | null = null

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	emit(): void {
		if (this.timer) return
		this.timer = setTimeout(() => {
			this.timer = null
			for (const fn of this.listeners) {
				try {
					fn()
				} catch {
					// a dead SSE client must not break the others
				}
			}
		}, 150)
	}
}

/** Watch the projects dir so another instance's writes also notify our SSE clients. */
export function watchProjects(onChange: () => void): () => void {
	try {
		const watcher = fs.watch(config.projectsDir, { persistent: false }, () => onChange())
		return () => watcher.close()
	} catch {
		return () => {}
	}
}
