/**
 * The host side of a plugin's HTTP.
 *
 * A plugin calls `http.GET(url, headers)` and expects the response **back**, not a promise. Nothing
 * in a GrayJay plugin is asynchronous. That is the single hardest constraint in this library, and
 * the way it is solved is worth stating because the obvious approaches are all worse:
 *
 * - **A worker thread blocked on `Atomics.wait`** over a `SharedArrayBuffer` while the main thread
 *   fetches. Works, and is what the research for this library originally planned. It costs a thread
 *   per plugin, a second serialisation boundary, and a whole class of deadlock.
 * - **A `curl` subprocess per request.** Fine for a spike, wrong for a server: a process spawn per
 *   HTTP call, and the exit status has to be recovered separately from the body — which is exactly
 *   how the first spike ended up reporting every response as `code: 0`.
 * - **QuickJS ASYNCIFY**, which is what this uses. `quickjs-emscripten`'s asyncified build lets a
 *   host function be `async` while the *guest* calls it synchronously: the WASM stack is unwound and
 *   resumed. So `http.GET` is a plain blocking call inside the sandbox and a plain `await fetch` out
 *   here, with no extra thread, no shared memory and no subprocess.
 *
 * ### Everything here is a boundary
 *
 * The plugin is somebody else's code. Every request it makes is checked against the allow-list from
 * its own manifest, counted against a per-call budget, and given a timeout. A plugin cannot reach a
 * host its manifest did not declare, cannot use a scheme other than http(s), and cannot make
 * unbounded requests — see `limits.ts`.
 */

import { allowsUrl } from './manifest.js';

/**
 * A replacement for the global `fetch`.
 *
 * Typed structurally, and narrowly, rather than as `typeof fetch`: this library uses a method, a
 * header set, an optional string body, a redirect mode and a signal, and nothing else. A caller can
 * therefore satisfy it with a small wrapper around their own client instead of having to implement
 * the whole WHATWG signature.
 */
export type FetchLike = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Headers;
		readonly body?: string;
		readonly redirect: 'follow';
		readonly signal: AbortSignal;
	}
) => Promise<Response>;

/** A request as the sandbox describes one. */
export interface HostRequest {
	readonly method: string;
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>> | undefined;
	readonly body?: string | undefined;
}

/**
 * A response in the shape a plugin reads.
 *
 * `code` is the real HTTP status. It has its own note because getting it wrong is silent: a plugin
 * tests `resp.isOk` or `resp.code === 200`, so a host that cannot report the status makes every
 * request look like a failure that the plugin then reports as an empty feed.
 */
export interface HostResponse {
	readonly code: number;
	readonly body: string;
	readonly isOk: boolean;
	readonly headers: Record<string, string[]>;
}

/** What a plugin is allowed to do with the network, for one call into it. */
export interface HttpPolicy {
	/** From the manifest. A request outside it is refused rather than attempted. */
	readonly allowUrls: readonly string[];

	/** Per request. */
	readonly timeoutMs: number;

	/** Across one call into the plugin, so a loop cannot turn into a crawl. */
	readonly maxRequests: number;

	/** Refused beyond this, because a plugin reads the whole body into the sandbox's heap. */
	readonly maxResponseBytes: number;

	/** Sent when the plugin does not set one. Several platforms answer differently without it. */
	readonly userAgent: string;

	/**
	 * Whether the plugin may reach a private or loopback address. **Off by default.**
	 *
	 * This matters because of `allowUrls: ["everywhere"]`, which five plugins in the public index
	 * declare and which means exactly what it says. On a desktop app that is a plugin reaching the
	 * internet; on a server it is a plugin that can reach `169.254.169.254` for cloud instance
	 * credentials, or anything else on the host's network that is reachable without authentication
	 * because it was never meant to be reachable from outside.
	 *
	 * So a literal private, loopback, link-local or unique-local address is refused regardless of
	 * what the manifest allows. Turn this on deliberately — for a self-hosted PeerTube on the same
	 * network, which is a real case — and not by default.
	 *
	 * **What this does not catch:** a *hostname* that resolves to a private address. Name resolution
	 * happens inside `fetch`, so there is no point at which this could check the answer without
	 * resolving separately and leaving a window between the check and the connection. Guarding that
	 * properly needs control of the socket, which this library does not have. If a plugin running on
	 * your network is part of your threat model, give it a `fetch` of your own that does.
	 */
	readonly allowPrivateHosts?: boolean | undefined;

