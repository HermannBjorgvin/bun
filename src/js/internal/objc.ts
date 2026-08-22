// The Objective-C bridge behind bun:appkit: any Objective-C class and
// selector by Apple's name. This is the layer bun:appkit's windows, menus and
// views are written on, and what a script uses (as `objc`) for everything
// they do not cover. Natives (binding.ObjCObject / ObjCClass) are handed out
// wrapped in a Proxy whose string properties are selectors. The proxy target
// is the native itself: that keeps it (and the id it retains) alive, lets
// the native side see through proxies passed back as arguments, and is what
// console.log shows. The native side hands out one wrapper per object (a
// class always as an ObjCClass), so one object is one proxy and `===` works.

type NativeObjCObject = {
  msgSend(selector: string, ...args: unknown[]): unknown;
  readonly className: string;
  readonly address: bigint;
  release(): void;
  readonly released: boolean;
  /** `-description`. */
  toString(): string;
};

type NativeObjCClass = {
  msgSend(selector: string, ...args: unknown[]): unknown;
  readonly name: string;
  readonly address: bigint;
  toString(): string;
};

type NativeObjC = NativeObjCObject | NativeObjCClass;

/** A wrapped native as scripts see it: every property is a selector-shaped method. */
type Handle = { [selector: string]: (...args: unknown[]) => any };

type NativeObjCSelector = {
  readonly name: string;
  toString(): string;
};

type Binding = {
  ObjCObject: { prototype: NativeObjCObject };
  ObjCClass: { prototype: NativeObjCClass };
  ObjCSelector: { new (name: string): NativeObjCSelector; prototype: NativeObjCSelector };
  objcLookupClass(name: string): NativeObjCClass;
  objcLookupProtocol(name: string): NativeObjCObject;
  objcJs(value: unknown): unknown;
  objcNs(value: unknown): NativeObjCObject | null;
  /** The same object, counted as handed out once more. */
  objcAcquire(object: NativeObjCObject): NativeObjCObject;
  objcResponds(object: NativeObjC, selector: string): boolean;
  objcMethodNames(object: NativeObjC): string[];
  objcConstant(name: string, types: string): unknown;
  objcIsBlock(object: NativeObjC): boolean;
  objcInvokeBlock(block: NativeObjCObject, ...args: unknown[]): unknown;
  objcSetHooks(
    dispatch: (fn: Function, receiver: NativeObjCObject | undefined, args: unknown[]) => unknown,
    outs: unknown[],
  ): void;
  objcDefineClass(
    name: string | undefined,
    superclass: unknown,
    protocols: string[],
    selectors: string[],
    types: (string | undefined)[],
    functions: Function[],
  ): NativeObjCClass;
  objcTargetClass(): NativeObjCClass;
  objcAttach(object: unknown, table: Record<string, Function>): void;
  objcBlock(fn: Function, types: string): NativeObjCObject;
};

const binding = $rust("appkit.rs", "createObjcBinding") as Binding;

const ArrayIsArray = Array.isArray;
const ObjectKeys = Object.keys;
const ObjectFreeze = Object.freeze;
const ObjectHasOwn = Object.hasOwn;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const emptyList = ObjectFreeze([]);

function typeError(message: string) {
  return new TypeError(message);
}

/**
 * Where the native side leaves (argument index, value) pairs for what a
 * send stored through its out-parameters; {@link send} empties it.
 */
const outs: unknown[] = [];
// How the native side runs a method of a script-defined class (the receiver
// becomes `this`) or the function behind a block (no receiver), and where it
// leaves what a send stored through its out-parameters. This claims the
// bridge for this global object, so it goes first: if the claim is refused
// nothing else here has run.
binding.objcSetHooks(
  (fn: Function, receiver: NativeObjCObject | undefined, args: unknown[]): unknown =>
    argumentOf(fn.$apply(fromNative(receiver), fromNative(args) as unknown[])),
  outs,
);

const ObjCObject = binding.ObjCObject;
const ObjCClass = binding.ObjCClass;
const ObjCSelector = binding.ObjCSelector;
const objcPointer = Symbol("objc.pointer");
const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
/** `NSNotFound` (`NSIntegerMax`), as the bridge returns it. */
const NSNotFound = 9223372036854775807n;

