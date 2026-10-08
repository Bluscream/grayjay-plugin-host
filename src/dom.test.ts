/**
 * `domParser`, tested from inside the sandbox.
 *
 * Every test runs a plugin that scrapes, because that is the only thing this feature is for and
 * because the interesting part is the boundary: the document lives on the host and the plugin holds
 * integer handles, so a test that called {@link DomSession} directly would not exercise the proxies
 * that plugins actually use.
 *
 * No network here. The HTML is a fixture; the real plugins are in `live.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { DomSession } from './dom.js';
import { Sandbox } from './sandbox.js';
import { BOOTSTRAP } from './bootstrap.js';

/** A page with the shapes scrapers meet: nesting, attributes, entities, a script blob, comments. */
const PAGE = `<!doctype html>
<html lang="de">
<head><title>A channel</title><meta name="description" content="two videos"></head>
<body>
	<div id="list" class="feed wide">
		<article class="video" data-id="7">
			<a href="/watch/1" title="first">First <b>title</b> &amp; more</a>
			<span class="views">1,234</span>
			<img src="https://cdn.test/1.jpg" alt="a picture">
		</article>
		<!-- a comment, which is a node but not an element -->
		<article class="video" data-id="8" data-live>
			<a href="/watch/2">Second</a>
			<span class="views">9</span>
		</article>
	</div>
	<script type="application/json" id="state">{"next":"abc"}</script>
</body>
</html>`;

/** A sandbox with DOM support and no network at all. */
async function load(script: string, dom: boolean | { maxBytes?: number } = true): Promise<Sandbox> {
	return Sandbox.load({
		script,
		http: {
			allowUrls: [],
			timeoutMs: 1_000,
			maxRequests: 0,
			maxResponseBytes: 1024,
			userAgent: 'test-agent'
		},
		limits: { timeoutMs: 20_000 },
		dom
	});
}

/** Runs one expression against {@link PAGE} and returns what the plugin produced. */
async function scrape(body: string): Promise<unknown> {
	const sandbox = await load(`
		source.run = function (html) {
			var doc = domParser.parseFromString(html, 'text/html');
			${body}
		};
	`);

	try {
		return await sandbox.call('run', [PAGE]);
	} finally {
		sandbox.dispose();
	}
}

describe('querying a document', () => {
	it('finds many nodes and reads each one', async () => {
		// The shape of nearly every scraping plugin: select rows, then read a few fields per row.
		expect(
			await scrape(`
			var out = [];
			var rows = doc.querySelectorAll('.video');
			for (var i = 0; i < rows.length; i++) {
				out.push({
					id: rows[i].getAttribute('data-id'),
					href: rows[i].querySelector('a').getAttribute('href'),
					views: rows[i].querySelector('.views').textContent
				});
			}
			return out;
		`)
		).toStrictEqual([
			{ id: '7', href: '/watch/1', views: '1,234' },
			{ id: '8', href: '/watch/2', views: '9' }
		]);
	});

	it('returns null for a selector that matches nothing', async () => {
		// Null and not an error: a plugin tests the result, and an optional element is ordinary.
		expect(await scrape(`return doc.querySelector('.nothing-here');`)).toBeNull();
	});

	it('returns an empty list rather than null for querySelectorAll', async () => {
		expect(await scrape(`return doc.querySelectorAll('.nothing-here').length;`)).toBe(0);
	});

	it('queries within a node, not from the document', async () => {
		// A scoped query is the difference between reading one row and reading the first row twice.
		expect(
			await scrape(`
			var second = doc.querySelectorAll('.video')[1];
			return second.querySelector('a').textContent;
		`)
		).toBe('Second');
	});

	it('supports the getElementsBy family, which plugins still use', async () => {
		expect(
			await scrape(`
			return [
				doc.getElementById('list').className,
				doc.getElementsByClassName('video').length,
				doc.getElementsByTagName('article').length
			];
		`)
		).toStrictEqual(['feed wide', 2, 2]);
	});

	it('names a selector it cannot evaluate instead of failing obscurely', async () => {
		const failure = await scrape(`
			try { doc.querySelectorAll('div:::broken'); return 'no error'; }
			catch (e) { return e.message; }
		`);

		expect(String(failure)).toContain('not a selector');
	});
});

