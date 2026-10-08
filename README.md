# grayjay-plugin-host

Run [GrayJay](https://grayjay.app) source plugins on Node.

GrayJay plugins are maintained readers for a long list of video platforms — Twitch, Kick, YouTube,
TikTok, Rumble, Odysee and about a hundred more. They are the reason the app keeps working when a
platform changes something: they are small, they are updated quickly, and somebody else maintains
them.

Until now the only hosts were `Grayjay.Engine` (C#) and the Android app (Kotlin). This is a
JavaScript one.

```sh
npm install grayjay-plugin-host
```

```ts
import { loadPlugin } from 'grayjay-plugin-host';

const plugin = await loadPlugin('https://plugins.grayjay.app/Kick/KickConfig.json');

try {
	const channel = await plugin.call('getChannel', ['https://kick.com/xqc']);
	const feed = await plugin.feed('https://kick.com/xqc');

	console.log(channel.name, feed.results.length);
} finally {
	plugin.dispose();
}
```

`dispose()` is not optional: the plugin runs in a WebAssembly heap that is released only when you
ask.

## What works today

Verified against the **real published plugins**, not against fixtures — `RUN_LIVE=1 npm test` loads
them over the network and reads a channel and a feed page:

Measured by loading all 112 runnable plugins from the public index and asking each for its home
feed (`scripts/` is not shipped; the numbers are from the same calls the live tests make):

| Outcome                                      | Plugins |
| :------------------------------------------- | ------: |
| **loaded and returned real content**         |  **45** |
| loaded and answered with an empty feed       |      17 |
| loaded, then failed on their own terms       |      11 |
| loaded, but expose no home feed to test with |       3 |
| could not be loaded at all                   |      36 |

Two of those rows are mostly not about this library. Of the 36 that could not be loaded, **27 are
upstream**: the index lists a manifest URL that 404s, has moved, or serves an HTML page instead of
JSON. The rest divide into platforms refusing the request (403), plugins that require a platform
login — which this host does not have — and two whose own regexes QuickJS rejects where V8 accepts
them.

For scale: before `DOMParser`, `URL` and the missing host classes were added, **2** plugins returned
content. The method names and the number of items are what the live tests assert, so a regression
here is loud rather than silent.

`Http`, `Utilities` and `DOMParser` are provided; `HttpImp` cannot be. A plugin needing it is
refused by name at load rather than left to fail against Cloudflare, because an empty feed is
indistinguishable from a platform being down. Check before you commit to one:

```ts
import { parseManifest, unsupportedReasons } from 'grayjay-plugin-host';

const manifest = parseManifest(await (await fetch(url)).json(), url);

console.log(unsupportedReasons(manifest)); // [] means it will run
```

## Known limits, up front

- **`HttpImp` cannot be provided.** TLS fingerprint impersonation needs a stack that presents a
  browser's exact ClientHello, and Node has no such thing. If a platform starts requiring it, its
  plugin stops working here and keeps working in the app.
- **A few plugins need browser APIs beyond these.** YouTube and TikTok drive a `JSDOM`/`CustomWindow`
  emulation to run the platform's own scripts, and one reaches for `XMLHttpRequest`. Those are not
  refused at load — they fail when they get there, because nothing in the manifest declares them.
- **Script signatures are not verified.** The algorithm is undocumented, and a verification that is
  wrong is worse than none. Pin a hash instead — see below.
- **No platform login.** A plugin whose manifest declares `authentication` will load and run, and its
  signed-in features will return nothing. `manifest.authentication` tells you before you call it.
- **`utility.md5` throws.** Nothing has needed it yet; it is a stub so that a plugin which does needs
  it fails with a sentence rather than `undefined is not a function`.

## Pin a version

"Constantly updated" is the appeal of these plugins and also the risk: an upstream change arrives as
somebody else's code running on your server, with no review.

```ts
const plugin = await loadPlugin(url, { expectHash: 'e3b0c442…' });
```

Record `plugin.scriptHash` once and pass it back. An upstream change then fails the load loudly
instead of deploying itself. Omitting it is a real choice and not a wrong one — it is how the app
behaves — but it should be a choice.

## Parsing HTML

About half the plugin index scrapes, so `domParser` and `new DOMParser()` are provided and **on by
default**. Pass `dom: false` to forbid it, or an object to change the limits.

The document is parsed on the host by [`linkedom`](https://github.com/WebReflection/linkedom) and the
sandbox gets integer handles; the guest's node objects are thin proxies. That is affordable because
none of it is asynchronous — unlike `http.GET`, which needs the WASM stack unwound because a fetch is
a promise, querying a parsed document is synchronous work, so it is one ordinary host call per
property read.

Query, read attributes and text, walk the element relations. Mutation is deliberately absent, which
keeps it a one-way boundary. A property outside the supported set reads as `undefined` rather than
throwing, because plugins probe — and the supported set is enforced on the host, since a plugin can
call the bridge directly and forwarding an arbitrary name to a real node would hand it
`constructor`.

Documents are **evicted, oldest first**, not refused, once more than `maxDocuments` are held. There
is no `release` in GrayJay's own API, so no real plugin calls one, and a cap that refused would stop
any plugin that reads page after page. Handles come from a counter that never rewinds, so a node
from an evicted document is refused rather than quietly naming a different page's content.

`URL` and `URLSearchParams` are provided too — QuickJS has neither. Parsing goes through the host's
own WHATWG parser rather than a regex here, because a plugin that resolves a scraped relative link
differently from a browser follows it somewhere else, and that surfaces as a platform returning
nothing.

## Sandboxing

Plugins are third-party JavaScript. They run in QuickJS compiled to WebAssembly
([`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten)), which means the plugin has
no `process`, no `require`, no filesystem and no network except through this host.

Enforced per call into the plugin:

| Limit           | Default                                                                         |
| :-------------- | :------------------------------------------------------------------------------ |
| Wall clock      | 60s, via an engine interrupt — a `while (true)` plugin is stopped, not survived |
| HTTP requests   | 60                                                                              |
| Response size   | 16 MiB                                                                          |
| Memory          | 128 MiB                                                                         |
| Hosts reachable | only those in the plugin's own `allowUrls`                                      |

The allow-list is **enforced**, not recorded. A request outside it never reaches the network, and
`file:` and `data:` are refused whatever the manifest says. A refused request comes back to the
plugin as a 403-shaped response rather than an exception, because that is the path the plugin's own
error handling already takes — several plugins probe optional endpoints deliberately.

### `allowUrls: ["everywhere"]`

Five plugins in the public index declare exactly that, and it means what it says — PeerTube needs it
because it is federated, so the instance a channel lives on cannot be in a fixed list. It is
honoured, and `reachesAnywhere(manifest)` reports it so you can refuse such a plugin before running
it.

Because that removes the allow-list as a bound, **a literal private, loopback, link-local or
multicast address is refused regardless of what the manifest allows.** On a desktop app a wildcard
is a plugin reaching the internet; on a server the interesting target is `169.254.169.254` for
instance credentials, or whatever else on your network answers without authentication because nobody
expected it to be reachable. Set `allowPrivateHosts: true` to permit it deliberately — for a
self-hosted instance on your own network, which is a real case.

This catches literal addresses, including IPv4-mapped IPv6 ones. It does **not** catch a hostname
that resolves to a private address: resolution happens inside `fetch`, so there is no point at which
this could check the answer without leaving a window between the check and the connection. Guarding
that needs control of the socket; if a plugin on your network is in your threat model, pass a
`fetch` of your own that does it.

None of this makes it safe to run an arbitrary plugin against a secret. It makes it bounded.

### Route it through your own client

Pass a `fetch` and every request — the manifest, the script, and everything the plugin asks for —
goes through it. Use it for a proxy, a metrics wrapper, or a user agent and deadline your own code
already owns:

```ts
const plugin = await loadPlugin(url, {
	fetch: (target, init) => myClient(target, init)
});
```

The allow-list, the request budget and the response cap are enforced **around** it, not by it: your
function is never asked for a url the policy has not already approved, and one that throws is
treated exactly like a transport failure rather than taking down a feed read.

## What this had to work out

GrayJay's plugin interface is documented; the _host_ interface is not. These were found by running
real plugins and reading what they did, and they are in the source with the plugin that cost each
one:

1. `IS_TESTING` must exist, or YouTube throws at load.
2. `setTimeout` must exist, even though the sandbox never sleeps.
3. `Type.Order.Chronological` is the string `"Latest releases"`, not a constant name.
4. `http.getDefaultClient()` must return an object with a `clientId`.
5. `http.batch()` must be chainable and must expose `DUMMY`, which some plugins read as a feature
   probe.
6. A plugin may write `const source = {…}`, which never becomes a global — the host has to resolve
   the bare _name_. The X plugin reports zero methods otherwise.
7. Optional arguments must be explicit `null`. TikTok tests `filters !== null`, and
   `undefined !== null` is true, so an omitted argument takes the error branch.
8. `btoa` and `atob` must be provided. They are Web platform APIs, not language ones, so QuickJS has
   neither — and Twitch calls `btoa` at load time.
9. A plugin method may return nothing, and a guest `undefined` read back out of the engine is the
   _string_ `"undefined"`. Kick's `enable` returns nothing.
10. **The data classes come in two shapes.** The content classes take one object
    (`new PlatformVideo({ ... })`); the small value classes take positional arguments
    (`new PlatformID(platform, value, pluginId)`). Assuming the object form everywhere is silent,
    not loud: `for (var k in 'kick')` walks a string's indices, so an id arrives as
    `{ 0: 'k', 1: 'i', ... }` that serialises cleanly and carries nothing.
11. **The `utility` members are not the ones you would guess.** Plugins call `utility.md5String`,
    `utility.toBase64` (bytes in) and `utility.fromBase64` (bytes out). A stub provided here for
    `utility.md5` was never reached by anything while every plugin wanting a digest got
    `undefined is not a function` — a stub for a name nobody uses reads as deliberate and is worse
    than nothing.
12. **A plugin may populate a field next to the documented one.** Kick's videos leave `datetime` at
    `0` and put unix seconds in `uploadDate`, so read both before deciding a feed has no dates.
13. **The declared feed capabilities cannot be trusted.** TikTok's `getChannelCapabilities()` returns
    `["VIDEOS","MIXED","LIVE"]` and the plugin then refuses `VIDEOS`; YouTube refuses `MIXED`. A host
    has to _try_, in an order, and treat a refusal as "not this one".

That last one is why you should prefer `plugin.feed(url)` over calling `getChannelContents`
yourself — it negotiates the type and tells you which one worked, so the next page can skip the dead
end:

```ts
const feed = await plugin.feed(url);

feed.type; // 'MIXED' — reuse it for page two
feed.refused; // [{ type: 'VIDEOS', reason: 'unreachable' }]
```

## Licence

This host is **MIT**.

The official plugins are **AGPL-3.0**, and this is not a way around that. Loading a plugin at run
time does not make your program a derivative of it; distributing one does carry its licence. Check
before you bundle somebody's plugin into your product.

Not affiliated with FUTO or GrayJay. This loads a plugin and calls its methods — playback, subtitles
and DRM are the app's business, not this library's.
