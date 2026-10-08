/**
 * The sandbox a plugin runs in.
 *
 * ### Why QuickJS and not `node:vm`
 *
 * `node:vm` is explicitly not a security boundary — its own documentation says so — and a plugin is
 * third-party JavaScript running on somebody's server. `isolated-vm` is a real boundary but needs a
 * native toolchain, which rules it out for immutable hosts and slim containers.
 * `quickjs-emscripten` is pure WASM with no native build step: the guest gets its own heap, cannot
 * see Node's globals, and reaches the outside world only through the two functions installed below.
 *
 * ### The limits are not optional
 *
 * A plugin is somebody else's code, fetched over the network, updated without asking. So:
 *
 * - **Memory** is capped by the QuickJS runtime, which fails the allocation rather than the process.
 * - **Wall clock** is enforced through an interrupt handler the engine calls periodically, which is
 *   the only way to stop a `while (true)` — there is no thread to kill.
 * - **Requests** are capped per call, in `http.ts`, so a loop cannot become a crawl.
 * - **Stack** is capped, because deep recursion in WASM is a crash rather than an exception.
 */

import { newAsyncContext } from 'quickjs-emscripten';
import type { QuickJSAsyncContext } from 'quickjs-emscripten';
import { BOOTSTRAP } from './bootstrap.js';
import { HttpSession } from './http.js';
import { DEFAULT_DOM_LIMITS, DomSession } from './dom.js';
import { performUrl } from './url.js';
import type { DomLimits } from './dom.js';
import type { HttpPolicy } from './http.js';

/** What the host will let a plugin consume. */
export interface Limits {
	/** Bytes. QuickJS fails an allocation past this rather than growing without bound. */
	readonly memoryBytes: number;

	/** Bytes of guest stack. Deep recursion in WASM is a crash, not an exception. */
	readonly stackBytes: number;

	/** Milliseconds of wall clock for one call into the plugin, interrupt-enforced. */
	readonly timeoutMs: number;
}

/** Defaults chosen against the real plugins rather than picked round. */
export const DEFAULT_LIMITS: Limits = {
	// The YouTube plugin is a 4 MiB script and builds sizeable lookup tables at load time. 128 MiB
	// leaves room for that plus a few feed pages of parsed JSON.
	memoryBytes: 128 * 1024 * 1024,
	stackBytes: 2 * 1024 * 1024,

	// Generous, because one call can legitimately make tens of HTTP requests: the budget in `http.ts`
	// is the real bound on work, and this is the backstop against a plugin that stops making progress.
	timeoutMs: 60_000
};

/** A line a plugin logged. Never contains a response body. */
export interface PluginLog {
	readonly level: 'info' | 'warn' | 'error';
	readonly message: string;
}

/** How to build a sandbox. */
export interface SandboxOptions {
	/** The plugin's JavaScript, already fetched. */
	readonly script: string;

	/** Network policy, from the plugin's own manifest. */
	readonly http: HttpPolicy;

	readonly limits?: Partial<Limits> | undefined;

	/** Settings the operator supplies, readable by the plugin as `plugin.settings`. */
	readonly settings?: Readonly<Record<string, unknown>> | undefined;

	/** The manifest, readable by the plugin as `plugin.config`. Several read their own id from it. */
	readonly config?: Readonly<Record<string, unknown>> | undefined;

	readonly onLog?: ((line: PluginLog) => void) | undefined;

	/**
	 * Whether the plugin may parse HTML, and with what limits.
	 *
	 * Off by default. `true` takes `DEFAULT_DOM_LIMITS`, and an object overrides them. A plugin given
	 * no DOM gets a named error from `domParser` rather than an `undefined is not a function`, which
	 * matters because a manifest declaring `DOMParser` is refused at load anyway — so reaching that
	 * error at all means a plugin used it without declaring it.
	 *
	 * Opt-in rather than always on because it holds a parsed document on the host heap: that is the
	 * caller's memory, and a caller who never loads a scraping plugin should not pay for the
	 * possibility.
	 */
	readonly dom?: boolean | Partial<DomLimits> | undefined;
}

/** A plugin failed on its own terms — its error, not the host's. */
export class PluginError extends Error {
	constructor(
		message: string,
		readonly stack2: string | null = null
	) {
		super(message);
		this.name = 'PluginError';
	}
}

