/**
 * `URL` and `URLSearchParams`, from inside the sandbox.
 *
 * QuickJS has neither — they are Web platform APIs, not language ones — and four plugins in the
 * public index fail at load with `'URL' is not defined`.
 *
 * Parsing is the host's, through Node's own WHATWG parser, so these tests are not checking a parser
 * this file wrote. They check the two things that could be wrong here: that the components survive
 * the round trip, and that the guest's bookkeeping (mutation, `searchParams`, reserialising) agrees
 * with what a browser would do. The expected values are what the platform's own `URL` produces.
 */

import { describe, expect, it } from 'vitest';
import { parseUrl } from './url.js';
import { Sandbox } from './sandbox.js';

/** A sandbox with no network and no DOM: this is about URL alone. */
async function evaluate(body: string): Promise<unknown> {
	const sandbox = await Sandbox.load({
		script: `source.run = function () { ${body} };`,
		http: {
			allowUrls: [],
			timeoutMs: 1_000,
			maxRequests: 0,
			maxResponseBytes: 1024,
			userAgent: 'test-agent'
		},
		limits: { timeoutMs: 20_000 }
	});

	try {
		return await sandbox.call('run');
	} finally {
		sandbox.dispose();
	}
}

describe('parsing a url', () => {
	it('gives the components a plugin reads', async () => {
		expect(
			await evaluate(`
			var u = new URL('https://user:pw@www.example.com:8443/a/b?x=1&y=2#top');
			return {
				protocol: u.protocol, hostname: u.hostname, port: u.port, host: u.host,
				pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
				username: u.username, password: u.password
			};
		`)
		).toStrictEqual({
			protocol: 'https:',
			hostname: 'www.example.com',
			port: '8443',
			host: 'www.example.com:8443',
			pathname: '/a/b',
			search: '?x=1&y=2',
			hash: '#top',
			origin: 'https://www.example.com:8443',
			username: 'user',
			password: 'pw'
		});
	});

	it('resolves a relative reference against a base', async () => {
		// The case plugins need most: a link scraped out of a page is relative, and the page's own
		// address is what makes it absolute. Getting this wrong sends a plugin to the wrong place,
		// which looks like a platform returning nothing.
		expect(
			await evaluate(`
			return [
				new URL('/watch/1', 'https://example.com/a/b').href,
				new URL('c', 'https://example.com/a/b').href,
				new URL('../up', 'https://example.com/a/b/c').href,
				new URL('//other.example/x', 'https://example.com/a').href,
				new URL('https://absolute.example/y', 'https://example.com/a').href
			];
		`)
		).toStrictEqual([
			'https://example.com/watch/1',
			'https://example.com/a/c',
			// `/a/b/c`'s directory is `/a/b/`, so one level up is `/a/`. Checked against the platform's
			// own URL rather than reasoned about — my first guess here was `/up`, and it was wrong.
			'https://example.com/a/up',
			'https://other.example/x',
			'https://absolute.example/y'
		]);
	});

	it('drops a default port, as the platform does', async () => {
		expect(
			await evaluate(`
			var u = new URL('https://example.com:443/a');
			return [u.port, u.host, u.href];
		`)
		).toStrictEqual(['', 'example.com', 'https://example.com/a']);
	});

	it('throws a TypeError for something that is not a url', async () => {
		// A `TypeError` specifically, because that is what the platform throws and what a plugin's
		// own `catch` is written against.
		expect(
			await evaluate(`
			try { new URL('not a url'); return 'no error'; }
			catch (e) { return { type: e instanceof TypeError, message: e.message }; }
		`)
		).toStrictEqual({ type: true, message: "'not a url' is not a valid URL" });
	});

	it('stringifies back to its href', async () => {
		expect(
			await evaluate(`
			var u = new URL('https://example.com/a?x=1');
			return [String(u), u.toString(), JSON.stringify({ u: u })];
		`)
		).toStrictEqual([
			'https://example.com/a?x=1',
			'https://example.com/a?x=1',
			'{"u":"https://example.com/a?x=1"}'
		]);
	});
});

