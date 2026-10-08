/**
 * Feed type negotiation — the undocumented item most likely to be mistaken for a broken platform.
 *
 * The plugins here are small, but their *behaviour* is copied from the real ones: YouTube throwing
 * `Unsupported type: MIXED`, TikTok accepting only `MIXED` while its own `getChannelCapabilities`
 * advertises `VIDEOS`, and the simplest plugins taking no type argument at all. Those three shapes
 * are the reason `negotiateFeed` exists, so they are what it is tested against.
 */

import { describe, expect, it, vi } from 'vitest';
import { negotiateFeed } from './feed.js';
import { PluginError, Sandbox } from './sandbox.js';

/** A sandbox over `script`, with no network: these plugins answer from their own code. */
async function load(script: string): Promise<Sandbox> {
	return Sandbox.load({
		script,
		http: {
			allowUrls: [],
			timeoutMs: 1_000,
			maxRequests: 0,
			maxResponseBytes: 1024,
			userAgent: 'test-agent'
		},
		limits: { timeoutMs: 10_000 }
	});
}

/** Runs `body` against a sandbox and disposes it, which is not optional: it holds a WASM heap. */
async function withPlugin(
	script: string,
	body: (sandbox: Sandbox) => Promise<void>
): Promise<void> {
	const sandbox = await load(script);

	try {
		await body(sandbox);
	} finally {
		sandbox.dispose();
	}
}

/** Records every `(method, type)` a plugin was asked for, so the attempt order is assertable. */
const RECORDER = `
	globalThis.asked = [];
	function record(type) { globalThis.asked.push(type === null ? '(none)' : type); }
	source.askedTypes = function () { return globalThis.asked; };
`;

describe('a plugin that accepts the first type it claims', () => {
	const script = `
		${RECORDER}
		source.getChannelCapabilities = function () { return { types: ['VIDEOS'] }; };
		source.getChannelContents = function (url, type) {
			record(type);
			if (type !== 'VIDEOS') throw new Error('Unsupported type: ' + type);
			return new ContentPager([{ id: 1 }], true, { page: 2 });
		};
	`;

	it('is asked once and for what it claimed', async () => {
		// The reason the declared list is used at all: believing it costs nothing when it is right, and
		// one call beats three.
		await withPlugin(script, async (sandbox) => {
			const feed = await negotiateFeed(sandbox, 'https://example.test/c');

			expect(feed.type).toBe('VIDEOS');
			expect(feed.results).toStrictEqual([{ id: 1 }]);
			expect(feed.hasMore).toBe(true);
			expect(feed.context).toStrictEqual({ page: 2 });
			expect(feed.refused).toStrictEqual([]);
			expect(await sandbox.call('askedTypes')).toStrictEqual(['VIDEOS']);
		});
	});
});

describe('a plugin whose declared capabilities are wrong', () => {
	// TikTok, exactly: `getChannelCapabilities()` returns `["VIDEOS","MIXED","LIVE"]` and the plugin
	// then throws `unreachable` for `VIDEOS`. This is why the declared list is an order and not a
	// contract — a host that trusted it would report an empty feed for every TikTok channel.
	const script = `
		${RECORDER}
		source.getChannelCapabilities = function () { return { types: ['VIDEOS', 'MIXED', 'LIVE'] }; };
		source.getChannelContents = function (url, type) {
			record(type);
			if (type !== 'MIXED') throw 'unreachable';
			return new ContentPager([{ id: 'tiktok' }], false, {});
		};
	`;

	it('tries past the refusal and succeeds', async () => {
		await withPlugin(script, async (sandbox) => {
			const feed = await negotiateFeed(sandbox, 'https://example.test/@someone');

			expect(feed.type).toBe('MIXED');
			expect(feed.results).toStrictEqual([{ id: 'tiktok' }]);
		});
	});

	it('reports what it tried, so the next page can skip the dead end', async () => {
		// `type` on the result is not a curiosity: a caller walking pages should reuse it rather than
		// pay the failed attempt again for every page.
		await withPlugin(script, async (sandbox) => {
			const feed = await negotiateFeed(sandbox, 'https://example.test/@someone');

			expect(feed.refused.map((entry) => entry.type)).toStrictEqual(['VIDEOS']);
			expect(feed.refused[0]?.reason).toMatch(/unreachable/);
			expect(await sandbox.call('askedTypes')).toStrictEqual(['VIDEOS', 'MIXED']);
		});
	});
});

