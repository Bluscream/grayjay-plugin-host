/**
 * Run GrayJay source plugins outside the GrayJay app, on Node.
 *
 * GrayJay plugins are the maintained, community-and-FUTO-written readers for a long list of video
 * platforms. They are the reason the app keeps working when a platform changes something: the
 * official Twitch, YouTube and Kick plugins all had commits within days of this library's research.
 *
 * Until now the only hosts were `Grayjay.Engine` (C#) and the Android app (Kotlin). A search turned
 * up no JavaScript or Node host at all, which is why this exists.
 *
 * ```ts
 * import { loadPlugin } from 'grayjay-plugin-host';
 *
 * const plugin = await loadPlugin('https://plugins.grayjay.app/Kick/KickConfig.json');
 *
 * try {
 *   const channel = await plugin.call('getChannel', ['https://kick.com/someone']);
 *   const feed = await plugin.feed('https://kick.com/someone');
 *
 *   console.log(channel, feed.results.length);
 * } finally {
 *   plugin.dispose();
 * }
 * ```
 *
 * ### What this is not
 *
 * Not the GrayJay app, not affiliated with FUTO, and not a way to play media. It loads a plugin and
 * calls its methods. Playback, subtitles and DRM are the app's business.
 *
 * It is also **not a licence laundering device.** The official plugins are AGPL-3.0; this host is
 * MIT. Loading a plugin at run time does not make your program a derivative of it, but distributing
 * one does carry its licence — check before you bundle somebody's plugin into your product.
 *
 * ### Known limits, up front
 *
 * - **`HttpImp` cannot be provided.** TLS fingerprint impersonation needs a TLS stack that presents
 *   a browser's exact ClientHello; Node has no such thing. When a platform starts requiring it, its
 *   plugin stops working here and keeps working in the app.
 * - **A few plugins need browser APIs beyond `DOMParser`.** YouTube and TikTok drive a
 *   `JSDOM`/`CustomWindow` emulation to run the platform's own scripts. Nothing in a manifest
 *   declares that, so they fail when they reach it rather than being refused at load.
 * - **Script signatures are not verified.** The algorithm is undocumented, and a verification that
 *   is wrong is worse than none. Pin a version and record a hash of the script instead.
 * - **No platform login.** A plugin whose manifest declares `authentication` will load and run, and
 *   its signed-in features will return nothing. `manifest.authentication` says so before you call it.
 */

export {
	PACKAGES,
	PROVIDED,
	UnsupportedPlugin,
	allowsUrl,
	assertSupported,
	manifestSchema,
	parseManifest,
	unsupportedReasons
} from './manifest.js';
export type { Manifest, PackageName, RawManifest } from './manifest.js';

export { DEFAULT_DOM_LIMITS, DomRefused, DomSession } from './dom.js';
export type { DomLimits } from './dom.js';

export { HttpSession } from './http.js';
export type { FetchLike, HostRequest, HostResponse, HttpPolicy } from './http.js';

export { parseUrl } from './url.js';
export type { UrlAnswer, UrlParts } from './url.js';

export { DEFAULT_LIMITS, LimitExceeded, PluginError, Sandbox } from './sandbox.js';
export type { Limits, PluginLog, SandboxOptions } from './sandbox.js';

export { FEED_TYPES, negotiateFeed } from './feed.js';
export type { Feed, FeedType } from './feed.js';

export { loadPlugin, type LoadOptions, type Plugin } from './plugin.js';