/** The host exceeded a limit and stopped the plugin. */
export class LimitExceeded extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LimitExceeded';
	}
}

/** A loaded plugin, ready to be called. */
export class Sandbox {
	private disposed = false;

	/**
	 * The plugin's network access, replaced at the start of every call.
	 *
	 * One per call rather than one per plugin, because the request budget is per call — see
	 * `HttpPolicy.maxRequests`. Held on the instance rather than closed over inside
	 * {@link installPrimitives} so that {@link call} can replace it: the asyncified host function
	 * reaches it through `this` on each request, so a replacement takes effect immediately.
	 */
	private session: HttpSession;

	/**
	 * The plugin's parsed documents, or null when DOM support is off.
	 *
	 * Per sandbox rather than per call, unlike the HTTP session: a plugin legitimately parses a page
	 * in one call and reads it in the next, whereas requests are the thing that must not accumulate.
	 */
	private readonly dom: DomSession | null;

	private constructor(
		private readonly ctx: QuickJSAsyncContext,
		private readonly options: SandboxOptions,
		private readonly limits: Limits,

		/** Set per call, so the deadline is per call rather than per plugin. */
		private deadline: number
	) {
		this.session = new HttpSession(options.http);
		this.dom =
			options.dom === undefined || options.dom === false
				? null
				: new DomSession(
						options.dom === true ? undefined : { ...DEFAULT_DOM_LIMITS, ...options.dom }
					);
	}

	/**
	 * Loads a plugin and returns it ready to call.
	 *
	 * The plugin's own code runs during this: plugins do work at load time — YouTube builds lookup
	 * tables, several read `IS_TESTING` — so a failure here is a failure of the plugin, reported as
	 * {@link PluginError} rather than as a host bug.
	 */
	static async load(options: SandboxOptions): Promise<Sandbox> {
		const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
		const ctx = await newAsyncContext();

		ctx.runtime.setMemoryLimit(limits.memoryBytes);
		ctx.runtime.setMaxStackSize(limits.stackBytes);

		const sandbox = new Sandbox(ctx, options, limits, Date.now() + limits.timeoutMs);

		// The only way to stop a plugin that stops yielding. QuickJS calls this periodically; returning
		// true aborts whatever is running.
		ctx.runtime.setInterruptHandler(() => Date.now() > sandbox.deadline);

		try {
			sandbox.installPrimitives();
			sandbox.run(BOOTSTRAP, 'grayjay-plugin-host/bootstrap.js');
			sandbox.run(sandbox.settingsSource(), 'grayjay-plugin-host/settings.js');

			// The plugin itself, last, so everything it reads at load time is already there.
			sandbox.run(options.script, 'plugin.js');
		} catch (cause) {
			ctx.dispose();
			throw cause;
		}

		return sandbox;
	}

	/**
	 * Whether the plugin exposes a method.
	 *
	 * Asked rather than assumed, because the documented `source` interface is out of date — it lists
	 * `getChannelVideos` while plugins implement `getChannelContents` — so a caller has to be able to
	 * find out what this particular plugin actually has.
	 */
	async has(method: string): Promise<boolean> {
		return (
			(await this.evaluate(`typeof (${SOURCE_EXPR})[${JSON.stringify(method)}] === 'function'`)) ===
			true
		);
	}

	/** Every method name the plugin exposes, which is the useful thing when one is missing. */
	async methods(): Promise<readonly string[]> {
		const found = await this.evaluate(
			`Object.keys(${SOURCE_EXPR}).filter(function (k) { return typeof (${SOURCE_EXPR})[k] === 'function'; })`
		);

		return Array.isArray(found)
			? found.filter((name): name is string => typeof name === 'string')
			: [];
	}

	/**
	 * Calls a method on the plugin's `source` and returns its result as plain data.
	 *
	 * Arguments are passed through as JSON, with one rule that is not obvious and cost a failed run:
	 * **`undefined` becomes explicit `null`**. The TikTok plugin tests `filters !== null`, and
	 * `undefined !== null` is true — so an omitted optional argument takes the error branch. Every
	 * host has to do this, and nothing documents it.
	 */
	async call(method: string, args: readonly unknown[] = []): Promise<unknown> {
		const normalised = args.map((value) => (value === undefined ? null : value));

		// Both per-call limits, reset together. They were not always: the deadline reset here and the
		// request budget did not, so a plugin's second page got whatever was left of the first page's
		// allowance and reported an empty feed rather than a refusal.
		this.deadline = Date.now() + this.limits.timeoutMs;
		this.session = new HttpSession(this.options.http);

		return this.evaluate(`__gph_invoke(${JSON.stringify(method)}, ${JSON.stringify(normalised)})`);
	}