describe('a plugin that refuses MIXED', () => {
	it('gets past it, which is what YouTube needs', async () => {
		// YouTube throws `Unsupported type: MIXED` — the message `isWrongType` was written for.
		await withPlugin(
			`
			${RECORDER}
			source.getChannelContents = function (url, type) {
				record(type);
				if (type === 'MIXED') throw new Error('Unsupported type: MIXED');
				return new ContentPager([{ id: 'yt' }], false, {});
			};
		`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c');

				expect(feed.type).toBe('VIDEOS');
			}
		);
	});
});

describe('a plugin that takes no type at all', () => {
	it('is reached, because null is always tried last', async () => {
		// Several simple plugins treat any argument as a filter they do not understand. "Ask for
		// nothing" has to be a real option or those plugins can never be read.
		await withPlugin(
			`
			${RECORDER}
			source.getChannelContents = function (url, type) {
				record(type);
				if (type !== null) throw new Error('invalid type');
				return [{ id: 'plain' }];
			};
		`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c');

				expect(feed.type).toBeNull();
				expect(feed.results).toStrictEqual([{ id: 'plain' }]);
				expect(await sandbox.call('askedTypes')).toStrictEqual([
					'VIDEOS',
					'MIXED',
					'STREAMS',
					'LIVE',
					'POSTS',
					'(none)'
				]);
			}
		);
	});

	it('is accepted when it returns a bare array rather than a pager', async () => {
		await withPlugin(
			`source.getChannelContents = function () { return [{ id: 1 }, { id: 2 }]; };`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c');

				expect(feed.results).toHaveLength(2);
				expect(feed.hasMore).toBe(false);
			}
		);
	});
});

describe('a failure that is not a wrong type', () => {
	it('is re-thrown rather than retried', async () => {
		// The judgement call in this module. Treating an unrecognised failure as "try the next type"
		// would turn a real bug — a platform outage, a parser error, a missing cookie — into an empty
		// feed, which is the single most misleading thing a reader can report.
		await withPlugin(
			`
			${RECORDER}
			source.getChannelContents = function (url, type) {
				record(type);
				throw new Error('the platform returned 503');
			};
		`,
			async (sandbox) => {
				await expect(negotiateFeed(sandbox, 'https://example.test/c')).rejects.toThrow(/503/);

				// Once, not six times: a failing platform must not be hammered by the retry loop.
				expect(await sandbox.call('askedTypes')).toStrictEqual(['VIDEOS']);
			}
		);
	});

	it.each([
		['Unsupported type: MIXED', true],
		['unreachable', true],
		['Invalid type', true],
		['invalid ordering', true],
		['that is not supported here', true],
		['the platform returned 503', false],
		['Cannot read property of undefined', false],
		['', false]
	])('classifies %j as retryable=%s', async (message, retryable) => {
		// Message matching is the only signal a plugin gives — these are `throw new Error(…)` from
		// plugin code with no type to switch on — so the boundary between the two sets is asserted
		// directly rather than left to the cases above.
		await withPlugin(
			`
			source.getChannelCapabilities = function () { return { types: ['VIDEOS'] }; };
			source.getChannelContents = function (url, type) {
				if (type === 'VIDEOS') throw new Error(${JSON.stringify(message)});
				return [{ id: 'fallback' }];
			};
		`,
			async (sandbox) => {
				const outcome = await negotiateFeed(sandbox, 'https://example.test/c').then(
					(feed) => feed.results,
					(cause: unknown) => cause
				);

				if (retryable) {
					expect(outcome).toStrictEqual([{ id: 'fallback' }]);
				} else {
					expect(outcome).toBeInstanceOf(PluginError);
				}
			}
		);
	});
});

