/**
 * The host side of `domParser`, which is what roughly half the plugin index needs.
 *
 * ### Why a handle table and not a DOM inside the sandbox
 *
 * The two alternatives are worse. Shipping a DOM implementation *into* QuickJS means a parser and a
 * node tree written in guest JavaScript — hundreds of kilobytes of code to maintain, evaluated on
 * every sandbox build, and slower than a real one. Serialising a parsed tree across the boundary
 * means turning a document into JSON, which for a 2 MiB page is both enormous and lossy about the
 * thing plugins actually use: live queries against the tree.
 *
 * So the document stays on the host, parsed by `linkedom` — pure JavaScript, no native build step,
 * which is the same constraint that chose QuickJS — and the sandbox gets **integer handles**. The
 * guest's node objects are thin proxies whose every property read is a call back out to
 * {@link DomSession.perform}.
 *
 * ### The reason this is fast enough to do that way
 *
 * A property read per DOM access sounds ruinous and is not, because **none of this is
 * asynchronous**. `http.GET` needs ASYNCIFY — unwinding and resuming the WASM stack — because a
 * fetch is a promise. Parsing and querying a document is synchronous work on the host, so this
 * installs an ordinary synchronous host function instead. A guest property read is then a JSON
 * round trip through one C call, with no stack unwinding at all.
 *
 * ### What is and is not provided
 *
 * A focused surface, listed in {@link PROPERTIES} and the operations below, rather than a claim to
 * implement the DOM. Plugins scrape: they query, read attributes and text, and walk a few relations.
 * That is what is here.
 *
 * A property outside the list reads as `undefined` in the sandbox rather than throwing, and that is
 * the right behaviour even though the opposite was tempting: plugins *probe*, writing
 * `if (node.dataset)` to find out what they are dealing with, and a host that threw would break a
 * plugin for asking a question the DOM answers with `undefined`.
 *
 * {@link PROPERTIES} is therefore not there to produce good error messages — it is the security
 * boundary. A plugin can call `__host_dom` directly with any name it likes, and forwarding that to a
 * real node would hand plugin-controlled strings to a host object, reaching `constructor`,
 * `__proto__` or a method. The guest-side proxies only ever ask for names on the list; the host
 * refuses everything else because the guest is not trusted to.
 *
 * Mutation is deliberately absent. A plugin has no reason to edit a document it only parsed to read,
 * and leaving it out keeps this a one-way boundary.
 */

import { DOMParser } from 'linkedom';

/** What a plugin may do with a document, and what it costs the host. */
export interface DomLimits {
	/** Bytes of HTML accepted in one parse. A plugin handed a huge page gets a refusal, not a hang. */
	readonly maxBytes: number;

	/** Documents alive at once. Each is a parsed tree held on the host heap. */
	readonly maxDocuments: number;

	/**
	 * Live node handles.
	 *
	 * Capped because the table only grows: a handle is created per node the guest touches and is
	 * released only when the plugin drops the document. A plugin walking a large tree would otherwise
	 * pin every node it has ever seen.
	 */
	readonly maxHandles: number;
}

export const DEFAULT_DOM_LIMITS: DomLimits = {
	// Generous: YouTube's watch page is over 1 MiB of HTML, and a cap that refuses real pages would
	// make this feature useless rather than safe.
	maxBytes: 8 * 1024 * 1024,
	maxDocuments: 8,
	maxHandles: 200_000
};

/**
 * Node properties a plugin may read, and nothing else.
 *
 * An allow-list rather than a pass-through to the real node. Forwarding an arbitrary property name
 * to `linkedom` would hand plugin-controlled strings to a host object — reaching `constructor`,
 * `__proto__` or a method — which is the sort of thing a sandbox exists to prevent.
 */
const PROPERTIES = new Set([
	'textContent',
	'innerText',
	'innerHTML',
	'outerHTML',
	'tagName',
	'localName',
	'nodeName',
	'nodeType',
	'id',
	'className',
	'value',
	'href',
	'src',
	'title',
	'alt',
	'type',
	'name',
	'content'
]);

