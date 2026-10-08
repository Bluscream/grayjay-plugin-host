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

| Plugin                       | Status                          |
| :--------------------------- | :------------------------------ |
| **Twitch**                   | loads, reads channels and feeds |
| **Kick**                     | loads, reads channels and feeds |
| Anything needing `DOMParser` | refused at load, by name        |
| Anything needing `HttpImp`   | refused at load, by name        |

A plugin is runnable here when its manifest declares nothing outside `packages: ["Http",
"Utilities"]`. Check before you commit to one:

```ts
import { parseManifest, unsupportedReasons } from 'grayjay-plugin-host';

const manifest = parseManifest(await (await fetch(url)).json(), url);

console.log(unsupportedReasons(manifest)); // [] means it will run
```

## Known limits, up front

- **`DOMParser` is not provided yet.** Roughly half the indexed plugins need it. They are refused by
  name at load rather than failing mysteriously three calls later.
- **`HttpImp` cannot be provided.** TLS fingerprint impersonation needs a stack that presents a
  browser's exact ClientHello, and Node has no such thing. If a platform starts requiring it, its
  plugin stops working here and keeps working in the app.
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

None of this makes it safe to run an arbitrary plugin against a secret. It makes it bounded.

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
10. **The declared feed capabilities cannot be trusted.** TikTok's `getChannelCapabilities()` returns
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