	/** Releases the WASM context. A sandbox that is not disposed holds its heap for the process. */
	dispose(): void {
		if (this.disposed) return;

		this.disposed = true;

		// Before the context, so the parsed documents are dropped even if disposing the context throws.
		this.dom?.clear();
		this.ctx.dispose();
	}

	/** The two functions that are the entire bridge out of the sandbox. */
	private installPrimitives(): void {
		// Asyncified: the guest calls this synchronously and the host awaits inside it. That is the
		// whole reason this library can host plugins at all — see the note in `http.ts`.
		const http = this.ctx.newAsyncifiedFunction('__host_http', async (handle) => {
			const request: unknown = JSON.parse(this.ctx.getString(handle));
			const answer = await this.session.perform(asRequest(request));

			return this.ctx.newString(JSON.stringify(answer));
		});

		this.ctx.setProp(this.ctx.global, '__host_http', http);
		http.dispose();

		const log = this.ctx.newFunction('__host_log', (handle) => {
			const line: unknown = JSON.parse(this.ctx.getString(handle));

			this.options.onLog?.(asLog(line));

			return this.ctx.undefined;
		});

		this.ctx.setProp(this.ctx.global, '__host_log', log);
		log.dispose();

		// Always installed, unlike the DOM: `URL` is a language-level expectation for plugin authors
		// even though it is not part of the language, and four plugins in the public index fail at
		// load without it. Synchronous, for the same reason as the DOM bridge.
		const url = this.ctx.newFunction('__host_url', (handle) =>
			this.ctx.newString(performUrl(this.ctx.getString(handle)))
		);

		this.ctx.setProp(this.ctx.global, '__host_url', url);
		url.dispose();

		// Not asyncified, deliberately. Parsing and querying a document is synchronous work on the
		// host, so this is an ordinary host function and a guest property read costs one C call rather
		// than unwinding and resuming the WASM stack — which is what makes a proxy-per-node design
		// affordable. Installed only when DOM support is on, so the guest can tell.
		if (this.dom !== null) {
			const session = this.dom;
			const parse = this.ctx.newFunction('__host_dom', (handle) =>
				this.ctx.newString(session.perform(this.ctx.getString(handle)))
			);

			this.ctx.setProp(this.ctx.global, '__host_dom', parse);
			parse.dispose();
		}
	}

	/** The operator's settings and the manifest, as the plugin reads them. */
	private settingsSource(): string {
		const settings = JSON.stringify(this.options.settings ?? {});
		const config = JSON.stringify(this.options.config ?? {});

		// Also the invoke helper, here rather than in the bootstrap because it has to resolve `source`
		// the same way `SOURCE_EXPR` does and the two must not drift.
		return `
			globalThis.plugin = { settings: ${settings}, config: ${config} };
			globalThis.__gph_invoke = function (method, args) {
				var src = ${SOURCE_EXPR};
				var fn = src[method];

				if (typeof fn !== 'function') throw new Error('this plugin has no ' + method);

				return __gph_plain(fn.apply(src, args));
			};

			// Pagers carry methods, which JSON cannot. Flattened to the three things a caller needs so
			// that walking pages stays the host's job rather than the sandbox's.
			globalThis.__gph_plain = function (value) {
				if (value === null || typeof value !== 'object') return value;

				if (typeof value.hasMorePagers === 'function') {
					return {
						__pager: true,
						results: value.results || [],
						hasMore: !!value.hasMorePagers(),
						context: value.context || {}
					};
				}

				return value;
			};
		`;
	}

	/** One script, with a plugin error told apart from a host limit. */
	private run(code: string, filename: string): void {
		const result = this.ctx.evalCode(code, filename);

		if (result.error === undefined) {
			result.value.dispose();

			return;
		}

		const detail = this.describe(result.error);

		result.error.dispose();
		throw this.toError(detail);
	}

