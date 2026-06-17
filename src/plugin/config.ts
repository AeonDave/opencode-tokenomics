/**
 * Runtime configuration + path resolution.
 *
 * Everything is overridable by environment variable so the plugin can be tuned
 * without touching code:
 *   OPENCODE_TOKENOMICS_PORT  - web server port (default 5757)
 *   OPENCODE_TOKENOMICS_DIR   - data directory (default ~/.local/share/opencode/tokenomics)
 *   OPENCODE_TOKENOMICS_OPEN  - "0" to disable auto-opening the browser
 */

import * as crypto from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"

// 4747 is taken by other opencode plugins (e.g. opencode-mem), so tokenomics defaults
// to 5757 and auto-scans upward if it's busy (see server.ts).
const DEFAULT_PORT = 5757

function readPort(): number {
	const raw = Number(process.env.OPENCODE_TOKENOMICS_PORT)
	return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT
}

function readDataDir(): string {
	const override = process.env.OPENCODE_TOKENOMICS_DIR?.trim()
	if (override) return override
	return path.join(os.homedir(), ".local", "share", "opencode", "tokenomics")
}

const port = readPort()
const dataDir = readDataDir()

export const config = {
	port,
	dataDir,
	autoOpen: process.env.OPENCODE_TOKENOMICS_OPEN !== "0",
	url: `http://localhost:${port}`,
	/** Per-project snapshot files the web server reads + watches. */
	projectsDir: path.join(dataDir, "projects"),
	/** Raw per-project usage records, persisted for restart continuity. */
	recordsDir: path.join(dataDir, "records"),
	/** Optional user pricing overrides (provider/model → per-1M rates). */
	pricingFile: path.join(dataDir, "pricing.json"),
} as const

/** Stable, filesystem-safe key for a project root path. */
export function projectKey(projectRoot: string): string {
	return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)
}

/** Human-friendly project name from its root path. */
export function projectName(projectRoot: string): string {
	return path.basename(projectRoot) || projectRoot
}
