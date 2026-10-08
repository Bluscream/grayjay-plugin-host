/**
 * The real thing: the published Twitch and Kick plugins, fetched and run.
 *
 * Everything else in this suite is offline and deterministic, and none of it can tell you whether
 * this library actually hosts GrayJay plugins — only whether it behaves as its own author imagined.
 * This file is the one that answers the question, so it is also the one that breaks when upstream
 * changes a plugin or a platform changes an API.
 *
 * It is therefore **opt-in**: set `RUN_LIVE=1`. Off by default because it reaches two third-party
 * platforms, and a test suite that quietly makes network requests to someone else's service on every
 * `npm test` is a bad citizen regardless of how useful it is.
 *
 * ```sh
 * RUN_LIVE=1 npm test
 * ```
 *
 * Both plugins declare `packages: ["Http"]`, which is why these two: they are the plugins this host
 * can run today. A failure here is as likely to be upstream or a platform as it is to be this
 * library — the assertions are deliberately loose about *content* (a channel's follower count is not
 * this library's business) and strict about *shape*.
 */

import { describe, expect, it } from 'vitest';
import { loadPlugin } from './plugin.js';
import { assertSupported, parseManifest } from './manifest.js';
import type { Plugin } from './plugin.js';

const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

/** A channel that has existed for years and is not going to be deleted mid-test. */
interface Target {
	readonly name: string;
	readonly manifest: string;
	readonly channel: string;
}

const TARGETS: readonly Target[] = [
	{
		name: 'Twitch',
		manifest: 'https://plugins.grayjay.app/Twitch/TwitchConfig.json',
		channel: 'https://www.twitch.tv/twitch'
	},
	{
		name: 'Kick',
		manifest: 'https://plugins.grayjay.app/Kick/KickConfig.json',
		channel: 'https://kick.com/xqc'
	}
];

/** Loads a plugin and hands it to `body`, always disposing it. */
async function withPlugin(target: Target, body: (plugin: Plugin) => Promise<void>): Promise<void> {
	const lines: string[] = [];
	const plugin = await loadPlugin(target.manifest, {
		onLog: (line) => lines.push(line.message),
		maxRequests: 80,
		timeoutMs: 30_000
	});

	try {
		await body(plugin);
	} catch (cause) {
		// A plugin's own log is usually the only explanation of why it refused, and without it a
		// failure here is a message with no context in somebody's CI output.
		if (lines.length > 0) {
			throw new Error(`${target.name}: ${String(cause)}\nplugin log:\n${lines.join('\n')}`, {
				cause
			});
		}

		throw cause;
	} finally {
		plugin.dispose();
	}
}

