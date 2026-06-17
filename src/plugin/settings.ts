/**
 * Card/feature settings, persisted next to the other opencode plugin config in
 * ~/.config/opencode/tokenomics.json (NOT the data dir). Each toggleable card maps to a
 * boolean; everything defaults ON ("parte tutto attivo"). Disabling a card both hides it
 * in the UI and skips its (sometimes heavy) computation in the aggregator.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export const CARD_IDS = [
	"spend",
	"tokenDistribution",
	"tree",
	"models",
	"context",
	"tools",
	"skills",
	"agentModel",
	"effByModel",
	"activityByHour",
	"spendByModel",
	"tokensByDay",
] as const
export type CardId = (typeof CARD_IDS)[number]

const KNOWN = new Set<string>(CARD_IDS)

function configDir(): string {
	const override = process.env.OPENCODE_TOKENOMICS_CONFIG_DIR?.trim()
	if (override) return override
	const xdg = process.env.XDG_CONFIG_HOME?.trim()
	return path.join(xdg || path.join(os.homedir(), ".config"), "opencode")
}
export function configFile(): string {
	return path.join(configDir(), "tokenomics.json")
}

function allOn(): Record<CardId, boolean> {
	const out = {} as Record<CardId, boolean>
	for (const id of CARD_IDS) out[id] = true
	return out
}

/** Mutable, in-memory card settings shared by the aggregator (gating) and the server (API). */
export class Settings {
	private cards: Record<string, boolean>
	constructor(cards?: Record<string, unknown>) {
		this.cards = allOn()
		this.apply(cards)
	}
	/** A card is enabled unless explicitly set to false (unknown ids default on). */
	enabled(id: string): boolean {
		return this.cards[id] !== false
	}
	/** Full, normalized map over the known card ids. */
	all(): Record<CardId, boolean> {
		const out = {} as Record<CardId, boolean>
		for (const id of CARD_IDS) out[id] = this.cards[id] !== false
		return out
	}
	/** Apply a partial map, ignoring unknown keys and coercing values to booleans. */
	apply(map: Record<string, unknown> | undefined | null): void {
		if (!map || typeof map !== "object") return
		for (const [k, v] of Object.entries(map)) if (KNOWN.has(k)) this.cards[k] = v !== false
	}
}

export async function loadSettings(): Promise<Settings> {
	try {
		const raw = await fs.readFile(configFile(), "utf8")
		const parsed = JSON.parse(raw) as { cards?: Record<string, unknown> }
		return new Settings(parsed?.cards)
	} catch {
		return new Settings()
	}
}

export async function saveSettings(settings: Settings): Promise<void> {
	await fs.mkdir(configDir(), { recursive: true })
	const tmp = `${configFile()}.tmp`
	await fs.writeFile(tmp, JSON.stringify({ cards: settings.all() }, null, 2), "utf8")
	await fs.rename(tmp, configFile())
}
