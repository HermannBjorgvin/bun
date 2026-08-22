// Hardcoded module "bun:appkit"
//
// Plain ES classes over the Objective-C bridge (`objc`, which lives in
// src/js/internal/objc.ts) and two native wrappers (the AppKitApp singleton,
// and AppKitView for the one kind still built natively: MetalView). The tree lives here: a parent's #children
// array keeps child Views alive, a Window keeps its root view, and
// `openWindows` keeps every open Window. The natives only hold weak
// references back.
//
// Windows, the menu bar and every other view are built here, through the
// bridge: the class makes the NSWindow, NSMenu or NSView, wires a control's
// target/action or a delegate (a table's data source) to a script object and
// reads and writes it with plain sends. What every view shares (a place in a
// container or window, the size props, `grow`, decoration, `frame`,
// `snapshot`) is done here too, on the view's NSView handle, so the natively
// built kind and a bridge-built one lay out alike.

type NativeView = {
  set(key: string, value: unknown): void;
  onFrame: Function | undefined;
  onResize: Function | undefined;
  readonly drawableSize: { width: number; height: number } | null | undefined;
  draw(): void;
  readonly native: NativeObjCObject;
};

type NativeObjCObject = {
  msgSend(selector: string, ...args: unknown[]): unknown;
  readonly className: string;
  readonly address: bigint;
  release(): void;
  readonly released: boolean;
  /** `-description`. */
  toString(): string;
};

/** A wrapped native as scripts see it: every property is a selector-shaped method (see internal/objc). */
type Handle = { [selector: string]: (...args: unknown[]) => any };

type NativeApp = {
  start(policy: string): void;
  quit(): void;
  activate(): void;
  hide(): void;
  set(key: string, value: unknown): void;
  readonly isDark: boolean;
  readonly hasDisplay: boolean;
  testing(op: string, a?: unknown, b?: unknown): unknown;
  onBeforeQuit: Function | undefined;
  onCloseAll: Function | undefined;
  onReopen: Function | undefined;
};

type NativeGpu = {
  readonly available: boolean;
  readonly name: string | null;
  readonly unifiedMemory: boolean;
  registerErrors(make: (kind: "compile" | "execution", message: string) => Error): void;
  buffer(data: unknown, opts?: unknown): unknown;
  texture(opts: unknown): unknown;
  library(source: unknown, opts?: unknown): unknown;
  renderPipeline(opts: unknown): unknown;
  computePipeline(fn: unknown, opts?: unknown): unknown;
  sampler(opts?: unknown): unknown;
  depthStencil(opts?: unknown): unknown;
  frame(opts?: unknown): NativeFrame;
};

type NativeFrame = {
  renderPass(target: unknown, options?: unknown): NativeFrame;
  commitAndWait(): void;
  readonly committed: boolean;
};

// The Gpu* classes are the native wrappers themselves; their constructors throw.
type Binding = {
  AppKitView: new () => NativeView;
  app: NativeApp;
  gpu: NativeGpu;
  GpuBuffer: Function;
  GpuTexture: Function;
  GpuLibrary: Function;
  GpuFunction: Function;
  GpuRenderPipeline: Function;
  GpuComputePipeline: Function;
  GpuSampler: Function;
  GpuDepthStencil: Function;
  GpuFrame: { prototype: NativeFrame };
};

const binding = $rust("appkit.rs", "createBinding") as Binding;
// The Objective-C bridge everything below is written with; loaded first, so
// a global object the bridge refuses gets no further here either.
const bridge = require("internal/objc") as typeof import("../internal/objc").default;
const {
  objc,
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
  enumTables,
  lowerFirstWord,
} = bridge;
const objcClasses = bridge.classes;
const objcEnums = bridge.enums;
const objcConstants = bridge.constants;
// A View or Window passed as a message argument is refused with a pointer to
// its `.native`; the bridge cannot see these classes itself.
bridge.refuseArguments((value: object) =>
  value instanceof View
    ? `pass view.native (the NSView) rather than the ${kindOf(value)} itself`
    : value instanceof Window
      ? "pass window.native (the NSWindow) rather than the Window itself"
      : undefined,
);
const AppKitView = binding.AppKitView;
const nativeApp = binding.app;
const nativeGpu = binding.gpu;
// What bun:internal-for-testing reaches that is not public API.
const hooks = require("internal/appkit_private") as typeof import("../internal/appkit_private").default;
const { basename } = require("node:path") as typeof import("node:path");

const ArrayIsArray = Array.isArray;
const ObjectKeys = Object.keys;
const ObjectFreeze = Object.freeze;
const ObjectHasOwn = Object.hasOwn;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetPrototypeOf = Object.getPrototypeOf;

hooks.testing = (op, a, b) => nativeApp.testing(op, a, b);