// The natives' own methods, taken once so that a script reaching the shared
// prototype through Object.getPrototypeOf(handle) cannot reroute sends.
const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
const { msgSend: objectMsgSend, toString: objectToString, release: objectRelease } = ObjCObject.prototype;
const objectClassName = getter(ObjCObject.prototype, "className");
const objectAddress = getter(ObjCObject.prototype, "address");
const objectReleased = getter(ObjCObject.prototype, "released");
const { msgSend: classMsgSend, toString: classToString } = ObjCClass.prototype;
const className = getter(ObjCClass.prototype, "name");
const classAddress = getter(ObjCClass.prototype, "address");

const isClassNative = (native: NativeObjC): native is NativeObjCClass => native instanceof ObjCClass;
const nativeToString = (native: NativeObjC): string =>
  isClassNative(native) ? classToString.$call(native) : objectToString.$call(native);
const nativeAddress = (native: NativeObjC): bigint =>
  isClassNative(native) ? classAddress.$call(native) : objectAddress.$call(native);

/** What console.log and util.inspect show: `[objc NSWindow: <NSWindow: 0x…>]`, `[objc class NSString]`. */
function inspectNative(native: NativeObjC): string {
  if (isClassNative(native)) return `[objc class ${className.$call(native)}]`;
  if (objectReleased.$call(native)) return "[objc released]";
  if (objectAddress.$call(native) === 0n) return `[objc ${objectClassName.$call(native)} alloc]`;
  return `[objc ${objectClassName.$call(native)}: ${objectToString.$call(native)}]`;
}
/** native wrapper -> its proxy, so one wrapper always surfaces as the same object. */
const proxyOfNative = new WeakMap<object, object>();
/** proxy -> native wrapper. */
const nativeOfProxy = new WeakMap<object, NativeObjC>();
// console.log prints a proxy's target, so the natives answer for themselves
// (util.inspect asks the target too, but with the proxy as `this`).
for (const proto of [ObjCObject.prototype, ObjCClass.prototype]) {
  ObjectDefineProperty(proto, inspectCustom, {
    value(this: NativeObjC) {
      return inspectNative(nativeOfProxy.get(this) ?? this);
    },
  });
}

/**
 * `setFrame_display_` -> `setFrame:display:` taking 2 arguments. Leading
 * underscores are kept, an interior `__` is a literal `_`, and every other
 * `_` is a `:`.
 */
function selectorFromProperty(property: string): { selector: string; colons: number } {
  const length = property.length;
  let lead = 0;
  while (lead < length && property.charCodeAt(lead) === 95) lead++;
  let end = length;
  while (end > lead && property.charCodeAt(end - 1) === 95) end--;
  const trailing = length - end;
  let selector = property.slice(0, lead);
  let colons = trailing;
  for (let i = lead; i < end; i++) {
    if (property.charCodeAt(i) !== 95) {
      selector += property[i];
    } else if (i + 1 < end && property.charCodeAt(i + 1) === 95) {
      selector += "_";
      i++;
    } else {
      selector += ":";
      colons++;
    }
  }
  for (let i = 0; i < trailing; i++) selector += ":";
  return { selector, colons };
}

/** `count:with:` -> `count_with_`; the reverse of {@link selectorFromProperty}. */
function propertyFromSelector(selector: string): string {
  let lead = 0;
  while (lead < selector.length && selector.charCodeAt(lead) === 95) lead++;
  return selector.slice(0, lead) + selector.slice(lead).replaceAll("_", "__").replaceAll(":", "_");
}

function receiverName(native: NativeObjC): string {
  return isClassNative(native) ? `+[${className.$call(native)}` : `-[${objectClassName.$call(native)}`;
}

/**
 * Arguments go to the native side as they are, for it to convert by the
 * method's signature or reject, except the objects `refused` has a message
 * for: bun:appkit's View and Window, which the native side would only see
 * as objects it cannot convert when the likely intent was their `.native`.
 */
let refused: (value: object) => string | undefined = () => undefined;
function argumentOf(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    const message = refused(value);
    if (message !== undefined) throw typeError(message);
  }
  return value;
}