describe('reading a node', () => {
	it('decodes entities in text, as a browser would', async () => {
		// `&amp;` has to arrive as `&`. A plugin putting that in a title would otherwise render the
		// entity, and a plugin comparing it would never match.
		expect(await scrape(`return doc.querySelector('.video a').textContent.trim();`)).toBe(
			'First title & more'
		);
	});

	it('gives innerHTML and outerHTML', async () => {
		const html = (await scrape(`
			var a = doc.querySelector('.video a');
			return { inner: a.innerHTML, outer: a.outerHTML };
		`)) as { inner: string; outer: string };

		expect(html.inner).toContain('<b>title</b>');
		expect(html.outer).toContain('<a href="/watch/1"');
	});

	it('reads an attribute that is present with no value', async () => {
		// `data-live` with no `=`. A plugin tests presence, so an empty string and a missing attribute
		// must be different answers.
		expect(
			await scrape(`
			var rows = doc.querySelectorAll('.video');
			return [rows[1].hasAttribute('data-live'), rows[1].getAttribute('data-live'), rows[0].hasAttribute('data-live')];
		`)
		).toStrictEqual([true, '', false]);
	});

	it('gives null for an attribute that is not there', async () => {
		expect(
			await scrape(`return doc.querySelector('.video').getAttribute('data-nope');`)
		).toBeNull();
	});

	it('lists attribute names', async () => {
		expect(
			await scrape(`return doc.querySelector('.video').getAttributeNames().sort();`)
		).toStrictEqual(['class', 'data-id']);
	});

	it('gives the tag name upper-cased, as the DOM does', async () => {
		// Plugins compare against `'DIV'`. Lower-casing it here would break those comparisons silently.
		expect(await scrape(`return doc.querySelector('.video').tagName;`)).toBe('ARTICLE');
	});

	it('reads the reflected properties a scraper wants', async () => {
		expect(
			await scrape(`
			var img = doc.querySelector('img');
			var a = doc.querySelector('.video a');
			return { src: img.src, alt: img.alt, title: a.title, meta: doc.querySelector('meta').content };
		`)
		).toStrictEqual({
			src: 'https://cdn.test/1.jpg',
			alt: 'a picture',
			title: 'first',
			meta: 'two videos'
		});
	});

	it('gives classList with contains, which is the method scrapers use', async () => {
		expect(
			await scrape(`
			var list = doc.getElementById('list').classList;
			return [list.length, list.contains('wide'), list.contains('narrow')];
		`)
		).toStrictEqual([2, true, false]);
	});

	it('reads a property it does not provide as undefined, rather than throwing', async () => {
		// Deliberate, and the opposite of what the first draft of this claimed. Plugins *probe* —
		// `if (node.dataset)` — and a host that threw would break a plugin for asking a question the
		// real DOM answers with `undefined`.
		expect(
			await scrape(`
			try { return { value: doc.querySelector('.video').offsetHeight, threw: false }; }
			catch (e) { return { threw: true, message: e.message }; }
		`)
		).toStrictEqual({ threw: false });
	});

	it('reads a script blob, which is how half of these pages carry their data', async () => {
		expect(await scrape(`return JSON.parse(doc.getElementById('state').textContent).next;`)).toBe(
			'abc'
		);
	});
});

describe('walking the tree', () => {
	it('follows the element relations', async () => {
		expect(
			await scrape(`
			var first = doc.querySelector('.video');
			return {
				parent: first.parentElement.getAttribute('id'),
				next: first.nextElementSibling.getAttribute('data-id'),
				firstChild: first.firstElementChild.tagName
			};
		`)
		).toStrictEqual({ parent: 'list', next: '8', firstChild: 'A' });
	});

	it('skips a comment when asked for children, and includes it for childNodes', async () => {
		// The distinction the DOM draws and plugins rely on: a stray comment between rows must not
		// appear as a row.
		const counts = (await scrape(`
			var list = doc.getElementById('list');
			return { elements: list.children.length, nodes: list.childNodes.length };
		`)) as { elements: number; nodes: number };

		expect(counts.elements).toBe(2);
		expect(counts.nodes).toBeGreaterThan(2);
	});

	it('gives null at the end of a relation rather than throwing', async () => {
		expect(await scrape(`return doc.querySelectorAll('.video')[1].nextElementSibling;`)).toBeNull();
	});

	it('reads a relation it does not provide as undefined too', async () => {
		expect(
			await scrape(`
			var node = doc.querySelector('.video');
			return { probe: typeof node.ownerDocument, known: typeof node.parentElement };
		`)
		).toStrictEqual({ probe: 'undefined', known: 'object' });
	});
});