/** Relations a plugin may follow. Element-wise where the DOM offers both, since scrapers want that. */
const RELATIONS = new Set([
	'parentElement',
	'parentNode',
	'firstElementChild',
	'lastElementChild',
	'nextElementSibling',
	'previousElementSibling'
]);

/** A node as the guest refers to one. Opaque; it means nothing outside its session. */
type Handle = number;

/**
 * A string field of a guest request.
 *
 * Validated rather than coerced. Every value here crosses from the sandbox, so a plugin can send an
 * object where a selector belongs — and `String({})` is `'[object Object]'`, a selector that parses,
 * matches nothing, and makes the plugin report an empty page instead of a mistake. A non-string is
 * a refusal naming the field.
 */
function text(message: Record<string, unknown>, field: string, fallback?: string): string {
	const value = message[field];

	if (typeof value === 'string') return value;
	if (value === undefined && fallback !== undefined) return fallback;

	throw new DomRefused(`'${field}' must be a string`);
}

/** Enough of a parsed node for the operations here, without depending on linkedom's own types. */
interface DomNode {
	readonly nodeType?: number;
	querySelector?: (selector: string) => DomNode | null;
	querySelectorAll?: (selector: string) => Iterable<DomNode>;
	getAttribute?: (name: string) => string | null;
	hasAttribute?: (name: string) => boolean;
	getElementById?: (id: string) => DomNode | null;
	getElementsByClassName?: (name: string) => Iterable<DomNode>;
	getElementsByTagName?: (name: string) => Iterable<DomNode>;
	readonly attributes?: Iterable<{ name: string; value: string }>;
	readonly children?: Iterable<DomNode>;
	readonly childNodes?: Iterable<DomNode>;
	readonly classList?: Iterable<string>;
	[key: string]: unknown;
}

/** A plugin asked for something this does not provide, or asked for too much. */
export class DomRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DomRefused';
	}
}

/**
 * One plugin's parsed documents.
 *
 * Per sandbox rather than per call, because a plugin legitimately parses a page in one call and
 * reads it in the next — unlike the HTTP budget, which is per call precisely because requests are
 * the thing that must not accumulate.
 */
export class DomSession {
	/**
	 * Every live node, by handle, with the document it came from.
	 *
	 * A map and a monotonic counter rather than an array and truncation. The first version used an
	 * array whose length was cut back to drop a document, which can only ever drop the *newest* — and
	 * what this needs is to drop the **oldest**. A counter that never rewinds also means a stale
	 * handle is always refused rather than quietly naming somebody else's node, which is the
	 * difference between a plugin getting an error and a plugin reporting another page's data as this
	 * page's.
	 */
	private readonly nodes = new Map<Handle, { node: DomNode; document: Handle }>();

	/** Each document's handles, so evicting one drops exactly its nodes and no others. */
	private readonly documents = new Map<Handle, Set<Handle>>();

	/** Document handles in the order they were parsed, which is the order they are evicted in. */
	private readonly order: Handle[] = [];

	private next = 1;

	/** Which document new handles are filed under. Set by `parse` and by every `lookup`. */
	private current: Handle = 0;

	constructor(private readonly limits: DomLimits = DEFAULT_DOM_LIMITS) {}

	/** How many handles are live. For tests and for a caller that wants to log it. */
	get handles(): number {
		return this.nodes.size;
	}

	/**
	 * One operation, as JSON in and JSON out.
	 *
	 * A single entry point, so the sandbox installs one function rather than twenty — and so every
	 * operation goes through the same validation. A refusal is returned as `{ error }` rather than
	 * thrown across the boundary, because the guest side turns that into a real `Error` with the
	 * message intact, which is what puts a usable sentence in front of a plugin author.
	 */
	perform(request: string): string {
		try {
			return JSON.stringify(this.dispatch(JSON.parse(request) as Record<string, unknown>));
		} catch (cause) {
			return JSON.stringify({
				error: cause instanceof Error ? cause.message : 'the host could not perform that'
			});
		}
	}

