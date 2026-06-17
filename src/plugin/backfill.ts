/**
 * Startup backfill: replay this project's past opencode sessions into the aggregator so
 * the dashboard shows history, not just usage from the moment the plugin loaded.
 *
 * Reads sessions + their messages over the SDK client (the same data the live event
 * stream carries), filtered to the current project directory. Idempotent: messages are
 * keyed by their real opencode IDs, so re-running — or live events arriving for the same
 * messages — never double-counts. Best-effort and fire-and-forget: any failure is
 * swallowed so plugin startup and live tracking are unaffected.
 */

import type { Aggregator } from "./aggregator"
import { estimateTokens } from "./tokenizer"

interface SessionLite {
	id: string
	parentID?: string
	title?: string
	directory?: string
}

interface MessagePart {
	type: string
	callID?: string
	tool?: string
	sessionID?: string
	name?: string
	state?: {
		status?: string
		output?: string
		title?: string
		input?: Record<string, unknown>
		metadata?: Record<string, unknown>
		time?: { start?: number; end?: number }
	}
}

function skillName(state: NonNullable<MessagePart["state"]>): string | undefined {
	const fromInput = state.input?.name
	if (typeof fromInput === "string" && fromInput) return fromInput
	const fromMeta = state.metadata?.name
	if (typeof fromMeta === "string" && fromMeta) return fromMeta
	const m = /Loaded skill:\s*(.+)$/.exec(state.title ?? "")
	return m?.[1]?.trim() || undefined
}

interface MessageEntry {
	info: { role?: string; path?: { root?: string }; tokens?: unknown } & Record<string, unknown>
	parts?: MessagePart[]
}

interface BackfillClient {
	session: {
		list: (opts?: { query?: { directory?: string } }) => Promise<{ data?: SessionLite[] }>
		messages: (opts: {
			path: { id: string }
			query?: { directory?: string }
		}) => Promise<{ data?: MessageEntry[] }>
	}
}

function toolResult(part: MessagePart): { outputTokens: number; durationMs: number; error?: boolean } | undefined {
	const st = part.state
	if (!st) return undefined
	const durationMs = Math.max(0, (st.time?.end ?? 0) - (st.time?.start ?? 0))
	if (st.status === "completed") return { outputTokens: estimateTokens(st.output), durationMs, error: false }
	if (st.status === "error") return { outputTokens: 0, durationMs, error: true }
	return undefined
}

/**
 * Backfill the current project's history. Returns the number of sessions imported (0 on
 * any failure). Safe to call with an undefined client/directory.
 */
export async function backfillProject(
	aggregator: Aggregator,
	client: unknown,
	directory: string | undefined,
): Promise<number> {
	if (!client || !directory) return 0
	const c = client as BackfillClient
	let sessions: SessionLite[]
	try {
		const listed = await c.session.list({ query: { directory } })
		sessions = (listed?.data ?? []).filter((s) => !s.directory || s.directory === directory)
	} catch {
		return 0
	}

	for (const s of sessions) {
		aggregator.ingestSession({ id: s.id, parentID: s.parentID, title: s.title, directory: s.directory })
	}

	let imported = 0
	for (const s of sessions) {
		try {
			const res = await c.session.messages({ path: { id: s.id }, query: { directory } })
			for (const entry of res?.data ?? []) {
				const info = entry.info
				if (info?.role === "assistant" && info.tokens && info.path?.root) {
					// Shape matches Aggregator's AssistantInput (id/sessionID/tokens/cost/path/time).
					aggregator.ingestAssistant(info as never)
				}
				for (const part of entry.parts ?? []) {
					if (part.type === "tool" && part.callID && part.tool && part.sessionID) {
						aggregator.ingestTool(part.callID, part.tool, part.sessionID, toolResult(part))
						if (part.tool === "skill" && part.state?.status === "completed") {
							const name = skillName(part.state)
							if (name) aggregator.ingestSkill(part.callID, name, part.sessionID, estimateTokens(part.state.output))
						}
					} else if (part.type === "agent" && part.sessionID && part.name) {
						aggregator.ingestAgent(part.sessionID, part.name)
					} else if (part.type === "retry" && part.sessionID) {
						aggregator.ingestRetry(part.sessionID)
					}
				}
			}
			imported++
		} catch {
			// skip a session that fails to load; keep going
		}
	}
	return imported
}