/** Natives (at any depth of an array/object the native side built) become proxies, in place. */
function fromNative(value: unknown): unknown {
  if (typeof value !== "object" || value === null || nativeOfProxy.has(value)) return value;
  if (value instanceof ObjCObject || value instanceof ObjCClass) return wrapObject(value);
  if (ArrayIsArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = fromNative(value[i]);
    return value;
  }
  if (ObjectGetPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    for (const key of ObjectKeys(record)) record[key] = fromNative(record[key]);
  }
  return value;
}

/**
 * One send (or, with a null selector, one call of the block `native` is):
 * arguments checked, natives in the result and in out-parameters proxied,
 * an Objective-C exception's object proxied too.
 */
function send(native: NativeObjC, selector: string | null, args: ArrayLike<unknown>): unknown {
  const argv: unknown[] = [selector ?? native];
  for (let i = 0; i < args.length; i++) argv.push(argumentOf(args[i]));
  let result: unknown;
  try {
    result =
      selector === null
        ? binding.objcInvokeBlock.$apply(undefined, argv as [NativeObjCObject])
        : (isClassNative(native) ? classMsgSend : objectMsgSend).$apply(native, argv);
  } catch (error) {
    outs.length = 0;
    throw surfaced(error);
  }
  // What the method stored through each out-parameter goes in the `{ value }` passed for it.
  if (outs.length > 0) {
    try {
      for (let i = 0; i < outs.length; i += 2) {
        (argv[(outs[i] as number) + 1] as { value: unknown }).value = fromNative(outs[i + 1]);
      }
    } finally {
      outs.length = 0;
    }
  }
  return fromNative(result);
}

/** An Objective-C exception carries the thrown object as a native; hand it out like a result. */
function surfaced(error: unknown): unknown {
  const thrown = error as { code?: unknown; exception?: unknown } | null;
  if (thrown?.code === "ERR_OBJC_EXCEPTION") thrown.exception = fromNative(thrown.exception);
  return error;
}

/**
 * The method a selector-shaped property stands for. Passing more arguments
 * than the selector has colons is refused here; fewer reach the native side,
 * which passes NULL for out-parameters left off the end and refuses the rest.
 */
function selectorMethod(native: NativeObjC, property: string): Function {
  const { selector, colons } = selectorFromProperty(property);
  return function (...args: unknown[]) {
    const { length } = args;
    if (length > colons) {
      throw typeError(
        `${receiverName(native)} ${selector}]: "${property}" stands for a selector taking ${colons} argument${colons === 1 ? "" : "s"}, but ${length} ${length === 1 ? "was" : "were"} passed`,
      );
    }
    return send(native, selector, args);
  };
}

/**
 * The few string properties that are not selectors. `toJSON` matters:
 * JSON.stringify would otherwise send `toJSON:`. `release` is the wrapper's
 * (objects only): the native side refuses the reference-counting selectors.
 * `invoke` calls a block (and is the selector on anything else).
 */
const reservedMethods = new Map<string, (native: NativeObjC) => Function | undefined>([
  [
    "invoke",
    native =>
      binding.objcIsBlock(native)
        ? function invoke(...args: unknown[]) {
            return send(native, null, args);
          }
        : selectorMethod(native, "invoke"),
  ],
  [
    "msgSend",
    native =>
      function msgSend(selector: unknown, ...args: unknown[]) {
        if (typeof selector !== "string" || selector.length === 0) {
          throw typeError("msgSend(selector, ...args): selector must be a non-empty string");
        }
        return send(native, selector, args);
      },
  ],
  [
    "toString",
    native =>
      function toString() {
        return nativeToString(native);
      },
  ],
  [
    "toJSON",
    native =>
      function toJSON() {
        const converted = binding.objcJs(native);
        if (converted === native) return nativeToString(native);
        return converted instanceof Date ? converted.toJSON() : fromNative(converted);
      },
  ],
  [
    "release",
    native =>
      isClassNative(native)
        ? undefined
        : function release() {
            objectRelease.$call(native);
          },
  ],
]);

/**
 * for...of over the Foundation collections, told apart by what they
 * respond to: an `NSIndexSet` yields its indexes, an `NSDictionary` or
 * `NSMapTable` its keys, an `NSEnumerator` what it has left, and anything
 * else with an `objectEnumerator` (`NSArray`, `NSSet`, `NSOrderedSet`,
 * `NSHashTable`) its objects.
 */
