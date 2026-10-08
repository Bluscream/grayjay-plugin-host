/**
 * Asking a plugin for a channel's content, which cannot be done by choosing a type.
 *
 * This is the ninth undocumented item, and the one most likely to look like a broken platform:
 *
 * - **YouTube throws `Unsupported type: MIXED`.**
 * - **TikTok accepts nothing but `MIXED`**, and throws `unreachable` for everything else.
 * - **And the declared capability list cannot be trusted**, because TikTok's
 *   `getChannelCapabilities()` returns `["VIDEOS","MIXED","LIVE"]` and the plugin then refuses
 *   `VIDEOS`.
 *
 * So a host cannot read the capabilities and pick one. It has to *try*, in an order, and treat a
 * refusal as "not this one" rather than as a failure. That is what {@link negotiateFeed} does, and
 * it is why a caller should prefer it over calling `getChannelContents` directly.
 *
 * The declared list is still used — as the order to try first, because starting with what a plugin
 * claims is faster than starting with a fixed order. It is just not believed.
 */

import { PluginError, type Sandbox } from './sandbox.js';

/** The feed types a plugin may accept. */
export const FEED_TYPES = ['VIDEOS', 'MIXED', 'STREAMS', 'LIVE', 'POSTS'] as const;

/** One of {@link FEED_TYPES}. */
export type FeedType = (typeof FEED_TYPES)[number];

/** A page of a channel's content. */
export interface Feed {
	/** The type that actually worked, which is worth keeping: the next page should use the same one. */
	readonly type: FeedType | null;

	readonly results: readonly unknown[];
	readonly hasMore: boolean;
	readonly context: Readonly<Record<string, unknown>>;

	/** Types that were tried and refused, in order. Empty when the first one worked. */
	readonly refused: readonly { type: FeedType | null; reason: string }[];
}

/**
 * Whether a plugin's complaint means "wrong type" rather than "something broke".
 *
 * Matched on the message because that is all a plugin gives: these are `throw new Error(...)` and
 * `throw "unreachable"` from inside plugin code, with no type to switch on. Deliberately narrow —
 * a message this does not recognise is re-thrown, because treating an unknown failure as "try the
 * next type" would turn a real bug into an empty feed.
 */
function isWrongType(message: string): boolean {
	return (
		/unsupported\s+type/i.test(message) ||
		/unreachable/i.test(message) ||
		/invalid\s+(type|ordering)/i.test(message) ||
		/not\s+supported/i.test(message)
	);
}

/**
 * The types to try, in order.
 *
 * What the plugin claims first — it is usually right, and trying its own answer first is one call
 * instead of three — then everything else, then `null`.
 *
 * `null` last and always: several plugins take no type at all and treat any argument as a filter
 * they do not understand, so "ask for nothing" is a real option and the one that works for the
 * simplest plugins.
 */
function order(declared: readonly string[]): readonly (FeedType | null)[] {
	const claimed = declared.filter((name): name is FeedType =>
		(FEED_TYPES as readonly string[]).includes(name)
	);

	const rest = FEED_TYPES.filter((name) => !claimed.includes(name));

	return [...claimed, ...rest, null];
}

/**
 * A channel's content, by trying the types the plugin will accept.
 *
 * @param url the channel url, as the plugin's own `isChannelUrl` would recognise it
 * @param method which method to call. `getChannelContents` is what plugins implement;
 *   `getChannelVideos` is what the out-of-date `plugin.d.ts` documents, and is tried as a fallback.
 */
export async function negotiateFeed(
	sandbox: Sandbox,
	url: string,
	options: { readonly method?: string | undefined; readonly order?: string | null | undefined } = {}
): Promise<Feed> {
	const method = options.method ?? (await pickMethod(sandbox));
	const declared = await capabilities(sandbox, url);
	const refused: { type: FeedType | null; reason: string }[] = [];

	for (const type of order(declared)) {
		try {
			// Explicit `null` for every optional argument, never `undefined`: TikTok tests
			// `filters !== null`, and `undefined !== null` is true, so an omitted argument takes the
			// error branch. This is the seventh undocumented item.
			const raw = await sandbox.call(method, [url, type, options.order ?? null, null]);
			const page = asPage(raw);

			return { type, ...page, refused };
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);

			if (!(cause instanceof PluginError) || !isWrongType(message)) throw cause;

			refused.push({ type, reason: message });
		}
	}

	// Every type refused. That is a real answer — the plugin cannot read this channel the way this
	// host asks — and the list of what was tried is what makes it diagnosable.
	throw new PluginError(
		`${method} refused every feed type: ${refused
			.map((entry) => `${entry.type ?? '(none)'} → ${entry.reason}`)
			.join('; ')}`
	);
}

/** Which of the two spellings this plugin actually implements. */
async function pickMethod(sandbox: Sandbox): Promise<string> {
	if (await sandbox.has('getChannelContents')) return 'getChannelContents';
	if (await sandbox.has('getChannelVideos')) return 'getChannelVideos';

	throw new PluginError(
		`this plugin exposes neither getChannelContents nor getChannelVideos (it has: ${(
			await sandbox.methods()
		).join(', ')})`
	);
}

/**
 * What the plugin says it can do, which is a hint and not a contract.
 *
 * A failure here is swallowed on purpose: the capability call is optional, several plugins do not
 * implement it, and its only use is to order the attempts below. Failing the whole feed read
 * because an advisory call threw would be the wrong trade.
 */
async function capabilities(sandbox: Sandbox, url: string): Promise<readonly string[]> {
	if (!(await sandbox.has('getChannelCapabilities'))) return [];

	try {
		const raw = await sandbox.call('getChannelCapabilities', [url]);
		const types =
			typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).types : undefined;

		return Array.isArray(types)
			? types.filter((name): name is string => typeof name === 'string')
			: [];
	} catch {
		return [];
	}
}

/** A pager, as the sandbox flattened it, or a bare array from a plugin that returns one. */
function asPage(raw: unknown): {
	results: readonly unknown[];
	hasMore: boolean;
	context: Record<string, unknown>;
} {
	if (Array.isArray(raw)) return { results: raw, hasMore: false, context: {} };

	if (typeof raw === 'object' && raw !== null) {
		const record = raw as Record<string, unknown>;

		return {
			results: Array.isArray(record.results) ? record.results : [],
			hasMore: record.hasMore === true,
			context:
				typeof record.context === 'object' && record.context !== null
					? (record.context as Record<string, unknown>)
					: {}
		};
	}

	return { results: [], hasMore: false, context: {} };
}