// A listener that throws must not stop the others or change their verdict;
// the error surfaces the way an uncaught one does.
function guarded(fn: Function, args: unknown[]): unknown {
  try {
    return fn.$apply(undefined, args);
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

// AppKit reports many things synchronously from inside the call that caused
// them: removing or hiding a focused text field ends its editing, closing a
// window does too. The controls built here hear that through their delegate
// or target while this module is halfway through the call (the container's
// children not yet updated, the native view mid-change). So while a call
// into the natives is in progress (`hold`), what the controls would deliver
// waits in `heldDeliveries`, and the outermost `unhold` runs it: handlers see
// settled state, and still run before the call that caused them returns.
let holds = 0;
const heldDeliveries: (() => void)[] = [];

function hold(): void {
  holds++;
}

function unhold(): void {
  if (--holds > 0) return;
  // A delivery that holds and unholds itself drains what it queued before
  // the next one here runs.
  while (holds === 0 && heldDeliveries.length > 0) {
    const batch = heldDeliveries.splice(0);
    for (const deliver of batch) delivered(deliver);
  }
}

/**
 * Runs `deliver` now, or once the outermost hold ends. Everything AppKit
 * reports to this module goes through here, so handlers run in the order
 * the reports arrived. A throw is reported like an uncaught error: it must
 * not replace the result of the unrelated call whose `unhold` delivers it,
 * nor drop the deliveries queued behind it.
 */
function later(deliver: () => void): void {
  if (holds > 0) heldDeliveries.push(deliver);
  else delivered(deliver);
}

function delivered(deliver: () => void): void {
  try {
    deliver();
  } catch (error) {
    reportError(error);
  }
}

function typeError(message: string) {
  return new TypeError(message);
}

/** The TypeError a prop setter throws for a value of the wrong type, coded like the natively checked props. */
function argTypeError(message: string): TypeError {
  const error = new TypeError(message) as TypeError & { code: string };
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

/** The TypeError for a value of the right type that does not name anything (a colour, a symbol). */
function argValueError(message: string): TypeError {
  const error = new TypeError(message) as TypeError & { code: string };
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

// ---------------------------------------------------------------------------
// app

type Listener = (...args: unknown[]) => unknown;

const openWindows = new Set<Window>();
const listeners = new Map<string, Set<Listener>>();
const appEvents = ["beforequit", "reopen", "menu"];
let started = false;
let activationPolicy = "regular";
const defaultAppName: string = basename(process.execPath);
let appName = defaultAppName;
let appBadge: string | null = null;
let keepAlive = false;

function emit(event: string, args: unknown[]): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) guarded(fn, args);
}

function ensureStarted() {
  if (started) return;
  nativeApp.onBeforeQuit = function () {
    let vetoed = false;
    const event = {
      preventDefault() {
        vetoed = true;
      },
    };
    const set = listeners.get("beforequit");
    if (set) {
      for (const fn of Array.from(set)) {
        if (guarded(fn, [event]) === false) vetoed = true;
      }
    }
    return !vetoed;
  };
  nativeApp.onCloseAll = closeAllWindows;
  nativeApp.onReopen = function (hasVisibleWindows: boolean) {
    emit("reopen", [!!hasVisibleWindows]);
  };
  nativeApp.start(activationPolicy);
  started = true;
  installMenuBar();
  if (appBadge !== null) nativeApp.set("badge", appBadge);
}

const app = {
  get name(): string {
    return appName;
  },
  set name(value: string | null | undefined) {
    if (value != null && typeof value !== "string") throw typeError("app.name must be a string or null");
    appName = value == null || value === "" ? defaultAppName : value;
    // The standard menus carry the name ("About …", "Quit …").
    if (started && menuSpec === null) installMenuBar();
  },
  get activationPolicy(): string {
    return activationPolicy;
  },
  set activationPolicy(value: string) {
    if (value !== "regular" && value !== "accessory" && value !== "background") {
      throw typeError('app.activationPolicy must be "regular", "accessory" or "background"');
    }
    if (started) nativeApp.set("activationPolicy", value);
    activationPolicy = value;
  },
  get keepAlive(): boolean {
    return keepAlive;
  },
  set keepAlive(value: boolean) {
    const on = !!value;
    // Holding the process open is only useful with the application running to
    // receive events (a menu bar tool with no window yet), so this starts it.
    if (on) ensureStarted();
    keepAlive = on;
    if (started) nativeApp.set("keepAlive", on);
  },
  get badge(): string | null {
    return appBadge;
  },
  set badge(value: string | number | null) {
    appBadge = value == null || value === "" ? null : String(value);
    if (started) nativeApp.set("badge", appBadge);
  },
  get menu(): MenuSpec[] | null {
    return menuSpec;
  },
  set menu(spec: MenuSpec[] | null) {
    const menus = normalizeMenus(spec);
    menuSpec = spec ?? null;
    normalizedMenus = menus;
    if (started) installMenuBar();
  },
  menuItem(item: MenuItem | MenuSpec): object | null {
    return menuItemOf(item);
  },
  get windows(): Window[] {
    return [...openWindows];
  },
  get isDark(): boolean {
    return !!nativeApp.isDark;
  },
  get hasDisplay(): boolean {
    return !!nativeApp.hasDisplay;
  },
  get isRunning(): boolean {
    return started;
  },
  activate() {
    ensureStarted();
    nativeApp.activate();
  },
  hide() {
    if (started) nativeApp.hide();
  },
  quit() {
    // Before anything started AppKit there is nobody to ask: plain process.exit().
    nativeApp.quit();
  },
  on(event: string, listener: Listener) {
    if (!appEvents.includes(event)) throw typeError(`Unknown app event "${event}"`);
    if (typeof listener !== "function") throw typeError("listener must be a function");
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener);
    return app;
  },
  off(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return app;
  },
};

// ---------------------------------------------------------------------------
// View

/** The native widget of a MetalView, the one kind built natively; it is the only caller. */
let nativeOf: (view: View) => NativeView;
let kindOf: (view: View) => string;
let propsOf: (view: View) => Record<string, unknown>;
let setParentOf: (view: View, parent: Container | Window | null) => void;
let rawParentOf: (view: View) => Container | Window | null;
/** The view's NSView as a bridge handle, for sends made here: cached, and not counted as a read. */
let handleOf: (view: View) => Handle;

// The props each View class accepts, keyed by prototype. Every accessor a
// class defines as a prop registers here; the constructor rejects anything else.
const ownPropKeys = new WeakMap<object, Set<string>>();

function registerProp(proto: object, key: string) {
  let keys = ownPropKeys.get(proto);
  if (!keys) ownPropKeys.set(proto, (keys = new Set()));
  keys.add(key);
}

function hasProp(view: View, key: string): boolean {
  for (let proto = ObjectGetPrototypeOf(view); proto !== null; proto = ObjectGetPrototypeOf(proto)) {
    if (ownPropKeys.get(proto)?.has(key)) return true;
  }
  return false;
}

/**
 * How a kind built here through the bridge hands its NSView (and the state
 * its props need, see `stateOf`) to `View`'s constructor:
 * `super(kind, props, built(view, state))`; MetalView, built natively,
 * passes `built()`. The token keeps the third argument this module's; the
 * view waits in `builtView` for that one call.
 */
const builtToken = Symbol("built");
let builtPending = false;
let builtView: Handle | undefined;
let builtState: object | undefined;
function built(view?: Handle, state?: object): symbol {
  builtPending = true;
  builtView = view;
  builtState = state;
  return builtToken;
}

// For leak tests: every View made and not yet collected.
let liveViewCount = 0;
const collectedViews = new FinalizationRegistry(() => liveViewCount--);
hooks.liveViews = () => liveViewCount;

class View {
  #native: NativeView | null;
  #handle: Handle;
  #parent: Container | Window | null = null;
  #props: Record<string, unknown> = {};
  #kind: string;

  static {
    nativeOf = view => view.#native!;
    kindOf = view => view.#kind;
    propsOf = view => view.#props;
    setParentOf = (view, parent) => {
      view.#parent = parent;
    };
    rawParentOf = view => view.#parent;
    // A natively built kind whose handle the script released gets a fresh
    // one from the native side; a kind built here has only the one.
    handleOf = view => {
      const handle = view.#handle;
      if (view.#native !== null && liveHandle(handle) === undefined) {
        return (view.#handle = wrapObject(view.#native.native) as Handle);
      }
      return handle;
    };
  }

  /** Every concrete kind passes `built(…)` third; see there. */
  constructor(kind: string, props?: Record<string, unknown>, token?: symbol) {
    if (typeof kind !== "string" || token !== builtToken || !builtPending) {
      throw typeError("View is abstract; construct a concrete view such as VStack, Text or Button");
    }
    const view = builtView;
    const state = builtState;
    builtPending = false;
    builtView = builtState = undefined;
    this.#kind = kind;
    if (view === undefined) {
      this.#native = new AppKitView();
      this.#handle = wrapObject(this.#native.native) as Handle;
    } else {
      this.#native = null;
      this.#handle = view;
      view.setTranslatesAutoresizingMaskIntoConstraints_(false);
    }
    if (state !== undefined) states.set(this, state);
    liveViewCount++;
    collectedViews.register(this, undefined);
    if (props != null) {
      if (typeof props !== "object") throw typeError(`${kind} options must be an object`);
      for (const key of ObjectKeys(props)) {
        const value = props[key];
        if (value === undefined) continue;
        if (!hasProp(this, key)) throw typeError(`Unknown property "${key}" for ${kind}`);
        (this as any)[key] = value;
      }
    }
  }

  get parent(): Container | null {
    const parent = this.#parent;
    return parent instanceof Window ? null : (parent as Container | null);
  }

  get window(): Window | null {
    let node: View | Container | Window | null = this;
    while (node && !(node instanceof Window)) node = rawParentOf(node as View);
    return (node as Window | null) ?? null;
  }

  /**
   * `-frame` once the view is in a window, with that window's pending layout
   * run first so the answer reflects every change made so far; all zeros
   * while it is not in one. What the layout pass provokes (a window's
   * onResize) is delivered after this returns.
   */
  get frame(): { x: number; y: number; width: number; height: number } {
    hold();
    try {
      const view = handleOf(this);
      const inWindow = looking(view.window(), (window: Handle | null) => {
        window?.layoutIfNeeded();
        return window !== null;
      });
      if (!inWindow) return { x: 0, y: 0, width: 0, height: 0 };
      const { origin, size } = view.frame();
      return { x: origin.x, y: origin.y, width: size.width, height: size.height };
    } finally {
      unhold();
    }
  }

  /**
   * The widget's outer NSView (for Table, TextEditor and ScrollView that is
   * the NSScrollView): its one handle, and each read counts as handing it
   * out once, like any bridge result, so `using` or one `release()` undoes
   * exactly that read.
   */
  get native(): object {
    return handedOut(handleOf(this));
  }

  remove(): void {
    const parent = this.#parent;
    if (!parent) return;
    if (parent instanceof Window) parent.content = null;
    else (parent as Container).removeChild(this);
  }

  /** PNG of the view drawn at its current size (`cacheDisplayInRect:toBitmapImageRep:`), or null while it has none. */
  snapshot(): Uint8Array | null {
    hold();
    try {
      return snapshotOf(handleOf(this));
    } finally {
      unhold();
    }
  }
}

/** PNG of `view` drawn at its current size, or null while it has none. */
function snapshotOf(view: Handle): Uint8Array | null {
  view.layoutSubtreeIfNeeded();
  const bounds = view.bounds();
  if (bounds.size.width <= 0 || bounds.size.height <= 0) return null;
  const rep = view.bitmapImageRepForCachingDisplayInRect_(bounds);
  if (rep === null) return null;
  // width × height × 4 bytes the collector cannot see: given back here,
  // not whenever the handle is finalized.
  try {
    view.cacheDisplayInRect_toBitmapImageRep_(bounds, rep);
    const png = plainSend(rep, "representationUsingType:properties:", bitmapTypes().png, {});
    return png instanceof Uint8Array ? png : null;
  } finally {
    rep.release();
  }
}

/** Per-view state of the kinds built here that AppKit cannot hold for them (a slider's step, a divider's constraint). */
const states = new WeakMap<View, object>();
function stateOf<T extends object>(view: View, initial: (view: View) => T): T {
  let state = states.get(view) as T | undefined;
  if (state === undefined) states.set(view, (state = initial(view)));
  return state;
}

type Axis = "horizontal" | "vertical" | null;

/**
 * Tells a child whose layout follows the enclosing container's axis (Divider,
 * Spacer) that axis: on insertion, on removal (`null`), and again when a prop
 * turns the container.
 */
function tellAxis(child: View, container: Container | null): void {
  if (!(child instanceof Divider || child instanceof Spacer)) return;
  const axis = container === null ? null : axisOf(container);
  if (child instanceof Divider) {
    dividerState(child).axis = axis;
    orientDivider(child);
  } else {
    spacerState(child).axis = axis;
    applyMinLength(child);
  }
}

// ---------------------------------------------------------------------------
// Containers: the children list, and the rules every container follows when
// a child arrives or leaves. What each kind does with its NSView is its
// `ContainerLayout`, in the section that builds them.

/** Throws unless `child` is a View this container may take: not an ancestor, and not in another parent. */
function adoptable(container: Container, child: unknown, method: string): void {
  if (!(child instanceof View)) throw typeError(`${kindOf(container)}.${method}: child must be a View`);
  for (let ancestor: Container | null = container; ancestor; ancestor = ancestor.parent) {
    if (ancestor === (child as View)) throw typeError("A view cannot contain itself or one of its ancestors");
  }
  const parent = rawParentOf(child);
  if (parent !== null && parent !== container) {
    throw $ERR_INVALID_STATE(
      `${kindOf(container)}.${method}: this ${kindOf(child)} already has a parent; call remove() on it first`,
    );
  }
}

/** What a container kind does with its children's NSViews; `Container` decides when. */
type ContainerLayout = {
  /** Adds a child that was not one before at `index`. */
  insert(child: View, index: number): void;
  /** Reorders a child to `index` (counted with it taken out) without it leaving the view hierarchy. */
  move(child: View, index: number): void;
  remove(child: View): void;
  /** A child's `hidden` changed; what only that child needs, before `regrow`. */
  hid?(child: View): void;
  /** Re-derives what the children share by their `grow` weights and `hidden`. */
  regrow?(children: readonly View[]): void;
  /** How many containers now enclose this one (see `fillPriority`). */
  nested?(depth: number, children: readonly View[]): void;
  /** Children hold their size loosely: a divider between them must be able to move. */
  readonly loose?: boolean;
};

let layoutOfContainer: (container: Container) => ContainerLayout;
/** The children, or none while the container's constructor has not returned (a prop given at construction). */
let childrenOf: (container: Container) => readonly View[];
/** Records a container's depth (containers above it) and renumbers the containers below it; leaves have none. */
let nest: (view: View, depth: number) => void;

/**
 * What a script hears when it reaches a container from inside a call that
 * container is making into AppKit: through a delegate or target of its own
 * that it installed on a child's `.native`, which `hold` cannot defer.
 */
const reentered =
  "this view is inside a call into AppKit that called back into JavaScript (through a delegate or target set on its .native); change it after that call returns, e.g. from queueMicrotask()";

class Container extends View {
  #children: View[] = [];
  #layout: ContainerLayout;
  #depth = 0;
  /** A call into AppKit that changes the children is in progress. */
  #changing = false;

  static {
    layoutOfContainer = container => container.#layout;
    childrenOf = container => (#children in container ? container.#children : emptyList);
    nest = (view, depth) => {
      if (!(view instanceof Container) || view.#depth === depth) return;
      view.#depth = depth;
      view.#layout.nested?.(depth, view.#children);
      for (const child of view.#children) nest(child, depth + 1);
    };
  }

  // `children` cannot go through the View constructor: #children does not
  // exist until super() returns.
  constructor(kind: string, props: Record<string, unknown> | undefined, token: symbol, layout: ContainerLayout) {
    let children: unknown;
    if (props != null && typeof props === "object") {
      children = props.children;
      if (children !== undefined) props = { ...props, children: undefined };
    }
    super(kind, props, token);
    this.#layout = layout;
    if (children !== undefined) this.children = children as View[];
  }

  get children(): readonly View[] {
    return ObjectFreeze(this.#children.slice());
  }

  set children(views: readonly View[]) {
    if (!ArrayIsArray(views)) throw typeError(`${kindOf(this)}.children must be an array of views`);
    this.replaceChildren.$apply(this, views);
  }

  append(...views: View[]): void {
    for (const view of views) this.insertBefore(view, null);
  }

  /** Runs `change`, a call into AppKit about the children, with deliveries held and a second one meanwhile refused. */
  #change<T>(change: () => T): T {
    if (this.#changing) throw $ERR_INVALID_STATE(reentered);
    this.#changing = true;
    hold();
    try {
      return change();
    } finally {
      this.#changing = false;
      unhold();
    }
  }

  insertBefore(child: View, before: View | null | undefined): void {
    adoptable(this, child, "insertBefore");
    const children = this.#children;
    // Re-inserting an existing child moves it in place; the view never
    // leaves the window, so it keeps focus.
    const from = children.indexOf(child);
    if (from >= 0 && child === before) return;
    let index: number;
    if (before == null) {
      index = children.length;
    } else {
      index = children.indexOf(before);
      if (index < 0)
        throw $ERR_INVALID_STATE(`${kindOf(this)}.insertBefore: reference view is not a child of this container`);
    }
    // The layout's index counts the children with the moved one taken out.
    if (from >= 0 && from < index) index--;
    this.#change(() => {
      const layout = this.#layout;
      if (from >= 0) {
        layout.move(child, index);
        children.splice(from, 1);
        children.splice(index, 0, child);
      } else {
        layout.insert(child, index);
        children.splice(index, 0, child);
        setParentOf(child, this);
        loosen(child, layout.loose === true);
        nest(child, this.#depth + 1);
        tellAxis(child, this);
      }
      regrow(this);
    });
  }

  removeChild(child: View): void {
    const children = this.#children;
    const index = children.indexOf(child);
    if (index < 0) throw $ERR_INVALID_STATE(`${kindOf(this)}.removeChild: view is not a child of this container`);
    this.#change(() => {
      // Bookkeeping first: removing a focused field ends its editing inside
      // the call, and whatever hears that must see the child gone.
      children.splice(index, 1);
      setParentOf(child, null);
      try {
        this.#layout.remove(child);
      } catch (e) {
        children.splice(index, 0, child);
        setParentOf(child, this);
        throw e;
      }
      loosen(child, false);
      nest(child, 0);
      tellAxis(child, null);
      regrow(this);
    });
  }

  replaceChildren(...views: View[]): void {
    const wanted = new Set<View>();
    for (const view of views) {
      adoptable(this, view, "replaceChildren");
      if (wanted.has(view)) throw typeError(`${kindOf(this)}.replaceChildren: the same view appears twice`);
      wanted.add(view);
    }
    const children = this.#children;
    for (let i = children.length - 1; i >= 0; i--) {
      if (!wanted.has(children[i])) this.removeChild(children[i]);
    }
    for (const view of views) this.insertBefore(view, null);
  }
}
registerProp(Container.prototype, "children");

/** Hands the container's layout its children again after one's `grow` or `hidden` changed. */
function regrow(container: Container): void {
  layoutOfContainer(container).regrow?.(childrenOf(container));
}

/** Tells the view's container that the view's `hidden` changed. */
function rehid(view: View): void {
  const parent = view.parent;
  if (parent === null) return;
  layoutOfContainer(parent).hid?.(view);
  regrow(parent);
}

/** The axis a container lays its children along, if it has one. */
function axisOf(container: Container): Axis {
  if (container instanceof HStack) return "horizontal";
  if (container instanceof VStack || container instanceof Group) return "vertical";
  if (container instanceof SplitView) return container.vertical ? "vertical" : "horizontal";
  return null;
}

const emptyList = ObjectFreeze([]);

// ---------------------------------------------------------------------------
// Metal

class GpuCompileError extends Error {}
ObjectDefineProperty(GpuCompileError.prototype, "name", {
  value: "GpuCompileError",
  configurable: true,
  writable: true,
});
class GpuExecutionError extends Error {}
ObjectDefineProperty(GpuExecutionError.prototype, "name", {
  value: "GpuExecutionError",
  configurable: true,
  writable: true,
});
nativeGpu.registerErrors((kind, message) =>
  kind === "compile" ? new GpuCompileError(message) : new GpuExecutionError(message),
);

const GpuBuffer = binding.GpuBuffer;
const GpuTexture = binding.GpuTexture;
const GpuLibrary = binding.GpuLibrary;
const GpuFunction = binding.GpuFunction;
const GpuRenderPipeline = binding.GpuRenderPipeline;
const GpuComputePipeline = binding.GpuComputePipeline;
const GpuSampler = binding.GpuSampler;
const GpuDepthStencil = binding.GpuDepthStencil;
const GpuFrame = binding.GpuFrame;

// The only JavaScript between a caller and the natives: `renderPass` unwraps
// a MetalView and parses a `clear` colour string.
{
  const proto = GpuFrame.prototype;
  const renderPass = proto.renderPass;
  const what = "frame.renderPass() clear";
  proto.renderPass = function (this: NativeFrame, target: unknown, options?: unknown) {
    if (target instanceof MetalView) {
      target = nativeOf(target);
      if (typeof (options as { clear?: unknown } | undefined)?.clear === "string") {
        options = { ...(options as object), clear: rgbaFor(what, (options as { clear: string }).clear) };
      }
    } else if (typeof (target as { clear?: unknown } | undefined)?.clear === "string") {
      target = { ...(target as object), clear: rgbaFor(what, (target as { clear: string }).clear) };
    }
    return renderPass.$call(this, target, options);
  };
}

// MSL size/alignment (Metal Shading Language spec §2): 3-wide vectors take the
// room of 4-wide ones, and a matrix is `columns` column vectors.
type Scalar = "f32" | "f16" | "i32" | "u32" | "i16" | "u16" | "u8" | "bool";
type TypeInfo = { size: number; align: number; scalar: Scalar; count: number; columns: number; rows: number };
const scalarBytes: Record<Scalar, number> = { f32: 4, f16: 2, i32: 4, u32: 4, i16: 2, u16: 2, u8: 1, bool: 1 };
function vec(scalar: Scalar, n: number): TypeInfo {
  const width = scalarBytes[scalar] * (n === 3 ? 4 : n);
  return { size: width, align: width, scalar, count: n, columns: 1, rows: n };
}
function mat(scalar: Scalar, columns: number, rows: number): TypeInfo {
  const column = vec(scalar, rows);
  return { size: column.size * columns, align: column.align, scalar, count: columns * rows, columns, rows };
}
const mslTypes: Record<string, TypeInfo> = {
  bool: vec("bool", 1),
  uchar4: vec("u8", 4),
  short: vec("i16", 1),
  ushort: vec("u16", 1),
  half: vec("f16", 1),
  half2: vec("f16", 2),
  half3: vec("f16", 3),
  half4: vec("f16", 4),
  int: vec("i32", 1),
  int2: vec("i32", 2),
  int3: vec("i32", 3),
  int4: vec("i32", 4),
  uint: vec("u32", 1),
  uint2: vec("u32", 2),
  uint3: vec("u32", 3),
  uint4: vec("u32", 4),
  float: vec("f32", 1),
  float2: vec("f32", 2),
  float3: vec("f32", 3),
  float4: vec("f32", 4),
  float2x2: mat("f32", 2, 2),
  float3x3: mat("f32", 3, 3),
  float4x4: mat("f32", 4, 4),
};

type StructField = { name: string; type: string; offset: number; size: number; align: number; info: TypeInfo };

const alignUp = (n: number, align: number) => Math.ceil(n / align) * align;

function writeScalar(view: DataView, at: number, scalar: Scalar, value: unknown, path: string) {
  if (scalar === "bool") {
    if (typeof value !== "boolean" && typeof value !== "number") throw typeError(`${path} must be a boolean`);
    view.setUint8(at, value ? 1 : 0);
    return;
  }
  if (typeof value !== "number") throw typeError(`${path} must be a number`);
  switch (scalar) {
    case "f32":
      return view.setFloat32(at, value, true);
    case "f16":
      return view.setFloat16(at, value, true);
    case "i32":
      return view.setInt32(at, value, true);
    case "u32":
      return view.setUint32(at, value, true);
    case "i16":
      return view.setInt16(at, value, true);
    case "u16":
      return view.setUint16(at, value, true);
    case "u8":
      return view.setUint8(at, value);
  }
}

class StructLayout {
  readonly name: string;
  readonly size: number;
  readonly align: number;
  readonly fields: Readonly<Record<string, Readonly<StructField>>>;
  #order: StructField[];

  constructor(spec: Record<string, string>, name: string) {
    if (!spec || typeof spec !== "object" || ArrayIsArray(spec)) {
      throw typeError("gpu.struct(fields) expects an object mapping field names to MSL type names");
    }
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw typeError("gpu.struct(fields, name): name must be an identifier");
    }
    const order: StructField[] = [];
    const fields: Record<string, StructField> = {};
    let offset = 0;
    let align = 1;
    for (const key of ObjectKeys(spec)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw typeError(`gpu.struct: field name "${key}" is not an identifier`);
      const type = spec[key];
      const info = typeof type === "string" && ObjectHasOwn(mslTypes, type) ? mslTypes[type] : undefined;
      if (!info) {
        throw typeError(
          `gpu.struct: field "${key}" has unknown type ${JSON.stringify(type)}; expected one of ${ObjectKeys(mslTypes).join(", ")}`,
        );
      }
      offset = alignUp(offset, info.align);
      const field = ObjectFreeze({ name: key, type, offset, size: info.size, align: info.align, info });
      order.push(field);
      fields[key] = field;
      offset += info.size;
      const fieldAlign = info.align;
      if (fieldAlign > align) align = fieldAlign;
    }
    if (order.length === 0) throw typeError("gpu.struct(fields) needs at least one field");
    this.name = name;
    this.align = align;
    this.size = alignUp(offset, align);
    this.fields = ObjectFreeze(fields);
    this.#order = order;
  }

  /** The matching MSL declaration, ready to paste into shader source. */
  get msl(): string {
    let out = `struct ${this.name} {\n`;
    for (const f of this.#order) out += `  ${f.type} ${f.name};\n`;
    return out + "};";
  }

  pack(values: Record<string, unknown>, target?: ArrayBufferLike | ArrayBufferView | null, byteOffset: number = 0) {
    if (!values || typeof values !== "object") throw typeError(`${this.name}.pack(values) expects an object`);
    let buffer: ArrayBufferLike;
    let base: number;
    let room: number;
    if (target === undefined || target === null) {
      buffer = new ArrayBuffer(this.size);
      base = 0;
      room = this.size;
      target = buffer;
    } else if (target instanceof ArrayBuffer || target instanceof SharedArrayBuffer) {
      buffer = target;
      base = 0;
      room = target.byteLength;
    } else if (ArrayBuffer.isView(target)) {
      buffer = target.buffer;
      base = target.byteOffset;
      room = target.byteLength;
    } else {
      throw typeError(`${this.name}.pack: target must be an ArrayBuffer or a typed array`);
    }
    if (typeof byteOffset !== "number" || !(byteOffset >= 0) || byteOffset % 1 !== 0) {
      throw new RangeError(`${this.name}.pack: byteOffset must be a non-negative integer`);
    }
    const { size } = this;
    if (byteOffset + size > room) {
      throw new RangeError(
        `${this.name}.pack: ${size} bytes at offset ${byteOffset} do not fit in a target of ${room} bytes`,
      );
    }
    for (const key of ObjectKeys(values)) {
      if (!ObjectHasOwn(this.fields, key)) throw typeError(`${this.name}.pack: unknown field "${key}"`);
    }
    const view = new DataView(buffer, base + byteOffset, this.size);
    for (const field of this.#order) {
      const value = values[field.name];
      if (value === undefined) continue;
      const { scalar, count, columns, rows } = field.info;
      const path = `${this.name}.${field.name}`;
      const step = scalarBytes[scalar];
      if (count === 1) {
        // A one-element array is fine for a scalar too.
        const v =
          typeof value === "object" && value !== null && (value as ArrayLike<unknown>).length === 1
            ? (value as ArrayLike<unknown>)[0]
            : value;
        writeScalar(view, field.offset, scalar, v, path);
        continue;
      }
      const list = value as ArrayLike<unknown>;
      if (typeof list !== "object" || list === null || typeof list.length !== "number") {
        throw typeError(`${path} must be an array or typed array of ${count} numbers (${field.type})`);
      }
      // Matrices are column-major; each column is padded like a vector, so a
      // 3-row column takes 4 slots. Accept both the tight and the padded form.
      const paddedRows = rows === 3 ? 4 : rows;
      let stride: number;
      if (list.length === count) stride = rows;
      else if (list.length === columns * paddedRows) stride = paddedRows;
      else {
        const shape = paddedRows === rows ? String(count) : `${count} (or ${columns * paddedRows} padded)`;
        throw typeError(`${path} must have ${shape} elements for ${field.type}, got ${list.length}`);
      }
      for (let c = 0; c < columns; c++) {
        const columnAt = field.offset + c * paddedRows * step;
        for (let r = 0; r < rows; r++) {
          writeScalar(view, columnAt + r * step, scalar, list[c * stride + r], `${path}[${c * stride + r}]`);
        }
      }
    }
    return target;
  }
}

// Every native member throws `TypeError: Metal is not available` without a
// device, except the three getters.
const gpu = {
  get available(): boolean {
    return nativeGpu.available;
  },
  get name(): string | null {
    return nativeGpu.name;
  },
  get unifiedMemory(): boolean {
    return nativeGpu.unifiedMemory;
  },
  buffer(data: unknown, opts?: unknown) {
    return nativeGpu.buffer(data, opts);
  },
  texture(opts: unknown) {
    return nativeGpu.texture(opts);
  },
  library(source: unknown, opts?: unknown) {
    return nativeGpu.library(source, opts);
  },
  renderPipeline(opts: unknown) {
    return nativeGpu.renderPipeline(opts);
  },
  computePipeline(fn: unknown, opts?: unknown) {
    return nativeGpu.computePipeline(fn, opts);
  },
  sampler(opts?: unknown) {
    return nativeGpu.sampler(opts);
  },
  depthStencil(opts?: unknown) {
    return nativeGpu.depthStencil(opts);
  },
  frame(opts?: unknown) {
    return nativeGpu.frame(opts);
  },
  /** Pure layout math; works without a GPU. */
  struct(fields: Record<string, string>, name: string = "Uniforms") {
    return new StructLayout(fields, name);
  },
};

/** Hands `parsed` to the native setter for `key`, then keeps `value` for the getter (`null`/`undefined` unset it). */
function setMetalProp(view: MetalView, key: string, value: unknown, parsed: unknown): void {
  nativeOf(view).set(key, parsed ?? null);
  if (value == null) delete propsOf(view)[key];
  else propsOf(view)[key] = value;
}

/**
 * Stores an `on*` handler and points the native slot at it. The native
 * payload is passed through: onFrame(frame, { time, dt, width, height }),
 * onResize({ width, height }).
 */
function setMetalHandler(
  view: MetalView,
  prop: "onFrame" | "onResize",
  handler: unknown,
  deliver: (deliver: () => void) => void,
): void {
  if (handler != null && typeof handler !== "function") throw typeError(`MetalView.${prop} must be a function`);
  const native = nativeOf(view);
  if (handler == null) {
    delete propsOf(view)[prop];
    native[prop] = undefined;
    return;
  }
  propsOf(view)[prop] = handler;
  native[prop] = function (...payload: unknown[]) {
    deliver(() => {
      const current = propsOf(view)[prop] as Function | undefined;
      if (current) current.$apply(undefined, payload);
    });
  };
}

class MetalView extends View {
  static {
    for (const key of ["clearColor", "preferredFPS", "running", "onFrame", "onResize"]) {
      registerProp(MetalView.prototype, key);
    }
  }

  constructor(props?: Record<string, unknown>) {
    super("MetalView", props, built());
  }

  /** Kept as assigned: `-clearColor` answers components, not the colour string that was given. */
  get clearColor(): string {
    return (propsOf(this).clearColor as string | undefined) ?? "#000000";
  }
  set clearColor(value: unknown) {
    setMetalProp(this, "clearColor", value, rgbaFor("MetalView.clearColor", value ?? null));
  }

  /** `-preferredFramesPerSecond` of the `MTKView`; the assigned value when Metal is unavailable. */
  get preferredFPS(): number {
    if (nativeGpu.available) return handleOf(this).preferredFramesPerSecond();
    return (propsOf(this).preferredFPS as number | undefined) ?? 60;
  }
  set preferredFPS(value: unknown) {
    setMetalProp(this, "preferredFPS", value, value);
  }

  /** Kept as assigned: the view's `paused` also folds in whether a display is attached. */
  get running(): boolean {
    return (propsOf(this).running as boolean | undefined) ?? true;
  }
  set running(value: unknown) {
    setMetalProp(this, "running", value, value);
  }

  get onFrame(): Function | null {
    return (propsOf(this).onFrame as Function | undefined) ?? null;
  }
  // A frame is encoded inside `drawInMTKView:` or not at all, so onFrame is never deferred.
  set onFrame(handler: unknown) {
    setMetalHandler(this, "onFrame", handler, deliver => deliver());
  }

  get onResize(): Function | null {
    return (propsOf(this).onResize as Function | undefined) ?? null;
  }
  set onResize(handler: unknown) {
    setMetalHandler(this, "onResize", handler, later);
  }

  /** Drawable size in pixels (points × backing scale). */
  get drawableSize(): { width: number; height: number } {
    return nativeOf(this).drawableSize ?? { width: 0, height: 0 };
  }

  get gpu() {
    return gpu;
  }

  /** Render one frame now: runs `onFrame` synchronously. How headless code and tests drive the view. */
  draw(): void {
    nativeOf(this).draw();
  }
}

// ---------------------------------------------------------------------------
// The views built through the bridge: the containers, and Text, Button,
// Checkbox, Radio, Switch, TextField/SecureField/SearchField, Slider, Picker,
// Segmented, Progress, Image, Divider and Spacer. Each makes its NSView with
// `objc`, hands it to View with `built()`, and points a control's
// target/action (and a text field's delegate) at a script object. Getters
// read the view; nothing about it is mirrored here except the props AppKit
// cannot answer in the shape they were given (`font`, `tint`, `image`,
// `padding`) and state it does not keep (a slider's `step`, an index wanted
// before the items arrive, a stack's `grow` shares).

/** Classes by name, looked up (and AppKit loaded) on first use rather than when the module loads. */
const classes = objcClasses as Record<string, Handle>;
/** `NSUserInterfaceLayoutOrientation`, for the hugging and compression priorities set per axis. */
const orientations = () =>
  objcEnums.NSUserInterfaceLayoutOrientation as Readonly<Record<"horizontal" | "vertical", number>>;
/** `NSLayoutPriority…` constants by name (`NSLayoutPriorityDefaultLow` is NSView's stock content hugging). */
const layoutPriority = (name: string) => objcEnums[name] as number;
/**
 * Horizontal compression resistance for controls that draw a title: above a
 * label's (250) so plain text truncates first, below the window holding its
 * size (500) so a long title truncates instead of widening the window.
 */
const titleCompression = 490;
/** Hugging and compression of empty stretch (Spacer, a Divider's long side): gives way to everything. */
const yielding = 1;
/** An explicit length (`minLength`), weighed like `width`/`height`: beaten only by a required constraint. */
const almostRequired = 999;
const zeroRect = ObjectFreeze({ x: 0, y: 0, width: 0, height: 0 });
/**
 * `NSWindow` raises (and the process aborts) unless every frame edge lies in
 * the i32 range, and auto layout grows the window to fit its content, so every
 * length or coordinate that reaches AppKit is capped well inside that.
 */
const maxPoints = 1e7;

function optionalString(what: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw argTypeError(`${what} must be a string or null`);
  return value;
}

function optionalBoolean(what: string, value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw argTypeError(`${what} must be a boolean or null`);
  return value;
}

function optionalNumber(what: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw argTypeError(`${what} must be a number or null`);
  if (!Number.isFinite(value)) throw argTypeError(`${what} must be a finite number`);
  return value;
}

function optionalCount(what: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw argTypeError(`${what} must be a non-negative integer or null`);
  }
  return value;
}

/** Numbers and booleans in a list of labels read as their text, as a template literal would show them. */
function stringList(what: string, value: unknown): readonly string[] {
  if (value === null) return emptyList;
  if (!ArrayIsArray(value)) throw argTypeError(`${what} must be an array of strings`);
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") out.push(item);
    else if (typeof item === "number" || typeof item === "boolean") out.push(String(item));
    else throw argTypeError(`${what}[${i}] must be a string`);
  }
  return ObjectFreeze(out);
}

/** `"a", "b" or "c"`, for messages that list what a prop accepts. */
function nameList(names: readonly string[]): string {
  let out = "";
  for (let i = 0; i < names.length; i++) {
    if (i > 0) out += i + 1 === names.length ? " or " : ", ";
    out += `"${names[i]}"`;
  }
  return out;
}

function oneOf<T extends string>(what: string, value: unknown, names: readonly T[]): T {
  if (typeof value === "string" && names.includes(value as T)) return value as T;
  throw argTypeError(`${what} must be ${nameList(names)}`);
}

/** A number above zero; `null` and `0` both mean "none" and give `null`. */
function positiveNumber(what: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !(Number.isFinite(value) && value >= 0)) {
    throw argTypeError(`${what} must be a positive number or null`);
  }
  return value === 0 ? null : value;
}

/** A positive screen length; `null` and `0` both mean "none". */
function positivePoints(what: string, value: unknown): number | null {
  const length = positiveNumber(what, value);
  if (length !== null && length > maxPoints) {
    throw argTypeError(`${what} must be a positive number no larger than ${maxPoints} or null`);
  }
  return length;
}

/**
 * An enum member's value from its short (`push`) or full (`NSBezelStylePush`)
 * name, or the value itself (what `objc.enums` and the getters give; any
 * the framework defines, listed or not).
 */
function enumValue(what: string, typeName: string, value: unknown): number {
  const members = objcEnums[typeName] as Readonly<Record<string, number>>;
  if (typeof value === "string" && ObjectHasOwn(members, value)) return members[value];
  const row = enumTables().enums[typeName];
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0) return value;
    // A negative number only when it is a member's (NSStackViewDistributionGravityAreas is -1).
    for (let i = 2; i < row.length; i += 2) {
      if (row[i] === value) return value;
    }
  }
  const names: string[] = [];
  for (let i = 1; i < row.length; i += 2) {
    const suffix = row[i] as string;
    if (!suffix.startsWith("=")) names.push(lowerFirstWord(suffix));
  }
  throw argTypeError(`${what} must be an ${typeName} name (${nameList(names)}) or value`);
}

/** The short name of the first member with this value (current names precede deprecated aliases), else the number. */
function enumName(typeName: string, value: number): string | number {
  const row = enumTables().enums[typeName];
  for (let i = 1; i < row.length; i += 2) {
    const suffix = row[i] as string;
    if (row[i + 1] === value && !suffix.startsWith("=")) return lowerFirstWord(suffix);
  }
  return value;
}