function iteratorOf(native: NativeObjCObject): (() => Iterator<unknown>) | undefined {
  const { objcResponds } = binding;
  if (objcResponds(native, "indexGreaterThanIndex:")) {
    return function* indexes() {
      for (let i = send(native, "firstIndex", []); i !== NSNotFound; i = send(native, "indexGreaterThanIndex:", [i])) {
        yield i;
      }
    };
  }
  const enumerator = objcResponds(native, "keyEnumerator")
    ? "keyEnumerator"
    : objcResponds(native, "nextObject")
      ? "self"
      : objcResponds(native, "objectEnumerator")
        ? "objectEnumerator"
        : undefined;
  if (enumerator === undefined) return undefined;
  return function* objects() {
    const each = nativeOfProxy.get(send(native, enumerator, []) as object) as NativeObjCObject;
    for (let item = send(each, "nextObject", []); item !== null; item = send(each, "nextObject", [])) yield item;
  };
}

function wrapObject(native: NativeObjC): object {
  let proxy = proxyOfNative.get(native);
  if (proxy !== undefined) return proxy;
  const isClass = isClassNative(native);
  const methods = new Map<string, Function>();
  // `-description` for an object, the name for a class.
  const toPrimitive = () => nativeToString(native);
  const inspect = () => inspectNative(native);
  const release = isClass ? undefined : () => objectRelease.$call(native);
  let iterator: (() => Iterator<unknown>) | undefined | null = null;
  const usable = () => isClass || (!objectReleased.$call(native) && objectAddress.$call(native) !== 0n);
  const symbolValue = (property: symbol): unknown => {
    if (property === objcPointer) return nativeAddress(native);
    if (property === Symbol.toPrimitive) return toPrimitive;
    if (property === Symbol.toStringTag) return isClass ? "ObjCClass" : "ObjCObject";
    if (property === inspectCustom) return inspect;
    if (property === Symbol.dispose) return release;
    if (property === Symbol.iterator) {
      if (iterator === null) iterator = isClass || !usable() ? undefined : iteratorOf(native);
      return iterator;
    }
    return undefined;
  };
  // Not "then": promises resolve with the object itself rather than sending `then`.
  const method = (property: string) =>
    property === "then" ? undefined : (reservedMethods.get(property)?.(native) ?? selectorMethod(native, property));
  const responds = (property: string | symbol): boolean => {
    if (typeof property !== "string") return symbolValue(property) !== undefined;
    if (property === "then") return false;
    const reserved = reservedMethods.get(property);
    if (reserved !== undefined) return reserved(native) !== undefined;
    return usable() && binding.objcResponds(native, selectorFromProperty(property).selector);
  };
  proxy = new Proxy(native, {
    get(_target, property) {
      if (typeof property !== "string") return symbolValue(property);
      let found = methods.get(property);
      if (found === undefined) {
        found = method(property);
        if (found !== undefined) methods.set(property, found);
      }
      return found;
    },
    // `"count" in list`: whether the receiver responds to the selector.
    has(_target, property) {
      return responds(property);
    },
    // The selectors the receiver's classes implement, spelled as properties.
    ownKeys() {
      if (!usable()) return [];
      const names = new Set<string>();
      for (const name of binding.objcMethodNames(native)) names.add(propertyFromSelector(name));
      return [...names];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!responds(property)) return undefined;
      const value = typeof property === "string" ? (methods.get(property) ?? method(property)) : symbolValue(property);
      return { value, writable: false, enumerable: typeof property === "string", configurable: true };
    },
    set(_target, property) {
      throw typeError(
        `Cannot assign to ${String(property)} on an Objective-C object; call the setter, e.g. setTitle_(value)`,
      );
    },
    defineProperty() {
      throw typeError("Cannot define properties on an Objective-C object");
    },
    deleteProperty() {
      throw typeError("Cannot delete properties of an Objective-C object");
    },
  });
  proxyOfNative.set(native, proxy);
  nativeOfProxy.set(proxy, native);
  return proxy;
}

/** The cached `.native` handle of a view or window, unless the script released that handle. */
function liveHandle<T extends object>(handle: T | undefined): T | undefined {
  return handle !== undefined && objectReleased.$call(nativeOfProxy.get(handle)) ? undefined : handle;
}