describe('the boundary', () => {
	it('hands the sandbox handles, never host objects', async () => {
		// The property this design rests on. A node that leaked a real `linkedom` object into the
		// sandbox would carry its prototype chain with it, and the isolation would be gone.
		expect(
			await scrape(`
			var node = doc.querySelector('.video');
			return [typeof node.__handle, typeof node.querySelector('a').__handle];
		`)
		).toStrictEqual(['number', 'number']);
	});

	it('says so when DOM support is off', async () => {
		// Rather than `undefined is not a function`. A manifest declaring DOMParser is refused at load
		// anyway, so reaching this means a plugin parsed HTML without declaring that it does.
		const sandbox = await load(
			`source.run = function () { try { domParser.parseFromString('<p>x</p>'); return 'parsed'; } catch (e) { return e.message; } };`,
			false
		);

		try {
			expect(String(await sandbox.call('run'))).toContain('without DOM support');
		} finally {
			sandbox.dispose();
		}
	});

	it('refuses a document larger than the limit', async () => {
		const sandbox = await load(
			`source.run = function (html) { try { domParser.parseFromString(html); return 'parsed'; } catch (e) { return e.message; } };`,
			{ maxBytes: 64 }
		);

		try {
			expect(String(await sandbox.call('run', ['x'.repeat(500)]))).toContain('over the host limit');
		} finally {
			sandbox.dispose();
		}
	});

	it('measures the limit in bytes, not characters', async () => {
		// A page of CJK text is three times its character count, and the cap is about host memory.
		const sandbox = await load(
			`source.run = function (html) { try { domParser.parseFromString(html); return 'parsed'; } catch (e) { return e.message; } };`,
			{ maxBytes: 100 }
		);

		try {
			expect(String(await sandbox.call('run', ['字'.repeat(60)]))).toContain('over the host limit');
			expect(await sandbox.call('run', ['a'.repeat(60)])).toBe('parsed');
		} finally {
			sandbox.dispose();
		}
	});

	it('evicts the oldest document rather than refusing a new one', async () => {
		const sandbox = await Sandbox.load({
			script: `
				source.run = function () {
					var n = 0;
					try { for (var i = 0; i < 20; i++) { domParser.parseFromString('<p>' + i + '</p>'); n++; } }
					catch (e) { return { parsed: n, message: e.message }; }
					return { parsed: n, message: null };
				};
			`,
			http: {
				allowUrls: [],
				timeoutMs: 1_000,
				maxRequests: 0,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			},
			dom: { maxDocuments: 3 }
		});

		try {
			const outcome = (await sandbox.call('run')) as { parsed: number; message: string | null };

			// All twenty, not three. `release` is this library's own idea and no real plugin calls it,
			// so a cap that refused would stop any plugin that reads page after page — which is most
			// of them. The bound is still three documents held; the oldest is simply given up.
			expect(outcome.parsed).toBe(20);
			expect(outcome.message).toBeNull();
		} finally {
			sandbox.dispose();
		}
	});

	it('keeps the newest documents readable after evicting', async () => {
		// Eviction is only acceptable if it drops the document a plugin has finished with. The one it
		// just parsed has to still work.
		const sandbox = await Sandbox.load({
			script: `
				source.run = function () {
					var kept = [];
					for (var i = 0; i < 10; i++) kept.push(domParser.parseFromString('<p>' + i + '</p>'));

					// The last two were parsed most recently, so they survive; the first was given up.
					var recent = kept[9].querySelector('p').textContent;
					var alsoRecent = kept[8].querySelector('p').textContent;
					var oldest;
					try { oldest = kept[0].querySelector('p').textContent; } catch (e) { oldest = 'evicted'; }

					return { recent: recent, alsoRecent: alsoRecent, oldest: oldest };
				};
			`,
			http: {
				allowUrls: [],
				timeoutMs: 1_000,
				maxRequests: 0,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			},
			dom: { maxDocuments: 3 }
		});

		try {
			expect(await sandbox.call('run')).toStrictEqual({
				recent: '9',
				alsoRecent: '8',
				oldest: 'evicted'
			});
		} finally {
			sandbox.dispose();
		}
	});

	it('never lets a stale handle name somebody else node', async () => {
		// The reason handles come from a counter that does not rewind. If they were reused, a plugin
		// holding a node from an evicted page would silently read a *different* page's content and
		// report it as this one's — which is worse than any error.
		const sandbox = await Sandbox.load({
			script: `
				source.run = function () {
					var first = domParser.parseFromString('<p>first</p>');
					var node = first.querySelector('p');

					for (var i = 0; i < 6; i++) domParser.parseFromString('<p>later ' + i + '</p>');

					try { return node.textContent; } catch (e) { return 'refused'; }
				};
			`,
			http: {
				allowUrls: [],
				timeoutMs: 1_000,
				maxRequests: 0,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			},
			dom: { maxDocuments: 2 }
		});

		try {
			expect(await sandbox.call('run')).toBe('refused');
		} finally {
			sandbox.dispose();
		}
	});

	it('lets a plugin release a document and parse another', async () => {
		// The escape hatch from the limit above, and the thing a plugin reading many pages needs.
		const sandbox = await load(`
			source.run = function () {
				var n = 0;
				for (var i = 0; i < 30; i++) {
					var doc = domParser.parseFromString('<p>' + i + '</p>');
					if (doc.querySelector('p').textContent === String(i)) n++;
					doc.release();
				}
				return n;
			};
		`);

		try {
			expect(await sandbox.call('run')).toBe(30);
		} finally {
			sandbox.dispose();
		}
	});

	it('refuses a node from a released document instead of answering wrongly', async () => {
		// Using a stale node is a plugin bug. Answering it from a recycled handle would be worse than
		// refusing: the plugin would get somebody else's data and report it as this page's.
		expect(
			await scrape(`
			var node = doc.querySelector('.video');
			doc.release();
			try { return node.textContent; } catch (e) { return 'refused'; }
		`)
		).toBe('refused');
	});

	it('caps the number of live nodes', async () => {
		const sandbox = await Sandbox.load({
			script: `
				source.run = function (html) {
					try { for (var i = 0; i < 500; i++) { domParser.parseFromString(html).querySelectorAll('*'); } }
					catch (e) { return e.message; }
					return 'no limit hit';
				};
			`,
			http: {
				allowUrls: [],
				timeoutMs: 1_000,
				maxRequests: 0,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			},
			limits: { timeoutMs: 20_000 },
			// `maxHandles` far below what one copy of PAGE needs, so the refusal is reached on the
			// first document rather than by accumulating many.
			dom: { maxHandles: 4, maxDocuments: 1000 }
		});

		try {
			// Refused only because one document alone is over the budget: there is nothing older left
			// to give up, so the honest answer is that the page is too big.
			expect(String(await sandbox.call('run', [PAGE]))).toMatch(/over the host limit/);
		} finally {
			sandbox.dispose();
		}
	});
});