// Colours: the CSS-ish strings the props take, to NSColor.
const systemColors: Record<string, string> = {
  label: "labelColor",
  secondaryLabel: "secondaryLabelColor",
  tertiaryLabel: "tertiaryLabelColor",
  quaternaryLabel: "quaternaryLabelColor",
  text: "textColor",
  placeholder: "placeholderTextColor",
  link: "linkColor",
  separator: "separatorColor",
  accent: "controlAccentColor",
  control: "controlColor",
  controlText: "controlTextColor",
  controlBackground: "controlBackgroundColor",
  windowBackground: "windowBackgroundColor",
  underPageBackground: "underPageBackgroundColor",
  textBackground: "textBackgroundColor",
  selectedContentBackground: "selectedContentBackgroundColor",
  clear: "clearColor",
  black: "blackColor",
  white: "whiteColor",
  gray: "systemGrayColor",
  grey: "systemGrayColor",
  red: "systemRedColor",
  orange: "systemOrangeColor",
  yellow: "systemYellowColor",
  green: "systemGreenColor",
  mint: "systemMintColor",
  teal: "systemTealColor",
  cyan: "systemCyanColor",
  blue: "systemBlueColor",
  indigo: "systemIndigoColor",
  purple: "systemPurpleColor",
  pink: "systemPinkColor",
  brown: "systemBrownColor",
};
const decimalPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** `[r, g, b, a]` in 0..1 from `#rgb[a]`, `#rrggbb[aa]`, `rgb()`/`rgba()`; undefined when the text is none of those. */
function parseRgba(text: string): [number, number, number, number] | undefined {
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
    const { length } = hex;
    if (length === 3 || length === 4) {
      const channel = (i: number) => (parseInt(hex[i], 16) * 17) / 255;
      return [channel(0), channel(1), channel(2), length === 4 ? channel(3) : 1];
    }
    if (length === 6 || length === 8) {
      const channel = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
      return [channel(0), channel(2), channel(4), length === 8 ? channel(6) : 1];
    }
    return undefined;
  }
  const call = /^rgba?\((.*)\)$/.exec(text);
  if (!call) return undefined;
  const parts = call[1].split(",");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i].trim();
    // A bare number is out of 255 for a colour channel and out of 1 for alpha; `%` is always out of 100.
    let scale = i === 3 ? 1 : 255;
    if (part.endsWith("%")) {
      part = part.slice(0, -1);
      scale = 100;
    }
    if (!decimalPattern.test(part)) return undefined;
    const value = Number(part) / scale;
    if (!Number.isFinite(value)) return undefined;
    out.push(Math.min(Math.max(value, 0), 1));
  }
  if (out.length === 3) out.push(1);
  return out as [number, number, number, number];
}

/** An NSColor for a colour prop, or null for none. */
function colorFor(what: string, value: unknown): Handle | null {
  if (value === null) return null;
  if (typeof value !== "string") throw argTypeError(`${what} must be a color string or null`);
  const text = value.trim();
  if (ObjectHasOwn(systemColors, text)) return classes.NSColor[systemColors[text]]();
  const rgba = parseRgba(text);
  if (rgba === undefined) throw argValueError(`${what}: invalid color ${JSON.stringify(text)}`);
  return classes.NSColor.colorWithSRGBRed_green_blue_alpha_(rgba[0], rgba[1], rgba[2], rgba[3]);
}

/**
 * `[r, g, b, a]` in sRGB for what Metal clears to: a colour string (a system
 * colour resolves once, for the current appearance) or null for the default.
 */
function rgbaFor(what: string, value: unknown): [number, number, number, number] | null {
  if (value === null) return null;
  if (typeof value !== "string") throw argTypeError(`${what} must be a color string or null`);
  const text = value.trim();
  if (!ObjectHasOwn(systemColors, text)) {
    const rgba = parseRgba(text);
    if (rgba === undefined) throw argValueError(`${what}: invalid color ${JSON.stringify(text)}`);
    return rgba;
  }
  const dynamic = classes.NSColor[systemColors[text]]();
  const srgb = looking(classes.NSColorSpace.sRGBColorSpace(), space => dynamic.colorUsingColorSpace_(space));
  dynamic.release();
  if (srgb === null) throw argValueError(`${what}: invalid color ${JSON.stringify(text)}`);
  try {
    return [srgb.redComponent(), srgb.greenComponent(), srgb.blueComponent(), srgb.alphaComponent()];
  } finally {
    srgb.release();
  }
}

// Fonts: a point size or { size, weight, design, italic } to NSFont.
const fontWeightConstants: Record<string, string> = {
  ultralight: "NSFontWeightUltraLight",
  thin: "NSFontWeightThin",
  light: "NSFontWeightLight",
  regular: "NSFontWeightRegular",
  medium: "NSFontWeightMedium",
  semibold: "NSFontWeightSemibold",
  bold: "NSFontWeightBold",
  heavy: "NSFontWeightHeavy",
  black: "NSFontWeightBlack",
};
const fontWeightNames = ObjectKeys(fontWeightConstants);
/** The upper bounds of the CSS 100–900 buckets, in `fontWeightNames` order. */
const fontWeightSteps = [150, 250, 350, 450, 550, 650, 750, 850];
const fontDesigns = ["default", "monospaced", "rounded", "serif"] as const;
const fontDesignConstants: Record<string, string> = {
  rounded: "NSFontDescriptorSystemDesignRounded",
  serif: "NSFontDescriptorSystemDesignSerif",
};

function fontWeightFor(what: string, weight: unknown): string {
  if (typeof weight === "number") {
    if (!Number.isFinite(weight)) throw argTypeError(`${what} must be a finite number`);
    let i = 0;
    while (i < fontWeightSteps.length && weight >= fontWeightSteps[i]) i++;
    return fontWeightNames[i];
  }
  if (typeof weight === "string") {
    const name = weight === "normal" ? "regular" : weight;
    if (!ObjectHasOwn(fontWeightConstants, name)) throw argTypeError(`${what}: unknown weight "${name}"`);
    return name;
  }
  throw argTypeError(`${what} must be a number from 100 to 900 or a weight name`);
}

/** The NSFont closest to a `font` prop value; `null` gives the standard system font. */
function fontFor(what: string, value: unknown): Handle {
  let size: number | null = null;
  let weight = "regular";
  let design: (typeof fontDesigns)[number] = "default";
  let italic = false;
  if (typeof value === "number") {
    size = positivePoints(what, value);
  } else if (value !== null) {
    if (typeof value !== "object") {
      throw argTypeError(`${what} must be a number, a { size, weight, design, italic } object or null`);
    }
    const spec = value as { size?: unknown; weight?: unknown; design?: unknown; italic?: unknown };
    const { size: givenSize, weight: givenWeight, design: givenDesign, italic: givenItalic } = spec;
    if (givenSize !== undefined) size = positivePoints(`${what}.size`, givenSize ?? null);
    if (givenWeight !== undefined) weight = fontWeightFor(`${what}.weight`, givenWeight);
    if (givenDesign !== undefined) design = oneOf(`${what}.design`, givenDesign, fontDesigns);
    if (givenItalic !== undefined) {
      if (typeof givenItalic !== "boolean") throw argTypeError(`${what}.italic must be a boolean`);
      italic = givenItalic;
    }
  }
  const { NSFont } = classes;
  const points = size ?? (NSFont.systemFontSize() as number);
  const nsWeight = objcConstants[fontWeightConstants[weight]] as number;
  let font: Handle =
    design === "monospaced"
      ? NSFont.monospacedSystemFontOfSize_weight_(points, nsWeight)
      : NSFont.systemFontOfSize_weight_(points, nsWeight);
  if (ObjectHasOwn(fontDesignConstants, design)) {
    const descriptor = font.fontDescriptor().fontDescriptorWithDesign_(objcConstants[fontDesignConstants[design]]);
    const designed = descriptor === null ? null : NSFont.fontWithDescriptor_size_(descriptor, points);
    if (designed !== null) font = designed;
  }
  if (italic) {
    const descriptor = font.fontDescriptor();
    const slanted = NSFont.fontWithDescriptor_size_(
      descriptor.fontDescriptorWithSymbolicTraits_(
        descriptor.symbolicTraits() | (objcEnums.NSFontItalicTrait as number),
      ),
      points,
    );
    if (slanted !== null) font = slanted;
  }
  return font;
}

/** An SF Symbol image by name, or null for none. */
function symbolImage(what: string, name: string | null): Handle | null {
  if (name === null) return null;
  const image = classes.NSImage.imageWithSystemSymbolName_accessibilityDescription_(name, null);
  if (image === null) throw argValueError(`${what}: no system symbol named ${JSON.stringify(name)}`);
  return image;
}

type ControlAccessor = {
  get(view: View, control: Handle): unknown;
  /** `value` is never undefined: an `undefined` assignment arrives as `null` (reset). */
  set(view: View, control: Handle, value: unknown, what: string): void;
};

/**
 * The view whose own setter is running. What its control reports meanwhile
 * (a change, an action) is that setter's echo, not the user, and is not
 * passed on; editing that the setter begins or ends still is.
 */
let setting: View | undefined;

/** Runs `change` as `view`'s own doing: held, and what its control reports meanwhile dropped as an echo. */
function ownSetting(view: View, change: () => void): void {
  const outer = setting;
  setting = view;
  hold();
  try {
    change();
  } finally {
    setting = outer;
    unhold();
  }
}

/**
 * Accessors that read and write the NSView behind a view. A setter holds, so
 * what it provokes is delivered as it returns; a control's own (`echoes`)
 * also marks the view as `setting` meanwhile.
 */
function defineControlProps(Class: { prototype: object }, accessors: Record<string, ControlAccessor>, echoes = true) {
  for (const key of ObjectKeys(accessors)) {
    const { get, set } = accessors[key];
    registerProp(Class.prototype, key);
    ObjectDefineProperty(Class.prototype, key, {
      get(this: View) {
        return get(this, handleOf(this));
      },
      set(this: View, value: unknown) {
        const assign = () => set(this, handleOf(this), value === undefined ? null : value, `${kindOf(this)}.${key}`);
        if (echoes) return ownSetting(this, assign);
        hold();
        try {
          assign();
        } finally {
          unhold();
        }
      },
      enumerable: true,
      configurable: true,
    });
  }
}

/** A prop kept as given (AppKit cannot hand it back in that shape) and applied by `apply`. */
function keptProp(
  key: string,
  apply: (control: Handle, value: unknown, what: string, view: View) => void,
): ControlAccessor {
  return {
    get: view => propsOf(view)[key] ?? null,
    set(view, control, value, what) {
      apply(control, value, what, view);
      if (value === null) delete propsOf(view)[key];
      else propsOf(view)[key] = value;
    },
  };
}

/**
 * An `on*` handler prop of a view built here. The handler is only stored;
 * the control's target or delegate looks it up when it has something to report.
 */
function defineHandlers(Class: { prototype: object }, ...props: string[]) {
  for (const prop of props) {
    registerProp(Class.prototype, prop);
    ObjectDefineProperty(Class.prototype, prop, {
      get(this: View) {
        return propsOf(this)[prop] ?? null;
      },
      set(this: View, handler: Function | null | undefined) {
        if (handler != null && typeof handler !== "function")
          throw typeError(`${kindOf(this)}.${prop} must be a function`);
        if (handler == null) delete propsOf(this)[prop];
        else propsOf(this)[prop] = handler;
      },
      enumerable: true,
      configurable: true,
    });
  }
}

/** Runs the view's `prop` handler, if it has one, a throw reported like an uncaught error; whether there was one. */
function callHandler(view: View, prop: string, args: unknown[]): boolean {
  const handler = propsOf(view)[prop] as Function | undefined;
  if (handler === undefined) return false;
  guarded(handler, args);
  return true;
}

const noArguments = (): unknown[] => [];

/**
 * What a control reports of the user's doing goes to the view's `prop`
 * handler: now, inside the AppKit call that reported it, or when the call
 * this module is making returns (see `hold`). `args` is read at delivery.
 */
function report(view: View, prop: string, args: () => unknown[] = noArguments): void {
  if (setting === view) return;
  later(() => callHandler(view, prop, args()));
}

/** The script objects each view built here points its control at (target, delegate); the view keeps them alive, since AppKit holds both weakly. */
const controlTargets = new WeakMap<View, object>();
const controlDelegates = new WeakMap<View, object>();

/**
 * Points `control`'s target/action (or another action slot of it, a table's
 * `doubleAction`) at a script object (`objc.target`) whose `action:` runs
 * `fire(view)` on the main thread, inside whatever sent the action (a click
 * AppKit dispatches, `performClick:`, Return in a field). The target holds
 * the view weakly, so an unreferenced view and its target are collected
 * together.
 */
function wireAction(view: View, control: Handle, fire: (view: any) => void, actionSetter = "setAction_") {
  const ref = new WeakRef(view);
  const target = objc.target(function () {
    const view = ref.deref();
    if (view !== undefined) fire(view);
  });
  controlTargets.set(view, target);
  control.setTarget_(target);
  control[actionSetter]("action:");
}

/** delegate -> the view or window it reports to, held weakly like `wireAction`'s targets hold their views. */
const ownerOfDelegate = new WeakMap<object, WeakRef<object>>();

/** Makes `control`'s delegate a new instance of `Class` (from `delegateClass`) that reports to `view`. */
function wireDelegate(view: View, control: Handle, Class: Handle) {
  const delegate = Class.new();
  ownerOfDelegate.set(delegate, new WeakRef(view));
  controlDelegates.set(view, delegate);
  control.setDelegate_(delegate);
}

/**
 * A class adopting `protocols` whose methods run
 * `hooks[selector](owner, ...arguments)` for the view or window the receiving
 * instance was wired to; `this` is that instance's one handle, the same
 * object `ownerOfDelegate` has. Once the owner has been collected a method
 * answers `gone[selector]` (nothing, for the void ones), so a delegate a
 * script kept hold of still answers in type.
 */
function delegateClass(
  protocols: string[],
  hooks: Record<string, (owner: any, ...args: any[]) => unknown>,
  gone: Record<string, unknown> = {},
): Handle {
  const methods: Record<string, Function> = {};
  for (const selector of ObjectKeys(hooks)) {
    const hook = hooks[selector];
    const fallback = gone[selector];
    methods[selector] = function (this: object, ...args: unknown[]) {
      const owner = ownerOfDelegate.get(this)?.deref();
      return owner === undefined ? fallback : hook(owner, ...args);
    };
  }
  return defineClass({ protocols, methods }) as Handle;
}