describe('changing a url', () => {
	it('re-parses through the host rather than patching the string', async () => {
		// Why it is a re-parse: assigning `port = ''` has to drop the port, and that is a rule of the
		// parser rather than of string concatenation.
		expect(
			await evaluate(`
			var u = new URL('https://example.com:8443/a');
			u.pathname = '/b';
			u.port = '';
			return u.href;
		`)
		).toBe('https://example.com/b');
	});

	it('ignores a component assignment that would make the url invalid', async () => {
		// What the platform does: assigning nonsense to `protocol` is a no-op, not an exception.
		expect(
			await evaluate(`
			var u = new URL('https://example.com/a');
			u.protocol = 'not a protocol';
			return u.href;
		`)
		).toBe('https://example.com/a');
	});

	it('shows a searchParams change in search and href', async () => {
		// The join a plugin relies on most: it builds a query through `searchParams` and then passes
		// `url.href` to `http.GET`. If the two were not connected the request would go out without
		// the query, and the platform would answer something unrelated.
		expect(
			await evaluate(`
			var u = new URL('https://example.com/api');
			u.searchParams.set('limit', '30');
			u.searchParams.append('tag', 'a b');
			return { search: u.search, href: u.href };
		`)
		).toStrictEqual({
			search: '?limit=30&tag=a+b',
			href: 'https://example.com/api?limit=30&tag=a+b'
		});
	});
});

describe('URLSearchParams', () => {
	it('builds from a plain object, which is how plugins use it', async () => {
		expect(
			await evaluate(`return new URLSearchParams({ a: '1', b: 'two words' }).toString();`)
		).toBe('a=1&b=two+words');
	});

	it('parses a query string with or without the question mark', async () => {
		expect(
			await evaluate(`
			return [
				new URLSearchParams('?a=1&b=2').get('a'),
				new URLSearchParams('a=1&b=2').get('b'),
				new URLSearchParams('a=one+two').get('a'),
				new URLSearchParams('a=%C3%A9').get('a')
			];
		`)
		).toStrictEqual(['1', '2', 'one two', 'é']);
	});

	it('gives null for a key it does not have, not undefined', async () => {
		// Plugins test `=== null`.
		expect(await evaluate(`return new URLSearchParams('a=1').get('b');`)).toBeNull();
	});

	it('keeps repeated keys and reads them all', async () => {
		expect(
			await evaluate(`
			var p = new URLSearchParams('t=a&t=b');
			return { all: p.getAll('t'), first: p.get('t'), size: p.size };
		`)
		).toStrictEqual({ all: ['a', 'b'], first: 'a', size: 2 });
	});

	it('set replaces every occurrence and keeps the first position', async () => {
		expect(
			await evaluate(`
			var p = new URLSearchParams('a=1&t=x&b=2&t=y');
			p.set('t', 'z');
			return p.toString();
		`)
		).toBe('a=1&t=z&b=2');
	});

	it('deletes, has, sorts and iterates', async () => {
		expect(
			await evaluate(`
			var p = new URLSearchParams('c=3&a=1&b=2');
			p['delete']('b');
			p.sort();
			var seen = [];
			p.forEach(function (value, name) { seen.push(name + '=' + value); });
			return { text: p.toString(), has: [p.has('a'), p.has('b')], seen: seen, entries: p.entries() };
		`)
		).toStrictEqual({
			text: 'a=1&c=3',
			has: [true, false],
			seen: ['a=1', 'c=3'],
			entries: [
				['a', '1'],
				['c', '3']
			]
		});
	});

	it('form-encodes a space as plus and escapes what encodeURIComponent leaves', async () => {
		// `application/x-www-form-urlencoded` is not `encodeURIComponent`: a space is `+`, and
		// `!'()~` are escaped. A platform parsing the query strictly rejects the other spelling.
		expect(await evaluate(`return new URLSearchParams({ q: "a b!'()~&=" }).toString();`)).toBe(
			'q=a+b%21%27%28%29%7E%26%3D'
		);
	});

	it('is iterable with for..of', async () => {
		expect(
			await evaluate(`
			var out = [];
			for (var pair of new URLSearchParams('a=1&b=2')) out.push(pair[0] + ':' + pair[1]);
			return out;
		`)
		).toStrictEqual(['a:1', 'b:2']);
	});
});

describe('the host side', () => {
	it('refuses a url longer than it will parse', () => {
		// A plugin can hand over anything, and a pathological input is the caller's memory.
		expect(parseUrl(`https://example.com/${'a'.repeat(100_000)}`)).toStrictEqual({
			error: 'the url is longer than this host will parse'
		});
	});

	it('does not pass a thrown message through', () => {
		// The message is this library's own sentence. A thrown value's message is not somewhere to
		// take text from, even when it is only `Invalid URL`.
		const answer = parseUrl('://nope');

		expect(answer).toHaveProperty('error');
		expect('error' in answer ? answer.error : '').not.toContain('TypeError');
	});

	it('treats an empty base as no base', () => {
		// `new URL(x, '')` would throw on the empty string rather than parsing `x` on its own.
		expect(parseUrl('https://example.com/a', '')).toHaveProperty('parts');
	});
});