/** A handle this module keeps, given to the caller: the same object, counted as theirs once more so their `release()` leaves it usable here. */
function handedOut(handle: Handle): object {
  return fromNative(binding.objcAcquire(nativeOfProxy.get(handle) as NativeObjCObject)) as object;
}

/**
 * A read-only table whose entries `lookup` computes by name (a class, a
 * protocol, a constant), once for those `keep` accepts (all of them by
 * default). The names JavaScript itself probes (await, String(),
 * JSON.stringify) read as absent: they are never Objective-C names.
 */
function namedTable<T>(
  label: string,
  lookup: (name: string) => T,
  keep: (value: T) => boolean = () => true,
): Record<string, T> {
  const readOnly = () => {
    throw typeError(`${label} is read-only`);
  };
  const toName = () => `[${label}]`;
  const cache = new Map<string, T>();
  return new Proxy(Object.create(null) as Record<string, T>, {
    get(_target, name) {
      if (name === "then") return undefined;
      if (name === "toString" || name === "toJSON" || name === Symbol.toPrimitive) return toName;
      if (typeof name !== "string") return undefined;
      let value = cache.get(name);
      if (value === undefined) {
        value = lookup(name);
        if (keep(value)) cache.set(name, value);
      }
      return value;
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  });
}

// Classes and protocols are immortal; the tables' caches keep their one handle each alive.
const objcClasses = namedTable("objc.classes", name => wrapObject(binding.objcLookupClass(name)));
const objcProtocols = namedTable("objc.protocols", name => wrapObject(binding.objcLookupProtocol(name)));

/** The generated enum and constant tables (`scripts/appkit-enums.ts`), loaded on first use. */
let loadedEnumTables: typeof import("../internal/appkit_enums").default | undefined;
const enumTables = () =>
  (loadedEnumTables ??= require("internal/appkit_enums") as typeof import("../internal/appkit_enums").default);

/** An exported constant by name, read as `type` (default: the generated table's, else an object). */
function constant(name: string, options?: { type?: string }): unknown {
  if (typeof name !== "string" || name.length === 0)
    throw typeError("objc.constant(name): name must be a non-empty string");
  let type = options?.type;
  if (type !== undefined && typeof type !== "string")
    throw typeError("objc.constant(name, { type }): type must be a type encoding string");
  const { constants } = enumTables();
  type ??= ObjectHasOwn(constants, name) ? constants[name] : "@";
  return fromNative(binding.objcConstant(name, type));
}

// An object constant is looked up each time: `NSApp` is nil until the
// application exists, and the handle table already makes repeat reads `===`.
const objcConstants = namedTable(
  "objc.constants",
  name => constant(name),
  value => value !== null && (typeof value !== "object" || !nativeOfProxy.has(value)),
);

/** `PNGFileType` -> `pngFileType`, `Titled` -> `titled`, `URL` -> `url`: the first word in lower case. */
function lowerFirstWord(suffix: string): string {
  const first = /^[A-Z]+(?![a-z])|^[A-Z]/.exec(suffix)?.[0] ?? "";
  return first.toLowerCase() + suffix.slice(first.length);
}

/**
 * One enum: its members by short name (`titled`) and by full name
 * (`NSWindowStyleMaskTitled`), frozen. Built on first use from the
 * generated `[prefix, suffix, value, ...]` row.
 */
function enumObject(typeName: string, row: (string | number | bigint)[]): Readonly<Record<string, number | bigint>> {
  const prefix = row[0] as string;
  const members: Record<string, number | bigint> = Object.create(null);
  for (let i = 1; i < row.length; i += 2) {
    const suffix = row[i] as string;
    const value = row[i + 1] as number | bigint;
    if (suffix.startsWith("=")) {
      members[suffix.slice(1)] = value;
    } else {
      members[lowerFirstWord(suffix)] = value;
      members[prefix + suffix] = value;
    }
  }
  ObjectDefineProperty(members, Symbol.toStringTag, { value: typeName });
  return ObjectFreeze(members);
}

/** Every member of every enum by its full name, built once on the first lookup that needs it. */
let enumMembers: Map<string, number | bigint> | undefined;

const objcEnums = namedTable("objc.enums", name => {
  const { enums, loose } = enumTables();
  if (ObjectHasOwn(enums, name)) return enumObject(name, enums[name]);
  if (ObjectHasOwn(loose, name)) return loose[name];
  if (enumMembers === undefined) {
    enumMembers = new Map();
    for (const typeName of ObjectKeys(enums)) {
      const row = enums[typeName];
      const prefix = row[0] as string;
      for (let i = 1; i < row.length; i += 2) {
        const suffix = row[i] as string;
        enumMembers.set(suffix.startsWith("=") ? suffix.slice(1) : prefix + suffix, row[i + 1] as number | bigint);
      }
    }
  }
  const member = enumMembers.get(name);
  if (member !== undefined) return member;
  throw typeError(
    `objc.enums: no enum or constant named "${name}" in the Foundation, AppKit, QuartzCore or Metal headers`,
  );
});

/** A method whose result never changes can be given as the result. */
type ScriptConstant = boolean | number | bigint | null;
type ScriptMethod =
  | Function
  | ScriptConstant
  | { types?: string; fn: Function }
  | { types?: string; value: ScriptConstant };
const isScriptConstant = (value: unknown): value is ScriptConstant =>
  value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint";
type ClassDefinition = {
  name?: string;
  superclass?: string | object;
  protocols?: string[];
  methods: Record<string, ScriptMethod>;
};

const classNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defineClass(definition: ClassDefinition): object {
  if (typeof definition !== "object" || definition === null) {
    throw typeError("objc.defineClass(definition): definition must be an object");
  }
  const { name, superclass = "NSObject", protocols = [], methods } = definition;
  if (name !== undefined && (typeof name !== "string" || !classNamePattern.test(name))) {
    throw typeError("objc.defineClass(): name must be a string of letters, digits and _");
  }
  const superclassHandle = typeof superclass === "string" ? objcClasses[superclass] : superclass;
  if (!ArrayIsArray(protocols)) {
    throw typeError("objc.defineClass(): protocols must be an array of protocol names");
  }
  if (typeof methods !== "object" || methods === null) {
    throw typeError("objc.defineClass(): methods must be an object of functions keyed by selector");
  }
  const selectors: string[] = [];
  const types: (string | undefined)[] = [];
  /** Each method's function, or its constant result. */
  const bodies: unknown[] = [];
  for (const key of ObjectKeys(methods)) {
    const method = methods[key] as ScriptMethod | undefined;
    let body: unknown = method;
    let encoding: unknown;
    if (typeof method === "object" && method !== null) {
      body = "fn" in method ? method.fn : (method as { value?: unknown }).value;
      encoding = method.types;
    }
    if (
      (typeof body !== "function" && !isScriptConstant(body)) ||
      (encoding !== undefined && typeof encoding !== "string")
    ) {
      throw typeError(
        `objc.defineClass(): methods[${JSON.stringify(key)}] must be a function, a constant (boolean, number or null), or { types, fn } or { types, value } with types a string`,
      );
    }
    // A key spelled the way sends are (`tableView_objectValueForTableColumn_row_`) names the same selector.
    let selector = key;
    let colons = 0;
    if (key.includes(":")) {
      for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) === 58) colons++;
    } else {
      ({ selector, colons } = selectorFromProperty(key));
    }
    const declared = typeof body === "function" ? body.length : 0;
    if (declared > colons) {
      throw typeError(
        `objc.defineClass(): "${selector}" takes ${colons} argument${colons === 1 ? "" : "s"} but its function declares ${declared}`,
      );
    }
    selectors.push(selector);
    types.push(encoding as string | undefined);
    bodies.push(body);
  }
  return fromNative(binding.objcDefineClass(name, superclassHandle, protocols, selectors, types, bodies)) as object;
}

