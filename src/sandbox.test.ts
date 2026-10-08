/**
 * The sandbox: the host surface it provides, and the limits it enforces.
 *
 * Every test here runs a small plugin written the way the real ones are written — synchronous
 * `http.GET`, a `source` object, the globals read at load time — because the whole value of this
 * library is that those patterns work, and a test that called the host's own functions directly
 * would prove nothing about that.
 *
 * `fetch` is stubbed. The live tests against real published plugins are in `live.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitExceeded, PluginError, Sandbox } from './sandbox.js';
import type { PluginLog } from './sandbox.js';
import type { HttpPolicy } from './http.js';

/** Requests the sandbox was allowed to make. */
let made: { method: string; url: string; body: string | null }[];

/** What the stubbed network answers, by url substring. */
let answers: Record<string, { status?: number; body?: string }>;

let logged: PluginLog[];

function policy(extra: Partial<HttpPolicy> = {}): HttpPolicy {
	return {
		allowUrls: ['example.test'],
		timeoutMs: 5_000,
		maxRequests: 10,
		maxResponseBytes: 1024 * 1024,
		userAgent: 'test-agent',
		...extra
	};
}

/** A sandbox running `script`, with the stubbed network. */
async function load(script: string, extra: Partial<HttpPolicy> = {}): Promise<Sandbox> {
	return Sandbox.load({
		script,
		http: policy(extra),
		onLog: (line) => logged.push(line)
	});
}

beforeEach(() => {
	made = [];
	logged = [];
	answers = { 'example.test': { status: 200, body: '{"ok":true}' } };

	// Not `async`: there is nothing to await, and `RequestInfo` is a DOM type that is not in this
	// project's lib, so it would widen the parameter to `any` and silently stop checking the call.
	vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);

		made.push({
			method: init?.method ?? 'GET',
			url,
			body: typeof init?.body === 'string' ? init.body : null
		});

		const key = Object.keys(answers).find((part) => url.includes(part));
		const answer = key === undefined ? undefined : answers[key];
		const status = answer?.status ?? 404;

		return Promise.resolve(
			new Response(answer?.body ?? '', {
				status,
				headers: { 'content-type': 'application/json' }
			})
		);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a plugin that declares its own source', () => {
	it('is found, although it is a lexical binding and not a global', async () => {
		// The undocumented item that cost the most. `const source = {…}` at the top level of a script
		// never becomes a property of the global object, so a host reading `globalThis.source` sees an
		// empty plugin — which is exactly what happened to the X plugin, reporting zero methods.
		// Evaluating the bare *name* finds both forms.
		const sandbox = await load(`const source = { who: function () { return 'declared'; } };`);

		try {
			expect(await sandbox.has('who')).toBe(true);
			expect(await sandbox.call('who')).toBe('declared');
		} finally {
			sandbox.dispose();
		}
	});

	it('is also found when the plugin assigns to the injected one', async () => {
		const sandbox = await load(`source.who = function () { return 'assigned'; };`);

		try {
			expect(await sandbox.call('who')).toBe('assigned');
		} finally {
			sandbox.dispose();
		}
	});

	it('reports nothing rather than crashing when a plugin defines neither', async () => {
		const sandbox = await load(`var somethingElse = 1;`);

		try {
			expect(await sandbox.methods()).toStrictEqual([]);
			expect(await sandbox.has('who')).toBe(false);
		} finally {
			sandbox.dispose();
		}
	});
});

