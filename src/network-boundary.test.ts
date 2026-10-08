/**
 * The two parts of the network boundary that a wildcard manifest makes load-bearing.
 *
 * Five plugins in the public index declare `allowUrls: ["everywhere"]`, and it means what it says.
 * Until that was recognised it was silently refusing every request those plugins made — no host ends
 * with `.everywhere` — so PeerTube and Bandcamp reported empty feeds that looked exactly like a
 * platform with nothing on it.
 *
 * Honouring it removes the allow-list as a bound for those plugins, which is fine on a desktop app
 * and not fine on a server: the interesting target then is not the public internet but
 * `169.254.169.254` and whatever else on the host's network answers without authentication because
 * nobody expected it to be reachable. Hence the second half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowsUrl, parseManifest, reachesAnywhere } from './manifest.js';
import { isPrivateHost } from './http.js';
import { Sandbox } from './sandbox.js';

const BASE = {
	id: 'test',
	name: 'Test',
	scriptUrl: './Script.js',
	sourceUrl: 'https://example.invalid/Config.json',
	packages: ['Http']
};

describe('the everywhere wildcard', () => {
	it.each([
		['everywhere, as PeerTube and Bandcamp declare it', ['everywhere']],
		['with surrounding space', ['  everywhere  ']],
		['in any case', ['Everywhere']],
		['a bare star', ['*']],
		// MediathekView's real manifest: named hosts and then the wildcard.
		['alongside named hosts', ['mediathekviewweb.de', 'akamaihd.net', 'everywhere']]
	])('allows any host when declared as %s', (_name, allow) => {
		expect(allowsUrl(allow, 'https://anything.example/x')).toBe(true);
		expect(allowsUrl(allow, 'http://other.example/y')).toBe(true);
	});

	it('still refuses a scheme that is not http', () => {
		// The one thing a wildcard must not reach. `file:` through this would be the host's disk, and
		// no manifest entry should be able to permit that.
		expect(allowsUrl(['everywhere'], 'file:///etc/passwd')).toBe(false);
		expect(allowsUrl(['everywhere'], 'data:text/plain,hello')).toBe(false);
		expect(allowsUrl(['everywhere'], 'not a url')).toBe(false);
	});

	it('does not treat a host merely containing the word as a wildcard', () => {
		// `everywhere.com` is an ordinary host name, not a declaration.
		expect(allowsUrl(['everywhere.com'], 'https://anything.example/x')).toBe(false);
		expect(allowsUrl(['everywhere.com'], 'https://everywhere.com/x')).toBe(true);
	});

	it('is reported on the manifest so a caller can refuse the plugin', () => {
		// Asked separately because it is a materially different proposition from a plugin that names
		// its hosts, and a caller running plugins on a server should be able to see it rather than
		// have it buried in a predicate.
		expect(reachesAnywhere(parseManifest({ ...BASE, allowUrls: ['everywhere'] }))).toBe(true);
		expect(reachesAnywhere(parseManifest({ ...BASE, allowUrls: ['*'] }))).toBe(true);
		expect(reachesAnywhere(parseManifest({ ...BASE, allowUrls: ['kick.com'] }))).toBe(false);
		expect(reachesAnywhere(parseManifest({ ...BASE, allowUrls: [] }))).toBe(false);
	});
});

describe('addresses that are not on the public internet', () => {
	it.each([
		['loopback', 'http://127.0.0.1/x'],
		['loopback, elsewhere in the range', 'http://127.1.2.3/x'],
		['localhost', 'http://localhost:8080/x'],
		['a subdomain of localhost', 'http://api.localhost/x'],
		// The one that matters most: instance credentials on every major cloud.
		['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
		['private, 10/8', 'http://10.0.0.5/x'],
		['private, 172.16/12', 'http://172.20.1.1/x'],
		['private, 192.168/16', 'http://192.168.1.108:3002/x'],
		['this network', 'http://0.0.0.0/x'],
		['carrier-grade NAT', 'http://100.70.0.1/x'],
		['multicast', 'http://239.1.1.1/x'],
		['IPv6 loopback', 'http://[::1]:9000/x'],
		['IPv6 unspecified', 'http://[::]/x'],
		['IPv6 unique-local', 'http://[fd00::1]/x'],
		['IPv6 link-local', 'http://[fe80::1]/x'],
		// The obvious way round a v4-only check.
		['IPv4 wearing an IPv6 hat', 'http://[::ffff:169.254.169.254]/x']
	])('refuses %s', (_name, url) => {
		expect(isPrivateHost(url)).toBe(true);
	});

	it.each([
		['an ordinary host', 'https://kick.com/x'],
		['a public address', 'https://1.1.1.1/x'],
		['a public address near a private range', 'https://172.32.0.1/x'],
		['another near miss', 'https://11.0.0.1/x'],
		['a host that merely starts with a private-looking label', 'https://10.example.com/x'],
		['a public IPv6 address', 'https://[2606:4700::1111]/x']
	])('allows %s', (_name, url) => {
		expect(isPrivateHost(url)).toBe(false);
	});
});

describe('a plugin allowed everywhere, in the sandbox', () => {
	let reached: string[];

	beforeEach(() => {
		reached = [];
		vi.stubGlobal('fetch', (input: unknown) => {
			reached.push(String(input));

			return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** A sandbox whose manifest allows everything. */
	async function load(script: string, allowPrivateHosts?: boolean): Promise<Sandbox> {
		return Sandbox.load({
			script,
			http: {
				allowUrls: ['everywhere'],
				timeoutMs: 1_000,
				maxRequests: 10,
				maxResponseBytes: 1024,
				userAgent: 'test-agent',
				...(allowPrivateHosts === undefined ? {} : { allowPrivateHosts })
			}
		});
	}

	it('reaches a public host it never named', async () => {
		// The behaviour the wildcard is for, and what PeerTube needs: it is federated, so the instance
		// a channel lives on cannot be in a fixed list.
		const sandbox = await load(
			`source.read = function () { return http.GET('https://some.instance.example/api/v1/videos').code; };`
		);

		try {
			expect(await sandbox.call('read')).toBe(200);
			expect(reached).toStrictEqual(['https://some.instance.example/api/v1/videos']);
		} finally {
			sandbox.dispose();
		}
	});

	it('is still refused a private address, and never reaches the network', async () => {
		// The request must not be made at all. A refusal the plugin sees as a 403 is not enough on
		// its own — what matters is that nothing left the process.
		const sandbox = await load(`
			source.read = function () {
				var out = [];
				var targets = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/', 'http://10.1.2.3/'];
				for (var i = 0; i < targets.length; i++) out.push(http.GET(targets[i]).code);
				return out;
			};
		`);

		try {
			expect(await sandbox.call('read')).toStrictEqual([403, 403, 403]);
			expect(reached).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('reaches a private address when the caller allows it deliberately', async () => {
		// A self-hosted instance on the same network is a real case, so this has to be possible — just
		// not the default.
		const sandbox = await load(
			`source.read = function () { return http.GET('http://192.168.1.50/api').code; };`,
			true
		);

		try {
			expect(await sandbox.call('read')).toBe(200);
			expect(reached).toStrictEqual(['http://192.168.1.50/api']);
		} finally {
			sandbox.dispose();
		}
	});

	it('refuses a private address even when the manifest names it outright', async () => {
		// Not only a wildcard problem. The unofficial TikTok plugin hardcodes its author's LAN
		// address, so a manifest naming a private host is a real thing that exists.
		const sandbox = await Sandbox.load({
			script: `source.read = function () { return http.GET('http://192.168.1.108:3002/x').code; };`,
			http: {
				allowUrls: ['192.168.1.108'],
				timeoutMs: 1_000,
				maxRequests: 10,
				maxResponseBytes: 1024,
				userAgent: 'test-agent'
			}
		});

		try {
			expect(await sandbox.call('read')).toBe(403);
			expect(reached).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('does not tell the plugin anything it did not already know', async () => {
		// The refusal names the host, which the plugin supplied, and nothing else. A message that
		// distinguished "private" from "not allowed" too finely would be a probe for what is reachable.
		const sandbox = await load(
			`source.read = function () { return http.GET('http://10.0.0.1/x').body; };`
		);

		try {
			const body = String(await sandbox.call('read'));

			expect(body).toContain('10.0.0.1');
			expect(body).not.toContain('allowPrivateHosts');
		} finally {
			sandbox.dispose();
		}
	});
});
