/**
 * The manifest layer, which is the only thing this host reads before deciding to run somebody
 * else's code — so it is where a refusal has to be correct.
 *
 * The fixtures are the **real published manifests** for Twitch and Kick, trimmed. Invented ones
 * would prove the schema parses what this file imagines, which is the mistake that makes a parser
 * pass its tests and fail on the first real input.
 */

import { describe, expect, it } from 'vitest';
import { allowsUrl, assertSupported, parseManifest, unsupportedReasons } from './manifest.js';

/** Twitch's published manifest, trimmed. `packages: ["Http"]` is its real value. */
const TWITCH = {
	id: 'c0f315f9-0992-4508-a061-f2738724c331',
	name: 'Twitch',
	version: 38,
	scriptUrl: './TwitchScript.js',
	sourceUrl: 'https://plugins.grayjay.app/Twitch/TwitchConfig.json',
	packages: ['Http'],
	allowEval: false,
	allowUrls: [
		'gql.twitch.tv',
		'twitch.tv',
		'usher.ttvnw.net',
		'.playlist.ttvnw.net',
		'.hls.ttvnw.net',
		'.live-video.net'
	],
	authentication: {
		userAgent: null,
		loginUrl: 'https://www.twitch.tv/login',
		headersToFind: ['Authorization']
	},
	settings: [
		{
			variable: 'shouldIncludeChannelClips',
			name: 'Show channel clips',
			type: 'Boolean',
			default: 'true'
		}
	]
};

describe('a published manifest', () => {
	it('resolves a relative scriptUrl against the manifest own location', () => {
		// Every official manifest writes `./ThingScript.js`. A host that used it verbatim would fetch
		// a relative path and fail with something that does not mention the manifest at all.
		expect(parseManifest(TWITCH).scriptUrl).toBe(
			'https://plugins.grayjay.app/Twitch/TwitchScript.js'
		);
	});

	it('prefers the url it was fetched from over the one the manifest claims', () => {
		// A mirror, or a plugin served from a fork. The manifest's own `sourceUrl` is what upstream
		// published; where it actually came from is the truth for resolving against.
		const manifest = parseManifest(TWITCH, 'https://mirror.example/Twitch/TwitchConfig.json');

		expect(manifest.scriptUrl).toBe('https://mirror.example/Twitch/TwitchScript.js');
	});

	it('normalises a numeric version to a string', () => {
		// Manifests use a number; a caller comparing or recording it wants one type.
		expect(parseManifest(TWITCH).version).toBe('38');
	});

	it('reports what a plugin wants a login for, without refusing it', () => {
		// GrayJay's TikTok plugin declares `cookiesToFind: ["ttwid","sessionid"]` — it wants a real
		// signed-in account, which a server serving a public page must not carry. Most plugins declare
		// this for optional features and work fine without it, so it is reported and not refused.
		const manifest = parseManifest({
			...TWITCH,
			authentication: { cookiesToFind: ['ttwid', 'sessionid'], loginUrl: 'https://tiktok.com' }
		});

		expect(manifest.authentication?.cookies).toStrictEqual(['ttwid', 'sessionid']);
		expect(unsupportedReasons(manifest)).toStrictEqual([]);
	});

	it('keeps the whole manifest, because plugins read their own config back', () => {
		expect(parseManifest(TWITCH).raw.id).toBe(TWITCH.id);
	});
});