/** `click()`: a real click (`performClick:`), so the control highlights and sends its action. */
function defineClick(Class: { prototype: object }) {
  ObjectDefineProperty(Class.prototype, "click", {
    value: function click(this: View) {
      if (!(this instanceof Button || this instanceof Checkbox || this instanceof Radio || this instanceof Switch)) {
        throw typeError("click() only applies to a Button, Checkbox, Radio or Switch");
      }
      handleOf(this).performClick_(null);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Layout: the props every view has, applied to its NSView. Sizes are
// NSLayoutConstraints on the view itself; `grow` and a SplitView parent
// rewrite its hugging and compression priorities (and put its own back);
// decoration is its layer.

/** `NSLayoutAttribute` and `NSLayoutRelation`, for the constraints made here. */
const layoutAttributes = () => objcEnums.NSLayoutAttribute as Readonly<Record<string, number>>;
const layoutRelations = () => objcEnums.NSLayoutRelation as Readonly<Record<string, number>>;
const bitmapTypes = () => objcEnums.NSBitmapImageFileType as Readonly<Record<string, number>>;

/** `view.attribute relation constant`, active at `priority`. */
function lengthConstraint(view: Handle, attribute: number, relation: number, constant: number, priority: number) {
  return relateConstraint(view, attribute, relation, null, attribute, 1, constant, priority);
}

/** `view.attribute relation other.otherAttribute × multiplier + constant`, active at `priority`. */
function relateConstraint(
  view: Handle,
  attribute: number,
  relation: number,
  other: Handle | null,
  otherAttribute: number,
  multiplier: number,
  constant: number,
  priority: number,
): Handle {
  const constraint =
    classes.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
      view,
      attribute,
      relation,
      other,
      other === null ? layoutAttributes().notAnAttribute : otherAttribute,
      multiplier,
      constant,
    );
  constraint.setPriority_(priority);
  constraint.setActive_(true);
  return constraint;
}

/** Pins `child` to all four edges of `parent`, `inset` points in. */
function pinEdges(parent: Handle, child: Handle, inset: number) {
  const { leading, top, trailing, bottom } = layoutAttributes();
  const { equal } = layoutRelations();
  const required = layoutPriority("NSLayoutPriorityRequired");
  child.setTranslatesAutoresizingMaskIntoConstraints_(false);
  giveBack(relateConstraint(child, leading, equal, parent, leading, 1, inset, required));
  giveBack(relateConstraint(child, top, equal, parent, top, 1, inset, required));
  giveBack(relateConstraint(child, trailing, equal, parent, trailing, 1, -inset, required));
  giveBack(relateConstraint(child, bottom, equal, parent, bottom, 1, -inset, required));
}

/** A screen length or null; capped where the window's are (an NSWindow frame edge past ±2^31 raises). */
function optionalPoints(what: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maxPoints) return value;
  throw argTypeError(`${what} must be null or a finite number no larger than ${maxPoints}`);
}

/**
 * One axis's size props as last assigned, plus the constraints that realise
 * them (kept so a later assignment edits the constant instead of stacking a
 * second constraint). Props arrive one at a time and in any order, so
 * conflicts are settled here rather than left to Auto Layout: `min` wins
 * over `max`, and the exact length is clamped between them.
 */
type AxisSize = {
  exact: number | null;
  min: number | null;
  max: number | null;
  exactConstraint: Handle | null;
  minConstraint: Handle | null;
  maxConstraint: Handle | null;
};

const newAxis = (): AxisSize => ({
  exact: null,
  min: null,
  max: null,
  exactConstraint: null,
  minConstraint: null,
  maxConstraint: null,
});

type Layout = {
  width: AxisSize;
  height: AxisSize;
  /** The `grow` weight: 0 hugs content, larger takes leftover space sooner. */
  grow: number;
  /** A parent (SplitView) whose divider must be able to move this view's edge. */
  loose: boolean;
  /** The view's own [hugging, compression] per axis while `grow` or `loose` overrides them. */
  saved: [number, number, number, number] | null;
  background: Handle | null;
  borderColor: Handle | null;
};

const layouts = new WeakMap<View, Layout>();
function layoutOf(view: View): Layout {
  let layout = layouts.get(view);
  if (layout === undefined) {
    layout = {
      width: newAxis(),
      height: newAxis(),
      grow: 0,
      loose: false,
      saved: null,
      background: null,
      borderColor: null,
    };
    layouts.set(view, layout);
  }
  return layout;
}

/** Keeps at most one active `view.attribute relation value` constraint for this slot; none when `value` is null. */
function keepLength(
  view: Handle,
  current: Handle | null,
  attribute: number,
  relation: number,
  value: number | null,
): Handle | null {
  if (value === null) {
    if (current !== null) {
      current.setActive_(false);
      giveBack(current);
    }
    return null;
  }
  if (current !== null) {
    current.setConstant_(value);
    return current;
  }
  return lengthConstraint(view, attribute, relation, value, almostRequired);
}

/** Settles `axis` into its constraints on `view` and returns the bounds as applied. */
function applyAxis(view: Handle, axis: AxisSize, attribute: number): { min: number | null; max: number | null } {
  const min = axis.min === null ? null : Math.max(axis.min, 0);
  const floor = min ?? 0;
  const max = axis.max === null ? null : Math.max(axis.max, floor);
  let exact = axis.exact === null ? null : Math.max(axis.exact, floor);
  if (exact !== null && max !== null) exact = Math.min(exact, max);
  const { greaterThanOrEqual, lessThanOrEqual, equal } = layoutRelations();
  axis.minConstraint = keepLength(view, axis.minConstraint, attribute, greaterThanOrEqual, min);
  axis.maxConstraint = keepLength(view, axis.maxConstraint, attribute, lessThanOrEqual, max);
  axis.exactConstraint = keepLength(view, axis.exactConstraint, attribute, equal, exact);
  return { min, max };
}

/** One of `width`/`minWidth`/`maxWidth`/`height`/…: reads as assigned, writes through `applyAxis`. */
function sizeProp(dimension: "width" | "height", field: "exact" | "min" | "max"): ControlAccessor {
  return {
    get: view => layoutOf(view)[dimension][field],
    set(view, control, value, what) {
      const axis = layoutOf(view)[dimension];
      axis[field] = optionalPoints(what, value);
      applyAxis(control, axis, layoutAttributes()[dimension]);
    },
  };
}

/**
 * Hugging of a view with `grow`: below stock hugging (250), a stack's own
 * (249) and the window's bottom pin (240), so growers stretch first.
 */
const growerHugging = 200;
/**
 * Share constraints between growing siblings sit above `growerHugging` so the
 * ratio decides who stretches, and below a grower's compression (249) so the
 * ratio never squeezes one below its content.
 */
const growShare = 225;
/** Just under NSStackView's own filler (250): a view at this hugging stretches before the filler does. */
const belowStackFiller = 249;

/**
 * Derives the view's hugging and compression priorities from its own plus
 * `grow` and `loose`, and puts its own back once neither applies (so the
 * next time re-reads whatever the view set in between).
 */
function syncEmphasis(view: View, layout: Layout) {
  const control = handleOf(view);
  // A stack view has no content of its own for `contentHuggingPriority` to
  // hold on to; how tightly it wraps its children is a separate priority,
  // kept equal to it.
  const stack = view instanceof VStack || view instanceof HStack;
  const setHugging = (priority: number, orientation: number) => {
    control.setContentHuggingPriority_forOrientation_(priority, orientation);
    if (stack) control.setHuggingPriority_forOrientation_(priority, orientation);
  };
  const { horizontal, vertical } = orientations();
  if (!(layout.grow > 0 || layout.loose)) {
    const saved = layout.saved;
    if (saved === null) return;
    layout.saved = null;
    setHugging(saved[0], horizontal);
    control.setContentCompressionResistancePriority_forOrientation_(saved[1], horizontal);
    setHugging(saved[2], vertical);
    control.setContentCompressionResistancePriority_forOrientation_(saved[3], vertical);
    return;
  }
  const saved = (layout.saved ??= [
    control.contentHuggingPriorityForOrientation_(horizontal),
    control.contentCompressionResistancePriorityForOrientation_(horizontal),
    control.contentHuggingPriorityForOrientation_(vertical),
    control.contentCompressionResistancePriorityForOrientation_(vertical),
  ]);
  // Growers stretch and squeeze before anything at stock priorities; how much
  // each takes among siblings is the container's `regrow`. Loose panes only
  // need to sit below NSStackView's filler.
  for (const [orientation, ownHugging, ownCompression] of [
    [horizontal, saved[0], saved[1]],
    [vertical, saved[2], saved[3]],
  ]) {
    const growing = layout.grow > 0;
    setHugging(growing ? growerHugging : Math.min(ownHugging, belowStackFiller), orientation);
    control.setContentCompressionResistancePriority_forOrientation_(
      growing ? belowStackFiller : ownCompression,
      orientation,
    );
  }
}

/** Sets the view's `grow` weight and has its container lay the growers out again. */
function weigh(view: View, weight: number) {
  const layout = layoutOf(view);
  layout.grow = weight;
  syncEmphasis(view, layout);
  regrowParent(view);
}

function loosen(view: View, loose: boolean) {
  const layout = layoutOf(view);
  layout.loose = loose;
  syncEmphasis(view, layout);
}

const growWeight = (view: View) => layoutOf(view).grow;

function regrowParent(view: View) {
  const parent = view.parent;
  if (parent !== null) regrow(parent);
}

/** The `grow` prop's weight: `true` is 1, a number counts from 0 up. */
function growFor(what: string, value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return Math.max(optionalNumber(what, value) ?? 0, 0);
}

/** The `grow` prop: reads as given, weighs as `weightOf` makes of it (a Spacer's 0 counts as 1). */
const growProp = (weightOf: (weight: number) => number): ControlAccessor => ({
  get: view => propsOf(view).grow ?? 0,
  set: keptProp("grow", (_control, value, what, view) => weigh(view, weightOf(growFor(what, value)))).set,
});

/**
 * `-[NSColor CGColor]` resolves a dynamic colour against
 * `NSAppearance.currentAppearance`, which AppKit only points at the right
 * appearance while drawing, so it is pointed at the view's own around the
 * conversion.
 */
function paintLayer(view: Handle, layout: Layout) {
  view.setWantsLayer_(true);
  const layer = view.layer();
  if (layer === null) return;
  const { NSAppearance } = classes;
  const previous = NSAppearance.currentAppearance();
  const effective = view.effectiveAppearance();
  NSAppearance.setCurrentAppearance_(effective);
  try {
    looking(layout.background?.CGColor() ?? null, color => layer.setBackgroundColor_(color));
    looking(layout.borderColor?.CGColor() ?? null, color => layer.setBorderColor_(color));
  } finally {
    NSAppearance.setCurrentAppearance_(previous);
    giveBack(effective);
    giveBack(previous);
    giveBack(layer);
  }
}

/** `border`: a width, `{ width = 1, color = "separator" }`, or null for none. */
function borderFor(what: string, value: unknown): { width: number; color: Handle | null } {
  if (value === null) return { width: 0, color: null };
  if (typeof value === "number")
    return { width: Math.max(optionalPoints(what, value)!, 0), color: colorFor(what, "separator") };
  if (typeof value !== "object") throw argTypeError(`${what} must be a number, a { width, color } object or null`);
  const { width, color } = value as { width?: unknown; color?: unknown };
  return {
    width: width === undefined ? 1 : Math.max(optionalPoints(`${what}.width`, width ?? null) ?? 0, 0),
    color: colorFor(`${what}.color`, color === undefined ? "separator" : color),
  };
}

defineControlProps(
  View,
  {
    hidden: {
      get: (_view, control) => control.isHidden(),
      set(view, control, value, what) {
        control.setHidden_(optionalBoolean(what, value) ?? false);
        // A hidden child lets go of its fill and share; shown again it takes them back.
        rehid(view);
      },
    },
    alpha: {
      get: (_view, control) => control.alphaValue(),
      set: (_view, control, value, what) =>
        control.setAlphaValue_(Math.min(Math.max(optionalNumber(what, value) ?? 1, 0), 1)),
    },
    tooltip: {
      get: (_view, control) => stringOf(control, "toolTip") || null,
      set: (_view, control, value, what) => control.setToolTip_(optionalString(what, value)),
    },
    id: {
      get: (_view, control) => stringOf(control, "identifier") || null,
      set: (_view, control, value, what) => control.setIdentifier_(optionalString(what, value)),
    },
    width: sizeProp("width", "exact"),
    height: sizeProp("height", "exact"),
    minWidth: sizeProp("width", "min"),
    maxWidth: sizeProp("width", "max"),
    minHeight: sizeProp("height", "min"),
    maxHeight: sizeProp("height", "max"),
    grow: growProp(weight => weight),
    background: keptProp("background", (control, value, what, view) => {
      const layout = layoutOf(view);
      giveBack(layout.background);
      layout.background = colorFor(what, value);
      paintLayer(control, layout);
    }),
    cornerRadius: {
      get: (_view, control) =>
        looking(control.layer(), (layer: Handle | null) => (layer === null ? 0 : layer.cornerRadius())),
      set(_view, control, value, what) {
        const radius = Math.max(optionalPoints(what, value) ?? 0, 0);
        control.setWantsLayer_(true);
        looking(control.layer(), (layer: Handle | null) => {
          layer?.setCornerRadius_(radius);
          layer?.setMasksToBounds_(radius > 0);
        });
      },
    },
    border: keptProp("border", (control, value, what, view) => {
      const { width, color } = borderFor(what, value);
      const layout = layoutOf(view);
      giveBack(layout.borderColor);
      layout.borderColor = color;
      paintLayer(control, layout);
      looking(control.layer(), (layer: Handle | null) => layer?.setBorderWidth_(width));
    }),
  },
  false,
);

// ---------------------------------------------------------------------------
// Containers, built through the bridge: VStack/HStack (NSStackView), ZStack
// (a bare NSView pinning every child to its edges), Group (NSBox around a
// stack), ScrollView (NSScrollView with a flipped clip view) and SplitView
// (NSSplitView). Each hands `Container` a `ContainerLayout`.

/**
 * Beats default content hugging (250) so labels and fields stretch; loses to
 * the window holding its size (500) so a lone hugging child (a button, 750)
 * cannot shrink the window to itself, and to an explicit width/height (999).
 * A fill constraint pulls both ways: a child that will not stretch pulls the
 * stack towards its own width just as hard. Each level of nesting takes one
 * off, so where an inner stack's fill and an outer one's disagree the outer
 * one wins instead of the solver picking either.
 */
const fillPriority = 400;
/** Fill stops dropping this far below `fillPriority`, still above every hugging priority it has to beat. */
const fillLevels = 100;

const aligns = ["fill", "leading", "center", "trailing", "top", "bottom", "firstBaseline", "lastBaseline"] as const;
type StackAlign = (typeof aligns)[number];
const distributions = () => objcEnums.NSStackViewDistribution as Readonly<Record<string, number>>;

/** An NSStackView and what VStack, HStack and Group keep about it. */
type Stack = {
  view: Handle;
  vertical: boolean;
  /** `align` is `"fill"`: the one alignment NSStackView cannot hold itself (see `alignStack`). */
  fill: boolean;
  /** Containers between this one and the window content; see `fillPriority`. */
  depth: number;
  /** The cross-axis constraint `align: "fill"` adds per child. */
  fills: Map<View, Handle>;
  /** Ties the growers' lengths together in `grow` ratio; see `shareStack`. */
  shares: Handle[];
};

const stackOf = (view: View) => states.get(view) as Stack;

function makeStack(vertical: boolean): Stack {
  const view = classes.NSStackView.stackViewWithViews_(emptyList);
  const { horizontal: across, vertical: down } = orientations();
  view.setOrientation_(vertical ? down : across);
  view.setSpacing_(8);
  view.setDistribution_(distributions().fill);
  view.setDetachesHiddenViews_(true);
  // A stack should be as easy to stretch as its most willing child, and
  // never clip its children. `contentHuggingPriority` does nothing for a
  // stack itself; it carries the value `grow` saves and restores.
  const high = layoutPriority("NSLayoutPriorityDefaultHigh");
  for (const orientation of [across, down]) {
    view.setHuggingPriority_forOrientation_(belowStackFiller, orientation);
    view.setContentHuggingPriority_forOrientation_(belowStackFiller, orientation);
    view.setContentCompressionResistancePriority_forOrientation_(high, orientation);
  }
  const stack: Stack = {
    view,
    vertical,
    fill: false,
    depth: 0,
    fills: new Map(),
    shares: [],
  };
  alignStack(stack, vertical ? "fill" : "center", emptyList);
  return stack;
}

/**
 * NSStackView alignment is a layout attribute on the cross axis. It only
 * positions children there, never sizes them, so `fill` is leading/centre
 * plus a per-child constraint (`fillChild`). The curated names map onto
 * the attribute for the stack's axis; a bare `NSLayoutAttribute` is taken
 * as it is.
 */
function alignStack(stack: Stack, align: StackAlign | number, children: readonly View[]) {
  const attributes = layoutAttributes();
  let attribute: number;
  if (typeof align === "number") {
    attribute = align;
  } else if (stack.vertical) {
    attribute =
      align === "center"
        ? attributes.centerX
        : align === "trailing" || align === "bottom"
          ? attributes.trailing
          : align === "fill" || align === "leading" || align === "top"
            ? attributes.leading
            : attributes[align];
  } else {
    attribute =
      align === "fill" || align === "center"
        ? attributes.centerY
        : align === "top" || align === "leading"
          ? attributes.top
          : align === "bottom" || align === "trailing"
            ? attributes.bottom
            : attributes[align];
  }
  if (stack.vertical && (attribute === attributes.firstBaseline || attribute === attributes.lastBaseline)) {
    throw argValueError("firstBaseline/lastBaseline alignment only applies to a horizontal stack");
  }
  stack.fill = align === "fill";
  stack.view.setAlignment_(attribute);
  refillStack(stack, children);
}

/** The curated name of the stack's `-alignment` for its axis (`"fill"` while filling), else `NSLayoutAttribute`'s. */
function alignOf(stack: Stack): StackAlign | string | number {
  const attribute: number = stack.view.alignment();
  const { leading, trailing, left, right, top, bottom, centerX, centerY } = layoutAttributes();
  if (stack.vertical) {
    // Once given a left or right alignment, NSStackView answers those for leading and trailing too.
    if (attribute === leading || attribute === left) return stack.fill ? "fill" : "leading";
    if (attribute === trailing || attribute === right) return "trailing";
    if (attribute === centerX) return "center";
  } else {
    if (attribute === centerY) return stack.fill ? "fill" : "center";
    if (attribute === top) return "top";
    if (attribute === bottom) return "bottom";
  }
  return enumName("NSLayoutAttribute", attribute);
}

/**
 * Whether `child` takes part in the stack's layout. A hidden one does not
 * (`detachesHiddenViews`), so a constraint on it would hold the stack or a
 * sibling to a length nothing shows.
 */
function placed(stack: Stack, child: Handle): boolean {
  return !child.isHidden() && looking(child.superview(), superview => superview === stack.view);
}

/** With `align: "fill"`, stretches `child` across the cross axis: its width (or height) equals the stack's, less the edge insets. */
function fillChild(stack: Stack, child: View) {
  unfillChild(stack, child);
  const childView = handleOf(child);
  if (!stack.fill || !placed(stack, childView)) return;
  const { width, height } = layoutAttributes();
  const attribute = stack.vertical ? width : height;
  const insets = stack.view.edgeInsets();
  const inset = stack.vertical ? insets.left + insets.right : insets.top + insets.bottom;
  const priority = fillPriority - Math.min(stack.depth, fillLevels);
  const fill = relateConstraint(
    childView,
    attribute,
    layoutRelations().equal,
    stack.view,
    attribute,
    1,
    -inset,
    priority,
  );
  stack.fills.set(child, fill);
}

function unfillChild(stack: Stack, child: View) {
  const fill = stack.fills.get(child);
  if (fill === undefined) return;
  fill.setActive_(false);
  giveBack(fill);
  stack.fills.delete(child);
}

/** Re-applies (or removes) every fill constraint after `align`, `padding` or the depth changed. */
function refillStack(stack: Stack, children: readonly View[]) {
  for (const child of children) fillChild(stack, child);
}

function padStack(stack: Stack, what: string, value: unknown, fallback: number, children: readonly View[]) {
  stack.view.setEdgeInsets_(insetsFor(what, value ?? fallback));
  refillStack(stack, children);
}

/**
 * Hugging priorities only say who stretches first, and views with no
 * intrinsic size (spacers, nested stacks) have none to hug, so with `fill`
 * distribution leftover length is handed out explicitly: each grower's
 * length is tied to the first one's in the ratio of their weights. Other
 * distributions size children themselves.
 */
function shareStack(stack: Stack, children: readonly View[]) {
  for (const constraint of stack.shares) {
    constraint.setActive_(false);
    giveBack(constraint);
  }
  stack.shares.length = 0;
  if (stack.view.distribution() !== distributions().fill) return;
  const { width, height } = layoutAttributes();
  const attribute = stack.vertical ? height : width;
  let first: Handle | undefined;
  let firstWeight = 0;
  for (const child of children) {
    const weight = growWeight(child);
    if (!(weight > 0)) continue;
    const view = handleOf(child);
    if (!placed(stack, view)) continue;
    if (first === undefined) {
      first = view;
      firstWeight = weight;
    } else {
      const ratio = weight / firstWeight;
      stack.shares.push(
        relateConstraint(view, attribute, layoutRelations().equal, first, attribute, ratio, 0, growShare),
      );
    }
  }
}

const arrangedCount = (view: Handle): number => looking(view.arrangedSubviews(), list => list.count());

/** The `ContainerLayout` of the container whose children are `stack`'s arranged subviews. */
function stackLayout(stack: Stack): ContainerLayout {
  return {
    insert(child, index) {
      stack.view.insertArrangedSubview_atIndex_(handleOf(child), Math.min(index, arrangedCount(stack.view)));
      fillChild(stack, child);
    },
    // `insertArrangedSubview:atIndex:` on a view already arranged only
    // reorders it: it stays in the hierarchy with its constraints.
    move(child, index) {
      stack.view.insertArrangedSubview_atIndex_(handleOf(child), Math.min(index, arrangedCount(stack.view)));
    },
    remove(child) {
      const view = handleOf(child);
      unfillChild(stack, child);
      stack.view.removeArrangedSubview_(view);
      view.removeFromSuperview();
    },
    hid(child) {
      fillChild(stack, child);
    },
    regrow(children) {
      shareStack(stack, children);
    },
    nested(depth, children) {
      stack.depth = depth;
      refillStack(stack, children);
    },
  };
}

/** `padding`: a number for all edges, `{ top, left, bottom, right }`, `{ x, y }` or `[vertical, horizontal]`, as NSEdgeInsets. */
function insetsFor(what: string, value: unknown): { top: number; left: number; bottom: number; right: number } {
  const edge = (name: string, length: unknown) => {
    if (typeof length === "number" && Number.isFinite(length) && Math.abs(length) <= maxPoints) {
      return Math.max(length, 0);
    }
    throw argTypeError(`${what}${name} must be a finite number no larger than ${maxPoints}`);
  };
  if (typeof value === "number") {
    const all = edge("", value);
    return { top: all, left: all, bottom: all, right: all };
  }
  if (ArrayIsArray(value)) {
    if (value.length !== 2) throw argTypeError(`${what} array form is [vertical, horizontal]`);
    const y = edge("[0]", value[0]);
    const x = edge("[1]", value[1]);
    return { top: y, left: x, bottom: y, right: x };
  }
  if (typeof value !== "object" || value === null) {
    throw argTypeError(
      `${what} must be a number, an [vertical, horizontal] pair or a { top, left, bottom, right } object`,
    );
  }
  const given = value as Record<string, unknown>;
  const side = (name: string, fallback: string) =>
    given[name] !== undefined
      ? edge(`.${name}`, given[name])
      : given[fallback] !== undefined
        ? edge(`.${fallback}`, given[fallback])
        : 0;
  return { top: side("top", "y"), left: side("left", "x"), bottom: side("bottom", "y"), right: side("right", "x") };
}

/** `align`: a curated name, else any `NSLayoutAttribute` by name or number; null is the stack's default. */
function alignFor(what: string, value: unknown, vertical: boolean): StackAlign | number {
  if (value === null) return vertical ? "fill" : "center";
  if (typeof value === "string" && (aligns as readonly string[]).includes(value)) return value as StackAlign;
  const attributes = layoutAttributes();
  if ((typeof value === "string" && ObjectHasOwn(attributes, value)) || typeof value === "number") {
    return enumValue(what, "NSLayoutAttribute", value);
  }
  throw argTypeError(`${what} must be ${nameList(aligns)}, or an NSLayoutAttribute name or value`);
}

/** `"gravity"` is the curated name of `NSStackViewDistributionGravityAreas`; every other member goes by its own. */
function distributionFor(what: string, value: unknown): number {
  if (value === null) return distributions().fill;
  if (value === "gravity") return distributions().gravityAreas;
  return enumValue(what, "NSStackViewDistribution", value);
}

/** The props VStack, HStack and Group share, applied to the `Stack` in the view's state. */
function defineStackProps(Class: { prototype: object }, defaultPadding: number) {
  defineControlProps(Class, {
    spacing: {
      get: view => stackOf(view).view.spacing(),
      set: (view, _control, value, what) =>
        stackOf(view).view.setSpacing_(Math.max(optionalPoints(what, value) ?? 8, 0)),
    },
    padding: {
      get: view => stackOf(view).view.edgeInsets(),
      set: (view, _control, value, what) =>
        padStack(stackOf(view), what, value, defaultPadding, childrenOf(view as Container)),
    },
    align: {
      get: view => alignOf(stackOf(view)),
      set(view, _control, value, what) {
        const stack = stackOf(view);
        alignStack(stack, alignFor(what, value, stack.vertical), childrenOf(view as Container));
      },
    },
    distribution: {
      get(view) {
        const value = stackOf(view).view.distribution();
        return value === distributions().gravityAreas ? "gravity" : enumName("NSStackViewDistribution", value);
      },
      set(view, _control, value, what) {
        const stack = stackOf(view);
        stack.view.setDistribution_(distributionFor(what, value));
        shareStack(stack, childrenOf(view as Container));
      },
    },
  });
}

class VStack extends Container {
  constructor(props?: Record<string, unknown>) {
    const stack = makeStack(true);
    super("VStack", props, built(stack.view, stack), stackLayout(stack));
  }
}
defineStackProps(VStack, 0);

class HStack extends Container {
  constructor(props?: Record<string, unknown>) {
    const stack = makeStack(false);
    super("HStack", props, built(stack.view, stack), stackLayout(stack));
  }
}
defineStackProps(HStack, 0);

const titlePositions = () => objcEnums.NSTitlePosition as Readonly<Record<"noTitle" | "atTop", number>>;

class Group extends Container {
  constructor(props?: Record<string, unknown>) {
    const stack = makeStack(true);
    const box = classes.NSBox.alloc().initWithFrame_(zeroRect);
    box.setTitlePosition_(titlePositions().noTitle);
    // The box lays its own content view out by frame (autoresizing
    // constraints that track the box, its margins and title), so the stack
    // goes inside that view rather than replacing it: pinned edge to edge,
    // the stack's size then decides the box's.
    looking(box.contentView(), content => {
      content.addSubview_(stack.view);
      pinEdges(content, stack.view, 0);
    });
    // Inside the box's own margin, so children clear its rounded border.
    padStack(stack, "Group.padding", null, 4, emptyList);
    box.setTitle_("");
    super("Group", props, built(box, stack), stackLayout(stack));
  }
}
defineStackProps(Group, 4);
defineControlProps(Group, {
  title: {
    get: (_view, box) => stringOf(box, "title"),
    set(_view, box, value, what) {
      const title = optionalString(what, value) ?? "";
      box.setTitle_(title);
      // An empty title hides the title area; a titled box keeps whichever position it has.
      const { noTitle, atTop } = titlePositions();
      if (title === "") box.setTitlePosition_(noTitle);
      else if (box.titlePosition() === noTitle) box.setTitlePosition_(atTop);
    },
  },
});

const orderingModes = () => objcEnums.NSWindowOrderingMode as Readonly<Record<"above" | "below" | "out", number>>;

/**
 * A bare NSView whose children are pinned to all four edges, so several
 * overlap back to front: subview order is children order, index 0 back-most.
 */
function plainLayout(view: Handle): ContainerLayout {
  return {
    insert(child, index) {
      const childView = handleOf(child);
      const subviews = handlesOf(view, "subviews");
      try {
        if (index < subviews.length)
          view.addSubview_positioned_relativeTo_(childView, orderingModes().below, subviews[index]);
        else view.addSubview_(childView);
      } finally {
        subviews.forEach(giveBack);
      }
      pinEdges(view, childView, 0);
    },
    // Re-adding a subview to its own superview only changes its z-order.
    move(child, index) {
      const childView = handleOf(child);
      const subviews = handlesOf(view, "subviews");
      const siblings = subviews.filter(sibling => sibling !== childView);
      const { above, below } = orderingModes();
      try {
        if (index < siblings.length) view.addSubview_positioned_relativeTo_(childView, below, siblings[index]);
        else view.addSubview_positioned_relativeTo_(childView, above, null);
      } finally {
        subviews.forEach(giveBack);
      }
    },
    // AppKit drops the constraints involving the child when it leaves the hierarchy.
    remove(child) {
      handleOf(child).removeFromSuperview();
    },
  };
}

class ZStack extends Container {
  constructor(props?: Record<string, unknown>) {
    const view = classes.NSView.alloc().initWithFrame_(zeroRect);
    super("ZStack", props, built(view), plainLayout(view));
  }
}

/** The `NSClipView` subclass whose `isFlipped` is YES, so a scroll view's document starts at the top. */
let flippedClipViewClass: Handle | undefined;

type Scroll = {
  view: Handle;
  clip: Handle;
  horizontal: boolean;
  document: View | null;
  /** Ties the document's width to the clip view's; see `documentWidth`. */
  width: Handle | null;
};
const scrollOf = (view: View) => states.get(view) as Scroll;

/**
 * The document is at least as wide as the clip view: exactly as wide when
 * there is no horizontal scroller, so text wraps instead of running off to
 * the right.
 */
function documentWidth(scroll: Scroll): Handle | null {
  if (scroll.document === null) return null;
  const { greaterThanOrEqual, equal } = layoutRelations();
  const { width } = layoutAttributes();
  const relation = scroll.horizontal ? greaterThanOrEqual : equal;
  const required = layoutPriority("NSLayoutPriorityRequired");
  return relateConstraint(handleOf(scroll.document), width, relation, scroll.clip, width, 1, 0, required);
}

function scrollLayout(scroll: Scroll): ContainerLayout {
  return {
    insert(child) {
      if (scroll.document !== null) {
        throw $ERR_INVALID_STATE("ScrollView takes a single child; remove the current one first");
      }
      const document = handleOf(child);
      scroll.view.setDocumentView_(document);
      // Top and leading track the clip view and `documentWidth` ties the
      // widths; the height floor keeps short content at the top instead of
      // centred.
      const { leading, top, height } = layoutAttributes();
      const { equal, greaterThanOrEqual } = layoutRelations();
      const required = layoutPriority("NSLayoutPriorityRequired");
      document.setTranslatesAutoresizingMaskIntoConstraints_(false);
      giveBack(relateConstraint(document, leading, equal, scroll.clip, leading, 1, 0, required));
      giveBack(relateConstraint(document, top, equal, scroll.clip, top, 1, 0, required));
      giveBack(relateConstraint(document, height, greaterThanOrEqual, scroll.clip, height, 1, 0, required));
      scroll.document = child;
      scroll.width = documentWidth(scroll);
    },
    move() {},
    remove() {
      scroll.view.setDocumentView_(null);
      scroll.document = null;
      scroll.width = null;
    },
  };
}

/** `scrollBars`: `{ horizontal, vertical }`, one boolean for both, a name, or null for the defaults (vertical only). */
function scrollBarsFor(what: string, value: unknown): { horizontal: boolean; vertical: boolean } {
  if (value === null) return { horizontal: false, vertical: true };
  if (typeof value === "boolean") return { horizontal: value, vertical: value };
  if (typeof value === "string") {
    switch (value) {
      case "none":
        return { horizontal: false, vertical: false };
      case "horizontal":
        return { horizontal: true, vertical: false };
      case "vertical":
        return { horizontal: false, vertical: true };
      case "both":
        return { horizontal: true, vertical: true };
      default:
        throw argTypeError(`${what} must be "none", "horizontal", "vertical" or "both", got "${value}"`);
    }
  }
  if (typeof value !== "object")
    throw argTypeError(`${what} must be a { horizontal, vertical } object, a boolean or null`);
  const { horizontal, vertical } = value as { horizontal?: unknown; vertical?: unknown };
  return {
    horizontal: optionalBoolean(`${what}.horizontal`, horizontal ?? null) ?? false,
    vertical: optionalBoolean(`${what}.vertical`, vertical ?? null) ?? true,
  };
}

class ScrollView extends Container {
  constructor(props?: Record<string, unknown>) {
    const view = classes.NSScrollView.alloc().initWithFrame_(zeroRect);
    flippedClipViewClass ??= defineClass({
      name: "BunAppKitFlippedClipView",
      superclass: "NSClipView",
      // A constant, so AppKit's hit-testing and geometry never wait on JavaScript.
      methods: { isFlipped: true },
    }) as Handle;
    // NSScrollView positions its clip view with frames, so the clip keeps autoresizing on.
    const clip = flippedClipViewClass.alloc().initWithFrame_(zeroRect);
    clip.setDrawsBackground_(false);
    view.setContentView_(clip);
    view.setHasVerticalScroller_(true);
    view.setHasHorizontalScroller_(false);
    view.setAutohidesScrollers_(true);
    view.setDrawsBackground_(false);
    view.setBorderType_((objcEnums.NSBorderType as Record<string, number>).noBorder);
    const { horizontal, vertical } = orientations();
    for (const orientation of [horizontal, vertical]) {
      view.setContentHuggingPriority_forOrientation_(yielding, orientation);
      view.setContentCompressionResistancePriority_forOrientation_(yielding, orientation);
    }
    const scroll: Scroll = { view, clip, horizontal: false, document: null, width: null };
    super("ScrollView", props, built(view, scroll), scrollLayout(scroll));
  }
}
defineControlProps(ScrollView, {
  scrollBars: {
    get: (_view, control) =>
      ObjectFreeze({ horizontal: control.hasHorizontalScroller(), vertical: control.hasVerticalScroller() }),
    set(view, control, value, what) {
      const { horizontal, vertical } = scrollBarsFor(what, value);
      control.setHasHorizontalScroller_(horizontal);
      control.setHasVerticalScroller_(vertical);
      const scroll = scrollOf(view);
      if (horizontal === scroll.horizontal) return;
      scroll.horizontal = horizontal;
      scroll.width?.setActive_(false);
      scroll.width = documentWidth(scroll);
    },
  },
});

const dividerStyles = () => objcEnums.NSSplitViewDividerStyle as Readonly<Record<"thin", number>>;

/** `NSSplitView` with arranged subviews. */
function splitLayout(view: Handle): ContainerLayout {
  return {
    loose: true,
    insert(child, index) {
      view.insertArrangedSubview_atIndex_(handleOf(child), Math.min(index, arrangedCount(view)));
    },
    move(child, index) {
      view.insertArrangedSubview_atIndex_(handleOf(child), Math.min(index, arrangedCount(view)));
    },
    remove(child) {
      const childView = handleOf(child);
      view.removeArrangedSubview_(childView);
      childView.removeFromSuperview();
    },
    // The pane with the lowest holding priority is the one the split view
    // resizes, so a larger `grow` holds less; no `grow` keeps AppKit's default.
    regrow(children) {
      const defaultLow = layoutPriority("NSLayoutPriorityDefaultLow");
      children.forEach((child, index) => {
        const weight = growWeight(child);
        const holding =
          weight > 0 ? Math.min(Math.max(belowStackFiller - weight * 10, yielding), belowStackFiller) : defaultLow;
        view.setHoldingPriority_forSubviewAtIndex_(holding, index);
      });
    },
  };
}

class SplitView extends Container {
  constructor(props?: Record<string, unknown>) {
    const view = classes.NSSplitView.alloc().initWithFrame_(zeroRect);
    view.setDividerStyle_(dividerStyles().thin);
    view.setArrangesAllSubviews_(false);
    view.setVertical_(true);
    super("SplitView", props, built(view), splitLayout(view));
  }
}
defineControlProps(SplitView, {
  /**
   * NSSplitView's `vertical` means vertical *dividers* (side by side panes);
   * ours means panes stacked vertically, like VStack. Turning the split turns
   * what follows its axis (a Spacer's `minLength`, a Divider).
   */
  vertical: {
    get: (_view, control) => !control.isVertical(),
    set(view, control, value, what) {
      control.setVertical_(!(optionalBoolean(what, value) ?? false));
      for (const child of childrenOf(view as Container)) tellAxis(child, view as Container);
    },
  },
});

const titleAccessor: ControlAccessor = {
  get: (_view, control) => stringOf(control, "title"),
  set: (_view, control, value, what) => control.setTitle_(optionalString(what, value) ?? ""),
};
const enabledAccessor: ControlAccessor = {
  get: (_view, control) => control.isEnabled(),
  set: (_view, control, value, what) => control.setEnabled_(optionalBoolean(what, value) ?? true),
};
const fontAccessor = keptProp("font", (control, value, what) =>
  looking(fontFor(what, value), font => control.setFont_(font)),
);
/** `NSControlStateValueOn`; mixed and off read as not checked. */
const checkedAccessor: ControlAccessor = {
  get: (_view, control) => control.state() === 1,
  set: (_view, control, value, what) => control.setState_((optionalBoolean(what, value) ?? false) ? 1 : 0),
};
const naturalAlignment = () => (objcEnums.NSTextAlignment as Record<string, number>).natural;
/** `-alignment`, every `NSTextAlignment` member by name or value; `null` is natural. */
const textAlignAccessor: ControlAccessor = {
  get: (_view, control) => enumName("NSTextAlignment", control.alignment()),
  set: (_view, control, value, what) =>
    control.setAlignment_(value === null ? naturalAlignment() : enumValue(what, "NSTextAlignment", value)),
};

function fireChange(view: View & { checked: boolean }) {
  report(view, "onChange", () => [view.checked]);
}

/** The two enums Button props name members of (Apple's short names, as `objc.enums` has them). */
const bezelStyles = () => objcEnums.NSBezelStyle as Readonly<Record<string, number>>;
const imagePositions = () => objcEnums.NSCellImagePosition as Readonly<Record<string, number>>;

class Button extends View {
  constructor(props?: Record<string, unknown> | string) {
    const button = classes.NSButton.buttonWithTitle_target_action_("", null, null);
    button.setBezelStyle_(bezelStyles().push);
    const { horizontal } = orientations();
    button.setContentHuggingPriority_forOrientation_(layoutPriority("NSLayoutPriorityDefaultHigh"), horizontal);
    button.setContentCompressionResistancePriority_forOrientation_(titleCompression, horizontal);
    super("Button", typeof props === "string" ? { title: props } : props, built(button));
    wireAction(this, button, fireClick);
  }
}
function fireClick(view: Button) {
  report(view, "onClick");
}
/** No image without one, the image alone without a title, else image before title. */
function placeButtonImage(button: Handle) {
  const { noImage, imageOnly, imageLeft } = imagePositions();
  const hasImage = looking(button.image(), image => image !== null);
  button.setImagePosition_(!hasImage ? noImage : stringOf(button, "title") === "" ? imageOnly : imageLeft);
}
defineControlProps(Button, {
  title: {
    get: titleAccessor.get,
    set(view, control, value, what) {
      titleAccessor.set(view, control, value, what);
      placeButtonImage(control);
    },
  },
  bezelStyle: {
    get: (_view, control) => enumName("NSBezelStyle", control.bezelStyle()),
    set: (_view, control, value, what) =>
      control.setBezelStyle_(value === null ? bezelStyles().push : enumValue(what, "NSBezelStyle", value)),
  },
  bordered: {
    get: (_view, control) => control.isBordered(),
    set: (_view, control, value, what) => control.setBordered_(optionalBoolean(what, value) ?? true),
  },
  hasDestructiveAction: {
    get: (_view, control) => control.hasDestructiveAction(),
    set: (_view, control, value, what) => control.setHasDestructiveAction_(optionalBoolean(what, value) ?? false),
  },
  keyEquivalent: {
    get: (_view, control) => stringOf(control, "keyEquivalent") || null,
    set: (_view, control, value, what) => control.setKeyEquivalent_(optionalString(what, value) ?? ""),
  },
  enabled: enabledAccessor,
  symbol: keptProp("symbol", (control, value, what) => {
    looking(symbolImage(what, optionalString(what, value)), image => control.setImage_(image));
    placeButtonImage(control);
  }),
  font: fontAccessor,
  tint: keptProp("tint", (control, value, what) =>
    looking(colorFor(what, value), color => control.setContentTintColor_(color)),
  ),
});
defineHandlers(Button, "onClick");
defineClick(Button);

/** Checkbox and Radio: the same NSButton in two styles. */
function defineToggle(Class: { prototype: object }) {
  defineControlProps(Class, {
    title: titleAccessor,
    checked: checkedAccessor,
    enabled: enabledAccessor,
    font: fontAccessor,
  });
  defineHandlers(Class, "onChange");
  defineClick(Class);
}

function madeToggle(button: Handle): Handle {
  button.setContentCompressionResistancePriority_forOrientation_(titleCompression, orientations().horizontal);
  return button;
}

class Checkbox extends View {
  constructor(props?: Record<string, unknown>) {
    const button = madeToggle(classes.NSButton.checkboxWithTitle_target_action_("", null, null));
    super("Checkbox", props, built(button));
    wireAction(this, button, fireChange);
  }
}
defineToggle(Checkbox);

// Radios with one superview and one action selector are a group to AppKit:
// it turns the others off itself, sending no action for them.
class Radio extends View {
  constructor(props?: Record<string, unknown>) {
    const button = madeToggle(classes.NSButton.radioButtonWithTitle_target_action_("", null, null));
    super("Radio", props, built(button));
    wireAction(this, button, fireChange);
  }
}
defineToggle(Radio);

class Switch extends View {
  constructor(props?: Record<string, unknown>) {
    const control = classes.NSSwitch.alloc().initWithFrame_(zeroRect);
    super("Switch", props, built(control));
    wireAction(this, control, fireChange);
  }
}
defineControlProps(Switch, { checked: checkedAccessor, enabled: enabledAccessor });
defineHandlers(Switch, "onChange");
defineClick(Switch);

// Text: an NSTextField label.

/** `NSLineBreakMode`, for `lineLimit`. */
const lineBreakModes = () => objcEnums.NSLineBreakMode as Readonly<Record<string, number>>;
/** `-setMaximumNumberOfLines:` takes an NSInteger; nothing lays out this many. */
const maxLines = 0x7fffffff;

/** Truncating modes turn the cell's wrapping off, so "n lines then an ellipsis" is word wrapping plus `truncatesLastVisibleLine`. */
function setLineLimit(label: Handle, lines: number) {
  const { byTruncatingTail, byWordWrapping } = lineBreakModes();
  label.setMaximumNumberOfLines_(lines);
  label.setUsesSingleLineMode_(lines === 1);
  label.setLineBreakMode_(lines === 1 ? byTruncatingTail : byWordWrapping);
  looking(label.cell(), cell => cell.setTruncatesLastVisibleLine_(lines > 1));
}

class Text extends View {
  constructor(props?: Record<string, unknown> | string) {
    const label = classes.NSTextField.labelWithString_("");
    label.setSelectable_(false);
    label.setAlignment_(naturalAlignment());
    // A long label truncates instead of pushing the window wider.
    label.setContentCompressionResistancePriority_forOrientation_(
      layoutPriority("NSLayoutPriorityDefaultLow"),
      orientations().horizontal,
    );
    setLineLimit(label, 1);
    super("Text", typeof props === "string" ? { text: props } : props, built(label));
  }
}
defineControlProps(Text, {
  text: {
    get: (_view, control) => stringOf(control, "stringValue"),
    set: (_view, control, value, what) => control.setStringValue_(optionalString(what, value) ?? ""),
  },
  font: fontAccessor,
  color: keptProp("color", (control, value, what) =>
    looking(colorFor(what, value) ?? classes.NSColor.labelColor(), color => control.setTextColor_(color)),
  ),
  textAlign: textAlignAccessor,
  selectable: {
    get: (_view, control) => control.isSelectable(),
    set: (_view, control, value, what) => control.setSelectable_(optionalBoolean(what, value) ?? false),
  },
  lineLimit: {
    get: (_view, control) => control.maximumNumberOfLines(),
    set(_view, control, value, what) {
      setLineLimit(control, Math.min(optionalCount(what, value) ?? 1, maxLines));
    },
  },
});

// TextField, SecureField, SearchField: one-line input. Typing and focus come
// through an NSTextFieldDelegate (`controlTextDidBeginEditing:`,
// `controlTextDidChange:`, `controlTextDidEndEditing:`), Return through the
// field's target/action.

type FieldState = {
  /** `false` holds `onChange` back until editing ends or Return. */
  continuous: boolean;
  /** The text changed while `continuous` was off and nobody has been told yet. */
  dirty: boolean;
};
const fieldState = (view: View) => stateOf<FieldState>(view, () => ({ continuous: true, dirty: false }));

let fieldDelegateClass: Handle | undefined;
const fieldHooks = {
  "controlTextDidBeginEditing:"(view: TextField) {
    fieldState(view).dirty = false;
    later(() => callHandler(view, "onFocus", []));
  },
  "controlTextDidChange:"(view: TextField) {
    if (setting === view) return;
    const state = fieldState(view);
    if (state.continuous) later(() => callHandler(view, "onChange", [fieldValue(view)]));
    else state.dirty = true;
  },
  "controlTextDidEndEditing:"(view: TextField) {
    reportPendingChange(view);
    later(() => callHandler(view, "onBlur", []));
  },
};

function reportPendingChange(view: TextField) {
  const state = fieldState(view);
  if (!state.dirty) return;
  state.dirty = false;
  later(() => callHandler(view, "onChange", [fieldValue(view)]));
}

/** `-stringValue`: the text, including the user's edits so far. */
function fieldValue(view: View): string {
  return stringOf(handleOf(view), "stringValue");
}

/** Return (or a search field's search button): `onSubmit`, else what an NSTextField with no action of its own does with a key press. */
function fieldAction(view: TextField) {
  if (setting === view) return;
  reportPendingChange(view);
  later(() => {
    if (!callHandler(view, "onSubmit", [fieldValue(view)])) pressDefaultButton(handleOf(view));
  });
}

/** Sends Return on to the window's default button, as a field without a target does; only for a key press (not a search field's cancel button). */
function pressDefaultButton(field: Handle) {
  const keyDown = looking(classes.NSApplication.sharedApplication(), (nsapp: Handle) =>
    looking(
      nsapp.currentEvent(),
      (event: Handle | null) => event?.type() === (objcEnums.NSEventType as Record<string, number>).keyDown,
    ),
  );
  if (!keyDown) return;
  looking(field.window(), (window: Handle | null) =>
    looking(window?.defaultButtonCell() ?? null, (cell: Handle | null) => cell?.performClick_(null)),
  );
}

// SecureField and SearchField are TextFields here too; these tokens let
// their constructors pick the class without opening that up to callers.
const secureKind = Symbol("SecureField");
const searchKind = Symbol("SearchField");

class TextField extends View {
  constructor(props?: Record<string, unknown>, kind?: symbol) {
    const secure = kind === secureKind;
    const search = kind === searchKind;
    const Class = secure ? classes.NSSecureTextField : search ? classes.NSSearchField : classes.NSTextField;
    const field = Class.alloc().initWithFrame_(zeroRect);
    if (search) {
      // Submitted means Return (or the search glyph), not every pause in typing.
      field.setSendsWholeSearchString_(true);
    } else {
      // NSSearchField draws its own rounded bezel.
      field.setBezeled_(true);
      field.setDrawsBackground_(true);
    }
    field.setEditable_(true);
    field.setSelectable_(true);
    field.setAlignment_(naturalAlignment());
    looking(fontFor("", null), font => field.setFont_(font));
    looking(field.cell(), cell => {
      cell.setScrollable_(true);
      cell.setSendsActionOnEndEditing_(false);
    });
    // A long value scrolls inside the field instead of pushing the window wider.
    field.setContentCompressionResistancePriority_forOrientation_(
      layoutPriority("NSLayoutPriorityDefaultLow"),
      orientations().horizontal,
    );
    super(secure ? "SecureField" : search ? "SearchField" : "TextField", props, built(field));
    wireAction(this, field, fieldAction);
    fieldDelegateClass ??= delegateClass(["NSTextFieldDelegate"], fieldHooks);
    wireDelegate(this, field, fieldDelegateClass);
  }
}
defineControlProps(TextField, {
  value: {
    get: view => fieldValue(view),
    set(view, control, value, what) {
      const text = optionalString(what, value) ?? "";
      // Re-assigning the text the field already shows would still reset the
      // caret and selection while the user is typing.
      if (stringOf(control, "stringValue") === text) return;
      control.setStringValue_(text);
      // The user's unreported edit was just replaced from code.
      fieldState(view).dirty = false;
    },
  },
  placeholder: {
    get: (_view, control) => stringOf(control, "placeholderString") || null,
    set: (_view, control, value, what) => control.setPlaceholderString_(optionalString(what, value)),
  },
  editable: {
    get: (_view, control) => control.isEditable(),
    set: (_view, control, value, what) => control.setEditable_(optionalBoolean(what, value) ?? true),
  },
  enabled: enabledAccessor,
  font: fontAccessor,
  textAlign: textAlignAccessor,
  continuous: {
    get: view => fieldState(view).continuous,
    set(view, _control, value, what) {
      fieldState(view).continuous = optionalBoolean(what, value) ?? true;
    },
  },
});
defineHandlers(TextField, "onChange", "onSubmit", "onFocus", "onBlur");

class SecureField extends TextField {
  constructor(props?: Record<string, unknown>) {
    super(props, secureKind);
  }
}

class SearchField extends TextField {
  constructor(props?: Record<string, unknown>) {
    super(props, searchKind);
  }
}

// Slider: an NSSlider with an optional step.

type SliderState = {
  /** Snap to multiples of this above `min`; 0 for none. */
  step: number;
  /** What was last asked for (by a prop or the user), before snapping and clamping. */
  wanted: number;
};
const sliderState = (view: View) => stateOf<SliderState>(view, () => ({ step: 0, wanted: 0 }));
/** Above this many steps tick marks stop being useful and just cost drawing. */
const maxTickMarks = 50;

function snapped(control: Handle, state: SliderState, value: number): number {
  const min = control.minValue() as number;
  const max = control.maxValue() as number;
  const { step } = state;
  if (step > 0) value = min + Math.round((value - min) / step) * step;
  return min <= max ? Math.min(Math.max(value, min), max) : value;
}

/**
 * NSSlider spaces tick marks evenly from min to max, so they only coincide
 * with the step grid when the range is a whole number of steps; otherwise
 * `snapped` alone does the snapping.
 */
function settleSlider(view: View, control: Handle) {
  const state = sliderState(view);
  const steps = state.step > 0 ? (control.maxValue() - control.minValue()) / state.step : 0;
  const integral = Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(steps, 1);
  const ticks = integral && steps >= 1 && steps <= maxTickMarks ? Math.round(steps) + 1 : 0;
  control.setNumberOfTickMarks_(ticks);
  control.setAllowsTickMarkValuesOnly_(ticks > 0);
  control.setDoubleValue_(snapped(control, state, state.wanted));
}

function sliderMoved(view: Slider) {
  if (setting === view) return;
  const control = handleOf(view);
  const state = sliderState(view);
  const raw = control.doubleValue() as number;
  const value = snapped(control, state, raw);
  if (value !== raw) control.setDoubleValue_(value);
  state.wanted = value;
  report(view, "onChange", () => [value]);
}

class Slider extends View {
  constructor(props?: Record<string, unknown>) {
    const slider = classes.NSSlider.sliderWithValue_minValue_maxValue_target_action_(0, 0, 1, null, null);
    slider.setContinuous_(true);
    super("Slider", props, built(slider));
    wireAction(this, slider, sliderMoved);
  }
}
defineControlProps(Slider, {
  value: {
    get: (_view, control) => control.doubleValue(),
    set(view, control, value, what) {
      const state = sliderState(view);
      state.wanted = optionalNumber(what, value) ?? 0;
      control.setDoubleValue_(snapped(control, state, state.wanted));
    },
  },
  min: {
    get: (_view, control) => control.minValue(),
    set(view, control, value, what) {
      control.setMinValue_(optionalNumber(what, value) ?? 0);
      settleSlider(view, control);
    },
  },
  max: {
    get: (_view, control) => control.maxValue(),
    set(view, control, value, what) {
      control.setMaxValue_(optionalNumber(what, value) ?? 1);
      settleSlider(view, control);
    },
  },
  step: {
    get: view => sliderState(view).step,
    set(view, control, value, what) {
      sliderState(view).step = positiveNumber(what, value) ?? 0;
      settleSlider(view, control);
    },
  },
  continuous: {
    get: (_view, control) => control.isContinuous(),
    set: (_view, control, value, what) => control.setContinuous_(optionalBoolean(what, value) ?? true),
  },
  enabled: enabledAccessor,
});
defineHandlers(Slider, "onChange");

// Picker (NSPopUpButton) and Segmented (NSSegmentedControl): one index
// chosen from a list of titles. The wanted index outlives the item list, so a
// `selectedIndex` that arrives before `items` still takes effect, and the
// answer is the same whichever is assigned first.

type Choice = {
  count(control: Handle): number;
  items(control: Handle): readonly string[];
  selected(control: Handle): number;
  select(control: Handle, index: number): void;
  setItems(control: Handle, items: readonly string[]): void;
};
type ChoiceState = { wanted: number };
const choiceState = (view: View) => stateOf<ChoiceState>(view, () => ({ wanted: 0 }));

function showChoice(view: View, control: Handle, choice: Choice) {
  const { wanted } = choiceState(view);
  choice.select(control, wanted >= 0 && wanted < choice.count(control) ? wanted : -1);
}

function defineChoice(Class: { prototype: object }, choice: Choice) {
  defineControlProps(Class, {
    items: {
      get: (_view, control) => choice.items(control),
      set(view, control, value, what) {
        choice.setItems(control, stringList(what, value));
        showChoice(view, control, choice);
      },
    },
    selectedIndex: {
      get: (_view, control) => choice.selected(control),
      set(view, control, value, what) {
        const index = optionalNumber(what, value);
        choiceState(view).wanted = index === null ? 0 : index < 0 ? -1 : Math.trunc(index);
        showChoice(view, control, choice);
      },
    },
    enabled: enabledAccessor,
  });
  defineHandlers(Class, "onChange");
}

const chosen = (choice: Choice) =>
  function (view: View) {
    if (setting === view) return;
    const index = choice.selected(handleOf(view));
    choiceState(view).wanted = index;
    report(view, "onChange", () => [index]);
  };

const popUpChoice: Choice = {
  count: control => control.numberOfItems(),
  items: control => stringsOf(control, "itemTitles"),
  selected: control => control.indexOfSelectedItem(),
  select: (control, index) => control.selectItemAtIndex_(index),
  // Added to the menu rather than with the button's `addItemsWithTitles:`,
  // which drops an earlier item with the same title and so shifts every
  // index after it; NSMenu keeps duplicates.
  setItems(control, items) {
    control.removeAllItems();
    looking(control.menu(), menu => {
      for (const title of items) plainSend(menu, "addItemWithTitle:action:keyEquivalent:", title, null, "");
    });
  },
};

class Picker extends View {
  constructor(props?: Record<string, unknown>) {
    const control = classes.NSPopUpButton.alloc().initWithFrame_pullsDown_(zeroRect, false);
    control.setContentCompressionResistancePriority_forOrientation_(titleCompression, orientations().horizontal);
    super("Picker", props, built(control));
    wireAction(this, control, pickerChose);
  }
}
const pickerChose = chosen(popUpChoice);
defineChoice(Picker, popUpChoice);

const segmentChoice: Choice = {
  count: control => control.segmentCount(),
  items(control) {
    const labels: string[] = [];
    for (let i = 0, count = control.segmentCount(); i < count; i++)
      labels.push(stringOf(control, "labelForSegment:", i));
    return ObjectFreeze(labels);
  },
  selected: control => control.selectedSegment(),
  select: (control, index) => control.setSelectedSegment_(index),
  setItems(control, items) {
    control.setSegmentCount_(items.length);
    for (let i = 0; i < items.length; i++) {
      control.setLabel_forSegment_(items[i], i);
      control.setWidth_forSegment_(0, i);
    }
  },
};

class Segmented extends View {
  constructor(props?: Record<string, unknown>) {
    const tracking = objcEnums.NSSegmentSwitchTracking as Record<string, number>;
    const control = classes.NSSegmentedControl.segmentedControlWithLabels_trackingMode_target_action_(
      emptyList,
      tracking.selectOne,
      null,
      null,
    );
    // Fill, so the control spans a fill-aligned stack.
    control.setSegmentDistribution_((objcEnums.NSSegmentDistribution as Record<string, number>).fill);
    control.setContentCompressionResistancePriority_forOrientation_(titleCompression, orientations().horizontal);
    super("Segmented", props, built(control));
    wireAction(this, control, segmentedChose);
  }
}
const segmentedChose = chosen(segmentChoice);
defineChoice(Segmented, segmentChoice);

// Progress: a bar or spinner, determinate or not.

type ProgressState = {
  /** The value as asked for. NSProgressIndicator clamps into `[min, max]` on assignment, so it is applied again whenever the range changes. */
  wanted: number | null;
  running: boolean;
};
const progressState = (view: View) => stateOf<ProgressState>(view, () => ({ wanted: null, running: true }));
const progressStyles = () => objcEnums.NSProgressIndicatorStyle as Readonly<Record<string, number>>;

/** The indeterminate animation runs while `running`; a determinate bar ignores start/stop. */
function animateProgress(view: View, control: Handle) {
  if (control.isIndeterminate() && progressState(view).running) control.startAnimation_(null);
  else control.stopAnimation_(null);
}

function reapplyProgress(view: View, control: Handle) {
  const { wanted } = progressState(view);
  if (wanted !== null) control.setDoubleValue_(wanted);
}

class Progress extends View {
  constructor(props?: Record<string, unknown>) {
    const control = classes.NSProgressIndicator.alloc().initWithFrame_(zeroRect);
    control.setStyle_(progressStyles().bar);
    control.setControlSize_((objcEnums.NSControlSize as Record<string, number>).regular);
    control.setIndeterminate_(false);
    control.setDisplayedWhenStopped_(true);
    control.setMinValue_(0);
    control.setMaxValue_(100);
    super("Progress", props, built(control));
  }
}
defineControlProps(Progress, {
  value: {
    get: (_view, control) => control.doubleValue(),
    set(view, control, value, what) {
      progressState(view).wanted = optionalNumber(what, value) ?? 0;
      reapplyProgress(view, control);
    },
  },
  min: {
    get: (_view, control) => control.minValue(),
    set(view, control, value, what) {
      control.setMinValue_(optionalNumber(what, value) ?? 0);
      reapplyProgress(view, control);
    },
  },
  max: {
    get: (_view, control) => control.maxValue(),
    set(view, control, value, what) {
      control.setMaxValue_(optionalNumber(what, value) ?? 100);
      reapplyProgress(view, control);
    },
  },
  indeterminate: {
    get: (_view, control) => control.isIndeterminate(),
    set(view, control, value, what) {
      control.setIndeterminate_(optionalBoolean(what, value) ?? false);
      animateProgress(view, control);
    },
  },
  running: {
    get: view => progressState(view).running,
    set(view, control, value, what) {
      progressState(view).running = optionalBoolean(what, value) ?? true;
      animateProgress(view, control);
    },
  },
  spinner: {
    get: (_view, control) => control.style() === progressStyles().spinning,
    set(view, control, value, what) {
      const { spinning, bar } = progressStyles();
      // The size and the indeterminate flag are carried across the switch
      // by hand rather than trusting every AppKit version to; the
      // indeterminate animation only runs if started after it.
      const size = control.controlSize();
      const indeterminate = control.isIndeterminate();
      control.setStyle_((optionalBoolean(what, value) ?? false) ? spinning : bar);
      control.setControlSize_(size);
      control.setIndeterminate_(indeterminate);
      animateProgress(view, control);
    },
  },
});

// Image: an NSImageView showing a system symbol, a file or encoded bytes.

type ImageState = { symbolSize: number };
const imageState = (view: View) => stateOf<ImageState>(view, () => ({ symbolSize: 0 }));
/** The curated `scaling` names for `NSImageScaling`'s members (its own names and values are taken too). */
const imageScalings: Record<string, string> = {
  down: "scaleProportionallyDown",
  fit: "scaleProportionallyUpOrDown",
  fill: "scaleAxesIndependently",
  none: "scaleNone",
};

/** The NSImage for an `image` prop value, or null for none. */
function loadImage(what: string, source: unknown): Handle | null {
  if (source === null) return null;
  const { NSImage } = classes;
  const fromData = (bytes: unknown) => {
    const image = NSImage.alloc().initWithData_(bytes);
    if (image === null) throw argValueError(`${what}: unrecognized image data`);
    return image;
  };
  if (source instanceof ArrayBuffer || source instanceof SharedArrayBuffer || ArrayBuffer.isView(source)) {
    return fromData(source);
  }
  if (typeof source === "object") {
    const { symbol, file, data } = source as { symbol?: unknown; file?: unknown; data?: unknown };
    if (symbol !== undefined) {
      if (typeof symbol !== "string") throw argTypeError(`${what}.symbol must be a string`);
      return symbolImage(what, symbol);
    }
    if (file !== undefined) {
      if (typeof file !== "string") throw argTypeError(`${what}.file must be a string`);
      const image = NSImage.alloc().initWithContentsOfFile_(file);
      if (image === null) {
        const error = new Error(`could not load image file ${JSON.stringify(file)}`) as Error & { path: string };
        error.path = file;
        throw error;
      }
      return image;
    }
    if (data !== undefined) {
      if (!(data instanceof ArrayBuffer || data instanceof SharedArrayBuffer || ArrayBuffer.isView(data))) {
        throw argTypeError(`${what}.data must be an ArrayBuffer or a typed array`);
      }
      return fromData(data);
    }
  }
  throw argTypeError(`${what} must be { symbol }, { file }, { data } or null`);
}

function applySymbolSize(view: View, control: Handle) {
  const { symbolSize } = imageState(view);
  looking(
    symbolSize > 0
      ? classes.NSImageSymbolConfiguration.configurationWithPointSize_weight_(
          symbolSize,
          objcConstants.NSFontWeightRegular,
        )
      : null,
    configuration => control.setSymbolConfiguration_(configuration),
  );
}

class Image extends View {
  constructor(props?: Record<string, unknown>) {
    const control = classes.NSImageView.alloc().initWithFrame_(zeroRect);
    control.setEditable_(false);
    // A large bitmap should shrink to fit its container rather than force
    // the window to its pixel size.
    const { horizontal, vertical } = orientations();
    const low = layoutPriority("NSLayoutPriorityDefaultLow");
    control.setContentCompressionResistancePriority_forOrientation_(low, horizontal);
    control.setContentCompressionResistancePriority_forOrientation_(low, vertical);
    super("Image", props, built(control));
  }
}
defineControlProps(Image, {
  image: keptProp("image", (control, value, what, view) => {
    control.setImage_(loadImage(what, value));
    applySymbolSize(view, control);
  }),
  scaling: {
    get(_view, control) {
      const value = control.imageScaling() as number;
      const name = enumName("NSImageScaling", value);
      for (const key of ObjectKeys(imageScalings)) if (imageScalings[key] === name) return key;
      return name;
    },
    set(_view, control, value, what) {
      const members = objcEnums.NSImageScaling as Record<string, number>;
      let scaling: number;
      if (value === null) scaling = members[imageScalings.down];
      else if (typeof value === "string" && ObjectHasOwn(imageScalings, value)) scaling = members[imageScalings[value]];
      else if ((typeof value === "string" && ObjectHasOwn(members, value)) || typeof value === "number") {
        scaling = enumValue(what, "NSImageScaling", value);
      } else {
        throw argTypeError(
          `${what} must be ${nameList(ObjectKeys(imageScalings))}, or an NSImageScaling name or value`,
        );
      }
      control.setImageScaling_(scaling);
    },
  },
  tint: keptProp("tint", (control, value, what) =>
    looking(colorFor(what, value), color => control.setContentTintColor_(color)),
  ),
  size: {
    get: view => imageState(view).symbolSize,
    set(view, control, value, what) {
      imageState(view).symbolSize = positivePoints(what, value) ?? 0;
      applySymbolSize(view, control);
    },
  },
  enabled: enabledAccessor,
});

// Divider (a one-pixel NSBox separator) and Spacer (empty stretch). Both
// follow the enclosing container's axis, which the container tells them
// (`tellAxis`).

type DividerState = {
  /** The `vertical` prop, when set; otherwise the line runs across the container's axis. */
  explicit: boolean | null;
  axis: Axis;
  /** Whether the line runs top to bottom at the moment. */
  upright: boolean;
  /** Pins the short side to one pixel; swapped when `upright` changes. */
  thickness: Handle;
};

/** An NSBoxSeparator draws along whichever side is longer: the short one is pinned and the long one stretches (its hugging yields from the start). */
function pinThickness(box: Handle, upright: boolean): Handle {
  const { width, height } = layoutAttributes();
  return lengthConstraint(
    box,
    upright ? width : height,
    layoutRelations().equal,
    1,
    layoutPriority("NSLayoutPriorityRequired"),
  );
}

const dividerState = (view: View) =>
  stateOf<DividerState>(view, view => ({
    explicit: null,
    axis: null,
    upright: false,
    thickness: pinThickness(handleOf(view), false),
  }));

function orientDivider(view: View) {
  const state = dividerState(view);
  const upright = state.explicit ?? state.axis === "horizontal";
  if (upright === state.upright) return;
  state.thickness.setActive_(false);
  state.thickness = pinThickness(handleOf(view), upright);
  state.upright = upright;
}

class Divider extends View {
  constructor(props?: Record<string, unknown>) {
    const box = classes.NSBox.alloc().initWithFrame_({ x: 0, y: 0, width: 100, height: 1 });
    box.setBoxType_((objcEnums.NSBoxType as Record<string, number>).separator);
    const { horizontal, vertical } = orientations();
    box.setContentHuggingPriority_forOrientation_(yielding, horizontal);
    box.setContentHuggingPriority_forOrientation_(yielding, vertical);
    super("Divider", props, built(box));
    dividerState(this);
  }
}
defineControlProps(Divider, {
  vertical: {
    get: view => dividerState(view).explicit,
    set(view, _control, value, what) {
      dividerState(view).explicit = optionalBoolean(what, value);
      orientDivider(view);
    },
  },
});

type SpacerState = { minLength: number; axis: Axis; constraint: Handle | null };
const spacerState = (view: View) => stateOf<SpacerState>(view, () => ({ minLength: 0, axis: null, constraint: null }));

function applyMinLength(view: View) {
  const state = spacerState(view);
  if (state.constraint !== null) {
    state.constraint.setActive_(false);
    giveBack(state.constraint);
    state.constraint = null;
  }
  if (state.minLength === 0 || state.axis === null) return;
  const { width, height } = layoutAttributes();
  state.constraint = lengthConstraint(
    handleOf(view),
    state.axis === "horizontal" ? width : height,
    layoutRelations().greaterThanOrEqual,
    state.minLength,
    almostRequired,
  );
}

/** A spacer with no `grow` of its own takes leftover space like `grow: 1`: that is what it is for, and two of them should share it. */
const spacerWeight = (weight: number) => (weight > 0 ? weight : 1);

class Spacer extends View {
  constructor(props?: Record<string, unknown>) {
    const space = classes.NSView.alloc().initWithFrame_(zeroRect);
    const { horizontal, vertical } = orientations();
    for (const axis of [horizontal, vertical]) {
      space.setContentHuggingPriority_forOrientation_(yielding, axis);
      space.setContentCompressionResistancePriority_forOrientation_(yielding, axis);
    }
    super("Spacer", props, built(space));
    if (!ObjectHasOwn(propsOf(this), "grow")) weigh(this, 1);
  }
}
defineControlProps(Spacer, {
  grow: growProp(spacerWeight),
  minLength: {
    get: view => spacerState(view).minLength,
    set(view, _control, value, what) {
      spacerState(view).minLength = positivePoints(what, value) ?? 0;
      applyMinLength(view);
    },
  },
});

// ---------------------------------------------------------------------------
// TextEditor: the plain-text NSTextView inside the scroll view that
// `+[NSTextView scrollableTextView]` makes; `onChange` is its
// NSTextViewDelegate's `textDidChange:`.

type EditorState = {
  /** The NSTextView, the scroll view's document; `.native` is the NSScrollView around it. */
  text: Handle;
  /**
   * The view's own undo stack, handed out from `undoManagerForTextView:`.
   * The default is the window's shared one, where clearing this editor's
   * stale groups after a programmatic `value` would also erase every
   * sibling's typing history.
   */
  undo: Handle;
};
const editorOf = (view: View) => states.get(view) as EditorState;

/** `-string`: the text, including the user's edits so far. */
function editorValue(view: View): string {
  return stringOf(editorOf(view).text, "string");
}

let editorDelegateClass: Handle | undefined;
const editorHooks = {
  "textDidChange:": (view: TextEditor) => report(view, "onChange", () => [editorValue(view)]),
  "undoManagerForTextView:": (view: TextEditor) => editorOf(view).undo,
};

class TextEditor extends View {
  constructor(props?: Record<string, unknown>) {
    const scroll = classes.NSTextView.scrollableTextView();
    const text = scroll.documentView();
    text.setRichText_(false);
    text.setAutomaticQuoteSubstitutionEnabled_(false);
    text.setAutomaticDashSubstitutionEnabled_(false);
    text.setAutomaticTextReplacementEnabled_(false);
    text.setAllowsUndo_(true);
    text.setUsesAdaptiveColorMappingForDarkAppearance_(true);
    // NSTextView's own default is Helvetica 12; match the other controls.
    looking(fontFor("", null), font => text.setFont_(font));
    looking(classes.NSColor.textColor(), color => text.setTextColor_(color));
    super("TextEditor", props, built(scroll, { text, undo: classes.NSUndoManager.new() }));
    editorDelegateClass ??= delegateClass(["NSTextViewDelegate"], editorHooks);
    wireDelegate(this, text, editorDelegateClass);
  }
}
defineControlProps(TextEditor, {
  value: {
    get: view => editorValue(view),
    set(view, _scroll, value, what) {
      const string = optionalString(what, value) ?? "";
      const { text, undo } = editorOf(view);
      // Re-assigning the text the view already shows would still reset the
      // caret and selection while the user is typing.
      if (stringOf(text, "string") === string) return;
      text.setString_(string);
      // setString: bypasses the shouldChangeText/didChangeText bracket, so
      // pending undo groups refer to ranges that no longer exist and Cmd-Z
      // would raise NSRangeException.
      text.breakUndoCoalescing();
      undo.removeAllActions();
    },
  },
  editable: {
    get: view => editorOf(view).text.isEditable(),
    set: (view, _scroll, value, what) => editorOf(view).text.setEditable_(optionalBoolean(what, value) ?? true),
  },
  font: keptProp("font", (_scroll, value, what, view) =>
    looking(fontFor(what, value), font => editorOf(view).text.setFont_(font)),
  ),
  color: keptProp("color", (_scroll, value, what, view) =>
    looking(colorFor(what, value) ?? classes.NSColor.textColor(), color => editorOf(view).text.setTextColor_(color)),
  ),
});
defineHandlers(TextEditor, "onChange");

// ---------------------------------------------------------------------------
// Table: a view-based NSTableView in an NSScrollView. One script object is
// its data source and delegate: AppKit asks it for the row count and for a
// cell's view as each row scrolls into sight, so the rows stay here and a
// long array costs nothing until it is looked at. `onSelect` is the
// delegate's `tableViewSelectionDidChange:`, `onActivate` the table's
// `doubleAction`.

type TableColumnSpec = { id: string; title: string; width: number | null };
type TableState = {
  /** The NSTableView, the scroll view's document; `.native` is the NSScrollView around it. */
  table: Handle;
  /** Kept so the header can come back after `setHeaderView:` nil. */
  header: Handle;
  /** `null`: shown once real columns exist (the implicit single column has nothing to title). */
  headerWanted: boolean | null;
  /** Whether `columns` were given; otherwise the table has the one untitled column. */
  explicit: boolean;
  /** The NSTableColumns the `columns` setter made, in order; a cell finds its text by its column's place here (one a script added has none). */
  columns: Handle[];
  rows: readonly (readonly string[])[];
  /** What the caller asked to select; re-applied when rows or columns change so prop order does not matter. */
  wanted: readonly number[];
  defaultRowHeight: number;
};
const tableOf = (view: View) => states.get(view) as TableState;

/** `NSTableColumnAutoresizingMask | NSTableColumnUserResizingMask`. */
const columnResizing = () => {
  const { autoresizingMask, userResizingMask } = objcEnums.NSTableColumnResizingOptions as Record<string, number>;
  return autoresizingMask | userResizingMask;
};
const cellIdentifier = "BunAppKitTextCell";
const cellPadding = 2;
/**
 * A scroll view has no intrinsic size, so without these a table with no
 * explicit `height` collapses to nothing. They sit below the window's bottom
 * pin (240) so a table still stretches to fill a window.
 */
const fallbackSizePriority = 200;
const fallbackSize = { width: 240, height: 160 };
const implicitColumn: TableColumnSpec = { id: "value", title: "", width: null };

function makeColumn(table: Handle, { id, title, width }: TableColumnSpec): Handle {
  const column = classes.NSTableColumn.alloc().initWithIdentifier_(id);
  column.setTitle_(title);
  column.setEditable_(false);
  column.setResizingMask_(columnResizing());
  if (width !== null) column.setWidth_(width);
  table.addTableColumn_(column);
  return column;
}

/** A reusable cell (`makeViewWithIdentifier:owner:`), else a new NSTableCellView with one truncating label. */
function tableCell(table: Handle): Handle {
  const reused = table.makeViewWithIdentifier_owner_(cellIdentifier, null);
  if (reused !== null) return reused;
  const cell = classes.NSTableCellView.alloc().initWithFrame_(zeroRect);
  const label = classes.NSTextField.labelWithString_("");
  label.setTranslatesAutoresizingMaskIntoConstraints_(false);
  label.setLineBreakMode_(lineBreakModes().byTruncatingTail);
  cell.addSubview_(label);
  cell.setTextField_(label);
  cell.setIdentifier_(cellIdentifier);
  const { leading, trailing, centerY } = layoutAttributes();
  const { equal } = layoutRelations();
  const required = layoutPriority("NSLayoutPriorityRequired");
  giveBack(relateConstraint(label, leading, equal, cell, leading, 1, cellPadding, required));
  giveBack(relateConstraint(label, trailing, equal, cell, trailing, 1, -cellPadding, required));
  giveBack(relateConstraint(label, centerY, equal, cell, centerY, 1, 0, required));
  return cell;
}

/** `-selectedRowIndexes` as a frozen list. */
function selectedRows(view: View): readonly number[] {
  const set = tableOf(view).table.selectedRowIndexes();
  try {
    return ObjectFreeze(Array.from(set as Iterable<number | bigint>, Number));
  } finally {
    set.release();
  }
}

/**
 * Selects the wanted rows that exist right now; at most one on a
 * single-selection table, because AppKit only enforces that for clicks.
 */
function applySelection(state: TableState) {
  const count = state.rows.length;
  let live = state.wanted.filter(i => i < count);
  if (live.length > 1 && !state.table.allowsMultipleSelection()) live = [live.reduce((a, b) => Math.min(a, b))];
  const set = classes.NSMutableIndexSet.indexSet();
  for (const i of live) set.addIndex_(i);
  state.table.selectRowIndexes_byExtendingSelection_(set, false);
}

function reloadTable(state: TableState) {
  state.table.reloadData();
  applySelection(state);
}

function syncHeader(state: TableState) {
  const visible = state.headerWanted ?? state.explicit;
  state.table.setHeaderView_(visible ? state.header : null);
}

function columnsFor(what: string, value: unknown): TableColumnSpec[] {
  if (value === null) return [];
  if (!ArrayIsArray(value)) throw argTypeError(`${what} must be an array of strings or { id, title, width } objects`);
  const out: TableColumnSpec[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      out.push({ id: item, title: item, width: null });
    } else if (typeof item === "object" && item !== null) {
      const { id, title, width } = item as { id?: unknown; title?: unknown; width?: unknown };
      if (typeof title !== "string") throw argTypeError(`${what}[${i}].title must be a string`);
      if (id !== undefined && typeof id !== "string") throw argTypeError(`${what}[${i}].id must be a string`);
      out.push({
        id: id ?? title,
        title,
        width: width === undefined ? null : positivePoints(`${what}[${i}].width`, width),
      });
    } else {
      throw argTypeError(`${what}[${i}] must be a string or a { id, title, width } object`);
    }
  }
  return out;
}

/** The rows copied (so later edits to the caller's arrays do not show half-way), numbers and booleans as their text. */
function rowsFor(what: string, value: unknown): readonly (readonly string[])[] {
  if (value === null) return emptyList;
  if (!ArrayIsArray(value)) throw argTypeError(`${what} must be an array of rows`);
  const out: (readonly string[])[] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (ArrayIsArray(row)) out.push(stringList(`${what}[${i}]`, row));
    else if (typeof row === "string" || typeof row === "number") out.push(ObjectFreeze([String(row)]));
    else throw argTypeError(`${what}[${i}] must be an array of cell strings`);
  }
  return ObjectFreeze(out);
}