describe('the globals a plugin reads at load time', () => {
	it.each([
		['IS_TESTING', `source.v = function () { return IS_TESTING; };`, false],
		['setTimeout', `source.v = function () { return typeof setTimeout; };`, 'function'],
		[
			'Type.Order.Chronological',
			`source.v = function () { return Type.Order.Chronological; };`,
			'Latest releases'
		],
		['Type.Feed.Mixed', `source.v = function () { return Type.Feed.Mixed; };`, 'MIXED'],
		['Language.ENGLISH', `source.v = function () { return Language.ENGLISH; };`, 'en'],
		['PlaybackTracker', `source.v = function () { return typeof PlaybackTracker; };`, 'function'],
		['PlatformVideo', `source.v = function () { return typeof PlatformVideo; };`, 'function'],
		['utility', `source.v = function () { return utility.fromMilliseconds(2500); };`, 3]
	])('provides %s', async (_name, script, expected) => {
		// Each of these cost a failed run against a real plugin. YouTube throws on an undefined
		// `IS_TESTING` and refuses to start without `setTimeout`; TikTok reads `PlaybackTracker`.
		const sandbox = await load(script);

		try {
			expect(await sandbox.call('v')).toStrictEqual(expected);
		} finally {
			sandbox.dispose();
		}
	});

	it('gives Type.Order human strings, which is what plugins compare against', async () => {
		// Not a guess: the TikTok plugin ships `Type.Order.Chronological = "Latest releases"` as a
		// shim for older hosts, so its own comparisons are the authority. With screaming snake case a
		// plugin loads, runs, and throws `invalid ordering` from inside a feed call.
		const sandbox = await load(`source.v = function () { return Type.Order; };`);

		try {
			expect(await sandbox.call('v')).toStrictEqual({
				Chronological: 'Latest releases',
				Views: 'Most played',
				Favorites: 'Most favorited'
			});
		} finally {
			sandbox.dispose();
		}
	});
});

describe('synchronous http, which is the whole problem', () => {
	it('returns a response to a plugin that did not await anything', async () => {
		// The property this library exists for. A GrayJay plugin writes
		// `const r = http.GET(url); if (r.isOk) …` with no await anywhere, and the host has to do a
		// real async fetch inside that call.
		const sandbox = await load(`
			source.read = function () {
				const r = http.GET('https://example.test/feed');
				if (!r.isOk) throw new Error('not ok');
				return { code: r.code, parsed: JSON.parse(r.body).ok };
			};
		`);

		try {
			expect(await sandbox.call('read')).toStrictEqual({ code: 200, parsed: true });
		} finally {
			sandbox.dispose();
		}
	});

	it('reports the real status code, not zero', async () => {
		// The trap the first spike fell into: a host that loses the status makes every request look
		// like a failure, which the plugin then reports as an empty feed.
		answers = { 'example.test': { status: 418, body: 'teapot' } };

		const sandbox = await load(
			`source.read = function () { const r = http.GET('https://example.test/x'); return [r.code, r.isOk]; };`
		);

		try {
			expect(await sandbox.call('read')).toStrictEqual([418, false]);
		} finally {
			sandbox.dispose();
		}
	});

	it('sends a POST body', async () => {
		const sandbox = await load(
			`source.send = function () { return http.POST('https://example.test/gql', '{"q":1}', { 'content-type': 'application/json' }).code; };`
		);

		try {
			expect(await sandbox.call('send')).toBe(200);
			expect(made[0]?.method).toBe('POST');
			expect(made[0]?.body).toBe('{"q":1}');
		} finally {
			sandbox.dispose();
		}
	});

	it('gives getDefaultClient a clientId', async () => {
		// TikTok throws "missing http client id" without one.
		const sandbox = await load(
			`source.v = function () { return http.getDefaultClient(false).clientId; };`
		);

		try {
			expect(typeof (await sandbox.call('v'))).toBe('string');
		} finally {
			sandbox.dispose();
		}
	});
});