describe('what this host will not run', () => {
	it('refuses HttpImp by name rather than letting it fail against Cloudflare', () => {
		// TLS fingerprint impersonation needs a stack that presents a browser's exact ClientHello.
		// Node has none, and a plugin left to discover that returns an empty feed — indistinguishable
		// from the platform being down.
		const manifest = parseManifest({ ...TWITCH, packages: ['Http', 'HttpImp'] });

		expect(unsupportedReasons(manifest)).toHaveLength(1);
		expect(unsupportedReasons(manifest)[0]).toMatch(/HttpImp/);
		expect(() => {
			assertSupported(manifest);
		}).toThrow(/cannot run on this host/);
	});

	it('refuses DOMParser, which it does not provide yet', () => {
		const manifest = parseManifest({ ...TWITCH, packages: ['Http', 'DOMParser'] });

		expect(unsupportedReasons(manifest)[0]).toMatch(/DOMParser/);
	});

	it('refuses allowEval', () => {
		// A plugin building code at run time means the manifest's allow-list no longer bounds what
		// runs. Exactly one plugin in the public index asks for this.
		expect(unsupportedReasons(parseManifest({ ...TWITCH, allowEval: true }))[0]).toMatch(
			/allowEval/
		);
	});

	it('refuses a package it has never heard of', () => {
		// Rather than ignoring it. An unknown package is upstream adding a capability, and silently
		// running without it is how a plugin half-works.
		const manifest = parseManifest({ ...TWITCH, packages: ['Http', 'Telepathy'] });

		expect(manifest.unknownPackages).toStrictEqual(['Telepathy']);
		expect(unsupportedReasons(manifest)[0]).toMatch(/Telepathy/);
	});

	it('runs the real Twitch and Kick manifests, which need only Http', () => {
		// The point of the whole package check: these two are the reason this library is useful, and
		// they declare `["Http"]`.
		expect(unsupportedReasons(parseManifest(TWITCH))).toStrictEqual([]);
		expect(
			unsupportedReasons(
				parseManifest({
					id: '4a78c2ff-c20f-43ac-8f75-34515df1d320',
					name: 'Kick',
					scriptUrl: './KickScript.js',
					sourceUrl: 'https://plugins.grayjay.app/Kick/KickConfig.json',
					packages: ['Http'],
					allowUrls: ['kick.com', 'search.kick.com', 'web.kick.com']
				})
			)
		).toStrictEqual([]);
	});
});

describe('the allow-list, which is enforced and not recorded', () => {
	const allow = TWITCH.allowUrls;

	it.each([
		['the host itself', 'https://twitch.tv/someone', true],
		['a subdomain of a bare entry', 'https://gql.twitch.tv/gql', true],
		['an exact entry', 'https://usher.ttvnw.net/api/channel/hls/x.m3u8', true],
		['a subdomain of a dotted entry', 'https://video-weaver.lhr03.hls.ttvnw.net/v1/playlist', true],
		['an unrelated host', 'https://evil.example/collect', false],
		['a host that merely contains an entry', 'https://twitch.tv.evil.example/x', false],
		['a suffix without the dot boundary', 'https://nottwitch.tv/x', false]
	])('%s', (_name, url, expected) => {
		expect(allowsUrl(allow, url)).toBe(expected);
	});

	it('refuses a dotted entry matched exactly, because the dot means subdomains', () => {
		// `.hls.ttvnw.net` is a suffix wildcard. `hls.ttvnw.net` itself is a different host and was
		// not declared.
		expect(allowsUrl(['.hls.ttvnw.net'], 'https://hls.ttvnw.net/x')).toBe(false);
	});

	it.each([
		['file', 'file:///etc/passwd'],
		['data', 'data:text/plain,hello'],
		['a nonsense string', 'not a url at all']
	])('refuses the %s scheme whatever the list says', (_name, url) => {
		// The one that matters most. A plugin reaching `file:` through this would be reading the
		// host's disk, and no allow-list entry should be able to permit that.
		expect(allowsUrl(['*', 'etc', 'localhost', ''], url)).toBe(false);
	});

	it('treats an empty list as nothing allowed, not everything', () => {
		// A manifest that forgot to declare its hosts should fail loudly on its first request rather
		// than be handed the open internet.
		expect(allowsUrl([], 'https://twitch.tv/someone')).toBe(false);
	});

	it('ignores case, because host names are case-insensitive', () => {
		expect(allowsUrl(['Twitch.TV'], 'https://GQL.TWITCH.tv/gql')).toBe(true);
	});
});