function indexesFor(what: string, value: unknown): readonly number[] {
  if (value === null) return emptyList;
  if (!ArrayIsArray(value)) throw argTypeError(`${what} must be an array of row indexes`);
  const out: number[] = [];
  for (const index of value) {
    if (typeof index !== "number") throw argTypeError(`${what}[] must be a number`);
    if (!Number.isFinite(index)) throw argTypeError(`${what}[] must be a finite number`);
    if (index >= 0) out.push(Math.trunc(index));
  }
  return ObjectFreeze(out);
}

let tableDelegateClass: Handle | undefined;
const tableHooks = {
  "numberOfRowsInTableView:": (view: Table) => tableOf(view).rows.length,
  "tableView:viewForTableColumn:row:": (view: Table, table: Handle, column: Handle | null, row: number) => {
    const state = tableOf(view);
    const index = column === null ? -1 : state.columns.indexOf(column);
    if (index < 0) return null;
    const cell = tableCell(table);
    const label = cell.textField();
    if (label !== null) label.setStringValue_(state.rows[row]?.[index] ?? "");
    return cell;
  },
  "tableViewSelectionDidChange:": (view: Table) => {
    if (setting === view) return;
    tableOf(view).wanted = selectedRows(view);
    report(view, "onSelect", () => [selectedRows(view)]);
  },
};

