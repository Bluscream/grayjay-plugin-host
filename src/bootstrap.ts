/**
 * The host surface, as JavaScript that runs *inside* the sandbox.
 *
 * ### Why this is a string of JavaScript and not host bindings
 *
 * The alternative is building every object with `quickjs-emscripten` handles — `newObject`,
 * `setProp`, `dispose` — which for a surface this size is several hundred lines of handle juggling
 * where one missed `dispose` is a leak and one wrong lifetime is a crash. Here the host exposes
 * exactly two primitives (`__host_http`, `__host_log`), both taking and returning JSON strings, and
 * everything a plugin actually touches is plain JavaScript written once and readable as itself.
 *
 * It also means the data-carrier classes behave the way plugins expect: they are real constructors
 * the plugin can `instanceof`, subclass and read back, which host-built objects are awkward about.
 *
 * ### The nine things that are not documented anywhere
 *
 * `plugin.d.ts` in the official plugin repositories documents the `source` interface and the data
 * classes. It does not document the globals, and it is out of date. Each item below cost a failed
 * run against a real plugin, and each one is why this file exists rather than being guessed at:
 *
 * 1. **`IS_TESTING` must exist.** YouTube and TikTok read it at load time and throw on `undefined`.
 *    `false` is the production value.
 * 2. **`setTimeout` must exist.** YouTube refuses to start: "Please update Grayjay, missing
 *    setTimeout".
 * 3. **`http.batch()` must be a chainable builder** — `batch = batch.GET(…)`, `batch.DUMMY()`,
 *    `batch.execute()`. `DUMMY` queues a placeholder so a destructured result array keeps its
 *    positions when a request is skipped, and its mere presence is a feature probe:
 *    `canBatchDummy = !!batch.DUMMY`.
 * 4. **`http.getDefaultClient()` must return a client carrying a `clientId`.** TikTok throws
 *    "missing http client id" without one.
 * 5. **`Language` must exist** as an enum. YouTube builds a lookup table from it at load time.
 * 6. **A plugin may declare its own `const source = {…}`** rather than assigning to an injected
 *    one. That is a lexical binding, never a property of the global — see `sandbox.ts`, which
 *    evaluates the *name* `source` instead of reading the property.
 * 7. **Optional arguments must be passed as explicit `null`.** TikTok throws `unreachable` on
 *    `filters !== null`, and `undefined !== null`.
 * 8. **`Type.Order` values are human strings**, not screaming snake case. `Chronological` is
 *    `"Latest releases"`. This is not a guess: the TikTok plugin ships
 *    `Type.Order.Chronological = "Latest releases"` as a shim for older hosts, so its own
 *    comparisons are the authority. With the wrong values a plugin loads, runs, and throws
 *    `invalid ordering` from inside a feed call — which reads as a broken platform.
 * 9. **The feed type has to be negotiated, not chosen.** YouTube throws `Unsupported type: MIXED`;
 *    TikTok accepts nothing else. And the declared capability list cannot be trusted on its own,
 *    because TikTok declares `VIDEOS` and then refuses it. See `feed.ts`.
 */

/**
 * The bootstrap source.
 *
 * Evaluated in the sandbox before the plugin script, with `__host_http` and `__host_log` already
 * installed. Written as a single string rather than a separate `.js` asset so that a consumer gets
 * it from the package's own bundle with no file resolution at run time — which matters when this is
 * imported from a bundled server.
 */