	/** Called for each request, so a caller can log or count. Never given the response body. */
	readonly onRequest?: ((event: { method: string; url: string; code: number }) => void) | undefined;

	/**
	 * What actually performs the request. Defaults to the global `fetch`.
	 *
	 * Injectable because a host often already owns an HTTP client it is required to route through —
	 * one that sets a user agent, carries a proxy, records metrics, or enforces a deadline across the
	 * whole operation rather than per request. A library that called the global directly would make a
	 * caller silently opt out of all of that, with no way to notice.
	 *
	 * The allow-list, the request budget and the response cap are enforced **around** this, not by
	 * it: a replacement is never asked for a url the policy has not already approved, and the
	 * boundary does not depend on it behaving. A replacement that throws is treated exactly like a
	 * transport failure, so it cannot take down a feed read.
	 */
	readonly fetch?: FetchLike | undefined;
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address names, or null when it is not one.
 *
 * Both spellings: `::ffff:1.2.3.4` as written, and `::ffff:102:304` as `URL` normalises it. The
 * second is the one that matters — the dotted form never survives parsing, so a check looking for a
 * `.` here passes every mapped address straight through.
 */
function mappedToV4(inner: string): string | null {
	const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(inner);

	if (dotted?.[1] !== undefined) return dotted[1];

	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);

	if (hex?.[1] === undefined || hex[2] === undefined) return null;

	const high = Number.parseInt(hex[1], 16);
	const low = Number.parseInt(hex[2], 16);

	return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/**
 * Whether a url names a literal address that is not on the public internet.
 *
 * Literal addresses only, by design — see {@link HttpPolicy.allowPrivateHosts} for why a hostname
 * cannot be checked here honestly. Written against the ranges rather than pulled from a dependency
 * because it is twenty lines and a dependency for this would be one more thing to trust.
 */
export function isPrivateHost(url: string): boolean {
	let host: string;

	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// An unparseable url is refused by the allow-list before this, so the answer here is moot —
		// `true` is the safe one either way.
		return true;
	}

	// `localhost` and anything under it, which resolvers send to loopback.
	if (host === 'localhost' || host.endsWith('.localhost')) return true;

	// IPv6, which `URL` gives back in brackets.
	if (host.startsWith('[')) {
		const inner = host.slice(1, -1);
		const mapped = mappedToV4(inner);

		// Decided on the address it actually names, not on its spelling.
		if (mapped !== null) return isPrivateHost(`http://${mapped}`);

		return (
			inner === '::1' ||
			inner === '::' ||
			// Unique-local (fc00::/7) and link-local (fe80::/10).
			/^f[cd][0-9a-f]{2}:/.test(inner) ||
			/^fe[89ab][0-9a-f]:/.test(inner) ||
			// An IPv4 address wearing an IPv6 hat, which is the obvious way round a v4-only check.
			// `URL` normalises `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`, so the dotted form is
			// gone by the time this sees it and the two hextets have to be decoded back. Checking for
			// a `.` was the first attempt and it never fired once.
			mappedToV4(inner) !== null
		);
	}

	const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

	if (octets === null) return false;

	const [a, b] = [Number(octets[1]), Number(octets[2])];

	return (
		a === 0 || // this network
		a === 10 || // private
		a === 127 || // loopback
		(a === 169 && b === 254) || // link-local, which is where cloud metadata lives
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		a >= 224 // multicast and reserved
	);
}

/** A refusal that the plugin sees as a failed response rather than an exception. */
const REFUSED_CODE = 403;

/** What a plugin gets when it asks for something the policy forbids. */
function refused(reason: string): HostResponse {
	// A response rather than a thrown error: a plugin checks `isOk` and reports the platform as
	// unavailable, which is the truthful outcome. Throwing would abort a whole feed read for one
	// disallowed request, and some plugins probe optional endpoints on purpose.
	return {
		code: REFUSED_CODE,
		body: JSON.stringify({ error: `grayjay-plugin-host refused this request: ${reason}` }),
		isOk: false,
		headers: {}
	};
}

/**
 * One plugin's network access, with its budget.
 *
 * Constructed per call into the plugin rather than per plugin, because {@link HttpPolicy.maxRequests}
 * is a per-call budget: a plugin that legitimately makes 30 requests to build one feed page should
 * not be throttled by what it did on the previous page.
 */