/** The double action: `-clickedRow` is -1 for a double click below the last row. */
function tableActivated(view: Table) {
  const row = tableOf(view).table.clickedRow();
  if (row >= 0) report(view, "onActivate", () => [row]);
}

class Table extends View {
  constructor(props?: Record<string, unknown>) {
    const frame = { x: 0, y: 0, ...fallbackSize };
    const scroll = classes.NSScrollView.alloc().initWithFrame_(frame);
    const table = classes.NSTableView.alloc().initWithFrame_(frame);
    table.setUsesAlternatingRowBackgroundColors_(false);
    table.setAllowsMultipleSelection_(false);
    table.setAllowsEmptySelection_(true);
    table.setAllowsColumnReordering_(false);
    table.setColumnAutoresizingStyle_(
      (objcEnums.NSTableViewColumnAutoresizingStyle as Record<string, number>).lastColumnOnlyAutoresizingStyle,
    );
    scroll.setHasVerticalScroller_(true);
    scroll.setHasHorizontalScroller_(false);
    scroll.setAutohidesScrollers_(true);
    scroll.setDocumentView_(table);
    const { width, height } = layoutAttributes();
    const { equal } = layoutRelations();
    giveBack(lengthConstraint(scroll, width, equal, fallbackSize.width, fallbackSizePriority));
    giveBack(lengthConstraint(scroll, height, equal, fallbackSize.height, fallbackSizePriority));
    const state: TableState = {
      table,
      header: table.headerView(),
      headerWanted: null,
      explicit: false,
      columns: [makeColumn(table, implicitColumn)],
      rows: emptyList,
      wanted: emptyList,
      defaultRowHeight: table.rowHeight(),
    };
    syncHeader(state);
    super("Table", props, built(scroll, state));
    tableDelegateClass ??= delegateClass(["NSTableViewDataSource", "NSTableViewDelegate"], tableHooks, {
      "numberOfRowsInTableView:": 0,
      "tableView:viewForTableColumn:row:": null,
    });
    wireDelegate(this, table, tableDelegateClass);
    table.setDataSource_(controlDelegates.get(this));
    wireAction(this, table, tableActivated, "setDoubleAction_");
    // The props were assigned before the table had a data source, so it
    // counted no rows and kept none of `selectedIndexes`.
    ownSetting(this, () => reloadTable(state));
  }
}
defineControlProps(Table, {
  columns: {
    get(view) {
      const state = tableOf(view);
      const live = handlesOf(state.table, "tableColumns");
      try {
        if (!state.explicit && live.length === 1 && live[0] === state.columns[0]) return emptyList;
        return ObjectFreeze(
          live.map(column =>
            ObjectFreeze({
              id: stringOf(column, "identifier"),
              title: stringOf(column, "title"),
              width: column.width(),
            }),
          ),
        );
      } finally {
        live.forEach(giveBack);
      }
    },
    set(view, _scroll, value, what) {
      const specs = columnsFor(what, value);
      const state = tableOf(view);
      for (const column of handlesOf(state.table, "tableColumns")) {
        state.table.removeTableColumn_(column);
        giveBack(column);
      }
      state.explicit = specs.length > 0;
      state.columns = (state.explicit ? specs : [implicitColumn]).map(spec => makeColumn(state.table, spec));
      syncHeader(state);
      reloadTable(state);
    },
  },
  rows: {
    get: view => tableOf(view).rows,
    set(view, _scroll, value, what) {
      const state = tableOf(view);
      state.rows = rowsFor(what, value);
      reloadTable(state);
    },
  },
  selectedIndexes: {
    get: view => selectedRows(view),
    set(view, _scroll, value, what) {
      const state = tableOf(view);
      state.wanted = indexesFor(what, value);
      applySelection(state);
    },
  },
  multiple: {
    get: view => tableOf(view).table.allowsMultipleSelection(),
    set(view, _scroll, value, what) {
      const multiple = optionalBoolean(what, value) ?? false;
      const state = tableOf(view);
      state.table.setAllowsMultipleSelection_(multiple);
      if (!multiple) {
        // AppKit trimmed the live selection to one row just now; trim the
        // request to match so a later reload cannot bring the others back.
        const keep =
          selectedRows(view)[0] ??
          state.wanted.reduce((a: number | undefined, b) => (a === undefined || b < a ? b : a), undefined);
        state.wanted = keep === undefined ? emptyList : ObjectFreeze([keep]);
      }
      applySelection(state);
    },
  },
  headerVisible: {
    get: view => tableOf(view).headerWanted,
    set(view, _scroll, value, what) {
      const state = tableOf(view);
      state.headerWanted = optionalBoolean(what, value);
      syncHeader(state);
    },
  },
  alternatingRows: {
    get: view => tableOf(view).table.usesAlternatingRowBackgroundColors(),
    set: (view, _scroll, value, what) =>
      tableOf(view).table.setUsesAlternatingRowBackgroundColors_(optionalBoolean(what, value) ?? false),
  },
  rowHeight: {
    get: view => tableOf(view).table.rowHeight(),
    set(view, _scroll, value, what) {
      const state = tableOf(view);
      state.table.setRowHeight_(positivePoints(what, value) ?? state.defaultRowHeight);
    },
  },
});
defineHandlers(Table, "onSelect", "onActivate");