	/** One expression, with its value marshalled out as plain data. */
	private async evaluate(expression: string): Promise<unknown> {
		const result = await this.ctx.evalCodeAsync(
			// Wrapped in an object rather than stringified bare. `JSON.stringify(undefined)` is the JS
			// value `undefined`, and reading that back out of the engine yields the seven-character
			// *string* `"undefined"` — which is not JSON, and is also exactly what a plugin returning
			// the literal text would produce. Kick's `enable` returns nothing, so this was a crash on
			// load for a plugin that had done nothing wrong. A wrapper object is always valid JSON, and
			// a missing property is unambiguously "returned nothing".
			`JSON.stringify({ v: ${expression} })`,
			'grayjay-plugin-host/eval.js'
		);

		if (result.error !== undefined) {
			const detail = this.describe(result.error);

			result.error.dispose();
			throw this.toError(detail);
		}

		const text = this.ctx.getString(result.value);

		result.value.dispose();

		if (text === '') return undefined;

		return (JSON.parse(text) as { v?: unknown }).v;
	}

	/** A thrown guest value, as a message and a stack. */
	private describe(error: unknown): { message: string; stack: string | null } {
		const dumped: unknown = this.ctx.dump(error as never);

		if (typeof dumped === 'object' && dumped !== null) {
			const record = dumped as Record<string, unknown>;

			return {
				message: typeof record.message === 'string' ? record.message : JSON.stringify(dumped),
				stack: typeof record.stack === 'string' ? record.stack : null
			};
		}

		return { message: String(dumped), stack: null };
	}

	/**
	 * Which kind of failure this was.
	 *
	 * An interrupt arrives as a guest error, so without this a host timeout would be reported as the
	 * plugin's own bug — and the operator would go looking at the wrong platform.
	 */
	private toError(detail: { message: string; stack: string | null }): Error {
		if (Date.now() > this.deadline || /interrupted/i.test(detail.message)) {
			return new LimitExceeded(`the plugin was stopped after ${String(this.limits.timeoutMs)}ms`);
		}

		if (/out of memory/i.test(detail.message)) {
			return new LimitExceeded(
				`the plugin exceeded its ${String(Math.round(this.limits.memoryBytes / 1024 / 1024))}MiB memory limit`
			);
		}

		return new PluginError(detail.message, detail.stack);
	}
}

/**
 * How `source` is found.
 *
 * The undocumented item that cost the most. A plugin may do either of these:
 *
 * ```js
 * source.getChannel = function () {};   // assigns to the injected global
 * const source = { getChannel() {} };   // declares its own
 * ```
 *
 * The second is a **lexical binding at the top level of the script** and never becomes a property of
 * the global object — so a host that reads `globalThis.source` sees an empty plugin and reports zero
 * methods, which is exactly what happened with the X plugin. Evaluating the bare *name* finds both,
 * because an identifier lookup reaches the lexical binding first and falls back to the global.
 *
 * The `typeof` guard is what keeps this from being a `ReferenceError` on a plugin that defines
 * neither, so a caller gets "this plugin exposed nothing" instead of a crash.
 */
const SOURCE_EXPR = `(typeof source !== 'undefined' ? source : {})`;

/** A request from the sandbox, checked before the host acts on it. */
function asRequest(value: unknown): {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
} {
	const record =
		typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
	const headers: Record<string, string> = {};

	if (typeof record.headers === 'object' && record.headers !== null) {
		for (const [name, header] of Object.entries(record.headers)) {
			// Header values arrive from guest code, so anything that is not a string is dropped rather
			// than stringified into `[object Object]`.
			if (typeof header === 'string') headers[name] = header;
		}
	}

	return {
		method: typeof record.method === 'string' ? record.method.toUpperCase() : 'GET',
		url: typeof record.url === 'string' ? record.url : '',
		headers,
		...(typeof record.body === 'string' ? { body: record.body } : {})
	};
}

/** A log line from the sandbox, with its level checked against the three this host reports. */
function asLog(value: unknown): PluginLog {
	const record =
		typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
	const level = record.level;

	return {
		level: level === 'warn' || level === 'error' ? level : 'info',
		message: typeof record.message === 'string' ? record.message : String(record.message)
	};
}
