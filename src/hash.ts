/**
 * Digests for the sandbox, computed by the host.
 *
 * `utility.md5String` is used by eight plugins in the public index — BiliBili signs its API requests
 * with it, and YouTube fingerprints the player script — and QuickJS has no crypto of its own.
 *
 * Done on the host rather than in guest JavaScript for the same reason as `URL`: a hand-written MD5
 * is forty lines of bit twiddling whose failure mode is a subtly wrong digest, which a platform
 * rejects as a bad signature with no clue that the hash is at fault. Node's `crypto` is already
 * there and already correct.
 *
 * Synchronous work, so this is installed as an ordinary host function and not an asyncified one.
 *
 * **MD5 is here because plugins use it to sign requests to platforms that require MD5**, not because
 * it is a reasonable choice. Nothing in this library uses it for anything of its own.
 */

import { createHash } from 'node:crypto';

/** What a plugin may ask for. MD5 is what plugins actually use; the others cost nothing to allow. */
const ALGORITHMS = new Set(['md5', 'sha1', 'sha256', 'sha512']);

/** How much input one digest may be given. */
const MAX_LENGTH = 32 * 1024 * 1024;

/**
 * One guest request, as JSON in and JSON out.
 *
 * The same shape as the DOM and URL bridges: one installed function, one place where a
 * guest-supplied value is checked.
 */
export function performHash(request: string): string {
	try {
		const message = JSON.parse(request) as Record<string, unknown>;
		const algorithm = message.algorithm;
		const text = message.text;

		if (typeof algorithm !== 'string' || !ALGORITHMS.has(algorithm)) {
			// Named rather than defaulted to something. A plugin asking for an algorithm this does not
			// have wants that algorithm, and quietly giving it another one produces a digest the
			// platform will reject with no indication why.
			return JSON.stringify({
				error: `grayjay-plugin-host does not provide the '${String(algorithm)}' digest`
			});
		}

		if (typeof text !== 'string') return JSON.stringify({ error: 'the input must be a string' });

		if (text.length > MAX_LENGTH) {
			return JSON.stringify({ error: 'the input is longer than this host will hash' });
		}

		// UTF-8, which is what a platform's own signing does with the same string. `binary` would
		// differ for anything outside Latin-1 and the difference is invisible until a signature fails.
		return JSON.stringify({ hex: createHash(algorithm).update(text, 'utf8').digest('hex') });
	} catch {
		return JSON.stringify({ error: 'the host could not read that digest request' });
	}
}