// ---------------------------------------------------------------------------
// Menus: the menu bar, built out of NSMenu and NSMenuItem through the bridge
// once the application has started. `app.menu = null` (the default) installs
// the standard application, Edit, View and Window menus, which are plain data
// here; an array replaces the whole bar. An item that calls a function is
// target/action on one shared script object that finds the item by its tag;
// a selector `action` is that selector with no target, sent down the responder
// chain and validated by AppKit like the standard items are.

type MenuItem = {
  title: string;
  onClick?: () => void;
  action?: string | (() => void);
  key?: string;
  shift?: boolean;
  option?: boolean;
  control?: boolean;
  command?: boolean;
  enabled?: boolean;
  checked?: boolean;
  submenu?: (MenuItem | "separator")[];
};
type MenuSpec = { title: string; items: (MenuItem | "separator")[] };

/** An item of `app.menu`, checked and filled in. */
type MenuEntry =
  | { separator: true }
  | {
      title: string;
      /** The selector sent down the responder chain, or null: then `id` (non-zero) keys `callbackItems`, or the item only holds a submenu. */
      action: string | null;
      id: number;
      key: string;
      /** `NSEventModifierFlags` for the key equivalent. */
      mask: number;
      enabled: boolean;
      checked: boolean;
      submenu: MenuEntry[] | null;
      /** AppKit keeps the Services and open-window lists in the menus that say so. */
      role?: "services" | "windows";
      /** The caller's object this entry was read from; the standard items have none. */
      source: MenuItem | null;
    };
type MenuBar = { title: string; items: MenuEntry[]; role?: "windows"; source: MenuSpec | null }[];

let menuSpec: MenuSpec[] | null = null;
/** `menuSpec` normalized, or null for the standard menus. */
let normalizedMenus: MenuBar | null = null;
/** id (the NSMenuItem's tag) -> the caller's MenuItem, for the items that call a function or only emit "menu". */
let callbackItems = new Map<number, MenuItem>();
/** The caller's MenuItem / MenuSpec -> the NSMenuItem built for it. Both maps are of the installed bar and replaced with it. */
let menuHandles = new Map<object, Handle>();
/** The target of every callback item; kept here because an NSMenuItem holds its target weakly. */
let menuTarget: Handle | undefined;

/** A cyclic spec ends here with a clean error instead of recursing for ever. */
const maxMenuDepth = 16;
/** A responder-chain action: one argument (the sender), so one trailing colon. */
const actionPattern = /^[A-Za-z_][A-Za-z0-9_]*:$/;
const modifierFlags = () =>
  objcEnums.NSEventModifierFlags as Readonly<Record<"shift" | "control" | "option" | "command", number>>;

function keyMask(modifiers: { shift?: boolean; option?: boolean; control?: boolean; command?: boolean }, key: string) {
  const { shift, control, option, command } = modifierFlags();
  let mask = 0;
  if (modifiers.shift) mask |= shift;
  if (modifiers.option) mask |= option;
  if (modifiers.control) mask |= control;
  if (modifiers.command ?? key !== "") mask |= command;
  return mask;
}

/** `ids.next` numbers the callback items 1, 2, … across the whole bar. */
function normalizeMenuItems(items: unknown, path: string, ids: { next: number }, depth: number): MenuEntry[] {
  if (depth > maxMenuDepth) throw typeError(`${path}: submenus nest too deeply`);
  if (!ArrayIsArray(items)) throw typeError(`${path} must be an array`);
  const out: MenuEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === "separator" || item === "-" || (item && (item as any).separator === true)) {
      out.push({ separator: true });
      continue;
    }
    if (!item || typeof item !== "object") throw typeError(`${path}[${i}] must be an object or "separator"`);
    const { title, onClick, action, key, shift, option, control, command, enabled, checked, submenu } =
      item as MenuItem;
    if (typeof title !== "string") throw typeError(`${path}[${i}].title must be a string`);
    if (onClick !== undefined && typeof onClick !== "function") {
      throw typeError(`${path}[${i}].onClick must be a function`);
    }
    if (
      action !== undefined &&
      typeof action !== "function" &&
      !(typeof action === "string" && actionPattern.test(action))
    ) {
      throw typeError(
        `${path}[${i}].action must be a function, or a selector that takes the sender such as "copy:" or "performClose:"`,
      );
    }
    if (onClick !== undefined && action !== undefined) {
      throw typeError(`${path}[${i}]: onClick and action are mutually exclusive`);
    }
    if ((onClick !== undefined || action !== undefined) && submenu !== undefined) {
      throw typeError(`${path}[${i}]: an item with a submenu does not fire onClick or an action`);
    }
    const keyText = typeof key === "string" ? key : "";
    const entry: MenuEntry = {
      title,
      action: typeof action === "string" ? action : null,
      id: 0,
      key: keyText,
      mask: keyMask({ shift: !!shift, option: !!option, control: !!control, command }, keyText),
      enabled: enabled === undefined ? true : !!enabled,
      checked: !!checked,
      submenu: null,
      source: item as MenuItem,
    };
    if (submenu !== undefined) {
      entry.submenu = normalizeMenuItems(submenu, `${path}[${i}].submenu`, ids, depth + 1);
    } else if (entry.action === null) {
      entry.id = ids.next++;
    }
    out.push(entry);
  }
  return out;
}

/** Checks `spec`; `null` (the standard menus) for null. */
function normalizeMenus(spec: unknown): MenuBar | null {
  if (spec == null) return null;
  if (!ArrayIsArray(spec)) throw typeError("app.menu must be an array of { title, items } or null");
  const menus: MenuBar = [];
  const ids = { next: 1 };
  for (let i = 0; i < spec.length; i++) {
    const menu = spec[i];
    if (!menu || typeof menu !== "object" || typeof menu.title !== "string") {
      throw typeError(`app.menu[${i}] must be { title: string, items: [...] }`);
    }
    menus.push({
      title: menu.title,
      items: normalizeMenuItems(menu.items ?? [], `app.menu[${i}].items`, ids, 0),
      source: menu,
    });
  }
  return menus;
}

/**
 * The application, Edit, View and Window menus with the usual items and key
 * equivalents, so text editing shortcuts, full screen and Cmd-Q work out of
 * the box.
 */
function standardMenus(name: string): MenuBar {
  const item = (
    title: string,
    action: string,
    key = "",
    modifiers: { option?: boolean; control?: boolean } = {},
  ): MenuEntry => ({
    title,
    action,
    id: 0,
    key,
    mask: keyMask({ ...modifiers, command: true }, key),
    enabled: true,
    checked: false,
    submenu: null,
    source: null,
  });
  const separator: MenuEntry = { separator: true };
  return [
    {
      title: name,
      source: null,
      items: [
        item(`About ${name}`, "orderFrontStandardAboutPanel:"),
        separator,
        { ...item("Services", ""), action: null, submenu: [], role: "services" },
        separator,
        item(`Hide ${name}`, "hide:", "h"),
        item("Hide Others", "hideOtherApplications:", "h", { option: true }),
        item("Show All", "unhideAllApplications:"),
        separator,
        item(`Quit ${name}`, "terminate:", "q"),
      ],
    },
    {
      title: "Edit",
      source: null,
      items: [
        item("Undo", "undo:", "z"),
        item("Redo", "redo:", "Z"),
        separator,
        item("Cut", "cut:", "x"),
        item("Copy", "copy:", "c"),
        item("Paste", "paste:", "v"),
        item("Delete", "delete:"),
        item("Select All", "selectAll:", "a"),
      ],
    },
    {
      title: "View",
      source: null,
      items: [item("Enter Full Screen", "toggleFullScreen:", "f", { control: true })],
    },
    {
      title: "Window",
      role: "windows",
      source: null,
      items: [
        item("Minimize", "performMiniaturize:", "m"),
        item("Zoom", "performZoom:"),
        separator,
        item("Bring All to Front", "arrangeInFront:"),
      ],
    },
  ];
}

const newMenu = (title: string): Handle => classes.NSMenu.alloc().initWithTitle_(title);

/** Adds an item; a null `action` sends nothing. Items built here have no target of their own unless they call a function. */
function addMenuItem(menu: Handle, title: string, action: string | null, key: string, mask: number): Handle {
  const item = menu.addItemWithTitle_action_keyEquivalent_(title, action, key);
  item.setKeyEquivalentModifierMask_(mask);
  return item;
}

function menuChosen(id: number) {
  const item = callbackItems.get(id);
  if (item === undefined) return;
  const fn = item.onClick ?? item.action;
  if (typeof fn === "function") guarded(fn, []);
  emit("menu", [item]);
}

function buildMenuItems(nsapp: Handle, menu: Handle, entries: MenuEntry[]): void {
  for (const entry of entries) {
    if ("separator" in entry) {
      looking(classes.NSMenuItem.separatorItem(), item => menu.addItem_(item));
      continue;
    }
    const { submenu: nested, source } = entry;
    if (nested !== null) {
      // No action, so automatic validation leaves the holder's enabled flag alone.
      const holder = addMenuItem(menu, entry.title, null, "", 0);
      looking(newMenu(entry.title), submenu => {
        buildMenuItems(nsapp, submenu, nested);
        holder.setSubmenu_(submenu);
        if (entry.role === "services") nsapp.setServicesMenu_(submenu);
      });
      if (!entry.enabled) holder.setEnabled_(false);
      if (source !== null) menuHandles.set(source, holder);
      else giveBack(holder);
      continue;
    }
    // A disabled item gets no target or action: AppKit's automatic validation
    // greys out an item nothing responds to and never re-enables it later.
    const calls = entry.enabled && entry.id !== 0;
    const item = addMenuItem(
      menu,
      entry.title,
      !entry.enabled ? null : calls ? "action:" : entry.action,
      entry.key,
      entry.mask,
    );
    if (calls) {
      menuTarget ??= objc.target((sender: any) => {
        if (sender !== null) menuChosen(sender.tag());
      }) as Handle;
      item.setTarget_(menuTarget);
      item.setTag_(entry.id);
      callbackItems.set(entry.id, source!);
    }
    if (!entry.enabled) item.setEnabled_(false);
    if (entry.checked) item.setState_(objcEnums.NSControlStateValueOn);
    if (source !== null) menuHandles.set(source, item);
    else giveBack(item);
  }
}

/** Replaces the main menu with `app.menu` (or the standard set), and the two maps with it; only once the application runs. */
function installMenuBar(): void {
  const nsapp = classes.NSApplication.sharedApplication();
  const bar = newMenu("");
  callbackItems = new Map();
  menuHandles = new Map();
  try {
    for (const { title, items, role, source } of normalizedMenus ?? standardMenus(appName)) {
      const holder = addMenuItem(bar, title, null, "", 0);
      looking(newMenu(title), submenu => {
        buildMenuItems(nsapp, submenu, items);
        holder.setSubmenu_(submenu);
        // AppKit maintains the open-window list in whichever menu this names.
        if (role === "windows") nsapp.setWindowsMenu_(submenu);
      });
      if (source !== null) menuHandles.set(source, holder);
      else giveBack(holder);
    }
    nsapp.setMainMenu_(bar);
  } finally {
    giveBack(bar);
    giveBack(nsapp);
  }
}

/** The NSMenuItem the installed bar has for `item` (a MenuItem or MenuSpec of `app.menu`), else null. */
function menuItemOf(item: unknown): object | null {
  if (item === null || (typeof item !== "object" && typeof item !== "function")) {
    throw typeError("app.menuItem() expects an item or menu object from app.menu");
  }
  const handle = menuHandles.get(item);
  return handle === undefined ? null : handedOut(handle);
}

// ---------------------------------------------------------------------------
// Window: an NSWindow made through the bridge, with an NSWindowDelegate
// defined here. The content view (any View's NSView) goes into a plain
// container NSView pinned to the window's own contentView; the size limits
// are NSLayoutConstraints on that container as well as the window's content
// min/max size, so they bound what the content can grow the window to and
// not only the user's drags. The native `app` hears just two things: how
// many windows are open (an open window holds the process, like a listening
// server), and, on a quit, that every window is to be asked and closed.