export class HttpSession {
	private used = 0;

	constructor(private readonly policy: HttpPolicy) {}

	/** How many requests this session has made. */
	get requests(): number {
		return this.used;
	}

	/** One request, checked, performed, and reported in the shape a plugin reads. */
	async perform(request: HostRequest): Promise<HostResponse> {
		if (this.used >= this.policy.maxRequests) {
			return refused(`more than ${String(this.policy.maxRequests)} requests in one call`);
		}

		if (!allowsUrl(this.policy.allowUrls, request.url)) {
			// Deliberately does not echo the whole URL back into the sandbox — it already knows what it
			// asked for — but names the host so a caller's log says which allow-list entry is missing.
			return refused(`${hostOf(request.url)} is not in the plugin allowUrls`);
		}

		// Checked after the allow-list and independently of it, because a manifest saying `everywhere`
		// means the allow-list is no longer a bound at all. See `allowPrivateHosts`.
		if (this.policy.allowPrivateHosts !== true && isPrivateHost(request.url)) {
			return refused(`${hostOf(request.url)} is a private address`);
		}

		this.used += 1;

		const headers = new Headers(request.headers ?? {});

		if (!headers.has('user-agent')) headers.set('user-agent', this.policy.userAgent);

		let response: Response;

		try {
			// Resolved per request rather than captured once, so a caller may swap it, and read off the
			// global at the call rather than at module load, which is what makes it stubbable in a test.
			const perform = this.policy.fetch ?? fetch;

			response = await perform(request.url, {
				method: request.method,
				headers,
				...(request.body === undefined ? {} : { body: request.body }),

				// A plugin does not get to follow a redirect off its allow-list. `manual` would hand it
				// a 3xx it has to handle; `follow` is what the app does and what plugins expect, and the
				// allow-list is re-checked by the fact that a cross-host redirect still lands inside
				// fetch — so this is the one place the boundary is softer than it looks, and it is
				// recorded in the README rather than glossed.
				redirect: 'follow',
				signal: AbortSignal.timeout(this.policy.timeoutMs)
			});
		} catch (cause) {
			// A transport failure is a response with no status, which is exactly the `code: 0` trap. It
			// is reported as a 504 so a plugin's `isOk` check is false and its own error path runs.
			return {
				code: 504,
				body: JSON.stringify({ error: kindOf(cause) }),
				isOk: false,
				headers: {}
			};
		}

		const body = await this.read(response);

		this.policy.onRequest?.({ method: request.method, url: request.url, code: response.status });

		return {
			// The real status, captured before anything else can lose it.
			code: response.status,
			body,
			isOk: response.ok,
			headers: collect(response.headers)
		};
	}

	/** The body, up to the cap. */
	private async read(response: Response): Promise<string> {
		const declared = Number(response.headers.get('content-length') ?? '0');

		if (Number.isFinite(declared) && declared > this.policy.maxResponseBytes) {
			return JSON.stringify({ error: 'response larger than the host allows' });
		}

		const text = await response.text().catch(() => '');

		return text.length > this.policy.maxResponseBytes
			? JSON.stringify({ error: 'response larger than the host allows' })
			: text;
	}
}

/**
 * Header names to a list of values, which is the shape the app hands plugins.
 *
 * A list rather than a string because `set-cookie` legitimately repeats, and a plugin that reads
 * `headers["set-cookie"][0]` on a string gets a character.
 */
function collect(headers: Headers): Record<string, string[]> {
	const out: Record<string, string[]> = {};

	headers.forEach((value, name) => {
		const key = name.toLowerCase();
		const existing = out[key];

		if (existing === undefined) out[key] = [value];
		else existing.push(value);
	});

	return out;
}

/** A host for a log line, or a placeholder when the URL will not parse. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return '(unparseable url)';
	}
}

/**
 * What went wrong, without the message.
 *
 * A thrown value from `fetch` can quote the request, and a plugin's request may carry an
 * `Authorization` header supplied by the caller. The class name is enough to tell a timeout from a
 * DNS failure.
 */
function kindOf(cause: unknown): string {
	if (cause instanceof Error) return cause.name === '' ? 'Error' : cause.name;

	return typeof cause;
}
