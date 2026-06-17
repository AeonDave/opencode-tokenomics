import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Aggregator } from "../src/plugin/aggregator"
import { startServer } from "../src/plugin/server"
import { CARD_IDS, loadSettings, saveSettings, Settings } from "../src/plugin/settings"
import { Bus } from "../src/plugin/store"

const ROOT = "/cfg/root"
interface AInput {
	id: string
	sessionID: string
	providerID: string
	modelID: string
	cost: number
	tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
	path: { root: string }
	time: { created: number; completed?: number }
}
function assistant(o: Partial<AInput> = {}): AInput {
	return {
		id: "m1",
		sessionID: "ses_main",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0.1,
		tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
		path: { root: ROOT },
		time: { created: 1000 },
		...o,
	}
}

describe("Settings", () => {
	test("defaults every known card on", () => {
		const s = new Settings()
		for (const id of CARD_IDS) expect(s.enabled(id)).toBe(true)
	})

	test("apply only honors known ids and coerces to booleans", () => {
		const s = new Settings()
		s.apply({ tools: false, bogus: false, skills: 0 as unknown as boolean })
		expect(s.enabled("tools")).toBe(false)
		expect(s.enabled("skills")).toBe(true) // 0 !== false → stays on (only explicit false disables)
		expect(s.enabled("bogus")).toBe(true) // unknown ids are always on
		expect("bogus" in s.all()).toBe(false) // not persisted
	})

	test("all() returns a normalized map over the known ids", () => {
		const s = new Settings({ spend: false })
		const all = s.all()
		expect(Object.keys(all).sort()).toEqual([...CARD_IDS].sort())
		expect(all.spend).toBe(false)
		expect(all.tools).toBe(true)
	})

	test("save then load round-trips the selection", async () => {
		const s = new Settings()
		s.apply({ tools: false, spendByModel: false })
		await saveSettings(s)
		const loaded = await loadSettings()
		expect(loaded.enabled("tools")).toBe(false)
		expect(loaded.enabled("spendByModel")).toBe(false)
		expect(loaded.enabled("skills")).toBe(true)
	})
})

describe("Settings fuzzing", () => {
	test("apply never throws on arbitrary maps; enabled is always boolean", () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.anything()), (map) => {
				const s = new Settings()
				expect(() => s.apply(map)).not.toThrow()
				for (const id of CARD_IDS) expect(typeof s.enabled(id)).toBe("boolean")
			}),
			{ numRuns: 300 },
		)
	})
})

describe("aggregator gating", () => {
	function seed(agg: Aggregator) {
		agg.ingestAssistant(assistant())
		agg.ingestTool("c1", "read", "ses_main", { outputTokens: 10, durationMs: 5 })
		agg.ingestSkill("s1", "nmap", "ses_main", 100)
		agg.ingestSystemPrompt("ses_main", ["You are an assistant.", "cwd is /x"])
	}

	test("disabled cards skip their computation (empty in the snapshot)", () => {
		const off = new Settings()
		off.apply({ tools: false, skills: false, context: false, agentModel: false, spend: false, activityByHour: false, tokensByDay: false, spendByModel: false })
		const agg = new Aggregator(undefined, undefined, off)
		seed(agg)
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.tools).toEqual([])
		expect(snap.skills).toEqual([])
		expect(snap.agentModel).toEqual([])
		expect(snap.series).toEqual([])
		expect(snap.activityByHour).toEqual([])
		expect(snap.tokensByDay).toEqual([])
		expect(snap.spendByModel.points).toEqual([])
		expect(snap.context.total).toBe(0)
		// core totals still computed
		expect(snap.totals.messages).toBe(1)
	})

	test("all-on computes the optional sections", () => {
		const agg = new Aggregator(undefined, undefined, new Settings())
		seed(agg)
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.tools.length).toBeGreaterThan(0)
		expect(snap.skills.length).toBeGreaterThan(0)
		expect(snap.activityByHour.length).toBe(24)
		expect(snap.tokensByDay.length).toBeGreaterThan(0)
		expect(snap.spendByModel.points.length).toBeGreaterThan(0)
	})
})

describe("config endpoints (integration)", () => {
	test("GET returns cards; PUT updates + persists and gates next compute", async () => {
		const bus = new Bus()
		const settings = new Settings()
		const agg = new Aggregator(bus, undefined, settings)
		const server = await startServer(bus, agg, settings)
		if (!server) return // port owned by a real server — skip
		try {
			const got = (await (await fetch(`${server.url}/api/config`)).json()) as { cards: Record<string, boolean> }
			expect(got.cards.tools).toBe(true)

			const res = await fetch(`${server.url}/api/config`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cards: { tools: false } }),
			})
			const body = (await res.json()) as { ok: boolean; cards: Record<string, boolean> }
			expect(body.ok).toBe(true)
			expect(body.cards.tools).toBe(false)
			// shared settings now gate the aggregator
			expect(settings.enabled("tools")).toBe(false)
			// and it persisted
			expect((await loadSettings()).enabled("tools")).toBe(false)
		} finally {
			server.stop()
		}
	})
})