/** The one class behind every thread's objc.target(): `action:` looks its function up on the instance. */
let targetClass: { new: () => object } | undefined;

const objc = {
  classes: objcClasses,
  protocols: objcProtocols,
  constants: objcConstants,
  constant,
  enums: objcEnums,
  pointer: objcPointer,
  NSNotFound,
  sel(name: string): NativeObjCSelector {
    if (typeof name !== "string" || name.length === 0) {
      throw typeError("objc.sel(name): name must be a non-empty string");
    }
    return new ObjCSelector(name);
  },
  js(value: unknown): unknown {
    const converted = binding.objcJs(value);
    return converted === value ? value : fromNative(converted);
  },
  ns(value: unknown): object | null {
    return fromNative(binding.objcNs(argumentOf(value))) as object | null;
  },
  /** One object is one handle, so this is `===` between handles; anything that is not a handle is not the same. */
  same(a: unknown, b: unknown): boolean {
    return a === b && typeof a === "object" && a !== null && nativeOfProxy.has(a);
  },
  /** Storage for an out-parameter (`NSError **`, `BOOL *`, `NSRange *`): pass it, then read `.value`. */
  out<T>(value?: T): { value: T | undefined } {
    return { value };
  },
  defineClass,
  target(fn: (sender: object | null) => unknown): object {
    if (typeof fn !== "function") throw typeError("objc.target(fn): fn must be a function");
    targetClass ??= fromNative(binding.objcTargetClass()) as { new: () => object };
    const target = targetClass.new();
    binding.objcAttach(target, { "action:": fn });
    return target;
  },
  /** Without `types`: no result and one object per parameter `fn` declares. */
  block(fn: Function, types?: string): object {
    if (typeof fn !== "function") throw typeError("objc.block(fn, types): fn must be a function");
    if (types === undefined) types = "v@?" + "@".repeat(fn.length);
    else if (typeof types !== "string") throw typeError("objc.block(fn, types): types must be a string");
    return fromNative(binding.objcBlock(fn, types)) as object;
  },
};

