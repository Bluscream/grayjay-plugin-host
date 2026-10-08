/**
 * `URL` parsing for the sandbox, done by the host's own parser.
 *
 * QuickJS is an ES engine, so it has no `URL` and no `URLSearchParams` — they are Web platform APIs,
 * like `btoa`. Plugins use them constantly: building a query, reading a host to decide which API to
 * call, resolving a relative link found in a page. Four plugins in the public index die at load with
 * `'URL' is not defined` and several more at their first call.
 *
 * ### Why the host parses and the guest does not
 *
 * The tempting shortcut is a regex in the bootstrap. URL parsing is one of those problems that looks
 * like a regex and is not: the WHATWG algorithm handles default ports, IDN hosts, backslashes,
 * percent-encoding, scheme-relative references and dozens of edge cases, and a plugin that resolves
 * a link slightly differently from a browser follows it to the wrong place — which surfaces as a
 * platform returning nothing rather than as a parsing bug.
 *
 * So parsing happens **here**, with Node's own WHATWG `URL`, and the guest gets back a plain record
 * of components. The guest class is then only bookkeeping: it holds the components, and asks for a
 * re-parse when a plugin assigns to one.
 *
 * This is synchronous work, so — as with `dom.ts` — it is installed as an ordinary host function and
 * not an asyncified one.
 *
 * `URLSearchParams` is implemented in the guest instead, because it is string manipulation with no
 * parsing subtleties worth a round trip per operation, and plugins mutate it in loops.
 */

/** The components of a parsed url, as the guest holds them. */
export interface UrlParts {
	readonly href: string;
	readonly origin: string;
	readonly protocol: string;
	readonly username: string;
	readonly password: string;
	readonly host: string;
	readonly hostname: string;
	readonly port: string;
	readonly pathname: string;
	readonly search: string;
	readonly hash: string;
}

/** What the guest gets back: the parts, or why it could not be parsed. */
export type UrlAnswer = { readonly parts: UrlParts } | { readonly error: string };

/** How much work one parse may be given. */
const MAX_LENGTH = 64 * 1024;

/**
 * Parses a url for the sandbox.
 *
 * @param input the url, or a relative reference when `base` is given
 * @param base resolved against, which is the case plugins need most: a link scraped out of a page
 *   is relative, and the page's own address is what makes it absolute.
 */
export function parseUrl(input: string, base?: string): UrlAnswer {
	// A plugin can hand over anything. The cap is here rather than left to the parser because a
	// pathological input is the caller's memory, and no real url approaches it.
	if (input.length > MAX_LENGTH || (base !== undefined && base.length > MAX_LENGTH)) {
		return { error: 'the url is longer than this host will parse' };
	}

	let parsed: URL;

	try {
		parsed = base === undefined || base === '' ? new URL(input) : new URL(input, base);
	} catch {
		// The message is not passed through. `TypeError: Invalid URL` carries no more information
		// than this does, and a thrown value's message is not somewhere to take text from.
		return { error: `'${input.slice(0, 200)}' is not a valid URL` };
	}

	return {
		parts: {
			href: parsed.href,
			origin: parsed.origin,
			protocol: parsed.protocol,
			username: parsed.username,
			password: parsed.password,
			host: parsed.host,
			hostname: parsed.hostname,
			port: parsed.port,
			pathname: parsed.pathname,
			search: parsed.search,
			hash: parsed.hash
		}
	};
}

/**
 * One guest request, as JSON in and JSON out.
 *
 * The same shape as the DOM bridge, for the same reason: one installed function, one place where a
 * guest-supplied value is checked.
 */
export function performUrl(request: string): string {
	try {
		const message = JSON.parse(request) as Record<string, unknown>;
		const input = message.url;
		const base = message.base;

		if (typeof input !== 'string') return JSON.stringify({ error: 'the url must be a string' });

		return JSON.stringify(parseUrl(input, typeof base === 'string' ? base : undefined));
	} catch {
		return JSON.stringify({ error: 'the host could not read that url request' });
	}
}
