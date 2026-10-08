/**
 * A GrayJay plugin's manifest, parsed and checked.
 *
 * A plugin is two files: a manifest (`*Config.json`) and one JavaScript file. The manifest is the
 * only thing this host can read *before* deciding to run somebody else's code, which makes it the
 * right place to refuse — a plugin that needs a capability this host does not have should be
 * rejected here, by name, rather than failing somewhere inside a feed call where the error reads as
 * a broken platform.
 *
 * The schema is deliberately permissive about fields this host does not use. A manifest is written
 * for the GrayJay app, the app adds fields over time, and refusing an unknown one would make this
 * library break every time upstream ships a release. It is strict about the fields it *acts* on.
 */

import { z } from 'zod';

/**
 * Host capabilities a plugin can ask for.
 *
 * Of the 117 plugins in the public index, 117 need `Http`, 59 need `DOMParser`, 26 need
 * `Utilities`, and exactly one needs `HttpImp`. So the list is short and the gaps are knowable.
 */
export const PACKAGES = ['Http', 'Utilities', 'DOMParser', 'HttpImp'] as const;

/** One of {@link PACKAGES}. */
export type PackageName = (typeof PACKAGES)[number];

/**
 * What this version of the host actually provides.
 *
 * `HttpImp` is TLS fingerprint impersonation. It is **not implementable on Node** — it needs a TLS
 * stack that can present a browser's exact ClientHello, which is the whole point of it. A plugin
 * requiring it is refused rather than run and left to fail against Cloudflare, because an empty feed
 * is indistinguishable from a platform being down.
 *
 * `DOMParser` is provided — the document is parsed on the host and the sandbox gets handles, see
 * `dom.ts`. It is listed here because a manifest is checked before a sandbox exists, so this is the
 * answer to "could this plugin run at all" rather than "is DOM switched on for this one". A plugin
 * declaring it and loaded without `dom: true` gets a named error from `domParser` instead of an
 * `undefined is not a function`.
 */
export const PROVIDED: readonly PackageName[] = ['Http', 'Utilities', 'DOMParser'];

/** A setting a plugin exposes, which the operator supplies a value for. */
const settingSchema = z
	.object({
		variable: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		type: z.string().optional(),
		default: z.unknown().optional()
	})
	.loose();

/**
 * The manifest as it is published.
 *
 * `.loose()` throughout: see the note at the top.
 */
export const manifestSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		version: z.union([z.number(), z.string()]).optional(),

		/** Relative to the manifest's own URL, which is why {@link resolveManifest} exists. */
		scriptUrl: z.string().min(1),

		sourceUrl: z.string().optional(),
		platformUrl: z.string().optional(),
		author: z.string().optional(),
		description: z.string().optional(),
		iconUrl: z.string().optional(),

		/** Present on official plugins. See {@link Manifest.signature} for what this host does. */
		scriptSignature: z.string().optional(),
		scriptPublicKey: z.string().optional(),

		packages: z.array(z.string()).optional(),

		/** `true` means the plugin wants `eval`. This host refuses those — see `sandbox.ts`. */
		allowEval: z.boolean().optional(),

		/**
		 * Hosts the plugin may talk to. Enforced, not recorded.
		 *
		 * A leading dot is a suffix wildcard: `.hls.ttvnw.net` matches `foo.hls.ttvnw.net`. A bare
		 * host matches itself and its subdomains, which is how the app treats `twitch.tv` covering
		 * `gql.twitch.tv`.
		 */
		allowUrls: z.array(z.string()).optional(),

		settings: z.array(settingSchema).optional(),

		/**
		 * What the plugin needs a signed-in platform account for.
		 *
		 * Surfaced because it changes what a plugin can do here rather than merely how it behaves.
		 * GrayJay's official TikTok plugin declares `cookiesToFind: ["ttwid", "sessionid"]` — it wants
		 * the viewer's own TikTok session. The app can provide that from a login webview; a server
		 * hosting plugins for a public page cannot and must not, so a plugin like that will load,
		 * run, and return nothing.
		 *
		 * Reported by {@link Manifest.authentication} rather than refused: many plugins declare this
		 * for *optional* signed-in features and work fine without it, so this is a caller's judgement.
		 */
		authentication: z
			.object({
				loginUrl: z.string().nullish(),
				headersToFind: z.array(z.string()).nullish(),
				cookiesToFind: z.array(z.string()).nullish()
			})
			.loose()
			.nullish()
	})
	.loose();

/** A manifest as published, before URLs are resolved. */
export type RawManifest = z.infer<typeof manifestSchema>;

/** A manifest with its URLs resolved and its declarations in usable form. */
export interface Manifest {
	readonly id: string;
	readonly name: string;
	readonly version: string | null;

	/** Absolute, resolved against the manifest's own location. */
	readonly scriptUrl: string;

	/** Where this manifest was loaded from, when that is known. */
	readonly sourceUrl: string | null;

	readonly packages: readonly PackageName[];

	/** Packages the plugin asked for that are not in {@link PACKAGES} at all. */
	readonly unknownPackages: readonly string[];

	readonly allowEval: boolean;
	readonly allowUrls: readonly string[];

	/**
	 * The script signature, if the manifest carries one.
	 *
	 * **This host does not verify it.** The algorithm and canonical byte form are not documented
	 * anywhere public, and a verification that is wrong is worse than none: it would report
	 * "verified" for a signature it never actually checked. So it is surfaced for a caller to handle
	 * and `trustScript` in the loader is an explicit decision rather than a silent default.
	 */
	readonly signature: { readonly value: string; readonly publicKey: string | null } | null;