/**
 * One send whose object result is wanted only as its plain value (a string,
 * a list of them) or not at all: converted with `objc.js` and the reference
 * given straight back, without making the result a handle.
 */
function plainSend(receiver: Handle, selector: string, ...args: unknown[]): unknown {
  let raw: unknown;
  try {
    raw = objectMsgSend.$apply(nativeOfProxy.get(receiver), [selector, ...args]);
  } catch (error) {
    throw surfaced(error);
  }
  if (!(raw instanceof ObjCObject)) return raw;
  const plain = binding.objcJs(raw);
  objectRelease.$call(raw);
  return plain === raw ? undefined : plain;
}

/**
 * Gives back the read that produced `object`: a result this module looked
 * at (a view's window, layer or cell, a shared colour or font) rather than
 * kept, so that looking leaves the count of times the object was handed out,
 * which `release()` counts down, where the script left it.
 */
function giveBack(object: unknown): void {
  if (object == null) return;
  const native = nativeOfProxy.get(object as object);
  if (native instanceof ObjCObject) objectRelease.$call(native);
}

/** `use` applied to `object`, whose read is given back once it returns; see {@link giveBack}. */
function looking<T, R>(object: T, use: (object: T) => R): R {
  try {
    return use(object);
  } finally {
    giveBack(object);
  }
}

/** An NSString-returning send as a string, nil as "". */
function stringOf(receiver: Handle, selector: string, ...args: unknown[]): string {
  const text = plainSend(receiver, selector, ...args);
  return text == null ? "" : typeof text === "string" ? text : String(text);
}

/** An NSArray-of-NSString-returning send as a frozen list. */
function stringsOf(receiver: Handle, selector: string): readonly string[] {
  const list = plainSend(receiver, selector);
  return ArrayIsArray(list) ? ObjectFreeze(list.map(String)) : emptyList;
}

/** An NSArray-of-objects-returning send as a list of handles. */
function handlesOf(receiver: Handle, selector: string): Handle[] {
  const list = plainSend(receiver, selector);
  return ArrayIsArray(list) ? (fromNative(list) as Handle[]) : [];
}

export default {
  objc,
  classes: objcClasses,
  enums: objcEnums,
  constants: objcConstants,
  enumTables,
  lowerFirstWord,
  defineClass,
  wrapObject,
  liveHandle,
  handedOut,
  plainSend,
  giveBack,
  looking,
  stringOf,
  stringsOf,
  handlesOf,
  /** Lets bun:appkit name the objects of its own that must not be passed as arguments. */
  refuseArguments(refuse: (value: object) => string | undefined): void {
    refused = refuse;
  },
};
