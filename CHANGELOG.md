# Changelog

Notable changes per release. Every version so far is `0.x`: the surface is still settling, and a
minor bump may change it. What each release did to _plugin compatibility_ is recorded here too,
because that is the number a consumer of this library actually cares about.

## 0.5.0

- **`utility.md5String`, `utility.toBase64` and `utility.fromBase64`.** Digests are computed by the
  host, because a hand-written MD5 whose output is subtly wrong is rejected by a platform as a bad
  signature with no indication that the hash is at fault. `sha1String` and `sha256String` come along
  for free.
- A throwing `utility.md5` stub is gone. No plugin ever called that name; eight call `md5String`, so
  the stub read as deliberate while every plugin wanting a digest got
  `undefined is not a function`.
- **Niconico** now works as a result — its home feed went from 0 items to 82.

## 0.4.0

- **`allowUrls: ["everywhere"]` is honoured.** Five plugins in the public index declare it, and it is
  a literal word rather than a glob. Treating it as a hostname pattern meant nothing ever matched,
  so every request those plugins made was refused and each reported an empty feed —
  indistinguishable from a platform with nothing on it.
- **PeerTube works** as a result, home feed 0 → 20. It is federated, which is exactly why it needs
  the wildcard: the instance a channel lives on cannot be in a fixed list.
- **A literal private, loopback, link-local, CGNAT or multicast address is now refused** regardless
  of what the manifest allows, with `allowPrivateHosts` to permit it deliberately. Honouring a
  wildcard removes the allow-list as a bound, and on a server the interesting target is
  `169.254.169.254` rather than the public internet. IPv4-mapped IPv6 is decoded rather than
  pattern-matched. It does **not** catch a hostname that resolves to a private address — see the
  README for why that cannot be done honestly here.
- `reachesAnywhere(manifest)` reports the wildcard, so a caller can refuse such a plugin up front.

## 0.3.0

Plugins returning real content went from **2 to 45**, measured across all 112 runnable plugins in
the public index.

- **`DOMParser`**, which about half the index needs. The document is parsed on the host and the
  sandbox gets integer handles. It needs no ASYNCIFY: querying a parsed document is synchronous work,
  so it is one ordinary host call per property read. On by default; `dom: false` forbids it.
- **`URL` and `URLSearchParams`**, with parsing done by the host's WHATWG parser rather than a regex.
- **The missing host classes** — the exception family, the filter classes, the article and web
  content classes, the byte-range and raw-manifest sources, and `Comment`, whose absence alone
  stopped Bitchute. Found by diffing every plugin's referenced globals against what the bootstrap
  defines.
- Documents are **evicted oldest-first** rather than refused at the cap. `release` is this library's
  own idea — GrayJay has no such method, so no real plugin calls one, and refusing would stop any
  plugin that reads page after page.

## 0.2.0

- **`fetch` is injectable**, covering the manifest fetch, the script fetch and everything the plugin
  asks for. A host usually already owns the client it must route through, and calling the global
  directly made a caller silently opt out of its proxy, user agent, metrics and deadline. The
  allow-list, request budget and response cap are enforced **around** it, so a replacement is never
  asked for a url the policy has not approved and one that throws cannot take down a feed read.
- `0.2.1` fixed the data-carrier classes, which took only a single object argument while GrayJay's
  small value classes take **positional** ones. `new PlatformID('kick')` produced
  `{ 0: 'k', 1: 'i', 2: 'c', 3: 'k', value: '' }` — an object that serialises cleanly, passes every
  shape check and carries none of the data.

## 0.1.0

First release. Twitch and Kick load and read channels and feeds.

The constraint this library exists to solve: GrayJay plugins do **synchronous** HTTP, writing
`const r = http.GET(url)` with no await anywhere. That is solved with `quickjs-emscripten`'s ASYNCIFY
build, which lets guest code call a host function synchronously while the host awaits inside it — so
no worker thread, no `Atomics.wait` and no `SharedArrayBuffer`, and the plugin still gets a real
isolation boundary with no Node globals and no network except through this host.

`0.0.0-stage` is a deprecated placeholder that reserved the name and contains no code.
