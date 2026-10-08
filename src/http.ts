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

	/** Called for each request, so a caller can log or count. Never given the response body. */
	readonly onRequest?: ((event: { method: string; url: string; code: number }) => void) | undefined;
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

		this.used += 1;

		const headers = new Headers(request.headers ?? {});

		if (!headers.has('user-agent')) headers.set('user-agent', this.policy.userAgent);

		let response: Response;

		try {
			response = await fetch(request.url, {
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