live.each(TARGETS)('the published $name plugin', (target) => {
	it('loads, and reports the methods it really has', async () => {
		// The load itself is most of the test: the plugin's own top-level code runs, which is where
		// a missing host global shows up. `getChannel` and a feed method are what any useful reader
		// needs, so their absence means this host loaded something it cannot use.
		await withPlugin(target, async (plugin) => {
			const methods = await plugin.methods();

			expect(methods.length).toBeGreaterThan(5);
			expect(methods).toContain('getChannel');
			expect(await plugin.has('getChannelContents')).toBe(true);
			expect(plugin.scriptHash).toMatch(/^[0-9a-f]{64}$/);
		});
	}, 120_000);

	it('reads a channel', async () => {
		// One real request through the asyncified bridge, parsed by real plugin code. If the sync
		// HTTP shim were subtly wrong this is where it would show.
		await withPlugin(target, async (plugin) => {
			const channel = (await plugin.call('getChannel', [target.channel])) as Record<
				string,
				unknown
			>;

			expect(typeof channel.name).toBe('string');
			expect(String(channel.name).length).toBeGreaterThan(0);
			expect(String(channel.url)).toContain(new URL(target.channel).hostname.replace('www.', ''));
		});
	}, 120_000);

	it('reads a page of that channel content, with the type negotiated', async () => {
		await withPlugin(target, async (plugin) => {
			const feed = await plugin.feed(target.channel);

			// Not `toBeGreaterThan(0)`: a channel can legitimately have an empty page, and a test
			// that fails because somebody deleted their videos is a test nobody trusts. The shape
			// is what this library is responsible for.
			expect(Array.isArray(feed.results)).toBe(true);
			expect(typeof feed.hasMore).toBe('boolean');

			if (feed.results.length > 0) {
				const first = feed.results[0] as Record<string, unknown>;

				expect(typeof first.name).toBe('string');
				expect(typeof first.url).toBe('string');

				// The nested value classes, because asserting only the flat string fields is what let a
				// real bug through: the carriers were spreading a positional string argument by index,
				// so `id` arrived as `{ 0: 'k', 1: 'i', ... }` while `name` and `url` stayed perfectly
				// fine. A shape check that cannot fail on corrupt data is not a check.
				const id = first.id as Record<string, unknown> | undefined;

				if (id !== undefined) {
					expect(typeof id.value).toBe('string');
					expect(String(id.value).length).toBeGreaterThan(0);

					// No numeric keys: that is the corruption itself, stated directly.
					expect(Object.keys(id).filter((key) => /^\d+$/.test(key))).toStrictEqual([]);
				}

				const author = first.author as Record<string, unknown> | undefined;

				if (author !== undefined) {
					expect(typeof author.name).toBe('string');
					expect(String(author.url)).toContain('http');
				}

				const thumbnails = first.thumbnails as { sources?: unknown[] } | undefined;
				const thumbnail = thumbnails?.sources?.[0] as Record<string, unknown> | undefined;

				if (thumbnail !== undefined) {
					expect(String(thumbnail.url)).toMatch(/^https?:\/\//);
				}
			}
		});
	}, 180_000);

	it('is refused when the recorded script hash no longer matches', async () => {
		// The pinning path, tested with a hash that cannot be right. Worth a live test because its
		// whole purpose is to fire against a *real* upstream change, and a version-pinning check
		// that silently never fires is worse than none.
		await expect(loadPlugin(target.manifest, { expectHash: '0'.repeat(64) })).rejects.toThrow(
			/upstream changed the plugin/
		);
	}, 120_000);
});

live('a plugin that scrapes HTML', () => {
	// The DOMParser path against real plugins, which is what makes most of the public index runnable
	// at all. These three are official or long-standing and all declare `DOMParser`.
	//
	// `getHome` rather than a channel: it needs no fixture identity that somebody could delete, and
	// it is the call that exercises parse-and-walk over a real page of unpredictable markup — which
	// is where a gap in the host's DOM shows up, and a fixture never would.
	it.each([
		['Dailymotion', 'https://plugins.grayjay.app/Dailymotion/DailymotionConfig.json'],
		['Nebula', 'https://plugins.grayjay.app/Nebula/NebulaConfig.json'],
		['Bitchute', 'https://plugins.grayjay.app/Bitchute/BitchuteConfig.json']
	])(
		'%s loads and returns content',
		async (name, manifest) => {
			const lines: string[] = [];

			// DOM support is deliberately not passed. The manifest declares `DOMParser`, and
			// `loadPlugin` turning it on by itself is part of what is being asserted: a caller should
			// not have to know that a plugin scrapes.
			const plugin = await loadPlugin(manifest, {
				onLog: (line) => lines.push(line.message),
				maxRequests: 120,
				timeoutMs: 30_000
			});

			try {
				const home = await plugin.call('getHome');
				const results = Array.isArray(home)
					? home
					: ((home as { results?: unknown[] } | null)?.results ?? []);

				expect(results.length).toBeGreaterThan(0);

				const first = results[0] as Record<string, unknown>;

				expect(typeof first.name).toBe('string');
				expect(String(first.name).length).toBeGreaterThan(0);
				expect(String(first.url)).toMatch(/^https?:\/\//);

				// The nested value class, for the same reason as the Twitch and Kick cases above: it is
				// what a carrier bug corrupts while the flat fields stay convincing.
				const id = first.id as Record<string, unknown> | undefined;

				if (id !== undefined) {
					expect(Object.keys(id).filter((key) => /^\d+$/.test(key))).toStrictEqual([]);
				}
			} catch (cause) {
				throw new Error(
					`${name}: ${String(cause)}${lines.length > 0 ? `\nplugin log:\n${lines.join('\n')}` : ''}`,
					{ cause }
				);
			} finally {
				plugin.dispose();
			}
		},
		180_000
	);
});

live('a plugin this host cannot run', () => {
	it('is refused by name rather than left to fail against Cloudflare', () => {
		// `HttpImp` is the one package that cannot work on Node at any version — it needs a TLS stack
		// presenting a browser's exact ClientHello. The point is the *reason*: an operator reading
		// "needs HttpImp" knows this is a host limit, where an empty feed would have them checking the
		// platform's status page.
		//
		// Against a synthesised manifest rather than a named plugin, because which plugins declare
		// `HttpImp` changes upstream, and a test that fails when somebody else updates their plugin is
		// testing the wrong thing. The real published manifests are covered in `manifest.test.ts`.
		const manifest = parseManifest(
			{
				id: 'test',
				name: 'Impersonating',
				scriptUrl: './Script.js',
				sourceUrl: 'https://example.invalid/Config.json',
				packages: ['Http', 'HttpImp'],
				allowUrls: ['example.invalid']
			},
			'https://example.invalid/Config.json'
		);

		expect(() => {
			assertSupported(manifest);
		}).toThrow(/HttpImp/);
	});
});
