/**
 * Loading a plugin from its manifest, which is the thing most callers want.
 *
 * `Sandbox` takes a script that somebody already fetched, because that is the honest seam: deciding
 * *whether to fetch and run third-party code* is not a decision a library should make quietly. This
 * module is the convenience on top, and it is explicit about what it does on your behalf:
 *
 * - it fetches a manifest and the script it names,
 * - it refuses, by name, a plugin this host cannot run,
 * - and it does **not** verify the script's signature, because nothing can yet.
 *
 * ### Pin a version
 *
 * "Constantly updated" is the appeal of these plugins and also the risk: an upstream change arrives
 * as somebody else's code running on your server, with no review. {@link LoadOptions.expectHash}
 * exists for that — record the hash once, and an upstream change becomes a loud failure rather than
 * a silent deployment.
 */

import { createHash } from 'node:crypto';
import { assertSupported, parseManifest } from './manifest.js';
import type { Manifest } from './manifest.js';
import { Sandbox } from './sandbox.js';
import type { FetchLike } from './http.js';
import type { Limits, PluginLog } from './sandbox.js';
import { negotiateFeed } from './feed.js';
import type { Feed } from './feed.js';

/** How to load a plugin. */
export interface LoadOptions {
	readonly limits?: Partial<Limits> | undefined;

	/** Values for the plugin's own settings, by `variable` name. */
	readonly settings?: Readonly<Record<string, unknown>> | undefined;

	readonly onLog?: ((line: PluginLog) => void) | undefined;

	/** Per HTTP request the plugin makes. */
	readonly timeoutMs?: number | undefined;

	/** Across one call into the plugin. */
	readonly maxRequests?: number | undefined;

	readonly maxResponseBytes?: number | undefined;

	/**
	 * Sent when the plugin sets none.
	 *
	 * Defaults to a current browser string, because several platforms answer differently — or not at
	 * all — to anything else, and a plugin that works in the app and not here for that reason is a
	 * confusing bug rather than a platform limitation.
	 */
	readonly userAgent?: string | undefined;

	/**
	 * The expected SHA-256 of the plugin script, hex.
	 *
	 * Supply it and an upstream change fails the load instead of running. Omit it and you are
	 * choosing to run whatever that URL serves today, which is a real choice and not a wrong one —
	 * it is how the app behaves — but it should be a choice.
	 */
	readonly expectHash?: string | undefined;

	/** Used for the manifest and script fetches only. The plugin's own requests are unaffected. */
	readonly fetchTimeoutMs?: number | undefined;

	/**
	 * What performs every request, the manifest and script fetches included. Defaults to the global.
	 *
	 * Passed on to the sandbox as `HttpPolicy.fetch`, so one option covers both this module's two
	 * fetches and everything the plugin itself asks for — a caller required to route through its own
	 * client should not have to discover that half the traffic escaped.
	 */
	readonly fetch?: FetchLike | undefined;
}

/** A loaded plugin. */
export interface Plugin {
	readonly manifest: Manifest;

	/** The SHA-256 of the script that was loaded, hex. Record it and pass it as `expectHash`. */
	readonly scriptHash: string;

	/** Whether the plugin exposes a method. The documented interface is out of date; ask. */
	has(method: string): Promise<boolean>;

	/** Every method the plugin exposes. */
	methods(): Promise<readonly string[]>;

	/** Call a method. `undefined` arguments become explicit `null` — see `Sandbox.call`. */
	call(method: string, args?: readonly unknown[]): Promise<unknown>;

	/** A channel's content, with the feed type negotiated rather than chosen. See `feed.ts`. */
	feed(url: string, options?: { readonly order?: string | null | undefined }): Promise<Feed>;

	/** Release the sandbox. Always, in a `finally`: it holds a WASM heap until it is disposed. */
	dispose(): void;
}

/** A plugin's script or manifest could not be obtained, or is not what was expected. */
export class LoadFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LoadFailure';
	}
}

