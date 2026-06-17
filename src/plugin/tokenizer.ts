/**
 * Dependency-free token estimator.
 *
 * opencode gives us exact native token counts for billing; this estimator is only used
 * for *attribution* — splitting the system prompt into context components and sizing
 * tool schemas / tool outputs. It is intentionally an estimate (no model tokenizer
 * dependency): a blend of the ~4-chars/token rule of thumb and a whitespace word count,
 * which tracks real BPE counts well enough for proportions.
 */

export function estimateTokens(text: string | undefined | null): number {
	if (!text) return 0
	const chars = text.length
	if (chars === 0) return 0
	const trimmed = text.trim()
	const words = trimmed ? trimmed.split(/\s+/).length : 0
	const byChars = chars / 4
	const byWords = words * 1.3
	return Math.max(1, Math.round((byChars + byWords) / 2))
}

/** Sum the estimated tokens of several strings. */
export function estimateTokensOf(parts: ReadonlyArray<string>): number {
	let total = 0
	for (const p of parts) total += estimateTokens(p)
	return total
}
