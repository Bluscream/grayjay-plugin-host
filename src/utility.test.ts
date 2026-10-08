/**
 * The `utility` globals, which plugins use to sign requests.
 *
 * The member names here were taken from what plugins actually call, not from the documentation.
 * That matters: this file previously provided a throwing `md5` stub that no plugin ever reached,
 * while every plugin wanting a digest called `md5String` and got `undefined is not a function`. A
 * stub for a name nobody uses is worse than nothing, because it reads as deliberate.
 *
 * The expected digests are the real ones, so a subtly wrong implementation fails here rather than
 * as a rejected signature against a platform with no indication that the hash was at fault.
 */

import { describe, expect, it } from 'vitest';
import { performHash } from './hash.js';
import { Sandbox } from './sandbox.js';

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

describe('utility.md5String', () => {
	it('computes the real digest', async () => {
		// Known values. BiliBili signs its API calls with this and YouTube fingerprints the player
		// script, so an implementation that is close is useless.
		expect(
			await evaluate(`return [utility.md5String(''), utility.md5String('abc')];`)
		).toStrictEqual(['d41d8cd98f00b204e9800998ecf8427e', '900150983cd24fb0d6963f7d28e17f72']);
	});

	it('hashes text as UTF-8', async () => {
		// Not Latin-1. The difference is invisible for ASCII and wrong for everything else, and a
		// platform doing the same hash on its side would disagree.
		expect(await evaluate(`return utility.md5String('ä');`)).toBe(
			'8419b71c87a225a2c70b50486fbee545'
		);
	});

	it('is also available as sha1 and sha256', async () => {
		expect(
			await evaluate(`return [utility.sha1String('abc'), utility.sha256String('abc')];`)
		).toStrictEqual([
			'a9993e364706816aba3e25717850c26c9cd0d89d',
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		]);
	});

	it('refuses an algorithm it does not have, by name', () => {
		// Rather than defaulting to another one. A plugin asking for a specific digest wants that
		// digest, and quietly substituting produces a value the platform rejects with no clue why.
		const answer = JSON.parse(performHash(JSON.stringify({ algorithm: 'md4', text: 'abc' }))) as {
			error?: string;
		};

		expect(answer.error).toContain("does not provide the 'md4' digest");
	});

	it('refuses input that is not a string', () => {
		expect(
			JSON.parse(performHash(JSON.stringify({ algorithm: 'md5', text: { a: 1 } })))
		).toHaveProperty('error');
	});

	it('refuses malformed JSON rather than throwing across the boundary', () => {
		// The guest controls this string.
		expect(JSON.parse(performHash('{not json'))).toHaveProperty('error');
	});
});

describe('utility.toBase64', () => {
	it('takes a byte array, which is how every plugin calls it', async () => {
		// `utility.toBase64(string_to_bytes(...))` is the shape in Crunchyroll, BiliBili and PHUB.
		expect(await evaluate(`return utility.toBase64([102, 111, 111, 98, 97, 114]);`)).toBe(
			'Zm9vYmFy'
		);
	});

	it('accepts a string too, treating it as one byte per character', async () => {
		expect(await evaluate(`return utility.toBase64('foobar');`)).toBe('Zm9vYmFy');
	});

	it('masks a value outside a byte rather than producing nonsense', async () => {
		// A plugin computing bytes arithmetically can overshoot. `& 255` is what a real byte array
		// would have held.
		expect(await evaluate(`return utility.toBase64([256 + 102, 111, 111]);`)).toBe('Zm9v');
	});

	it('handles the padding boundaries', async () => {
		expect(
			await evaluate(`
			return [utility.toBase64([102]), utility.toBase64([102, 111]), utility.toBase64([102, 111, 111])];
		`)
		).toStrictEqual(['Zg==', 'Zm8=', 'Zm9v']);
	});

	it('round-trips through fromBase64 as a byte array', async () => {
		// The one plugin using `fromBase64` spreads the result into `String.fromCharCode(...)`, which
		// a string would not survive meaningfully — so it has to be a real array.
		expect(
			await evaluate(`
			var bytes = utility.fromBase64('Zm9vYmFy');
			return { isArray: Array.isArray(bytes), text: String.fromCharCode.apply(null, bytes) };
		`)
		).toStrictEqual({ isArray: true, text: 'foobar' });
	});

	it('round-trips every byte value', async () => {
		expect(
			await evaluate(`
			var bytes = [];
			for (var i = 0; i < 256; i++) bytes.push(i);
			var back = utility.fromBase64(utility.toBase64(bytes));
			if (back.length !== 256) return 'length ' + back.length;
			for (var j = 0; j < 256; j++) if (back[j] !== j) return 'mismatch at ' + j;
			return 'identical';
		`)
		).toBe('identical');
	});
});

describe('the rest of utility', () => {
	it('converts between seconds and milliseconds', async () => {
		expect(
			await evaluate(`return [utility.fromMilliseconds(2500), utility.toMilliseconds(3)];`)
		).toStrictEqual([3, 3000]);
	});

	it('gives a uuid-shaped string', async () => {
		// Plugins use it for request correlation ids, so the shape is what matters rather than the
		// entropy — which is documented as not cryptographic.
		expect(String(await evaluate(`return utility.randomUUID();`))).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
		);
	});

	it('gives a different one each time', async () => {
		expect(await evaluate(`return utility.randomUUID() !== utility.randomUUID();`)).toBe(true);
	});
});