export const BOOTSTRAP = /* js */ `
(function () {
	'use strict';

	// ── 1. IS_TESTING ────────────────────────────────────────────────────────────────────────
	// Read at load time by YouTube and TikTok, which throw on undefined.
	globalThis.IS_TESTING = false;

	// ── 2. setTimeout ────────────────────────────────────────────────────────────────────────
	// YouTube refuses to start without it. QuickJS has no timers of its own.
	//
	// Deliberately immediate rather than queued: there is no event loop in here to drain, and a
	// plugin's use of setTimeout is a yield rather than a real delay. A delayed callback that never
	// ran would hang a feed call; one that runs at once is at worst surprising ordering, which is
	// what the app's single-threaded plugin context does anyway.
	globalThis.setTimeout = function (fn, _ms) {
		if (typeof fn === 'function') { try { fn(); } catch (e) { __host_log(JSON.stringify({ level: 'warn', message: 'setTimeout callback threw: ' + (e && e.message) })); } }
		return 0;
	};
	globalThis.clearTimeout = function () {};
	globalThis.setInterval = function () { return 0; };
	globalThis.clearInterval = function () {};

	function request(method, url, headers, body) {
		var answer = __host_http(JSON.stringify({
			method: method,
			url: String(url),
			headers: headers || {},
			body: body === undefined || body === null ? undefined : String(body)
		}));

		var parsed = JSON.parse(answer);

		// The response shape plugins read. \`code\` is the real HTTP status — see http.ts.
		return {
			code: parsed.code,
			body: parsed.body,
			isOk: parsed.isOk,
			headers: parsed.headers,
			url: String(url)
		};
	}

	// ── 3 & 4. the http global ───────────────────────────────────────────────────────────────
	function makeClient(id, auth) {
		var client = {
			// 4. TikTok throws "missing http client id" without this.
			clientId: id,
			isLoggedIn: false,
			auth: !!auth,

			// \`useAuth\` is accepted and ignored: this host holds no platform session, so there is no
			// authenticated client to route to. A plugin that needs one is a plugin whose manifest
			// declares \`authentication\`, which is a caller's concern rather than something to fake here.
			GET: function (url, headers) { return request('GET', url, headers, undefined); },
			POST: function (url, body, headers) { return request('POST', url, headers, body); },
			PUT: function (url, body, headers) { return request('PUT', url, headers, body); },
			PATCH: function (url, body, headers) { return request('PATCH', url, headers, body); },
			DELETE: function (url, headers) { return request('DELETE', url, headers, undefined); },
			HEAD: function (url, headers) { return request('HEAD', url, headers, undefined); },

			// Some plugins set these; they are accepted and ignored rather than being a missing method.
			setDefaultHeaders: function () { return client; },
			clearDefaultHeaders: function () { return client; },
			setDoApplyCookies: function () { return client; },
			setDoAllowNewCookies: function () { return client; },
			setDoUpdateCookies: function () { return client; },

			batch: function () { return makeBatch(client); },
			requestWithBody: function (method, url, body, headers) { return request(method, url, headers, body); },
			request: function (method, url, headers) { return request(method, url, headers, undefined); }
		};

		return client;
	}

	// 3. A chainable builder. Every method returns the batch so \`batch = batch.GET(…)\` works, and
	//    DUMMY queues a placeholder so destructuring keeps its positions.
	function makeBatch(client) {
		var queued = [];

		var batch = {
			GET: function (url, headers) { queued.push({ kind: 'req', method: 'GET', url: url, headers: headers }); return batch; },
			POST: function (url, body, headers) { queued.push({ kind: 'req', method: 'POST', url: url, headers: headers, body: body }); return batch; },
			HEAD: function (url, headers) { queued.push({ kind: 'req', method: 'HEAD', url: url, headers: headers }); return batch; },
			DUMMY: function () { queued.push({ kind: 'dummy' }); return batch; },
			request: function (method, url, headers) { queued.push({ kind: 'req', method: method, url: url, headers: headers }); return batch; },
			requestWithBody: function (method, url, body, headers) { queued.push({ kind: 'req', method: method, url: url, headers: headers, body: body }); return batch; },

			execute: function () {
				var out = [];

				for (var i = 0; i < queued.length; i++) {
					var item = queued[i];

					if (item.kind === 'dummy') {
						// A placeholder, so a plugin that skipped one request still destructures the rest
						// into the right variables.
						out.push({ code: 0, body: '', isOk: false, headers: {}, url: '' });
						continue;
					}

					out.push(request(item.method, item.url, item.headers, item.body));
				}

				queued = [];

				return out;
			}
		};

		// Sequential, not parallel. The host could run these concurrently, but a plugin's batch is
		// usually a page of related requests against one platform and firing them at once is how a
		// host gets a source rate-limited. Correctness over throughput; see the README.
		return batch;
	}

	var defaultClient = makeClient('default', false);
	var authClient = makeClient('auth', true);

	globalThis.http = {
		GET: defaultClient.GET,
		POST: defaultClient.POST,
		PUT: defaultClient.PUT,
		PATCH: defaultClient.PATCH,
		DELETE: defaultClient.DELETE,
		HEAD: defaultClient.HEAD,
		request: defaultClient.request,
		requestWithBody: defaultClient.requestWithBody,

		batch: function () { return makeBatch(defaultClient); },

		// 4. Must carry a clientId.
		getDefaultClient: function (auth) { return auth ? authClient : defaultClient; },
		getAuthClient: function () { return authClient; },

		// A plugin that asks for an impersonating client gets the ordinary one and a warning rather
		// than a missing method. Manifests that *require* HttpImp are refused in manifest.ts; this is
		// for the ones where it is an opt-in setting, like Kick's.
		getHttpImpClient: function () {
			__host_log(JSON.stringify({ level: 'warn', message: 'this plugin asked for an impersonating HTTP client; it got an ordinary one, and the platform may block it' }));
			return defaultClient;
		},
		socket: function () { throw new Error('grayjay-plugin-host does not provide websockets'); }
	};

	// ── log and bridge ───────────────────────────────────────────────────────────────────────
	globalThis.log = function (message) {
		__host_log(JSON.stringify({ level: 'info', message: typeof message === 'string' ? message : JSON.stringify(message) }));
	};
	globalThis.console = {
		log: globalThis.log, info: globalThis.log, debug: globalThis.log,
		warn: function (m) { __host_log(JSON.stringify({ level: 'warn', message: String(m) })); },
		error: function (m) { __host_log(JSON.stringify({ level: 'error', message: String(m) })); }
	};

	globalThis.bridge = {
		log: globalThis.log,
		toast: function () {},
		devSubmit: function () {},
		isLoggedIn: function () { return false; },
		throwTestException: function () { throw new Error('test exception'); },
		sleep: function () {}
	};

	// ── 8. Type ──────────────────────────────────────────────────────────────────────────────
	// Order values are human strings. See the note at the top of this file.
	globalThis.Type = {
		Source: { Unknown: 0, Video: 1, Audio: 2, Subtitle: 3 },
		Feed: { Videos: 'VIDEOS', Streams: 'STREAMS', Mixed: 'MIXED', Live: 'LIVE', Posts: 'POSTS', Playlists: 'PLAYLISTS' },
		Order: {
			Chronological: 'Latest releases',
			Views: 'Most played',
			Favorites: 'Most favorited'
		},
		Date: { LastHour: 'last hour', Today: 'today', LastWeek: 'last week', LastMonth: 'last month', LastYear: 'last year' },
		Duration: { Short: 'short', Medium: 'medium', Long: 'long', Extralong: 'extra long' },
		Text: { RAW: 0, HTML: 1, MARKUP: 2 }
	};

	// ── 5. Language ──────────────────────────────────────────────────────────────────────────
	// YouTube builds a lookup table from this at load time.
	globalThis.Language = {
		UNKNOWN: 'ukn', ENGLISH: 'en', AFRIKAANS: 'af', ALBANIAN: 'sq', AMHARIC: 'am', ARABIC: 'ar',
		ARMENIAN: 'hy', AZERBAIJANI: 'az', BASQUE: 'eu', BELARUSIAN: 'be', BENGALI: 'bn',
		BOSNIAN: 'bs', BULGARIAN: 'bg', BURMESE: 'my', CATALAN: 'ca', CEBUANO: 'ceb',
		CHINESE: 'zh', CORSICAN: 'co', CROATIAN: 'hr', CZECH: 'cs', DANISH: 'da', DUTCH: 'nl',
		ESPERANTO: 'eo', ESTONIAN: 'et', FILIPINO: 'fil', FINNISH: 'fi', FRENCH: 'fr',
		GALICIAN: 'gl', GEORGIAN: 'ka', GERMAN: 'de', GREEK: 'el', GUJARATI: 'gu',
		HAITIAN_CREOLE: 'ht', HAUSA: 'ha', HAWAIIAN: 'haw', HEBREW: 'he', HINDI: 'hi',
		HMONG: 'hmn', HUNGARIAN: 'hu', ICELANDIC: 'is', IGBO: 'ig', INDONESIAN: 'id',
		IRISH: 'ga', ITALIAN: 'it', JAPANESE: 'ja', JAVANESE: 'jv', KANNADA: 'kn',
		KAZAKH: 'kk', KHMER: 'km', KINYARWANDA: 'rw', KOREAN: 'ko', KURDISH: 'ku',
		KYRGYZ: 'ky', LAO: 'lo', LATIN: 'la', LATVIAN: 'lv', LITHUANIAN: 'lt',
		LUXEMBOURGISH: 'lb', MACEDONIAN: 'mk', MALAGASY: 'mg', MALAY: 'ms', MALAYALAM: 'ml',
		MALTESE: 'mt', MAORI: 'mi', MARATHI: 'mr', MONGOLIAN: 'mn', NEPALI: 'ne',
		NORWEGIAN: 'no', NYANJA: 'ny', ODIA: 'or', PASHTO: 'ps', PERSIAN: 'fa',
		POLISH: 'pl', PORTUGUESE: 'pt', PUNJABI: 'pa', ROMANIAN: 'ro', RUSSIAN: 'ru',
		SAMOAN: 'sm', SCOTS_GAELIC: 'gd', SERBIAN: 'sr', SHONA: 'sn', SINDHI: 'sd',
		SINHALA: 'si', SLOVAK: 'sk', SLOVENIAN: 'sl', SOMALI: 'so', SOTHO: 'st',
		SPANISH: 'es', SUNDANESE: 'su', SWAHILI: 'sw', SWEDISH: 'sv', TAJIK: 'tg',
		TAMIL: 'ta', TATAR: 'tt', TELUGU: 'te', THAI: 'th', TURKISH: 'tr',
		TURKMEN: 'tk', UKRAINIAN: 'uk', URDU: 'ur', UYGHUR: 'ug', UZBEK: 'uz',
		VIETNAMESE: 'vi', WELSH: 'cy', XHOSA: 'xh', YIDDISH: 'yi', YORUBA: 'yo', ZULU: 'zu'
	};

	// ── the data-carrier classes ─────────────────────────────────────────────────────────────
	// Real constructors, so a plugin can \`instanceof\` and subclass them.
	//
	// GrayJay's own classes come in two shapes, and a host that assumes one of them silently
	// corrupts the other. The big content classes take a single object — \`new PlatformVideo({ id,
	// name, ... })\` — while the small value classes take **positional** arguments, as in
	// \`new PlatformID(platform, value, pluginId)\` and \`new Thumbnail(url, quality)\`.
	//
	// Assuming the object form everywhere is silent and bad rather than loud: \`for (var k in 'kick')\`
	// iterates a string's *indices*, so \`new PlatformID('kick')\` produced
	// \`{ 0: 'k', 1: 'i', 2: 'c', 3: 'k', value: '' }\` — an object that serialises, survives every
	// shape check, and carries none of the data. It was found by consuming a real feed, not by the
	// live test, which only asserted that a video's name and url were strings.
	//
	// So both forms are accepted, and the discrimination is on the arguments rather than configured:
	// one argument that is a plain object means the object form, and anything else is positional.
	// An array does not count as a plain object, because \`new Thumbnails([...])\` is positional with
	// a single argument. A class given no positional names is object-only, which is the correct
	// reading of a content class.
	function plainObject(value) {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function carrier(name, defaults, positional) {
		var Ctor = function () {
			for (var key in defaults) { if (Object.prototype.hasOwnProperty.call(defaults, key)) this[key] = defaults[key]; }

			var names = positional || [];
			var objectForm = arguments.length <= 1 && (arguments.length === 0 || plainObject(arguments[0]));

			if (names.length > 0 && !objectForm) {
				for (var i = 0; i < names.length && i < arguments.length; i++) {
					if (arguments[i] !== undefined) this[names[i]] = arguments[i];
				}
			} else {
				var src = arguments[0] || {};
				for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) this[k] = src[k]; }
			}

			this.__type = name;
		};
		Ctor.prototype.toString = function () { return name; };
		globalThis[name] = Ctor;
		return Ctor;
	}

	carrier('PlatformID', { platform: '', value: '', pluginId: '', claimType: 0, claimFieldType: -1 }, ['platform', 'value', 'pluginId', 'claimType', 'claimFieldType']);
	carrier('PlatformAuthorLink', { id: null, name: '', url: '', thumbnail: null, subscribers: null }, ['id', 'name', 'url', 'thumbnail', 'subscribers']);
	carrier('Thumbnail', { url: '', quality: 0 }, ['url', 'quality']);
	carrier('PlatformVideo', { id: null, name: '', thumbnails: null, author: null, datetime: 0, duration: 0, viewCount: 0, url: '', shareUrl: '', isLive: false });
	carrier('PlatformVideoDetails', { id: null, name: '', thumbnails: null, author: null, datetime: 0, duration: 0, viewCount: 0, url: '', shareUrl: '', isLive: false, description: '', video: null, rating: null, subtitles: [] });
	carrier('PlatformContent', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '' });
	carrier('PlatformPost', { id: null, author: null, name: '', content: '', datetime: 0, url: '', thumbnails: [], images: [] });
	carrier('PlatformPostDetails', { id: null, author: null, name: '', content: '', datetime: 0, url: '', thumbnails: [], images: [], rating: null });
	carrier('PlatformChannel', { id: null, name: '', thumbnail: null, banner: null, subscribers: 0, description: '', url: '', links: {} });
	carrier('PlatformPlaylist', { id: null, name: '', author: null, datetime: 0, url: '', videoCount: 0, thumbnail: null });
	carrier('PlatformPlaylistDetails', { id: null, name: '', author: null, datetime: 0, url: '', videoCount: 0, thumbnail: null, contents: null });
	carrier('PlatformComment', { contextUrl: '', author: null, message: '', rating: null, date: 0, replyCount: 0, context: {} });
	carrier('PlatformAuthorMembershipLink', { id: null, name: '', url: '', thumbnail: null, subscribers: null, membershipUrl: null }, ['id', 'name', 'url', 'thumbnail', 'subscribers', 'membershipUrl']);
	carrier('PlatformSubtitles', { name: '', url: '', format: null }, ['name', 'url', 'format']);
	carrier('ResultCapabilities', { types: [], sorts: [], filters: [] }, ['types', 'sorts', 'filters']);
	carrier('LiveEventComment', { name: '', message: '', thumbnail: null, colorName: null, badges: [] }, ['name', 'message', 'thumbnail', 'colorName', 'badges']);
	carrier('LiveEventEmojis', { emojis: {} }, ['emojis']);
	carrier('LiveEventDonation', { name: '', message: '', thumbnail: null, amount: '', colorDonation: null }, ['name', 'message', 'thumbnail', 'amount', 'colorDonation']);
	carrier('LiveEventViewCount', { viewCount: 0 }, ['viewCount']);
	carrier('LiveEventRaid', { targetName: '', targetThumbnail: '', targetUrl: '', isOutgoing: false }, ['targetName', 'targetThumbnail', 'targetUrl', 'isOutgoing']);

	globalThis.Thumbnails = function (sources) { this.sources = sources || []; this.__type = 'Thumbnails'; };
	globalThis.Thumbnails.prototype.toString = function () { return 'Thumbnails'; };

	globalThis.RatingLikes = function (likes) { this.type = 1; this.likes = likes || 0; };
	globalThis.RatingLikesDislikes = function (likes, dislikes) { this.type = 2; this.likes = likes || 0; this.dislikes = dislikes || 0; };
	globalThis.RatingScaler = function (value) { this.type = 3; this.value = value || 0; };

	globalThis.VideoSourceDescriptor = function (sources) { this.isUnMuxed = false; this.videoSources = sources || []; };
	globalThis.UnMuxVideoSourceDescriptor = function (videoSources, audioSources) { this.isUnMuxed = true; this.videoSources = videoSources || []; this.audioSources = audioSources || []; };
	globalThis.VideoUrlSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.AudioUrlSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.HLSSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.DashSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.VideoUrlWidevineSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.SubtitleSource = function (obj) { Object.assign(this, obj || {}); };

	// A plugin constructs one of these to report playback progress to the app. Nothing here consumes
	// it, but TikTok and others reference the class at load time and throw on undefined.
	globalThis.PlaybackTracker = function (interval) {
		this.nextRequest = interval || 10000;
		this.onInit = function () {};
		this.onProgress = function () {};
		this.onConcluded = function () {};
	};

	// ── pagers ───────────────────────────────────────────────────────────────────────────────
	// A plugin returns one of these from a feed call. The host walks it with \`hasMorePagers\` and
	// \`nextPage\`, so it has to be a real object with those methods rather than a plain array.
	function Pager(results, hasMore, context) {
		this.results = results || [];
		this.hasMore = !!hasMore;
		this.context = context || {};
	}
	Pager.prototype.hasMorePagers = function () { return this.hasMore; };
	Pager.prototype.nextPage = function () { this.results = []; this.hasMore = false; return this; };

	globalThis.ContentPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.ContentPager.prototype = Object.create(Pager.prototype);
	globalThis.VideoPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.VideoPager.prototype = Object.create(Pager.prototype);
	globalThis.ChannelPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.ChannelPager.prototype = Object.create(Pager.prototype);
	globalThis.PlaylistPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.PlaylistPager.prototype = Object.create(Pager.prototype);
	globalThis.CommentPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.CommentPager.prototype = Object.create(Pager.prototype);
	globalThis.LiveEventPager = function (results, hasMore, context) { Pager.call(this, results, hasMore, context); };
	globalThis.LiveEventPager.prototype = Object.create(Pager.prototype);

	// ── utility (the Utilities package) ──────────────────────────────────────────────────────
	globalThis.utility = {
		fromMilliseconds: function (ms) { return Math.round(Number(ms) / 1000); },
		toMilliseconds: function (s) { return Math.round(Number(s) * 1000); },
		randomUUID: function () {
			// Not cryptographic, and nothing here depends on it being so: plugins use it for request
			// correlation ids. A plugin needing real randomness would need a host primitive.
			var out = '';
			for (var i = 0; i < 32; i++) { out += Math.floor(Math.random() * 16).toString(16); }
			return out.slice(0, 8) + '-' + out.slice(8, 12) + '-4' + out.slice(13, 16) + '-a' + out.slice(17, 20) + '-' + out.slice(20, 32);
		},
		// Eight plugins sign requests with this — BiliBili its API calls, YouTube a fingerprint of the
		// player script. Computed by the host: a hand-written MD5 whose output is subtly wrong is
		// rejected by the platform as a bad signature with no clue that the hash is at fault.
		//
		// The member is \`md5String\`, not \`md5\`. This file had a throwing \`md5\` stub for a while, which
		// no plugin ever reached, while every plugin that wanted a digest got \`undefined is not a
		// function\` — a stub for a name nobody uses is worse than nothing, because it reads as
		// deliberate.
		md5String: function (text) {
			var answer = JSON.parse(__host_hash(JSON.stringify({ algorithm: 'md5', text: String(text) })));

			if (answer.error) throw new Error(answer.error);

			return answer.hex;
		},

		sha1String: function (text) { return digest('sha1', text); },
		sha256String: function (text) { return digest('sha256', text); },

		// Bytes in, base64 out. Nine plugins use this, every one of them passing a byte array —
		// \`utility.toBase64(string_to_bytes(...))\` — so an array is the signature that matters. A
		// string is accepted too and treated as one byte per character, which is what \`btoa\` does.
		toBase64: function (bytes) {
			if (typeof bytes === 'string') return btoa(bytes);

			var text = '';
			for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i] & 255);

			return btoa(text);
		},

		// Base64 in, bytes out — a real array, because the one plugin using it spreads the result into
		// \`String.fromCharCode(...)\`, which a string would not survive meaningfully.
		fromBase64: function (text) {
			var decoded = atob(String(text));
			var out = [];
			for (var i = 0; i < decoded.length; i++) out.push(decoded.charCodeAt(i));

			return out;
		}
	};

	function digest(algorithm, text) {
		var answer = JSON.parse(__host_hash(JSON.stringify({ algorithm: algorithm, text: String(text) })));

		if (answer.error) throw new Error(answer.error);

		return answer.hex;
	}

	// Base64. QuickJS is an ES engine, not a browser, so it has neither of these — they are Web
	// platform APIs, not language ones. The Twitch plugin calls \`btoa\` while building its GraphQL
	// request and fails at *load* time without it, with \`'btoa' is not defined\` and nothing to
	// suggest the missing piece belongs to the host rather than to Twitch.
	//
	// Implemented to the real semantics rather than approximately: these operate on a "binary string"
	// of one character per byte, and \`btoa\` throws on any code point above 255 instead of silently
	// truncating it. A plugin that passes UTF-8 text here gets the same error a browser would give,
	// because that is a bug in the plugin and quietly producing wrong base64 would hide it.
	var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

	globalThis.btoa = function (input) {
		var text = String(input);
		var out = '';

		for (var i = 0; i < text.length; i += 3) {
			var a = text.charCodeAt(i);
			var b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN;
			var c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN;

			if (a > 255 || b > 255 || c > 255) {
				throw new Error('btoa: the string contains characters outside the Latin1 range');
			}

			var bits = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);

			out +=
				B64[(bits >> 18) & 63] +
				B64[(bits >> 12) & 63] +
				(isNaN(b) ? '=' : B64[(bits >> 6) & 63]) +
				(isNaN(c) ? '=' : B64[bits & 63]);
		}

		return out;
	};

	globalThis.atob = function (input) {
		var text = String(input).replace(/[ \\t\\n\\f\\r]/g, '');

		if (text.length % 4 === 1) throw new Error('atob: the string is not valid base64');

		text = text.replace(/=+$/, '');

		var out = '';
		var bits = 0;
		var held = 0;

		for (var i = 0; i < text.length; i++) {
			var value = B64.indexOf(text[i]);

			if (value < 0) throw new Error('atob: the string is not valid base64');

			bits = (bits << 6) | value;
			held += 6;

			if (held >= 8) {
				held -= 8;
				out += String.fromCharCode((bits >> held) & 255);
			}
		}

		return out;
	};

	// ── the exception classes ────────────────────────────────────────────────────────────────
	// Plugins throw these to tell a host *why* something failed, and several subclass them. They were
	// missing, and the symptom is the worst kind: a plugin loads, runs, and dies with
	// \`'ScriptLoginRequiredException' is not defined\` from inside its own error handling — so the
	// real failure is replaced by a host one at exactly the moment the plugin was explaining itself.
	//
	// Real \`Error\` subclasses, so \`instanceof Error\`, \`.message\` and \`.stack\` all behave and the
	// host's own error reporting picks the message up unchanged. The name is kept on the instance
	// because that is the part a caller can act on — "this needs a login" is a different answer from
	// "this is broken".
	function exception(name, parent) {
		var Ctor = function (message, extra) {
			var self = new Error(message === undefined ? name : String(message));

			Object.setPrototypeOf(self, Ctor.prototype);
			self.name = name;
			self.msg = self.message;
			if (extra !== undefined) self.extra = extra;

			return self;
		};

		Ctor.prototype = Object.create((parent || Error).prototype);
		Ctor.prototype.constructor = Ctor;
		globalThis[name] = Ctor;

		return Ctor;
	}

	var ScriptException = exception('ScriptException');

	// Each of these is thrown by at least one plugin in the public index; the count in brackets is how
	// many reference it. A caller distinguishes them by \`name\`.
	exception('CriticalException', ScriptException);          // [4] the plugin cannot continue at all
	exception('AgeException', ScriptException);               // [5] age-restricted without a sign-in
	exception('ScriptLoginRequiredException', ScriptException); // [7] needs a platform login
	exception('LoginRequiredException', ScriptException);     // the same thing under its shorter name
	exception('ScriptImplementationException', ScriptException);
	exception('ScriptUnavailableException', ScriptException);
	exception('ScriptTimeoutException', ScriptException);
	exception('ScriptAgeException', ScriptException);
	exception('ReloadRequiredException', ScriptException);
	exception('UnavailableException', ScriptException);
	exception('TimeoutException', ScriptException);
	exception('Exception', ScriptException);

	// ── filters, which a plugin builds to describe its own search ────────────────────────────
	// [9] plugins construct these. Purely descriptive — a host reads them to render a filter menu —
	// so carrying the fields is the whole contract.
	carrier('FilterCapability', { id: '', name: '', value: '' }, ['name', 'value', 'id']);
	carrier('FilterGroup', { id: '', name: '', filters: [], isMultiSelect: false }, ['name', 'filters', 'isMultiSelect', 'id']);
	carrier('FilterGroupIDs', { ids: [] }, ['ids']);

	// ── the remaining content classes ────────────────────────────────────────────────────────
	// \`Comment\` is the one that stops Bitchute loading: it subclasses it, and only \`PlatformComment\`
	// was defined. The two are the same shape, and plugins use both names.
	carrier('Comment', { contextUrl: '', author: null, message: '', rating: null, date: 0, replyCount: 0, context: {} });

	carrier('PlatformLockedContent', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '', contentName: '', contentThumbnails: null, unlockUrl: '', lockDescription: '' });
	carrier('PlatformNestedMediaContent', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '', contentUrl: '', contentName: '', contentDescription: '', contentProvider: '', contentThumbnails: null });
	carrier('PlatformArticle', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '', thumbnails: null, summary: '' });
	carrier('PlatformArticleDetails', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '', thumbnails: null, summary: '', segments: [], rating: null });
	carrier('PlatformWeb', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '' });
	carrier('PlatformWebDetails', { id: null, name: '', author: null, datetime: 0, url: '', shareUrl: '', html: '' });

	// The segments an article is built from.
	carrier('ArticleTextSegment', { type: 0, content: '' }, ['content']);
	carrier('ArticleHeaderSegment', { type: 1, content: '', level: 1 }, ['content', 'level']);
	carrier('ArticleImagesSegment', { type: 2, images: [], caption: '' }, ['images', 'caption']);
	carrier('ArticleNestedSegment', { type: 3, nested: null }, ['nested']);

	// ── the remaining media sources ──────────────────────────────────────────────────────────
	// Byte-range and raw-manifest variants. Nothing here plays media, but a plugin constructs them
	// while describing what it found and throws on an undefined class before it ever returns.
	globalThis.VideoUrlRangeSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.AudioUrlRangeSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.HLSWidevineSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.AudioUrlWidevineSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.DashWidevineSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.DashManifestRawSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.DashManifestRawAudioSource = function (obj) { Object.assign(this, obj || {}); };
	globalThis.UMPSource = function (obj) { Object.assign(this, obj || {}); };

	// A plugin builds one of these to adjust the requests the *app* will make for media. This host
	// does not play media, so it is carried and never consulted — but it has to exist, because a
	// plugin constructs it while returning a video's sources.
	globalThis.RequestModifier = function (obj) { Object.assign(this, obj || {}); };

	// ── URL and URLSearchParams ──────────────────────────────────────────────────────────────
	// Web platform APIs, so QuickJS has neither, and plugins use them constantly — to build a query,
	// to read a host and decide which API to call, to resolve a relative link scraped out of a page.
	// Four plugins in the public index die at load with \`'URL' is not defined\`.
	//
	// Parsing is the host's, through its own WHATWG parser: URL is one of those problems that looks
	// like a regex and is not, and a plugin that resolves a link slightly differently from a browser
	// follows it somewhere else — which surfaces as a platform returning nothing rather than as a
	// parsing bug. See url.ts.
	//
	// \`URLSearchParams\` is implemented here instead, because it is string work with no parsing
	// subtleties worth a round trip, and plugins mutate it in loops.

	// Form encoding, which is \`encodeURIComponent\` plus the rules that differ: a space is \`+\`, and
	// the characters \`!'()~\` are escaped where \`encodeURIComponent\` leaves them alone.
	function formEncode(value) {
		return encodeURIComponent(String(value))
			.replace(/%20/g, '+')
			.replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
	}

	function formDecode(value) {
		// Two backslashes: this is inside a template literal, so one would be eaten and the guest
		// would receive \`/+/g\`, which is the regex error "nothing to repeat" at load time.
		try { return decodeURIComponent(String(value).replace(/\\+/g, ' ')); }
		catch (e) { return String(value).replace(/\\+/g, ' '); }
	}

	function URLSearchParams(init) {
		var pairs = [];

		if (typeof init === 'string') {
			var text = init.charAt(0) === '?' ? init.slice(1) : init;
			if (text !== '') {
				var parts = text.split('&');
				for (var i = 0; i < parts.length; i++) {
					if (parts[i] === '') continue;
					var eq = parts[i].indexOf('=');
					if (eq === -1) pairs.push([formDecode(parts[i]), '']);
					else pairs.push([formDecode(parts[i].slice(0, eq)), formDecode(parts[i].slice(eq + 1))]);
				}
			}
		} else if (Array.isArray(init)) {
			for (var a = 0; a < init.length; a++) pairs.push([String(init[a][0]), String(init[a][1])]);
		} else if (init && typeof init === 'object') {
			// A plain object, which is how nearly every plugin builds one.
			for (var key in init) {
				if (Object.prototype.hasOwnProperty.call(init, key)) pairs.push([key, String(init[key])]);
			}
		}

		this._pairs = pairs;
	}

	URLSearchParams.prototype.append = function (name, value) { this._pairs.push([String(name), String(value)]); };
	URLSearchParams.prototype.set = function (name, value) {
		var found = false;
		var out = [];
		for (var i = 0; i < this._pairs.length; i++) {
			if (this._pairs[i][0] !== String(name)) { out.push(this._pairs[i]); continue; }
			// \`set\` replaces the first and removes the rest, keeping the first one's position.
			if (!found) { out.push([String(name), String(value)]); found = true; }
		}
		if (!found) out.push([String(name), String(value)]);
		this._pairs = out;
	};
	URLSearchParams.prototype.get = function (name) {
		for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(name)) return this._pairs[i][1];
		// Null and not undefined: a plugin tests \`=== null\`.
		return null;
	};
	URLSearchParams.prototype.getAll = function (name) {
		var out = [];
		for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(name)) out.push(this._pairs[i][1]);
		return out;
	};
	URLSearchParams.prototype.has = function (name) { return this.get(name) !== null; };
	URLSearchParams.prototype['delete'] = function (name) {
		var out = [];
		for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] !== String(name)) out.push(this._pairs[i]);
		this._pairs = out;
	};
	URLSearchParams.prototype.forEach = function (fn, thisArg) {
		for (var i = 0; i < this._pairs.length; i++) fn.call(thisArg, this._pairs[i][1], this._pairs[i][0], this);
	};
	URLSearchParams.prototype.keys = function () { return this._pairs.map(function (p) { return p[0]; }); };
	URLSearchParams.prototype.values = function () { return this._pairs.map(function (p) { return p[1]; }); };
	URLSearchParams.prototype.entries = function () { return this._pairs.map(function (p) { return [p[0], p[1]]; }); };
	URLSearchParams.prototype.sort = function () { this._pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); };
	URLSearchParams.prototype.toString = function () {
		var out = [];
		for (var i = 0; i < this._pairs.length; i++) out.push(formEncode(this._pairs[i][0]) + '=' + formEncode(this._pairs[i][1]));
		return out.join('&');
	};
	Object.defineProperty(URLSearchParams.prototype, 'size', {
		get: function () { return this._pairs.length; }
	});
	URLSearchParams.prototype[Symbol.iterator] = function () { return this.entries()[Symbol.iterator](); };

	globalThis.URLSearchParams = URLSearchParams;

	var URL_PARTS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname',
		'port', 'pathname', 'search', 'hash'];

	function URL(input, base) {
		var answer = JSON.parse(__host_url(JSON.stringify({ url: String(input), base: base === undefined ? undefined : String(base) })));

		// A \`TypeError\`, which is what the platform throws and what a plugin's \`catch\` expects.
		if (answer.error) throw new TypeError(answer.error);

		this._parts = answer.parts;
		this._params = new URLSearchParams(answer.parts.search);
	}

	// Every component is a getter, and assigning to one re-parses through the host rather than
	// patching the string here — which is the only way \`port = ''\` dropping a default port, or
	// \`protocol\` changing what counts as a valid host, comes out right.
	for (var pi = 0; pi < URL_PARTS.length; pi++) {
		(function (name) {
			Object.defineProperty(URL.prototype, name, {
				get: function () {
					// \`search\` is answered from the params object, so a plugin that mutates
					// \`url.searchParams\` and then reads \`url.search\` or \`url.href\` sees its own change.
					if (name === 'search') {
						var query = this._params.toString();
						return query === '' ? '' : '?' + query;
					}
					if (name === 'href') return this._rebuild();
					return this._parts[name];
				},
				set: function (value) {
					if (name === 'origin') return;

					var next = {};
					for (var k = 0; k < URL_PARTS.length; k++) next[URL_PARTS[k]] = this._parts[URL_PARTS[k]];
					next[name] = String(value);

					// \`host\` and \`hostname\`+\`port\` are two spellings of the same thing, so the authority
					// has to be composed from whichever the plugin actually assigned. Using \`host\`
					// unconditionally meant \`port = ''\` could not drop a port — the old port was still
					// sitting inside \`host\`.
					var authority = name === 'host'
						? next.host
						: next.hostname + (next.port ? ':' + next.port : '');

					var candidate = next.protocol + '//' +
						(next.username ? next.username + (next.password ? ':' + next.password : '') + '@' : '') +
						authority + next.pathname +
						(name === 'search' ? String(value) : this.search) +
						next.hash;

					var answer = JSON.parse(__host_url(JSON.stringify({ url: candidate })));

					// A component a plugin assigned that makes the whole url invalid is ignored, which
					// is what the platform does — assigning nonsense to \`url.protocol\` is a no-op, not
					// an exception.
					if (answer.error) return;

					this._parts = answer.parts;
					this._params = new URLSearchParams(answer.parts.search);
				},
				enumerable: true
			});
		})(URL_PARTS[pi]);
	}

	Object.defineProperty(URL.prototype, 'searchParams', {
		get: function () { return this._params; },
		enumerable: true
	});

	URL.prototype._rebuild = function () {
		var p = this._parts;
		var credentials = p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : '';

		return p.protocol + '//' + credentials + p.host + p.pathname + this.search + p.hash;
	};

	URL.prototype.toString = function () { return this._rebuild(); };
	URL.prototype.toJSON = function () { return this._rebuild(); };

	globalThis.URL = URL;

	// ── domParser ────────────────────────────────────────────────────────────────────────────
	// Roughly half the plugin index needs this. The document itself lives on the host, parsed by a
	// real DOM implementation; what a plugin gets here are thin proxies over integer handles whose
	// every property read calls back out through \`__host_dom\`.
	//
	// That is affordable because none of it is asynchronous: unlike \`http.GET\`, which needs the WASM
	// stack unwound because a fetch is a promise, querying a parsed document is synchronous work on
	// the host — so \`__host_dom\` is an ordinary synchronous host function and a property read is one
	// C call, not a stack unwind.
	//
	// \`__host_dom\` is absent when the caller did not enable DOM support, so every entry point checks
	// for it and says so rather than failing as "undefined is not a function".
	function dom(message) {
		if (typeof __host_dom !== 'function') {
			throw new Error('grayjay-plugin-host was built without DOM support; pass dom: true to enable it');
		}

		var answer = JSON.parse(__host_dom(JSON.stringify(message)));

		// The host returns a refusal rather than throwing across the boundary, so it becomes a real
		// error here with its sentence intact.
		if (answer && answer.error) throw new Error(answer.error);

		return answer;
	}

	function node(handle) {
		if (handle === null || handle === undefined) return null;

		var self = {
			// Exposed so a plugin can tell two references to the same node apart, and so this is
			// debuggable at all. Not something a plugin should do arithmetic on.
			__handle: handle,

			querySelector: function (sel) { return node(dom({ op: 'query', h: handle, sel: sel, all: false }).h); },
			querySelectorAll: function (sel) { return dom({ op: 'query', h: handle, sel: sel, all: true }).hs.map(node); },

			// The \`getElementsBy*\` family, expressed as selectors. A plugin using them gets the same
			// answer, and the host keeps one query path rather than four.
			getElementById: function (id) { return node(dom({ op: 'query', h: handle, sel: '#' + id, all: false }).h); },
			getElementsByClassName: function (name) { return dom({ op: 'query', h: handle, sel: '.' + name, all: true }).hs.map(node); },
			getElementsByTagName: function (name) { return dom({ op: 'query', h: handle, sel: name, all: true }).hs.map(node); },

			getAttribute: function (name) { return dom({ op: 'attr', h: handle, name: name }).v; },
			hasAttribute: function (name) { return dom({ op: 'has', h: handle, name: name }).v; },

			// Read eagerly rather than lazily: a plugin that walks attributes reads most of them, and
			// one call beats one per attribute.
			getAttributeNames: function () { return Object.keys(dom({ op: 'attrs', h: handle }).v); },

			// A document is released explicitly. Nothing here can observe a plugin dropping its last
			// reference, so holding the tree until the plugin says so is the only correct behaviour —
			// and the host caps how much may be held at once.
			release: function () { dom({ op: 'release', h: handle }); }
		};

		function property(name) {
			Object.defineProperty(self, name, {
				get: function () { return dom({ op: 'get', h: handle, name: name }).v; },
				enumerable: true
			});
		}

		// The properties a scraper reads. Each is a call, which is why there is no attempt to mirror
		// the whole DOM: an absent one throws by name from the host, which is a sentence a plugin
		// author can act on.
		var names = ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'tagName', 'localName',
			'nodeName', 'nodeType', 'id', 'className', 'value', 'href', 'src', 'title', 'alt', 'type',
			'name', 'content'];
		for (var i = 0; i < names.length; i++) property(names[i]);

		function relation(name) {
			Object.defineProperty(self, name, {
				get: function () { return node(dom({ op: 'rel', h: handle, which: name }).h); },
				enumerable: true
			});
		}

		var relations = ['parentElement', 'parentNode', 'firstElementChild', 'lastElementChild',
			'nextElementSibling', 'previousElementSibling'];
		for (var r = 0; r < relations.length; r++) relation(relations[r]);

		Object.defineProperty(self, 'children', {
			get: function () { return dom({ op: 'kids', h: handle, elements: true }).hs.map(node); },
			enumerable: true
		});
		Object.defineProperty(self, 'childNodes', {
			get: function () { return dom({ op: 'kids', h: handle, elements: false }).hs.map(node); },
			enumerable: true
		});
		Object.defineProperty(self, 'classList', {
			get: function () {
				var list = dom({ op: 'classes', h: handle }).v;

				// An array with \`contains\`, because that is the one DOMTokenList method scrapers use and
				// a plain array would make \`classList.contains(...)\` a missing function.
				list.contains = function (name) { return list.indexOf(name) !== -1; };

				return list;
			},
			enumerable: true
		});

		// The document's own \`body\` and \`documentElement\`, which is where a plugin usually starts.
		Object.defineProperty(self, 'body', {
			get: function () { return self.querySelector('body'); },
			enumerable: true
		});
		Object.defineProperty(self, 'documentElement', {
			get: function () { return self.querySelector('html'); },
			enumerable: true
		});

		return self;
	}

	function parseDocument(html, mime) {
		return node(dom({ op: 'parse', html: String(html == null ? '' : html), mime: mime || 'text/html' }).h);
	}

	// Both spellings. \`domParser.parseFromString\` is what the package documents; \`new DOMParser()\` is
	// what a plugin written against a browser reaches for, and several do both.
	globalThis.domParser = { parseFromString: parseDocument };
	globalThis.DOMParser = function () { this.parseFromString = parseDocument; };

	// The injected \`source\`, for plugins that assign to it rather than declaring their own. See
	// item 6 at the top of this file and \`resolveSource\` in sandbox.ts for the other case.
	globalThis.source = globalThis.source || {};

	globalThis.plugin = { config: {}, settings: {} };
	globalThis.packages = ['Http', 'Utilities'];
})();
`;