const styleMasks = () => objcEnums.NSWindowStyleMask as Readonly<Record<string, number>>;
const collectionBehaviors = () => objcEnums.NSWindowCollectionBehavior as Readonly<Record<"fullScreenPrimary", number>>;
const titleVisibilities = () => objcEnums.NSWindowTitleVisibility as Readonly<Record<"visible" | "hidden", number>>;
/**
 * The content view's bottom pin: just under default-low hugging (250), so a
 * stack that hugs its content stays compact at the top while a scroll view or
 * `grow` child stretches to fill the window.
 */
const contentBottom = 240;
/** AppKit's own "no maximum" content size. */
const noMaximum = 3.4028234663852886e38;
const defaultContentSize = { width: 480, height: 320 };

type WindowSize = { width: number; height: number };

/** `size` brought inside the window's content size limits. */
function clampedSize(ns: Handle, size: WindowSize): WindowSize {
  const min = ns.contentMinSize();
  const max = ns.contentMaxSize();
  return {
    width: Math.min(Math.max(size.width, min.width), max.width),
    height: Math.min(Math.max(size.height, min.height), max.height),
  };
}

type WindowState = {
  /** The NSWindow: this module's handle, not counted as a read (`Window.native` counts). */
  ns: Handle;
  /** Pinned to every edge of the window's contentView; the content goes in here and `snapshot()` draws it. */
  container: Handle;
  /** Kept here because an NSWindow holds its delegate weakly. */
  delegate: object;
  content: View | null;
  handlers: Record<string, Function | undefined>;
  /** The size limits as given (`exact` unused), settled onto the container the way a view's are and onto the window from there. */
  width: AxisSize;
  height: AxisSize;
  /** As given; AppKit cannot hand a colour back in that shape. */
  background: unknown;
  closed: boolean;
  shownOnce: boolean;
};

let stateOfWindow: (win: Window) => WindowState;
/**
 * The window whose own geometry change is running: the `windowDidResize:` /
 * `windowDidMove:` it causes echo the caller's change and are not reported,
 * the same as a control's setters.
 */
let settingWindow: Window | undefined;

/** Runs `change` as `win`'s own doing; see `settingWindow`. */
function ownChange(win: Window, change: () => void): void {
  const outer = settingWindow;
  settingWindow = win;
  try {
    change();
  } finally {
    settingWindow = outer;
  }
}

/**
 * With no screen attached (sandbox, daemon) `-[NSWindow constrainFrameRect:toScreen:]`
 * clamps a window to a zero-height "screen" on first order-in, so windows made
 * there are of a subclass whose override is the identity.
 */
let headlessWindowClass: Handle | undefined;
function windowClass(): Handle {
  if (nativeApp.hasDisplay) return classes.NSWindow;
  return (headlessWindowClass ??= defineClass({
    name: "BunAppKitHeadlessWindow",
    superclass: "NSWindow",
    methods: { "constrainFrameRect:toScreen:": (frame: unknown) => frame },
  }) as Handle);
}

let windowDelegateClass: Handle | undefined;
/** What the window reports arrives here and, `shouldClose` apart (AppKit wants the verdict now), is delivered through `later`, behind whatever its views reported first (a field's onBlur before the onClose that ended its editing). */
function windowDelegate(): Handle {
  return (windowDelegateClass ??= delegateClass(
    ["NSWindowDelegate"],
    {
      "windowShouldClose:": (win: Window) => closeVerdict(win),
      "windowWillClose:": (win: Window) => finishClose(win),
      "windowDidResize:": (win: Window) => reportGeometry(win, "onResize", () => [contentSize(stateOfWindow(win))]),
      "windowDidMove:": (win: Window) => reportGeometry(win, "onMove", () => [framePosition(stateOfWindow(win))]),
      "windowDidBecomeKey:": (win: Window) => reportWindow(win, "onFocus", noArguments),
      "windowDidResignKey:": (win: Window) => reportWindow(win, "onBlur", noArguments),
    },
    // A closed NSWindow a script still holds may close again: nothing objects.
    { "windowShouldClose:": true },
  ));
}

function reportWindow(win: Window, prop: string, args: () => unknown[]): void {
  later(() => {
    const handler = stateOfWindow(win).handlers[prop];
    if (handler !== undefined) handler.$apply(undefined, args());
  });
}

function reportGeometry(win: Window, prop: string, args: () => unknown[]): void {
  if (settingWindow !== win) reportWindow(win, prop, args);
}

/** The `shouldClose` handler's verdict: go ahead unless it returned exactly `false` (a throw is reported and does not refuse). */
function closeVerdict(win: Window): boolean {
  const handler = stateOfWindow(win).handlers.shouldClose;
  return handler === undefined || guarded(handler, []) !== false;
}

/**
 * Bookkeeping for a close, from whichever of `close()` and the delegate's
 * `windowWillClose:` gets here first. The content's NSView leaves the window
 * now (which ends a focused field's editing: its onBlur queues first); the
 * JavaScript side (app.windows, the content's parent link, onClose) follows
 * as one delivery behind that.
 */
function finishClose(win: Window): void {
  const state = stateOfWindow(win);
  if (state.closed) return;
  state.closed = true;
  hold();
  try {
    const content = state.content;
    if (content !== null) handleOf(content).removeFromSuperview();
    // A closed NSWindow lives until its handles are collected; free the name for the next window now.
    state.ns.setFrameAutosaveName_("");
  } finally {
    // Whatever the sends above ran into, the window no longer counts as open.
    later(() => {
      openWindows.delete(win);
      nativeApp.set("windows", openWindows.size);
      const content = state.content;
      if (content !== null) {
        setParentOf(content, null);
        state.content = null;
      }
      const handler = state.handlers.onClose;
      if (handler !== undefined) handler.$call(undefined);
    });
    unhold();
  }
}

/**
 * What a quit does once `beforequit` allowed it: asks each window that has
 * not closed (visible, hidden or minimized; closable or not; oldest first)
 * through its `shouldClose` and closes it if that agrees. Stops at the first
 * refusal; windows after that one are not asked.
 */
function closeAllWindows(): boolean {
  for (const win of Array.from(openWindows)) {
    if (stateOfWindow(win).closed) continue;
    if (!closeVerdict(win)) return false;
    win.close();
  }
  return true;
}

function closedError(): Error {
  return $ERR_INVALID_STATE("window is closed");
}

/** The NSWindow, unless it has closed: every call that changes or orders the window goes through here. */
function liveWindow(win: Window): Handle {
  const state = stateOfWindow(win);
  if (state.closed) throw closedError();
  return state.ns;
}

function contentSize(state: WindowState): WindowSize {
  const { size } = state.ns.contentRectForFrameRect_(state.ns.frame());
  return { width: size.width, height: size.height };
}

/** The content area's size with pending layout applied first, so it reflects content added a moment ago; an onResize that layout provokes is delivered after the caller returns. */
function laidOutSize(state: WindowState): WindowSize {
  if (!state.closed) state.ns.layoutIfNeeded();
  return contentSize(state);
}

/** The frame origin in screen coordinates (bottom-left, as AppKit has it). */
function framePosition(state: WindowState): { x: number; y: number } {
  const { origin } = state.ns.frame();
  return { x: origin.x, y: origin.y };
}

/**
 * One axis's limits, settled like a view's (`applyAxis`: a minimum beats a
 * maximum) onto both the window and the container. AppKit's content size
 * limits only bound the user's drags; the same limits as constraints on the
 * container (above every priority a child can bring, but not required, so a
 * frame AppKit imposes on its own wins instead of conflicting) also bound
 * what the content can grow or shrink the window to.
 */
function applyLimits(state: WindowState, dimension: "width" | "height"): void {
  const { min, max } = applyAxis(state.container, state[dimension], layoutAttributes()[dimension]);
  const { ns } = state;
  ns.setContentMinSize_({ ...ns.contentMinSize(), [dimension]: min ?? 0 });
  ns.setContentMaxSize_({ ...ns.contentMaxSize(), [dimension]: max ?? noMaximum });
}

/**
 * Pins `content` into `container`: leading, trailing and top at required
 * priority; at the bottom it may end short of the window (an equality at
 * `contentBottom`) but never beyond it, so content the window cannot hold
 * makes the window taller, as content wider than the window makes it wider.
 */
function pinContent(container: Handle, content: Handle): void {
  const { leading, trailing, top, bottom } = layoutAttributes();
  const { equal, lessThanOrEqual } = layoutRelations();
  const required = layoutPriority("NSLayoutPriorityRequired");
  container.addSubview_(content);
  content.setTranslatesAutoresizingMaskIntoConstraints_(false);
  for (const edge of [leading, trailing, top])
    giveBack(relateConstraint(content, edge, equal, container, edge, 1, 0, required));
  giveBack(relateConstraint(content, bottom, equal, container, bottom, 1, 0, contentBottom));
  giveBack(relateConstraint(content, bottom, lessThanOrEqual, container, bottom, 1, 0, required));
}

/** One style-mask bit, live: read from `-styleMask`, written with `setStyleMask:` (which may lay the content out again: the caller's doing, not reported). */
function styleBit(
  member: string,
  fallback: boolean,
): WindowAccessor & { set(win: Window, value: unknown, what: string): boolean } {
  return {
    get: (_win, ns) => (ns.styleMask() & styleMasks()[member]) !== 0,
    set(win, value, what) {
      const on = optionalBoolean(what, value) ?? fallback;
      const ns = liveWindow(win);
      const bit = styleMasks()[member];
      ownChange(win, () => ns.setStyleMask_(on ? ns.styleMask() | bit : ns.styleMask() & ~bit));
      return on;
    },
  };
}

type WindowAccessor = {
  get(win: Window, ns: Handle): unknown;
  /** Checks `value` (throwing before anything changes), then applies it to the live window. */
  set(win: Window, value: unknown, what: string): unknown;
};

const contentDimension = (dimension: "width" | "height"): WindowAccessor => ({
  get: win => laidOutSize(stateOfWindow(win))[dimension],
  set(win, value, what) {
    const length = Math.max(optionalPoints(what, value) ?? defaultContentSize[dimension], 0);
    const ns = liveWindow(win);
    const size = laidOutSize(stateOfWindow(win));
    size[dimension] = length;
    ownChange(win, () => ns.setContentSize_(clampedSize(ns, size)));
  },
});

/** `x`/`y`: the frame origin; `null` centres the window instead. */
const screenCoordinate = (coordinate: "x" | "y"): WindowAccessor => ({
  get: win => framePosition(stateOfWindow(win))[coordinate],
  set(win, value, what) {
    const v = optionalPoints(what, value);
    const ns = liveWindow(win);
    if (v === null) return ownChange(win, () => ns.center());
    const origin = framePosition(stateOfWindow(win));
    origin[coordinate] = v;
    ownChange(win, () => ns.setFrameOrigin_(origin));
  },
});

/**
 * A size limit: `-contentMinSize`/`-contentMaxSize` (none reads `null`),
 * written through `applyLimits`; a window already outside the new limits is
 * resized to the nearest size inside them.
 */
const sizeLimit = (dimension: "width" | "height", bound: "min" | "max"): WindowAccessor => ({
  get(_win, ns) {
    if (bound === "min") return ns.contentMinSize()[dimension] || null;
    const limit = ns.contentMaxSize()[dimension];
    return limit < noMaximum ? limit : null;
  },
  set(win, value, what) {
    const limit = optionalPoints(what, value);
    const ns = liveWindow(win);
    const state = stateOfWindow(win);
    state[dimension][bound] = limit;
    ownChange(win, () => {
      applyLimits(state, dimension);
      const size = contentSize(state);
      const clamped = clampedSize(ns, size);
      if (clamped.width !== size.width || clamped.height !== size.height) ns.setContentSize_(clamped);
    });
  },
});

const resizableBit = styleBit("resizable", true);
/** Every option that is a property of the window afterwards, all of them live: the setter changes the NSWindow and, `background` apart, the getter reads it. A new window assigns them in this order. */
const windowAccessors: Record<string, WindowAccessor> = {
  title: {
    get: (_win, ns) => stringOf(ns, "title"),
    set: (win, value, what) => liveWindow(win).setTitle_(optionalString(what, value) ?? ""),
  },
  width: contentDimension("width"),
  height: contentDimension("height"),
  minWidth: sizeLimit("width", "min"),
  minHeight: sizeLimit("height", "min"),
  maxWidth: sizeLimit("width", "max"),
  maxHeight: sizeLimit("height", "max"),
  x: screenCoordinate("x"),
  y: screenCoordinate("y"),
  resizable: {
    ...resizableBit,
    set(win, value, what) {
      const on = resizableBit.set(win, value, what);
      // A resizable window can also go full screen from its zoom button and the Window menu.
      const ns = stateOfWindow(win).ns;
      const { fullScreenPrimary } = collectionBehaviors();
      ns.setCollectionBehavior_(
        on ? ns.collectionBehavior() | fullScreenPrimary : ns.collectionBehavior() & ~fullScreenPrimary,
      );
    },
  },
  closable: styleBit("closable", true),
  minimizable: styleBit("miniaturizable", true),
  fullSizeContent: styleBit("fullSizeContentView", false),
  titlebarTransparent: {
    get: (_win, ns) => !!ns.titlebarAppearsTransparent(),
    set: (win, value, what) => liveWindow(win).setTitlebarAppearsTransparent_(optionalBoolean(what, value) ?? false),
  },
  titleHidden: {
    get: (_win, ns) => ns.titleVisibility() === titleVisibilities().hidden,
    set(win, value, what) {
      const hidden = optionalBoolean(what, value) ?? false;
      liveWindow(win).setTitleVisibility_(hidden ? titleVisibilities().hidden : titleVisibilities().visible);
    },
  },
  background: {
    get: win => stateOfWindow(win).background ?? "windowBackground",
    set(win, value, what) {
      const ns = liveWindow(win);
      looking(colorFor(what, value) ?? classes.NSColor.windowBackgroundColor(), color => ns.setBackgroundColor_(color));
      stateOfWindow(win).background = value;
    },
  },
  alpha: {
    get: (_win, ns) => ns.alphaValue(),
    set(win, value, what) {
      const alpha = optionalNumber(what, value) ?? 1;
      liveWindow(win).setAlphaValue_(Math.min(Math.max(alpha, 0), 1));
    },
  },
  restoreName: {
    get: (_win, ns) => stringOf(ns, "frameAutosaveName") || null,
    set(win, value, what) {
      const name = optionalString(what, value) ?? "";
      // AppKit restores the frame saved under the name as it is set, and refuses a name another open window uses.
      if (!liveWindow(win).setFrameAutosaveName_(name)) {
        throw $ERR_INVALID_STATE(`another window already uses restoreName ${JSON.stringify(name)}`);
      }
    },
  },
};
const windowEvents = ["onClose", "shouldClose", "onResize", "onMove", "onFocus", "onBlur"];
const windowOptionKeys = ["content", "visible", ...ObjectKeys(windowAccessors), ...windowEvents];

class Window {
  #state: WindowState;

  static {
    stateOfWindow = win => win.#state;
  }

  constructor(options: Record<string, unknown> = {}) {
    if (options == null) options = {};
    if (typeof options !== "object") throw typeError("Window options must be an object");
    for (const key of ObjectKeys(options)) {
      if (!windowOptionKeys.includes(key)) throw typeError(`Unknown Window option "${key}"`);
    }
    const x = options.x ?? null;
    const y = options.y ?? null;
    if ((x === null) !== (y === null)) throw typeError("Window.x and Window.y must be given together");
    ensureStarted();

    const { buffered } = objcEnums.NSBackingStoreType as Readonly<Record<"buffered", number>>;
    // The bridge sends a window that comes out of an init `setReleasedWhenClosed:NO`.
    const ns: Handle = windowClass()
      .alloc()
      .initWithContentRect_styleMask_backing_defer_(
        { origin: { x: 0, y: 0 }, size: defaultContentSize },
        styleMasks().titled,
        buffered,
        false,
      );
    const container: Handle = classes.NSView.alloc().initWithFrame_(zeroRect);
    looking(ns.contentView(), (contentView: Handle) => {
      contentView.addSubview_(container);
      pinEdges(contentView, container, 0);
    });
    const delegate = windowDelegate().new();
    ownerOfDelegate.set(delegate, new WeakRef(this));
    ns.setDelegate_(delegate);
    this.#state = {
      ns,
      container,
      delegate,
      content: null,
      handlers: {},
      width: newAxis(),
      height: newAxis(),
      background: null,
      closed: false,
      shownOnce: false,
    };
    openWindows.add(this);
    nativeApp.set("windows", openWindows.size);

    // Every property starts out as its option (its default where not given);
    // a bad one closes the window again before the error leaves here.
    const win = this as unknown as Record<string, unknown>;
    try {
      for (const key of ObjectKeys(windowAccessors)) {
        if (key !== "x" && key !== "y" && key !== "restoreName") win[key] = options[key];
      }
      win.x = x; // null centres
      if (y !== null) win.y = y;
      // Last, so a frame saved under the name wins over the size and position given.
      const { restoreName, content, visible } = options;
      if (restoreName != null) win.restoreName = restoreName;
      for (const key of windowEvents) win[key] = options[key];
      if (content !== undefined) this.content = content as View | null;
      if (visible !== false) this.show();
    } catch (error) {
      // The caller never gets this window, so nobody gets its onClose.
      this.#state.handlers = {};
      this.close();
      throw error;
    }
  }

  get content(): View | null {
    return this.#state.content;
  }

  // Links are switched before the views move so that a handler the move
  // fires (the old content's focused field blurring) already sees the new content.
  set content(view: View | null | undefined) {
    if (view == null) view = null;
    const state = this.#state;
    const previous = state.content;
    if (previous === view) return;
    if (view !== null) {
      if (!(view instanceof View)) throw typeError("Window.content must be a View or null");
      if (rawParentOf(view)) {
        throw $ERR_INVALID_STATE(
          `Window.content: this ${kindOf(view)} already has a parent; call remove() on it first`,
        );
      }
    }
    if (state.closed) throw closedError();
    state.content = view;
    if (previous) setParentOf(previous, null);
    if (view) setParentOf(view, this);
    hold();
    try {
      if (previous) handleOf(previous).removeFromSuperview();
      if (view) pinContent(state.container, handleOf(view));
    } catch (error) {
      // A view that cannot be mounted leaves the window empty, not holding a view that is not in it.
      if (view) setParentOf(view, null);
      state.content = null;
      throw error;
    } finally {
      unhold();
    }
  }

  /** `-isVisible`. */
  get visible(): boolean {
    const state = this.#state;
    return !state.closed && !!state.ns.isVisible();
  }

  set visible(value: boolean) {
    if (value) this.show();
    else this.hide();
  }

  get closed(): boolean {
    return this.#state.closed;
  }

  /** `-isKeyWindow`. */
  get key(): boolean {
    const state = this.#state;
    return !state.closed && !!state.ns.isKeyWindow();
  }

  /** The NSWindow, open or closed: its one handle, each read counting once like `View.native`. */
  get native(): object {
    return handedOut(this.#state.ns);
  }

  /** Orders the window front and makes it key; the first call also activates the application so the window really comes forward. */
  show(): void {
    windowCall(this, ns => {
      ns.makeKeyAndOrderFront_(null);
      if (!this.#state.shownOnce) {
        this.#state.shownOnce = true;
        nativeApp.activate();
      }
    });
  }

  hide(): void {
    windowCall(this, ns => ns.orderOut_(null));
  }

  center(): void {
    windowCall(this, ns => ownChange(this, () => ns.center()));
  }

  /** Brings the window forward and makes it key, activating the app. */
  focus(): void {
    windowCall(this, ns => {
      nativeApp.activate();
      ns.makeKeyAndOrderFront_(null);
    });
  }

  /** Idempotent. onClose runs once, from whichever of this and the delegate's `windowWillClose:` gets there first. */
  close(): void {
    const state = this.#state;
    if (state.closed) return;
    hold();
    try {
      state.ns.close();
      finishClose(this);
    } finally {
      unhold();
    }
  }

  /** PNG of the content area as currently laid out, or null while it has no size. Callbacks the layout and display pass provoke go out after this returns. */
  snapshot(): Uint8Array | null {
    hold();
    try {
      const state = this.#state;
      if (!state.closed) state.ns.layoutIfNeeded();
      return snapshotOf(state.container);
    } finally {
      unhold();
    }
  }
}

/** `body` on the live NSWindow with control deliveries held until it returns. */
function windowCall(win: Window, body: (ns: Handle) => void): void {
  const ns = liveWindow(win);
  hold();
  try {
    body(ns);
  } finally {
    unhold();
  }
}

for (const key of ObjectKeys(windowAccessors)) {
  const { get, set } = windowAccessors[key];
  ObjectDefineProperty(Window.prototype, key, {
    // Held both ways: reading `width`/`height` lays the window out first.
    get(this: Window) {
      hold();
      try {
        return get(this, stateOfWindow(this).ns);
      } finally {
        unhold();
      }
    },
    set(this: Window, value: unknown) {
      hold();
      try {
        set(this, value === undefined ? null : value, `Window.${key}`);
      } finally {
        unhold();
      }
    },
    enumerable: true,
    configurable: true,
  });
}

for (const key of windowEvents) {
  ObjectDefineProperty(Window.prototype, key, {
    get(this: Window) {
      return stateOfWindow(this).handlers[key] ?? null;
    },
    set(this: Window, handler: Function | null | undefined) {
      if (handler != null && typeof handler !== "function") throw typeError(`Window.${key} must be a function`);
      stateOfWindow(this).handlers[key] = handler ?? undefined;
    },
    enumerable: true,
    configurable: true,
  });
}

export default {
  app,
  Window,
  View,
  Container,
  VStack,
  HStack,
  ZStack,
  Group,
  ScrollView,
  SplitView,
  Text,
  Button,
  Checkbox,
  Radio,
  Switch,
  TextField,
  SecureField,
  SearchField,
  TextEditor,
  Slider,
  Picker,
  Segmented,
  Progress,
  Image,
  Divider,
  Spacer,
  Table,
  MetalView,
  gpu,
  GpuBuffer,
  GpuTexture,
  GpuLibrary,
  GpuFunction,
  GpuRenderPipeline,
  GpuComputePipeline,
  GpuSampler,
  GpuDepthStencil,
  GpuFrame,
  GpuCompileError,
  GpuExecutionError,
  objc,
};