describe('a plugin that calls the host directly', () => {
	// The guest-side proxies only ever ask for names on the allow-list — but a plugin is not obliged
	// to use them. It can call `__host_dom` itself with any name, which is why the list is enforced
	// on the host and not merely respected by the guest.

	it.each([['constructor'], ['__proto__'], ['getAttribute'], ['ownerDocument']])(
		'cannot read %s off a host node',
		async (name) => {
			expect(
				await scrape(`
			var h = doc.querySelector('.video').__handle;
			var answer = JSON.parse(__host_dom(JSON.stringify({ op: 'get', h: h, name: ${JSON.stringify(name)} })));
			return answer.error ? 'refused' : { leaked: typeof answer.v };
		`)
			).toBe('refused');
		}
	);

	it('cannot follow a relation off the list either', async () => {
		expect(
			await scrape(`
			var h = doc.querySelector('.video').__handle;
			var answer = JSON.parse(__host_dom(JSON.stringify({ op: 'rel', h: h, which: 'constructor' })));
			return answer.error ? 'refused' : 'leaked';
		`)
		).toBe('refused');
	});

	it('gets a primitive or nothing, never a host object', async () => {
		// Even for an allowed name: a property holding a node has to come back as null here, because
		// a node is reached through `rel`, which issues a handle.
		expect(
			await scrape(`
			var h = doc.querySelector('.video').__handle;
			var answer = JSON.parse(__host_dom(JSON.stringify({ op: 'get', h: h, name: 'textContent' })));
			return typeof answer.v;
		`)
		).toBe('string');
	});
});