	/** Frees every document and node. Called when the sandbox is disposed. */
	clear(): void {
		this.nodes.clear();
		this.documents.clear();
		this.order.length = 0;
	}

	private dispatch(message: Record<string, unknown>): unknown {
		const op = text(message, 'op', '');

		switch (op) {
			case 'parse':
				return { h: this.parse(text(message, 'html', ''), text(message, 'mime', 'text/html')) };
			case 'query':
				return this.query(message);
			case 'get':
				return { v: this.get(message) };
			case 'attr':
				return { v: this.attribute(message) };
			case 'attrs':
				return { v: this.attributes(message) };
			case 'has':
				return { v: this.hasAttribute(message) };
			case 'classes':
				return { v: this.classes(message) };
			case 'kids':
				return { hs: this.children(message) };
			case 'rel':
				return { h: this.relation(message) };
			case 'release':
				this.release(Number(message.h));
				return {};
			default:
				throw new DomRefused(`grayjay-plugin-host does not provide the DOM operation '${op}'`);
		}
	}

	/** A document, as a handle to its root. */
	private parse(html: string, mime: string): Handle {
		// Byte length, not string length: the cap is about host memory, and a page of CJK text is
		// three times its character count.
		const bytes = new TextEncoder().encode(html).length;

		if (bytes > this.limits.maxBytes) {
			throw new DomRefused(
				`the document is ${String(bytes)} bytes, over the host limit of ${String(this.limits.maxBytes)}`
			);
		}

		// Evicted, not refused. `release` is this library's own idea — GrayJay has no such method, so
		// no real plugin calls it, and a plugin reading page after page would simply hit a wall at the
		// cap and report the platform as broken. Dropping the document it finished with several pages
		// ago is both bounded and what it would have asked for.
		while (this.order.length >= this.limits.maxDocuments) this.evict();

		// `text/html` and `text/xml` are what plugins pass; linkedom takes both. An unknown type is
		// treated as HTML rather than refused, because that is what a browser does and a plugin
		// passing `application/xhtml+xml` is not making a mistake worth failing.
		const type = mime === 'text/xml' || mime === 'application/xml' ? 'text/xml' : 'text/html';
		const parsed = new DOMParser().parseFromString(html, type) as unknown as DomNode;
		const handle = this.next;

		// Registered before `remember`, because `remember` files a node under the current document.
		this.documents.set(handle, new Set());
		this.order.push(handle);
		this.current = handle;

		return this.remember(parsed);
	}

	private query(message: Record<string, unknown>): unknown {
		const node = this.lookup(Number(message.h));
		const selector = text(message, 'sel', '');
		const all = message.all === true;

		// The `try` covers the query and nothing else, deliberately narrowly. Wrapping the handle
		// allocation below in it too meant a `DomRefused` from exceeding the handle cap came back to
		// the plugin as `'*' is not a selector this host can evaluate` — a true-sounding, entirely
		// wrong diagnosis of a valid selector, which is how a broad catch turns one bug into two.
		const found = (): readonly DomNode[] => {
			try {
				return all
					? [...(node.querySelectorAll?.(selector) ?? [])]
					: [node.querySelector?.(selector) ?? null].filter(
							(entry): entry is DomNode => entry !== null
						);
			} catch {
				// Selector syntax a plugin got wrong is the plugin's bug, and `linkedom` throws for it.
				// Named rather than passed through, because the raw message mentions internals a plugin
				// author cannot act on.
				throw new DomRefused(`'${selector}' is not a selector this host can evaluate`);
			}
		};

		const nodes = found();

		if (all) return { hs: nodes.map((entry) => this.remember(entry)) };

		const one = nodes[0];

		return { h: one === undefined ? null : this.remember(one) };
	}