/** A current desktop browser. See {@link LoadOptions.userAgent}. */
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Fetches a plugin's manifest and script, checks both, and loads it.
 *
 * @param source the manifest URL, for example
 *   `https://plugins.grayjay.app/Kick/KickConfig.json`. A relative `scriptUrl` inside it is resolved
 *   against this, which is how the published manifests are written.
 */
export async function loadPlugin(source: string, options: LoadOptions = {}): Promise<Plugin> {
	const manifest = parseManifest(await fetchJson(source, options), source);

	// Before the script is even fetched: running somebody else's code to discover it needed a
	// capability this host lacks is slower and less informative than reading what it declared.
	assertSupported(manifest);

	const script = await fetchText(manifest.scriptUrl, options);
	const scriptHash = createHash('sha256').update(script).digest('hex');

	if (options.expectHash !== undefined && options.expectHash !== scriptHash) {
		throw new LoadFailure(
			`${manifest.name} script hash is ${scriptHash}, expected ${options.expectHash} — upstream changed the plugin`
		);
	}

	const sandbox = await Sandbox.load({
		script,
		limits: options.limits,
		settings: defaults(manifest, options.settings),
		config: manifest.raw,
		onLog: options.onLog,
		http: {
			allowUrls: manifest.allowUrls,
			timeoutMs: options.timeoutMs ?? 20_000,
			maxRequests: options.maxRequests ?? 60,
			maxResponseBytes: options.maxResponseBytes ?? 16 * 1024 * 1024,
			userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
			...(options.fetch === undefined ? {} : { fetch: options.fetch })
		}
	});

	// Plugins expect this before anything else; the app calls it on load. Called only when present,
	// because not every plugin implements it.
	if (await sandbox.has('enable')) {
		await sandbox.call('enable', [manifest.raw, defaults(manifest, options.settings), null]);
	}

	return {
		manifest,
		scriptHash,
		has: (method) => sandbox.has(method),
		methods: () => sandbox.methods(),
		call: (method, args) => sandbox.call(method, args ?? []),
		feed: (url, feedOptions) => negotiateFeed(sandbox, url, feedOptions ?? {}),
		dispose: () => {
			sandbox.dispose();
		}
	};
}

/**
 * The plugin's own declared defaults, with the caller's values on top.
 *
 * Without the defaults a plugin reads `undefined` for every setting it declared and takes whichever
 * branch that implies — which for Kick's `useHttpImpersonation` (default `"true"`) is the one this
 * host cannot serve. Manifests express defaults as strings, so `"true"` becomes `true` here rather
 * than inside every plugin's own coercion.
 */
function defaults(
	manifest: Manifest,
	supplied: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const setting of manifest.settings) {
		const value = setting.default;

		if (value === undefined) continue;

		out[setting.variable] = value === 'true' ? true : value === 'false' ? false : value;
	}

	return { ...out, ...supplied };
}

/** The manifest, as JSON. */
async function fetchJson(url: string, options: LoadOptions): Promise<unknown> {
	const text = await fetchText(url, options);

	try {
		return JSON.parse(text);
	} catch {
		throw new LoadFailure(`${url} did not answer with JSON`);
	}
}

/** One fetch, with the failure named rather than the cause re-thrown. */
async function fetchText(url: string, options: LoadOptions): Promise<string> {
	let response: Response;

	try {
		const perform = options.fetch ?? fetch;

		response = await perform(url, {
			method: 'GET',
			headers: new Headers({
				accept: '*/*',
				'user-agent': options.userAgent ?? DEFAULT_USER_AGENT
			}),
			redirect: 'follow',
			signal: AbortSignal.timeout(options.fetchTimeoutMs ?? 30_000)
		});
	} catch (cause) {
		// The class name, not the message: a fetch failure can quote the request.
		throw new LoadFailure(
			`${url} could not be reached (${cause instanceof Error ? cause.name : typeof cause})`
		);
	}

	if (!response.ok) throw new LoadFailure(`${url} answered ${String(response.status)}`);

	return response.text();
}