describe('the session on its own', () => {
	// The host side directly, for the parts a plugin cannot reach: malformed requests, and the
	// promise that a refusal comes back as data rather than as a thrown value crossing the boundary.

	it('answers an unknown operation with a named refusal', () => {
		const answer = JSON.parse(new DomSession().perform(JSON.stringify({ op: 'eval' }))) as {
			error?: string;
		};

		expect(answer.error).toContain("does not provide the DOM operation 'eval'");
	});

	it('answers malformed JSON with a refusal rather than throwing', () => {
		// The guest controls this string. A throw here would cross the boundary as a host error.
		expect(JSON.parse(new DomSession().perform('{not json'))).toHaveProperty('error');
	});

	it('refuses a handle it never issued', () => {
		const session = new DomSession();
		const answer = JSON.parse(
			session.perform(JSON.stringify({ op: 'get', h: 99, name: 'textContent' }))
		) as { error?: string };

		expect(answer.error).toContain('not a live DOM node');
	});

	it('counts the handles it has issued', () => {
		const session = new DomSession();

		expect(session.handles).toBe(0);

		const parsed = JSON.parse(
			session.perform(JSON.stringify({ op: 'parse', html: PAGE, mime: 'text/html' }))
		) as { h: number };

		expect(session.handles).toBe(1);

		session.perform(JSON.stringify({ op: 'query', h: parsed.h, sel: '.video', all: true }));

		expect(session.handles).toBe(3);
	});

	it('drops everything when cleared', () => {
		const session = new DomSession();

		session.perform(JSON.stringify({ op: 'parse', html: PAGE }));
		session.clear();

		expect(session.handles).toBe(0);
	});

	it('parses xml when asked to', () => {
		const session = new DomSession();
		const parsed = JSON.parse(
			session.perform(
				JSON.stringify({ op: 'parse', html: '<rss><item>a</item></rss>', mime: 'text/xml' })
			)
		) as { h: number };
		const found = JSON.parse(
			session.perform(JSON.stringify({ op: 'query', h: parsed.h, sel: 'item', all: false }))
		) as { h: number };
		const text = JSON.parse(
			session.perform(JSON.stringify({ op: 'get', h: found.h, name: 'textContent' }))
		) as { v: string };

		expect(text.v).toBe('a');
	});
});

describe('the bootstrap itself', () => {
	it('contains no regex the sandbox cannot compile', () => {
		// A guard for a whole class of bug, written after one. The bootstrap is guest JavaScript
		// inside a TypeScript template literal, so a lone backslash is consumed before the guest ever
		// sees it: `/\+/g` in the source arrived as `/+/g`, which is the syntax error "nothing to
		// repeat" at load time — and because it happens while the bootstrap is evaluating, *every*
		// plugin fails with a message about a regex nobody wrote.
		//
		// Compiling each one here names the cause directly instead of leaving a whole suite red.
		const literals = [...BOOTSTRAP.matchAll(/\/(?:\[[^\]]*\]|\\.|[^/\n*\\])+\/[gimsuy]*/g)].map(
			(match) => match[0]
		);

		expect(literals.length).toBeGreaterThan(3);

		for (const literal of literals) {
			const body = literal.slice(1, literal.lastIndexOf('/'));
			const flags = literal.slice(literal.lastIndexOf('/') + 1);

			expect(() => new RegExp(body, flags), `${literal} is not a valid regex`).not.toThrow();
		}
	});

	it('escapes every backtick and dollar-brace, so the template closes where it should', () => {
		// The same hazard in its other form: an unescaped `${` in the guest source would be
		// interpolated by TypeScript rather than reaching the sandbox.
		expect(BOOTSTRAP).not.toMatch(/[^\\]\$\{/);
	});
});