	readonly settings: readonly z.infer<typeof settingSchema>[];

	/**
	 * What the plugin wants a platform login for, or null.
	 *
	 * Non-null does not mean the plugin is unusable — most declare it for optional signed-in features.
	 * It means a caller should expect the signed-in parts to be unavailable, and should read the
	 * plugin's own settings for a switch that turns them off.
	 */
	readonly authentication: {
		readonly cookies: readonly string[];
		readonly headers: readonly string[];
	} | null;

	/** Everything else the manifest carried, unchanged, for a caller that needs a field this does not model. */
	readonly raw: RawManifest;
}

/** Why a manifest cannot be run here. */
export class UnsupportedPlugin extends Error {
	constructor(
		readonly manifest: Manifest,
		readonly missing: readonly string[],
		message: string
	) {
		super(message);
		this.name = 'UnsupportedPlugin';
	}
}

/**
 * A manifest, parsed.
 *
 * @param source the URL this manifest came from, so a relative `scriptUrl` can be resolved. Optional
 *   because a manifest may be read from disk, in which case `scriptUrl` has to be absolute already.
 */
export function parseManifest(input: unknown, source?: string): Manifest {
	const parsed = manifestSchema.parse(input);
	const base = source ?? parsed.sourceUrl ?? null;

	const asked = parsed.packages ?? [];
	const known = asked.filter((name): name is PackageName =>
		(PACKAGES as readonly string[]).includes(name)
	);

	return {
		id: parsed.id,
		name: parsed.name,
		version: parsed.version === undefined ? null : String(parsed.version),
		scriptUrl: resolve(parsed.scriptUrl, base),
		sourceUrl: base,
		packages: known,
		unknownPackages: asked.filter((name) => !(PACKAGES as readonly string[]).includes(name)),
		allowEval: parsed.allowEval ?? false,
		allowUrls: parsed.allowUrls ?? [],
		signature:
			parsed.scriptSignature === undefined
				? null
				: { value: parsed.scriptSignature, publicKey: parsed.scriptPublicKey ?? null },
		settings: parsed.settings ?? [],
		authentication:
			parsed.authentication === undefined || parsed.authentication === null
				? null
				: {
						cookies: parsed.authentication.cookiesToFind ?? [],
						headers: parsed.authentication.headersToFind ?? []
					},
		raw: parsed
	};
}

/**
 * Whether this host can run the plugin, and what is missing if not.
 *
 * Checked before the script is even fetched. Running somebody else's code to discover it needed a
 * capability we do not have is both slower and less informative than reading what it declared.
 */
export function unsupportedReasons(manifest: Manifest): readonly string[] {
	const reasons: string[] = [];

	for (const name of manifest.packages) {
		if (!PROVIDED.includes(name)) {
			reasons.push(
				name === 'HttpImp'
					? 'needs HttpImp (TLS impersonation), which cannot be implemented on Node'
					: `needs the ${name} package, which this host does not provide yet`
			);
		}
	}

	for (const name of manifest.unknownPackages) {
		reasons.push(`asks for an unrecognised package: ${name}`);
	}

	if (manifest.allowEval) {
		// A plugin wanting `eval` wants to build code at run time. Exactly one plugin in the index
		// does, and allowing it would mean the manifest's own allow-list no longer bounds what runs.
		reasons.push('declares allowEval, which this host refuses');
	}

	return reasons;
}

/** Throws {@link UnsupportedPlugin} when {@link unsupportedReasons} finds anything. */
export function assertSupported(manifest: Manifest): void {
	const reasons = unsupportedReasons(manifest);

	if (reasons.length > 0) {
		throw new UnsupportedPlugin(
			manifest,
			reasons,
			`${manifest.name} cannot run on this host: ${reasons.join('; ')}`
		);
	}
}

/**
 * Whether a URL is inside a plugin's allow-list.
 *
 * Host-only and case-insensitive. Three rules, taken from how the published manifests are written:
 *
 * - `.hls.ttvnw.net` — a leading dot is a suffix match, so subdomains only.
 * - `twitch.tv` — a bare host matches itself *and* its subdomains, because Twitch's own manifest
 *   lists `twitch.tv` and the plugin then calls `gql.twitch.tv`.
 * - anything else is refused.
 *
 * Only `http:` and `https:` are ever allowed, whatever the list says: a plugin reaching `file:` or
 * `data:` through this would be reading the host's disk.
 */
export function allowsUrl(allowUrls: readonly string[], url: string): boolean {
	let parsed;

	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

	// An empty list is "nothing allowed", not "everything". A manifest that forgot to declare its
	// hosts should fail loudly on its first request rather than be handed the open internet.
	const host = parsed.hostname.toLowerCase();

	return allowUrls.some((entry) => {
		const pattern = entry.trim().toLowerCase().replace(/^\*/, '');

		if (pattern === '') return false;
		if (pattern.startsWith('.')) return host.endsWith(pattern);

		return host === pattern || host.endsWith(`.${pattern}`);
	});
}

/** A possibly-relative URL, made absolute against the manifest's own location. */
function resolve(url: string, base: string | null): string {
	if (base === null) return url;

	try {
		return new URL(url, base).toString();
	} catch {
		return url;
	}
}
