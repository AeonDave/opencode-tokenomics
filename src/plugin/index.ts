/**
 * opencode-tokenomics — plugin entry point.
 *
 * On opencode startup: ensure the data dir, load pricing, start the local web server
 * (first instance only) and open the dashboard in the browser. Then translate plugin
 * events into usage records, split by project, streamed live to the dashboard.
 *
 * Implementation is split into siblings:
 *   config · types · pricing · aggregator · store · server · open-browser · fallback-page
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { Aggregator } from "./aggregator"
import { backfillProject } from "./backfill"
import { config } from "./config"
import { openBrowser } from "./open-browser"
import { initPricing } from "./pricing"
import { startServer } from "./server"
import { loadSettings } from "./settings"
import { Bus, ensureDirs } from "./store"
import { estimateTokens } from "./tokenizer"

/** Extract the loaded skill's name from a completed `skill` tool state. */
function skillName(state: { input?: Record<string, unknown>; metadata?: Record<string, unknown>; title?: string }): string | undefined {
	const fromInput = state.input?.name
	if (typeof fromInput === "string" && fromInput) return fromInput
	const fromMeta = state.metadata?.name
	if (typeof fromMeta === "string" && fromMeta) return fromMeta
	const m = /Loaded skill:\s*(.+)$/.exec(state.title ?? "")
	return m?.[1]?.trim() || undefined
}

const TokenomicsPlugin: Plugin = async (ctx) => {
	await ensureDirs()
	await initPricing()
	const settings = await loadSettings()

	const bus = new Bus()
	// Fall back to this instance's directory when a message's path.root is degenerate
	// (non-git projects report "/" as the worktree). Settings gate which cards compute.
	const aggregator = new Aggregator(bus, ctx?.directory, settings)
	const server = await startServer(bus, aggregator, settings)

	if (server) {
		if (config.autoOpen) openBrowser(server.url)
		// eslint-disable-next-line no-console
		console.log(`[tokenomics] live dashboard → ${server.url}`)
	}

	// Replay this project's past sessions so the dashboard shows history, not just usage
	// from now on. Fire-and-forget so plugin load is never delayed; records flush as they
	// arrive, so the dashboard fills in progressively.
	void backfillProject(aggregator, ctx?.client, ctx?.directory).then((n) => {
		// eslint-disable-next-line no-console
		if (n > 0) console.log(`[tokenomics] backfilled ${n} past session(s) for ${ctx?.directory ?? "project"}`)
	})

	return {
		// Release the port + filesystem watcher when opencode tears the plugin down
		// (config reload / shutdown). Without this the server leaks across reloads.
		dispose: async (): Promise<void> => {
			server?.stop()
		},
		event: async ({ event }: { event: Event }): Promise<void> => {
			switch (event.type) {
				case "message.updated": {
					const info = event.properties.info
					if (info.role === "assistant") {
						aggregator.ingestAssistant(info)
					}
					break
				}
				case "session.created":
				case "session.updated": {
					const s = event.properties.info
					aggregator.ingestSession({
						id: s.id,
						parentID: s.parentID,
						title: s.title,
						directory: s.directory,
					})
					break
				}
				case "message.part.updated": {
					const part = event.properties.part
					if (part.type === "tool") {
						const st = part.state
						let result: { outputTokens: number; durationMs: number; error?: boolean } | undefined
						if (st?.status === "completed") {
							result = {
								outputTokens: estimateTokens(st.output),
								durationMs: Math.max(0, (st.time?.end ?? 0) - (st.time?.start ?? 0)),
								error: false,
							}
						} else if (st?.status === "error") {
							result = { outputTokens: 0, durationMs: Math.max(0, (st.time?.end ?? 0) - (st.time?.start ?? 0)), error: true }
						}
						aggregator.ingestTool(part.callID, part.tool, part.sessionID, result)
						// A loaded skill is a `skill` tool call — capture which skill + its loaded size.
						if (part.tool === "skill" && st?.status === "completed") {
							const name = skillName(st)
							if (name) aggregator.ingestSkill(part.callID, name, part.sessionID, estimateTokens(st.output))
						}
					} else if (part.type === "agent") {
						aggregator.ingestAgent(part.sessionID, part.name)
					} else if (part.type === "retry") {
						aggregator.ingestRetry(part.sessionID)
					}
					break
				}
			}
		},

		// Tool schema sizing: estimated "schema cost" + complexity per tool.
		"tool.definition": async (
			input: { toolID: string },
			output: { description: string; parameters: unknown; jsonSchema?: unknown },
		): Promise<void> => {
			// Prefer jsonSchema (plain JSON, serializable) over parameters (an Effect Schema).
			aggregator.ingestToolDef(input.toolID, output.description, output.jsonSchema ?? output.parameters)
		},

		// Context-component attribution: where the input tokens go (system/env/tree/...).
		"experimental.chat.system.transform": async (
			input: { sessionID?: string },
			output: { system: string[] },
		): Promise<void> => {
			aggregator.ingestSystemPrompt(input.sessionID, output.system)
		},
	}
}

export default TokenomicsPlugin