describe('when every type is refused', () => {
	it('says so and lists what was tried', async () => {
		// A real answer, not a crash: this plugin cannot read this channel the way this host asks. The
		// list is the whole diagnostic value — without it an operator has nothing to report upstream.
		await withPlugin(
			`source.getChannelContents = function (url, type) { throw new Error('Unsupported type: ' + type); };`,
			async (sandbox) => {
				const failure = await negotiateFeed(sandbox, 'https://example.test/c').catch(
					(cause: unknown) => cause
				);

				expect(failure).toBeInstanceOf(PluginError);

				const message = (failure as Error).message;

				expect(message).toMatch(/refused every feed type/);
				for (const type of ['VIDEOS', 'MIXED', 'STREAMS', 'LIVE', 'POSTS', '(none)']) {
					expect(message).toContain(type);
				}
			}
		);
	});
});

describe('which method to call', () => {
	it('prefers getChannelContents, which is what plugins implement', async () => {
		await withPlugin(
			`
			source.getChannelContents = function () { return [{ from: 'contents' }]; };
			source.getChannelVideos = function () { return [{ from: 'videos' }]; };
		`,
			async (sandbox) => {
				expect((await negotiateFeed(sandbox, 'https://example.test/c')).results).toStrictEqual([
					{ from: 'contents' }
				]);
			}
		);
	});

	it('falls back to getChannelVideos, which is what the documentation says', async () => {
		// `plugin.d.ts` is out of date. Both spellings exist in the wild, so both are tried.
		await withPlugin(
			`source.getChannelVideos = function () { return [{ from: 'videos' }]; };`,
			async (sandbox) => {
				expect((await negotiateFeed(sandbox, 'https://example.test/c')).results).toStrictEqual([
					{ from: 'videos' }
				]);
			}
		);
	});

	it('names the methods a plugin does have when it has neither', async () => {
		// Rather than "undefined is not a function". A plugin with a different interface is a thing a
		// caller can act on; a stack trace from inside the sandbox is not.
		await withPlugin(`source.getHome = function () { return []; };`, async (sandbox) => {
			await expect(negotiateFeed(sandbox, 'https://example.test/c')).rejects.toThrow(/getHome/);
		});
	});

	it('uses the method the caller names, without probing', async () => {
		await withPlugin(
			`
			source.getChannelContents = function () { return [{ from: 'contents' }]; };
			source.getChannelPlaylists = function () { return [{ from: 'playlists' }]; };
		`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c', {
					method: 'getChannelPlaylists'
				});

				expect(feed.results).toStrictEqual([{ from: 'playlists' }]);
			}
		);
	});
});