	private get(message: Record<string, unknown>): unknown {
		const name = text(message, 'name', '');

		if (!PROPERTIES.has(name)) {
			throw new DomRefused(`grayjay-plugin-host does not provide the node property '${name}'`);
		}

		const value = this.lookup(Number(message.h))[name];

		// Only primitives cross the boundary. A property holding a node is reached through `rel`,
		// which returns a handle — so nothing here can leak a host object into the sandbox.
		return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
			? value
			: null;
	}

	private attribute(message: Record<string, unknown>): string | null {
		return this.lookup(Number(message.h)).getAttribute?.(text(message, 'name', '')) ?? null;
	}

	private attributes(message: Record<string, unknown>): Record<string, string> {
		const found: Record<string, string> = {};

		for (const entry of this.lookup(Number(message.h)).attributes ?? []) {
			found[entry.name] = entry.value;
		}

		return found;
	}

	private hasAttribute(message: Record<string, unknown>): boolean {
		return this.lookup(Number(message.h)).hasAttribute?.(text(message, 'name', '')) ?? false;
	}

	private classes(message: Record<string, unknown>): string[] {
		return [...(this.lookup(Number(message.h)).classList ?? [])];
	}

	private children(message: Record<string, unknown>): Handle[] {
		const node = this.lookup(Number(message.h));
		const found = message.elements === false ? node.childNodes : node.children;

		return [...(found ?? [])].map((entry) => this.remember(entry));
	}

	private relation(message: Record<string, unknown>): Handle | null {
		const which = text(message, 'which', '');

		if (!RELATIONS.has(which)) {
			throw new DomRefused(`grayjay-plugin-host does not provide the relation '${which}'`);
		}

		const found = this.lookup(Number(message.h))[which];

		return typeof found === 'object' && found !== null ? this.remember(found as DomNode) : null;
	}

	/**
	 * Drops a document and every handle taken since it was parsed.
	 *
	 * Truncating rather than deleting individually: handles are issued in order, so everything after
	 * a document's own handle belongs to it or to a later one, and a plugin releases documents in the
	 * order it parsed them. A stale handle then looks up as invalid and is refused, which is the
	 * correct answer to using a node from a released document.
	 */
	private release(handle: Handle): void {
		const owned = this.documents.get(handle);

		if (owned === undefined) return;

		for (const node of owned) this.nodes.delete(node);

		this.documents.delete(handle);

		const at = this.order.indexOf(handle);

		if (at !== -1) this.order.splice(at, 1);
	}

	/** Drops the oldest document, which is the one a plugin is least likely to still be reading. */
	private evict(): void {
		const oldest = this.order[0];

		if (oldest !== undefined) this.release(oldest);
	}

	/**
	 * A handle for a node, filed under the document being worked on.
	 *
	 * Over the cap, the oldest document is evicted rather than the request refused — same reasoning
	 * as in `parse`. Refusing only when a *single* document has outgrown the whole budget, because
	 * then there is nothing older to give up and the honest answer is that the page is too big.
	 */
	private remember(node: DomNode): Handle {
		while (this.nodes.size >= this.limits.maxHandles && this.order.length > 1) this.evict();

		if (this.nodes.size >= this.limits.maxHandles) {
			throw new DomRefused(
				`this document alone needs more than ${String(this.limits.maxHandles)} DOM nodes, which is over the host limit`
			);
		}

		const handle = this.next;

		this.next += 1;
		this.nodes.set(handle, { node, document: this.current });
		this.documents.get(this.current)?.add(handle);

		return handle;
	}

	/** The node a handle names. */
	private lookup(handle: Handle): DomNode {
		const found = Number.isInteger(handle) ? this.nodes.get(handle) : undefined;

		if (found === undefined) {
			// Reached by a plugin using a node from a document that was released or evicted, which is
			// worth naming rather than answering from a recycled handle.
			throw new DomRefused(`${String(handle)} is not a live DOM node in this session`);
		}

		// The document a node belongs to becomes the one new handles are filed under, so a query from
		// a node attributes its results to the right document without the guest having to say which.
		this.current = found.document;

		return found.node;
	}
}
