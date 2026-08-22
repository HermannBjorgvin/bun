// objc.defineClass / objc.target: Objective-C classes whose methods are
// JavaScript functions, called by AppKit (a table asking its data source, a
// button firing its action) or through the bridge like any other method.
import { app, objc, Window } from "bun:appkit";
import { emit, run, waitFor } from "./_util";

type Thrown = { threw: false; value?: unknown } | { threw: true; isTypeError: boolean; code?: string; message: string };

function tryCall(f: () => unknown): Thrown {
  try {
    const value = f();
    return { threw: false, value: typeof value === "object" && value !== null ? String(value) : value };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err?.code === "ERR_APPKIT_UNAVAILABLE") throw err;
    return { threw: true, isTypeError: err instanceof TypeError, code: err?.code, message: String(err?.message) };
  }
}

function attempt(name: string, f: () => unknown) {
  emit({ step: name, ...tryCall(f) });
}

const uncaught: string[] = [];
process.on("uncaughtException", e => {
  uncaught.push(String((e as Error)?.message ?? e));
});

await run(async () => {
  app.activationPolicy = "accessory";
  const { NSObject, NSView, NSTableView, NSTableColumn, NSButton, NSMutableArray } = objc.classes;

  // A table data source: encodings come from the NSTableViewDataSource protocol.
  const calls: string[] = [];
  const rows = ["alpha", "beta", "gamma"];
  const DataSource = objc.defineClass({
    name: "FixtureDataSource",
    protocols: ["NSTableViewDataSource"],
    methods: {
      "numberOfRowsInTableView:"(table: any) {
        calls.push(`rows:${table.className()}`);
        return rows.length;
      },
      // Spelled the way sends are; the same selector as "tableView:objectValueForTableColumn:row:".
      tableView_objectValueForTableColumn_row_(_table: unknown, column: any, row: number) {
        calls.push(`value:${String(column.identifier())}:${row}`);
        return rows[row];
      },
    },
  });
  const ds = (DataSource as any).new();
  const table = NSTableView.alloc().initWithFrame_({ x: 0, y: 0, width: 200, height: 200 });
  const column = NSTableColumn.alloc().initWithIdentifier_("name");
  table.addTableColumn_(column);
  table.setDataSource_(ds);
  table.reloadData();
  const numberOfRows = table.numberOfRows();
  const direct = objc.js(ds.tableView_objectValueForTableColumn_row_(table, column, 2));
  emit({
    step: "data source",
    className: String(DataSource),
    sameClass: objc.classes.FixtureDataSource === DataSource,
    instanceClass: String(ds.className()),
    isKindOfNSObject: ds.isKindOfClass_(NSObject),
    numberOfRows,
    direct,
    askedRows: calls.some(c => c === "rows:NSTableView"),
    askedValue: calls.includes("value:name:2"),
    respondsRows: ds.respondsToSelector_("numberOfRowsInTableView:"),
    respondsValue: ds.respondsToSelector_("tableView:objectValueForTableColumn:row:"),
    respondsNope: ds.respondsToSelector_("tableView:nope:"),
    conforms: ds.conformsToProtocol_(objc.protocols.NSTableViewDataSource),
    conformsOther: ds.conformsToProtocol_(objc.protocols.NSTableViewDelegate),
    classConforms: (DataSource as any).conformsToProtocol_(objc.protocols.NSTableViewDataSource),
    instancesRespond: (DataSource as any).instancesRespondToSelector_("numberOfRowsInTableView:"),
    signature: String(ds.methodSignatureForSelector_("numberOfRowsInTableView:").methodReturnType?.() ?? ""),
    protocolsString: String(objc.protocols),
    sameProtocol: objc.protocols.NSTableViewDataSource === objc.protocols.NSTableViewDataSource,
  });

  // objc.target: an action receiver for a control.
  const senders: unknown[] = [];
  let thisInTarget: unknown;
  const target = objc.target(function (this: unknown, sender: unknown) {
    thisInTarget = this;
    senders.push(sender);
  });
  const win = new Window({ title: "define", width: 200, height: 100, visible: false });
  const button = NSButton.alloc().initWithFrame_({ x: 0, y: 0, width: 80, height: 24 });
  win.native.contentView().addSubview_(button);
  button.setTarget_(target);
  button.setAction_("action:");
  button.performClick_(null);
  (target as any).action_(null);
  // A reader that scopes what a getter returned gives back only what that
  // read acquired; the target (which AppKit holds weak) stays.
  {
    using read = button.target();
    void read;
  }
  button.performClick_(null);
  emit({
    step: "target",
    generatedClassName: /^BunScriptObject\d+$/.test(String((target as any).className())),
    stillTarget: objc.same(button.target(), target),
    clicks: senders.length,
    senderIsButton: objc.same(senders[0] as object, button),
    secondSender: senders[1],
    thisIsTarget: objc.same(thisInTarget as object, target),
    responds: (target as any).respondsToSelector_("action:"),
    buttonTarget: objc.same(button.target(), target),
  });

  // Subclassing a framework class: encodings read off the superclass.
  const Flipped = objc.defineClass({
    name: "FixtureFlippedView",
    superclass: "NSView",
    methods: {
      isFlipped: () => true,
      acceptsFirstResponder() {
        return true;
      },
      "viewDidMoveToSuperview"() {
        calls.push("moved");
      },
    },
  });
  const flipped = (Flipped as any).alloc().initWithFrame_({ x: 0, y: 0, width: 10, height: 10 });
  const plain = NSView.alloc().initWithFrame_({ x: 0, y: 0, width: 10, height: 10 });
  win.native.contentView().addSubview_(flipped);
  emit({
    step: "subclass",
    superclassName: String((Flipped as any).superclass()),
    flipped: flipped.isFlipped(),
    plainFlipped: plain.isFlipped(),
    accepts: flipped.acceptsFirstResponder(),
    plainAccepts: plain.acceptsFirstResponder(),
    moved: calls.includes("moved"),
    isKindOfNSView: flipped.isKindOfClass_(NSView),
    frameWidth: flipped.frame().size.width,
  });

  // A framework dealloc that messages an overridden method (NSView removing
  // its subviews) finds the receiver deallocating: JavaScript is not entered.
  const removals: string[] = [];
  const Parent = objc.defineClass({
    superclass: "NSView",
    methods: {
      willRemoveSubview_(subview: any) {
        removals.push(String(subview.className()));
      },
    },
  }) as any;
  let parent = Parent.alloc().initWithFrame_({ x: 0, y: 0, width: 10, height: 10 });
  const child = NSButton.alloc().initWithFrame_({ x: 0, y: 0, width: 5, height: 5 });
  parent.addSubview_(child);
  child.removeFromSuperview();
  const whileAlive = removals.slice();
  parent.addSubview_(child);
  parent.release();
  parent = undefined;
  Bun.gc(true);
  await new Promise(r => setImmediate(r));
  Bun.gc(true);
  emit({
    step: "dealloc",
    whileAlive,
    afterRelease: removals.slice(),
    childSuperview: child.superview(),
    childClass: String(child.className()),
  });

  // A subclass of a script class inherits and overrides its methods.
  const Base = objc.defineClass({
    methods: {
      greeting: () => "base",
      "twice:": { types: "q@:q", fn: (n: number) => n * 2 },
    },
  }) as any;
  const Derived = objc.defineClass({ superclass: Base, methods: { greeting: () => "derived" } }) as any;
  const derived = Derived.new();
  // A class that arrived as an `id` (here out of an array) is a superclass too.
  const classAsObject = NSMutableArray.arrayWithObject_(NSObject).objectAtIndex_(0);
  const FromObject = objc.defineClass({ superclass: classAsObject, methods: {} }) as any;
  emit({
    step: "inherit",
    fromObjectSuperclass: String(FromObject.superclass()),
    generatedNames: [String(Base), String(Derived)].every(n => /^BunScriptObject\d+$/.test(n)),
    base: objc.js(Base.new().greeting()),
    derived: objc.js(derived.greeting()),
    inheritedTwice: derived.twice_(21),
    derivedSuperclass: String(Derived.superclass()) === String(Base),
  });

  // A method given as a constant is a native method returning it: nothing
  // runs in JavaScript, so it answers on any thread too.
  {
    const Constants = objc.defineClass({
      name: "FixtureConstants",
      superclass: "NSView",
      methods: {
        isFlipped: true,
        isOpaque: { value: false },
        tag: -7,
        alphaValue: 0.25,
        menu: null,
        big: { types: "Q@:", value: 2n ** 64n - 1n },
        ratio: { types: "f@:", value: 1.5 },
        "level:": { types: "i@:@", value: 3 },
      },
    }) as any;
    const view = Constants.alloc().initWithFrame_({ x: 0, y: 0, width: 4, height: 4 });
    const Answers = objc.defineClass({
      name: "FixtureAnswers",
      methods: { level: { types: "q@:", value: 42 } },
    }) as any;
    const Asks = objc.defineClass({
      name: "FixtureAsks",
      methods: { level: { types: "q@:", fn: () => 1 } },
    }) as any;
    // KVC reads both on one background thread, the constant first; only the
    // function is refused there.
    const before = uncaught.length;
    const pair = NSMutableArray.new();
    pair.addObject_(Answers.new());
    pair.addObject_(Asks.new());
    pair.performSelectorInBackground_withObject_("valueForKey:", "level");
    await waitFor(() => uncaught.length > before, "the background read to be refused");
    emit({
      step: "constants",
      flipped: view.isFlipped(),
      opaque: view.isOpaque(),
      tag: view.tag(),
      alpha: view.alphaValue(),
      menu: view.menu(),
      big: String(view.big()),
      ratio: view.ratio(),
      level: view.level_(null),
      kvc: objc.js(view.valueForKey_("tag")),
      responds: Constants.instancesRespondToSelector_("big"),
      mainThread: objc.js(pair.valueForKey_("level")),
      uncaught: uncaught.splice(before),
      wrongBool: tryCall(() => objc.defineClass({ superclass: "NSView", methods: { isFlipped: 1 } })),
      wrongObject: tryCall(() => objc.defineClass({ superclass: "NSView", methods: { menu: true } })),
      wrongVoid: tryCall(() => objc.defineClass({ methods: { "poke:": { types: "v@:@", value: null } } })),
      wrongStruct: tryCall(() => objc.defineClass({ superclass: "NSView", methods: { frame: null } })),
      wrongRange: tryCall(() => objc.defineClass({ methods: { small: { types: "C@:", value: 300 } } })),
      wrongFraction: tryCall(() => objc.defineClass({ methods: { whole: { types: "q@:", value: 1.5 } } })),
      wrongKind: tryCall(() => objc.defineClass({ methods: { text: "yes" as never } })),
    });
  }

  // Return and argument conversions by encoding.
  const Types = objc.defineClass({
    name: "FixtureTypes",
    methods: {
      "rect:": {
        types: "{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}",
        fn: (r: any) => ({ x: r.origin.x + 1, y: r.origin.y, width: r.size.width * 2, height: r.size.height }),
      },
      "add:to:": { types: "d@:dd", fn: (a: number, b: number) => a + b },
      "not:": { types: "B@:B", fn: (b: boolean) => !b },
      "sel:": { types: ":@::", fn: (s: string) => s + "extra:" },
      "cls": { types: "#@:", fn: () => objc.classes.NSString },
      "big:": { types: "Q@:Q", fn: (n: bigint) => n + 1n },
      "describe:": { fn: (o: any) => `got ${objc.js(o)}` },
      "list": { fn: () => ["a", 1, true, null] },
      "nothing": { fn: () => undefined },
      "keep:"(this: any, o: unknown) {
        return o;
      },
    },
  }) as any;
  const t = Types.new();
  const kept = NSMutableArray.new();
  emit({
    step: "types",
    rect: t.rect_({ x: 1, y: 2, width: 3, height: 4 }),
    add: t.add_to_(1.5, 2.25),
    not: [t.not_(true), t.not_(false)],
    sel: t.sel_("some:"),
    cls: t.cls() === objc.classes.NSString,
    big: String(t.big_(2n ** 60n)),
    describe: objc.js(t.describe_(42)),
    describeString: objc.js(t.describe_("s")),
    list: objc.js(t.list()),
    nothing: t.nothing(),
    keepSame: objc.same(t.keep_(kept), kept),
    keepNull: t.keep_(null),
  });

  // A throw inside a method is reported as an uncaught JavaScript error and the sender reads zero / nil.
  const Throws = objc.defineClass({
    name: "FixtureThrows",
    methods: {
      boom() {
        throw new Error("boom from js");
      },
      "count": {
        types: "q@:",
        fn: () => {
          throw new TypeError("count failed");
        },
      },
      "flag": { types: "B@:", fn: () => "not a boolean" },
      "rows": { types: "q@:", fn: () => 1.5 },
      "badSel": { types: ":@:", fn: () => "with\0nul:" },
    },
  }) as any;
  const thrower = Throws.new();
  const boom = tryCall(() => thrower.boom());
  const count = tryCall(() => thrower.count());
  const flag = tryCall(() => thrower.flag());
  const badRows = tryCall(() => thrower.rows());
  const badSel = tryCall(() => thrower.badSel());
  await waitFor(() => uncaught.length >= 5, "five uncaught errors");
  emit({ step: "throws", boom, count, flag, badRows, badSel, uncaught: uncaught.slice() });

  // forwardInvocation: sent by hand with a selector no script class defines
  // has nothing to forward to (NSObject's would raise): it does nothing.
  attempt("forward by hand", () => {
    const { NSInvocation } = objc.classes;
    const invocation = NSInvocation.invocationWithMethodSignature_(ds.methodSignatureForSelector_("description"));
    invocation.setSelector_("description");
    return ds.forwardInvocation_(invocation);
  });
  // One whose signature is not the method's is refused rather than read past its end.
  {
    const before = uncaught.length;
    const { NSInvocation, NSMethodSignature } = objc.classes;
    const invocation = NSInvocation.invocationWithMethodSignature_(NSMethodSignature.signatureWithObjCTypes_("v@:"));
    invocation.setSelector_("tableView:objectValueForTableColumn:row:");
    const sent = tryCall(() => ds.forwardInvocation_(invocation));
    await waitFor(() => uncaught.length > before, "the mismatched invocation to be reported");
    emit({ step: "forward wrong signature", sent, uncaught: uncaught.slice(before) });
  }

  // Without `protocols`, a selector Foundation's and AppKit's protocols
  // declare one way takes that encoding; one they disagree on is refused.
  {
    const Untyped = objc.defineClass({
      methods: {
        "numberOfRowsInTableView:": () => 7,
        "windowShouldClose:": () => false,
        "somethingOfMyOwn:": (x: unknown) => x,
      },
    }) as any;
    const u = Untyped.new();
    const enc = (sel: string) =>
      String(u.methodSignatureForSelector_(sel).methodReturnType()) +
      String(u.methodSignatureForSelector_(sel).getArgumentTypeAtIndex_(2));
    emit({
      step: "untyped encodings",
      rows: enc("numberOfRowsInTableView:"),
      shouldClose: enc("windowShouldClose:"),
      own: enc("somethingOfMyOwn:"),
      rowsValue: NSTableView.alloc().initWithFrame_({ x: 0, y: 0, width: 10, height: 10 }).numberOfRows(),
    });
    attempt("untyped conflict", () => objc.defineClass({ methods: { state: () => 1 } }));
  }

  // What defineClass refuses.
  attempt("name taken", () => objc.defineClass({ name: "NSObject", methods: {} }));
  attempt("name taken twice", () => objc.defineClass({ name: "FixtureTypes", methods: {} }));
  attempt("bad name", () => objc.defineClass({ name: "has space", methods: {} }));
  attempt("no protocol", () => objc.defineClass({ protocols: ["NSDefinitelyNotAProtocol"], methods: {} }));
  attempt("protocol lookup", () => objc.protocols.NSDefinitelyNotAProtocol);
  attempt("bad superclass", () => objc.defineClass({ superclass: "NSDefinitelyNotAClass", methods: {} }));
  attempt("bad types", () => objc.defineClass({ methods: { "x:": { types: "v@:{{{", fn() {} } } }));
  attempt("types arity", () => objc.defineClass({ methods: { "x:": { types: "v@:", fn() {} } } }));
  attempt("types no self", () => objc.defineClass({ methods: { x: { types: "v", fn() {} } } }));
  attempt("types bad self", () => objc.defineClass({ methods: { "x:": { types: "vq:@", fn() {} } } }));
  attempt("fn arity", () => objc.defineClass({ methods: { "x:": (_a: unknown, _b: unknown) => 0 } }));
  attempt("init refused", () =>
    objc.defineClass({
      methods: {
        init() {
          return this;
        },
      },
    }),
  );
  attempt("initWith refused", () => objc.defineClass({ methods: { "initWithRows:": (_rows: unknown) => null } }));
  attempt("required missing", () => objc.defineClass({ protocols: ["NSCopying"], methods: {} }));
  attempt("required inherited", () =>
    String((objc.defineClass({ superclass: "NSCell", protocols: ["NSCopying"], methods: {} }) as any).superclass()),
  );
  attempt("required defined", () =>
    String(
      (
        objc.defineClass({ protocols: ["NSCopying"], methods: { copyWithZone_: (_zone: unknown) => null } }) as any
      ).superclass(),
    ),
  );
  // A block parameter arrives as a handle the method can call; a block
  // return takes a block handle.
  {
    const received: unknown[] = [];
    const WithBlocks = objc.defineClass({
      methods: {
        "run:with:": {
          types: "q@:@?q",
          fn(block: any, n: bigint | number) {
            received.push(typeof block.invoke, block.invoke(Number(n)), block.invoke(2));
            return block.invoke(10);
          },
        },
        "twiceOf:": { types: "@?@:@?", fn: (block: unknown) => block },
      },
    }) as any;
    const w = WithBlocks.new();
    const square = objc.block((x: unknown) => Number(objc.js(x)) * Number(objc.js(x)), "q@?@") as any;
    const result = w.run_with_(square, 7);
    const back = w.twiceOf_(square);
    emit({
      step: "block param",
      received,
      result,
      same: back === square,
      direct: square.invoke(9),
      // Two acquisitions (objc.block's and twiceOf's result), two releases.
      released: (square.release(), back.release(), tryCall(() => square.invoke(1)).threw),
    });
  }
  attempt("block return fn", () =>
    (objc.defineClass({ methods: { x: { types: "@?@:", fn: () => () => {} } } }) as any).new().x(),
  );
  attempt("reserved", () => objc.defineClass({ methods: { dealloc() {} } }));
  attempt("not a function", () => objc.defineClass({ methods: { x: "three" as any } }));
  attempt("no methods", () => (objc as any).defineClass({}));
  attempt("target not a function", () => (objc as any).target("nope"));
  // A refused definition leaves the name free.
  attempt("name reusable", () =>
    String(objc.defineClass({ name: "FixtureRetry", methods: { "x:": { types: "v@:{{{", fn() {} } } })),
  );
  attempt("name reused", () => String(objc.defineClass({ name: "FixtureRetry", methods: {} })));

  // An `inout` object pointer (`N^@`, KVC validation) arrives holding the
  // caller's object and stores what the method leaves.
  {
    const Validating = objc.defineClass({
      methods: {
        "validateValue:forKey:error:"(io: { value: any }, key: unknown) {
          const incoming = String(io.value);
          io.value = `${incoming}+${String(key)}`;
          return incoming.length > 0;
        },
      },
    }) as any;
    const v = Validating.new();
    const io = objc.out(objc.ns("in"));
    const ok = v.validateValue_forKey_error_(io, "k", null);
    emit({
      step: "inout",
      ok,
      out: String(io.value),
      types: String(v.methodSignatureForSelector_("validateValue:forKey:error:").getArgumentTypeAtIndex_(2)),
    });
  }

  // Lifetime: the instance keeps its functions alive; deallocating it lets them go.
  let collectedFn = false;
  const registry = new FinalizationRegistry(() => {
    collectedFn = true;
  });
  let firedAfterGc = 0;
  let keeper: any = (() => {
    const fn = () => firedAfterGc++;
    registry.register(fn, "fn");
    return objc.target(fn);
  })();
  Bun.gc(true);
  await new Promise(r => setImmediate(r));
  Bun.gc(true);
  keeper.action_(null);
  const aliveWhileHeld = !collectedFn && firedAfterGc === 1;
  keeper.release();
  keeper = undefined;
  await waitFor(
    () => {
      Bun.gc(true);
      return collectedFn;
    },
    "the released target's function to be collected",
    30_000,
  );
  emit({ step: "lifetime", aliveWhileHeld, collectedAfterRelease: collectedFn });

  // Released for the last time on another thread: the instance's functions
  // are still let go (on this one).
  {
    let collected = false;
    const gone = new FinalizationRegistry(() => {
      collected = true;
    });
    const holder = NSMutableArray.new();
    (() => {
      const fn = () => {};
      gone.register(fn, "fn");
      const held = objc.target(fn) as any;
      holder.addObject_(held);
      held.release();
    })();
    holder.performSelectorInBackground_withObject_("removeAllObjects", null);
    await waitFor(() => holder.count() === 0, "the background thread to empty the array");
    await waitFor(
      () => {
        Bun.gc(true);
        return collected;
      },
      "the function of a target deallocated on another thread to be collected",
      30_000,
    );
    emit({ step: "lifetime off thread", collected });
  }

  // NSXMLParser.delegate is one of the few properties still declared
  // `assign` rather than weak: the bridge has the parser hold what is set on
  // it, so a delegate whose handle is gone still answers instead of leaving
  // the parser a dangling pointer, and setting nil lets it go.
  {
    const { NSXMLParser, NSString, NSHashTable } = objc.classes;
    let elements = 0;
    const ParserDelegate = objc.defineClass({
      protocols: ["NSXMLParserDelegate"],
      methods: {
        "parser:didStartElement:namespaceURI:qualifiedName:attributes:": () => {
          elements++;
        },
      },
    });
    const xml = NSString.stringWithString_("<a><b/><b/></a>").dataUsingEncoding_(4);
    const parser = NSXMLParser.alloc().initWithData_(xml);
    const alive = NSHashTable.weakObjectsHashTable();
    (() => {
      const delegate = ParserDelegate.new();
      alive.addObject_(delegate);
      parser.setDelegate_(delegate);
      delegate.release();
    })();
    Bun.gc(true);
    await new Promise(r => setImmediate(r));
    Bun.gc(true);
    const heldWhileSet = alive.allObjects().count();
    const parsed = parser.parse();
    const sameObject = parser.delegate() === alive.anyObject();
    parser.setDelegate_(null);
    await waitFor(
      () => {
        Bun.gc(true);
        return alive.allObjects().count() === 0;
      },
      "the cleared delegate to deallocate",
      30_000,
    );
    emit({ step: "assign delegate", heldWhileSet, parsed, elements, sameObject, goneAfterNil: true });
    // A second parser given the same kind of delegate and then released
    // itself takes the delegate with it.
    const other = NSXMLParser.alloc().initWithData_(xml);
    (() => {
      const delegate = ParserDelegate.new();
      alive.addObject_(delegate);
      other.setDelegate_(delegate);
      delegate.release();
    })();
    other.release();
    await waitFor(
      () => {
        Bun.gc(true);
        return alive.allObjects().count() === 0;
      },
      "the released parser's delegate to deallocate",
      30_000,
    );
    emit({ step: "assign delegate owner released", gone: true });
  }

  win.close();
  emit({ step: "done" });
});