describe('the advisory capability call', () => {
	it('is ignored when it throws, rather than failing the whole read', async () => {
		// Its only use is to order the attempts. Several plugins do not implement it, and one that
		// throws should not cost the caller a feed it could otherwise have had.
		await withPlugin(
			`
			source.getChannelCapabilities = function () { throw new Error('not implemented'); };
			source.getChannelContents = function () { return [{ id: 1 }]; };
		`,
			async (sandbox) => {
				expect((await negotiateFeed(sandbox, 'https://example.test/c')).results).toHaveLength(1);
			}
		);
	});

	it.each([
		['a bare array instead of an object', `return ['VIDEOS'];`],
		['null', `return null;`],
		['types as a string', `return { types: 'VIDEOS' };`],
		['numbers in the list', `return { types: [1, 2] };`]
	])('survives %s', async (_name, body) => {
		// Nothing validates what a plugin returns here, so every malformed shape has to be a non-event.
		await withPlugin(
			`
			source.getChannelCapabilities = function () { ${body} };
			source.getChannelContents = function (url, type) {
				if (type !== 'MIXED') throw new Error('Unsupported type');
				return [{ id: 'ok' }];
			};
		`,
			async (sandbox) => {
				expect((await negotiateFeed(sandbox, 'https://example.test/c')).type).toBe('MIXED');
			}
		);
	});

	it('ignores a type it does not know, rather than passing it on', async () => {
		// A plugin advertising a type outside `FEED_TYPES` would otherwise be sent back a string this
		// host never validated. Upstream adding a type should be a no-op here, not a new code path.
		await withPlugin(
			`
			${RECORDER}
			source.getChannelCapabilities = function () { return { types: ['HOLOGRAMS', 'POSTS'] }; };
			source.getChannelContents = function (url, type) {
				record(type);
				if (type !== 'POSTS') throw new Error('Unsupported type');
				return [{ id: 'ok' }];
			};
		`,
			async (sandbox) => {
				await negotiateFeed(sandbox, 'https://example.test/c');
				expect(await sandbox.call('askedTypes')).toStrictEqual(['POSTS']);
			}
		);
	});
});

describe('the ordering argument', () => {
	it('reaches the plugin as the human string it compares against', async () => {
		// `Type.Order.Chronological` is `"Latest releases"`, not a constant name. A plugin given the
		// wrong spelling throws `invalid ordering` from inside the feed call.
		await withPlugin(
			`
			source.getChannelContents = function (url, type, order) { return [{ order: order }]; };
		`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c', {
					order: 'Latest releases'
				});

				expect(feed.results).toStrictEqual([{ order: 'Latest releases' }]);
			}
		);
	});

	it('is an explicit null when the caller names none', async () => {
		// Not `undefined`: a plugin testing `order !== null` would take the error branch.
		await withPlugin(
			`source.getChannelContents = function (url, type, order, filters) { return [[order, filters]]; };`,
			async (sandbox) => {
				const feed = await negotiateFeed(sandbox, 'https://example.test/c');

				expect(feed.results).toStrictEqual([[null, null]]);
			}
		);
	});
});

describe('the sandbox contract this module relies on', () => {
	it('does not swallow a host limit as a wrong type', async () => {
		// `LimitExceeded` is not a `PluginError`, so the retry loop must let it through. If it did not,
		// a plugin that hangs would be tried six times and the caller would wait six timeouts.
		const sandbox = await Sandbox.load({
			script: `source.getChannelContents = function () { while (true) {} };`,
			http: {
				allowUrls: [],
				timeoutMs: 500,
				maxRequests: 0,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			},
			limits: { timeoutMs: 700 }
		});

		try {
			const started = Date.now();

			await expect(negotiateFeed(sandbox, 'https://example.test/c')).rejects.toThrow(/stopped/);

			// Comfortably under two attempts' worth, which is what distinguishes "let it through" from
			// "retried and happened to fail the same way".
			expect(Date.now() - started).toBeLessThan(1_400);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('passes the channel url through unchanged', async () => {
		// Plugins run their own `isChannelUrl` on it and refuse anything they did not produce, so a
		// host that normalised the url would break channels that work in the app.
		const url = 'https://example.test/@someone?lang=de#top';

		await withPlugin(
			`source.getChannelContents = function (u) { return [{ u: u }]; };`,
			async (sandbox) => {
				expect((await negotiateFeed(sandbox, url)).results).toStrictEqual([{ u: url }]);
			}
		);
	});
});

describe('vi.useFakeTimers is not needed here', () => {
	it('confirms no test above left timers faked', () => {
		// A guard, because a faked clock would silently break the deadline assertions above — the
		// interrupt handler compares `Date.now()`.
		expect(vi.isFakeTimers()).toBe(false);
	});
});