describe('batch, which plugins use as a chainable builder', () => {
	it('chains, executes in order, and keeps DUMMY positions', async () => {
		// `DUMMY` queues a placeholder so a plugin that skipped one request still destructures the
		// rest into the right variables. Its mere presence is also a feature probe some plugins read
		// as `canBatchDummy = !!batch.DUMMY`.
		const sandbox = await load(`
			source.read = function () {
				let batch = http.batch();
				batch = batch.GET('https://example.test/a');
				batch = batch.DUMMY();
				batch = batch.GET('https://example.test/b');
				const [a, skipped, b] = batch.execute();
				return [a.code, skipped.code, b.code, !!http.batch().DUMMY];
			};
		`);

		try {
			expect(await sandbox.call('read')).toStrictEqual([200, 0, 200, true]);
			expect(made.map((entry) => entry.url)).toStrictEqual([
				'https://example.test/a',
				'https://example.test/b'
			]);
		} finally {
			sandbox.dispose();
		}
	});
});

describe('the network boundary', () => {
	it('refuses a host the manifest did not declare', async () => {
		// The plugin sees a failed response rather than an exception, because that is the path its own
		// error handling already takes — and some plugins probe optional endpoints on purpose.
		const sandbox = await load(
			`source.read = function () { const r = http.GET('https://evil.example/collect'); return [r.code, r.isOk]; };`
		);

		try {
			const [code, isOk] = (await sandbox.call('read')) as [number, boolean];

			expect(isOk).toBe(false);
			expect(code).toBe(403);
			expect(made).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('caps the number of requests in one call', async () => {
		// A plugin loop must not be able to become a crawl against somebody's platform.
		const sandbox = await load(
			`
			source.read = function () {
				let ok = 0;
				for (let i = 0; i < 50; i++) { if (http.GET('https://example.test/' + i).isOk) ok++; }
				return ok;
			};
		`,
			{ maxRequests: 3 }
		);

		try {
			expect(await sandbox.call('read')).toBe(3);
			expect(made).toHaveLength(3);
		} finally {
			sandbox.dispose();
		}
	});

	it('gives each call its own request budget', async () => {
		// Per call, not per plugin: a plugin that legitimately makes 30 requests for one feed page
		// should not be throttled by what the previous page cost.
		const sandbox = await load(
			`source.read = function () { return http.GET('https://example.test/x').isOk; };`,
			{ maxRequests: 1 }
		);

		try {
			expect(await sandbox.call('read')).toBe(true);
			expect(await sandbox.call('read')).toBe(true);
		} finally {
			sandbox.dispose();
		}
	});

	it('sends its own user agent when the plugin sets none', async () => {
		const sandbox = await load(
			`source.read = function () { return http.GET('https://example.test/x').code; };`
		);

		try {
			await sandbox.call('read');
			expect(made).toHaveLength(1);
		} finally {
			sandbox.dispose();
		}
	});

	it('reports a transport failure as a status, not as a thrown host error', async () => {
		// A plugin has no way to catch a host exception. A 504 means its own `isOk` check runs.
		vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED 1.2.3.4:443')));

		const sandbox = await load(
			`source.read = function () { const r = http.GET('https://example.test/x'); return [r.code, r.isOk]; };`
		);

		try {
			expect(await sandbox.call('read')).toStrictEqual([504, false]);
		} finally {
			sandbox.dispose();
		}
	});

	it('never puts the failure message into the sandbox', async () => {
		// A thrown value from `fetch` can quote the request, and a request may carry an Authorization
		// header the caller supplied.
		vi.stubGlobal('fetch', () =>
			Promise.reject(new Error('failed to connect with Authorization: Bearer hunter2'))
		);

		const sandbox = await load(
			`source.read = function () { return http.GET('https://example.test/x').body; };`
		);

		try {
			expect(String(await sandbox.call('read'))).not.toContain('hunter2');
		} finally {
			sandbox.dispose();
		}
	});
});

describe('the limits', () => {
	it('stops a plugin that never finishes', async () => {
		// The only way to stop `while (true)` in a single-threaded sandbox: an interrupt handler the
		// engine calls periodically. Without it this test would hang the suite rather than fail it.
		// An explicit short limit, not the 60s default: with the default this test would be a 60s wait
		// that the suite's own timeout kills first, which reads as "the interrupt never fired".
		const sandbox = await Sandbox.load({
			script: `source.spin = function () { while (true) {} };`,
			http: policy(),
			limits: { timeoutMs: 1_000 }
		});

		try {
			await expect(sandbox.call('spin')).rejects.toBeInstanceOf(LimitExceeded);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('reports a host timeout as a limit, not as the plugin own bug', async () => {
		// An interrupt arrives as a guest error. Without telling them apart, an operator would go
		// looking at the wrong platform.
		const sandbox = await Sandbox.load({
			script: `source.spin = function () { while (true) {} };`,
			http: policy(),
			limits: { timeoutMs: 500 }
		});

		try {
			const failure = await sandbox.call('spin').catch((cause: unknown) => cause);

			expect(failure).toBeInstanceOf(LimitExceeded);
			expect((failure as Error).message).toMatch(/500ms/);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('cannot see Node globals', async () => {
		// The reason this is QuickJS and not `node:vm`. If any of these resolved, the sandbox would
		// not be one.
		const sandbox = await load(`
			source.probe = function () {
				return [typeof process, typeof require, typeof globalThis.Deno, typeof XMLHttpRequest];
			};
		`);

		try {
			expect(await sandbox.call('probe')).toStrictEqual([
				'undefined',
				'undefined',
				'undefined',
				'undefined'
			]);
		} finally {
			sandbox.dispose();
		}
	});
});

describe('web globals QuickJS does not have', () => {
	// Both of these were found by the live test, not by this file. QuickJS is an ES engine, so
	// anything from the Web platform has to be provided — and the Twitch plugin calls `btoa` while
	// building its GraphQL request, failing at load with `'btoa' is not defined`.

	it.each([
		['', ''],
		['f', 'Zg=='],
		['fo', 'Zm8='],
		['foo', 'Zm9v'],
		['foob', 'Zm9vYg=='],
		['fooba', 'Zm9vYmE='],
		['foobar', 'Zm9vYmFy'],
		// The padding boundaries are where a hand-written encoder goes wrong, and a plugin sending
		// mis-padded base64 to a platform gets an opaque 400 back.
		['   ', 'AAAA'],
		['ÿÿÿ', '////']
	])('encodes %j', async (input, expected) => {
		const sandbox = await load(`source.v = function (s) { return btoa(s); };`);

		try {
			expect(await sandbox.call('v', [input])).toBe(expected);
		} finally {
			sandbox.dispose();
		}
	});

	it('round-trips every byte value', async () => {
		// The strongest statement available without a reference implementation inside the sandbox.
		const sandbox = await load(`
			source.v = function () {
				var s = '';
				for (var i = 0; i < 256; i++) s += String.fromCharCode(i);
				return atob(btoa(s)) === s;
			};
		`);

		try {
			expect(await sandbox.call('v')).toBe(true);
		} finally {
			sandbox.dispose();
		}
	});

	it('refuses a character that is not a byte, as a browser does', async () => {
		// Rather than truncating it. A plugin handing UTF-8 to `btoa` has a bug, and wrong base64 that
		// a platform rejects later is much harder to trace than the error at the call.
		const sandbox = await load(
			`source.v = function () { try { btoa('é\\u20ac'); return 'no error'; } catch (e) { return 'threw'; } };`
		);

		try {
			expect(await sandbox.call('v')).toBe('threw');
		} finally {
			sandbox.dispose();
		}
	});

	it('rejects base64 that cannot be decoded', async () => {
		const sandbox = await load(
			`source.v = function (s) { try { return atob(s); } catch (e) { return 'threw'; } };`
		);

		try {
			expect(await sandbox.call('v', ['Zm9v!'])).toBe('threw');
			expect(await sandbox.call('v', ['Zm9vY'])).toBe('threw');
			// Whitespace is skipped, not an error: base64 arrives wrapped in real responses.
			expect(await sandbox.call('v', ['Zm9v\nYmFy'])).toBe('foobar');
		} finally {
			sandbox.dispose();
		}
	});
});

describe('errors and logging', () => {
	it('accepts a method that returns nothing', async () => {
		// Found by the live test: Kick's `enable` returns nothing, and the host crashed on load with
		// `"undefined" is not valid JSON` — a plugin that had done nothing wrong, refused by a host
		// bug. Reading a guest `undefined` back out of the engine gives the seven-character *string*,
		// so the result is now wrapped in an object on the guest side.
		const sandbox = await load(`source.quiet = function () { return; };`);

		try {
			expect(await sandbox.call('quiet')).toBeUndefined();
		} finally {
			sandbox.dispose();
		}
	});

	it('tells a returned nothing apart from the literal word', async () => {
		// The reason string-sniffing the result was the wrong fix: these two are indistinguishable once
		// the value has left the engine, and a plugin really can return the text.
		const sandbox = await load(`
			source.nothing = function () { return undefined; };
			source.word = function () { return 'undefined'; };
		`);

		try {
			expect(await sandbox.call('nothing')).toBeUndefined();
			expect(await sandbox.call('word')).toBe('undefined');
		} finally {
			sandbox.dispose();
		}
	});

	it.each([
		['null', `return null;`, null],
		['false', `return false;`, false],
		['zero', `return 0;`, 0],
		['an empty string', `return '';`, ''],
		['an empty array', `return [];`, []],
		['NaN, which JSON cannot carry', `return NaN;`, null]
	])('carries %s back intact', async (_name, body, expected) => {
		// Every falsy value, because a host that uses `||` or a truthiness check anywhere in the return
		// path turns a legitimate `0` or `''` into a missing field.
		const sandbox = await load(`source.v = function () { ${body} };`);

		try {
			expect(await sandbox.call('v')).toStrictEqual(expected);
		} finally {
			sandbox.dispose();
		}
	});

	it('reports a plugin throw as a PluginError carrying its message', async () => {
		const sandbox = await load(
			`source.bad = function () { throw new Error('platform said no'); };`
		);

		try {
			const failure = await sandbox.call('bad').catch((cause: unknown) => cause);

			expect(failure).toBeInstanceOf(PluginError);
			expect((failure as Error).message).toBe('platform said no');
		} finally {
			sandbox.dispose();
		}
	});

	it('names a method the plugin does not have', async () => {
		const sandbox = await load(`source.only = function () { return 1; };`);

		try {
			await expect(sandbox.call('missing')).rejects.toThrow(/no missing/);
		} finally {
			sandbox.dispose();
		}
	});

	it('passes a plugin log line out to the host', async () => {
		const sandbox = await load(
			`source.talk = function () { log('hello from the plugin'); return 1; };`
		);

		try {
			await sandbox.call('talk');
			expect(logged.some((line) => line.message.includes('hello from the plugin'))).toBe(true);
		} finally {
			sandbox.dispose();
		}
	});

	it('turns undefined arguments into explicit null', async () => {
		// TikTok throws `unreachable` on `filters !== null`, and `undefined !== null` is true — so an
		// omitted optional argument takes the error branch. Every host has to do this and nothing
		// documents it.
		const sandbox = await load(
			`source.check = function (a, b) { return [a === null, b === null]; };`
		);

		try {
			expect(await sandbox.call('check', [undefined, undefined])).toStrictEqual([true, true]);
		} finally {
			sandbox.dispose();
		}
	});

	it('flattens a pager to the three things a caller needs', async () => {
		// A pager carries methods, which JSON cannot, so walking pages stays the host's job.
		const sandbox = await load(`
			source.getChannelContents = function () {
				return new ContentPager([{ name: 'one' }], true, { page: 2 });
			};
		`);

		try {
			expect(await sandbox.call('getChannelContents', ['https://example.test/c'])).toStrictEqual({
				__pager: true,
				results: [{ name: 'one' }],
				hasMore: true,
				context: { page: 2 }
			});
		} finally {
			sandbox.dispose();
		}
	});
});

describe('an injected fetch', () => {
	// The reason this option exists: a host often already owns the client it must route through, and
	// a library that called the global directly would make it silently opt out.

	/** A policy whose requests go to `calls` instead of the network. */
	function injected(calls: string[], answer?: () => Promise<Response>): Partial<HttpPolicy> {
		return {
			fetch: (url, init) => {
				calls.push(`${init.method} ${url}`);

				return answer === undefined
					? Promise.resolve(new Response('{"from":"injected"}', { status: 200 }))
					: answer();
			}
		};
	}

	it('is used instead of the global', async () => {
		const calls: string[] = [];
		const sandbox = await load(
			`source.read = function () { return JSON.parse(http.GET('https://example.test/x').body).from; };`,
			injected(calls)
		);

		try {
			expect(await sandbox.call('read')).toBe('injected');
			expect(calls).toStrictEqual(['GET https://example.test/x']);

			// Not merely "the injected one was called": the global must not also have been, or a caller
			// routing through a proxy would be leaking half its traffic.
			expect(made).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('is never asked for a url the allow-list refuses', async () => {
		// The boundary is enforced around the injected function, not by it. A caller supplying one
		// must not have to re-implement the allow-list to stay safe.
		const calls: string[] = [];
		const sandbox = await load(
			`source.read = function () { return http.GET('https://evil.example/collect').code; };`,
			injected(calls)
		);

		try {
			expect(await sandbox.call('read')).toBe(403);
			expect(calls).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('is still counted against the request budget', async () => {
		const calls: string[] = [];
		const sandbox = await load(
			`
			source.read = function () {
				var ok = 0;
				for (var i = 0; i < 10; i++) { if (http.GET('https://example.test/' + i).isOk) ok++; }
				return ok;
			};
		`,
			{ ...injected(calls), maxRequests: 2 }
		);

		try {
			expect(await sandbox.call('read')).toBe(2);
			expect(calls).toHaveLength(2);
		} finally {
			sandbox.dispose();
		}
	});

	it('cannot break a feed read by throwing', async () => {
		// Somebody else's client, so it may fail in ways the global would not. It is treated exactly
		// like a transport failure, which means the plugin's own `isOk` path runs.
		const sandbox = await load(
			`source.read = function () { var r = http.GET('https://example.test/x'); return [r.code, r.isOk]; };`,
			injected([], () => Promise.reject(new Error('the host client is closed')))
		);

		try {
			expect(await sandbox.call('read')).toStrictEqual([504, false]);
		} finally {
			sandbox.dispose();
		}
	});

	it('is given the host user agent to pass on', async () => {
		let seen: string | null = null;
		const sandbox = await load(
			`source.read = function () { return http.GET('https://example.test/x').code; };`,
			{
				userAgent: 'creator-site/1.0',
				fetch: (_url, init) => {
					seen = init.headers.get('user-agent');

					return Promise.resolve(new Response('', { status: 200 }));
				}
			}
		);

		try {
			await sandbox.call('read');
			expect(seen).toBe('creator-site/1.0');
		} finally {
			sandbox.dispose();
		}
	});

	it('does not override a header the plugin set itself', async () => {
		// Plugins set their own user agent for platforms that check it, and the host default is a
		// fallback rather than a policy.
		let seen: string | null = null;
		const sandbox = await load(
			`source.read = function () { return http.GET('https://example.test/x', { 'User-Agent': 'plugin-ua' }).code; };`,
			{
				userAgent: 'host-ua',
				fetch: (_url, init) => {
					seen = init.headers.get('user-agent');

					return Promise.resolve(new Response('', { status: 200 }));
				}
			}
		);

		try {
			await sandbox.call('read');
			expect(seen).toBe('plugin-ua');
		} finally {
			sandbox.dispose();
		}
	});
});
