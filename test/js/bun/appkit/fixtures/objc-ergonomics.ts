// The parts of `objc` beyond plain sends: out-parameters, exported constants,
// the enum tables, one handle per object, inspection, the `in`/keys traps,
// `using`, for...of over collections, and NSData/NSDate conversion.
import { objc, Text, Window } from "bun:appkit";
import { inspect } from "node:util";
import { emit, run } from "./_util";

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

await run(async () => {
  const { NSFileManager, NSScanner, NSAttributedString, NSString, NSMutableArray, NSObject, NSIndexSet } = objc.classes;
  // Read before the application object exists; must not stick.
  const earlyApp = objc.constants.NSApp;

  // ^@: NSError ** filled on failure, left nil on success; null passes NULL.
  const missing = "/definitely/not/a/path/for/bun";
  const error = objc.out();
  const failed = NSFileManager.defaultManager().attributesOfItemAtPath_error_(missing, error);
  const plain: { value?: any } = {};
  NSFileManager.defaultManager().attributesOfItemAtPath_error_(missing, plain);
  const unused = objc.out();
  const root = NSFileManager.defaultManager().attributesOfItemAtPath_error_("/", unused);
  emit({
    step: "out error",
    failed,
    errorClass: error.value.isKindOfClass_(objc.classes.NSError),
    domain: String(error.value.domain()),
    code: error.value.code(),
    plainCode: plain.value.code(),
    unusedIsNull: unused.value === null,
    rootIsDictionary: root.isKindOfClass_(objc.classes.NSDictionary),
    withNull: NSFileManager.defaultManager().attributesOfItemAtPath_error_(missing, null),
    // A trailing out-parameter left off is NULL.
    omitted: NSFileManager.defaultManager().attributesOfItemAtPath_error_(missing),
  });
  attempt("omitted non-out", () => NSString.stringWithString_("a").compare_());

  // ^d, ^q, ^I, ^@ on NSScanner; a value set beforehand is the storage's initial contents.
  const scanner = NSScanner.scannerWithString_("3.25 -17 ff word");
  const d = objc.out();
  const q = objc.out(99);
  const hex = objc.out();
  const word = objc.out();
  const scanned = [
    scanner.scanDouble_(d),
    scanner.scanInteger_(q),
    scanner.scanHexInt_(hex),
    scanner.scanUpToString_intoString_("!", word),
  ];
  const exhausted = objc.out(7.5);
  emit({
    step: "out scalars",
    scanned,
    d: d.value,
    q: q.value,
    hex: hex.value,
    word: String(word.value),
    // Nothing left to scan: NSScanner leaves the storage alone, so the initial value comes back.
    again: scanner.scanDouble_(exhausted),
    exhausted: exhausted.value,
  });

  // ^{_NSRange=QQ}: NSRangePointer.
  const styled = NSAttributedString.alloc().initWithString_("hello");
  const range = objc.out();
  const font = styled.attribute_atIndex_effectiveRange_("NSFont", 1, range);
  const lineEnd = objc.out();
  NSString.stringWithString_("ab\ncd").getLineStart_end_contentsEnd_forRange_(null, lineEnd, null, {
    location: 0,
    length: 1,
  });
  emit({ step: "out struct", font, range: range.value, lineEnd: lineEnd.value });

  // Out-parameters of a defined method read and write the same `{ value }` cells.
  const Filler = objc.defineClass({
    methods: {
      "bump:": { types: "v@:^q", fn: (cell: { value: number }) => void (cell.value += 1) },
      "fill:": {
        types: "B@:^@",
        fn(cell: { value: unknown }) {
          const wasNull = cell.value === null;
          cell.value = "filled";
          return wasNull;
        },
      },
      "frame:": {
        types: "v@:^{CGRect={CGPoint=dd}{CGSize=dd}}",
        fn: (cell: { value: any }) => void (cell.value = { x: 1, y: 2, width: cell.value.size.width * 2, height: 4 }),
      },
    },
  });
  const filler = Filler.new();
  const counter = objc.out(41);
  filler.bump_(counter);
  const text = objc.out();
  const wasNull = filler.fill_(text);
  const frame = objc.out({ x: 0, y: 0, width: 21, height: 0 });
  filler.frame_(frame);
  emit({
    step: "out defined",
    counter: counter.value,
    wasNull,
    text: String(text.value),
    textIsString: text.value.isKindOfClass_(NSString),
    withNull: filler.fill_(null),
    // Object storage is not read on the way in (an NSError ** need not be initialised).
    presetReadsNull: filler.fill_(objc.out("preset")),
    frame: frame.value,
  });
  attempt("out number", () => scanner.scanDouble_(1.5 as any));
  attempt("out handle", () => scanner.scanDouble_(NSObject.new()));
  attempt("out bad initial", () => scanner.scanDouble_(objc.out("x")));

  // C arrays and buffers are not out-parameters: only NULL can be passed.
  const abc = NSString.stringWithString_("abc");
  attempt("array objects", () => objc.ns(["x"])!.getObjects_range_(objc.out(), { location: 0, length: 1 }));
  attempt("array unichar", () => abc.getCharacters_range_(objc.out(), { location: 0, length: 3 }));
  attempt("array char", () => abc.getCString_maxLength_encoding_("", 1000, 4));
  attempt("array const", () => objc.classes.NSArray.arrayWithObjects_count_(objc.out(), 1));
  attempt("array no count", () => objc.classes.NSColor.redColor().getComponents_(objc.out()));
  attempt("array read", () =>
    objc.classes.NSInputStream.inputStreamWithData_(new Uint8Array(8)).read_maxLength_({}, 8),
  );
  emit({
    step: "array null",
    getCharacters: abc.getCharacters_range_(null, { location: 0, length: 0 }),
    constChar: String(NSString.stringWithUTF8String_("hi")),
    utf8: abc.UTF8String(),
  });

  // A class cluster allocates when the init is looked up; a failed init leaves an alloc that takes only an init.
  const clusterAlloc = NSAttributedString.alloc();
  attempt("cluster bad init", () => clusterAlloc.msgSend("initWithString:"));
  attempt("cluster not initialized", () => clusterAlloc.length());
  emit({
    step: "cluster alloc",
    inspect: Bun.inspect(clusterAlloc),
    keys: Object.keys(clusterAlloc).length,
    length: clusterAlloc.initWithString_("ok").length(),
    consumed: tryCall(() => clusterAlloc.length()).threw,
  });

  // Exported constants: objects by default, numbers and structs where the table says so.
  emit({
    step: "constants",
    fontAttribute: objc.js(objc.constants.NSFontAttributeName),
    didResize: objc.js(objc.constants.NSWindowDidResizeNotification),
    runLoopMode: objc.js(objc.constants.NSDefaultRunLoopMode),
    cached: objc.constants.NSFontAttributeName === objc.constants.NSFontAttributeName,
    viaFunction: objc.constant("NSFontAttributeName") === objc.constants.NSFontAttributeName,
    weightRegular: objc.constants.NSFontWeightRegular,
    weightBoldPositive: (objc.constants.NSFontWeightBold as number) > 0,
    typed: objc.constant("NSFontWeightRegular", { type: "d" }),
    noIntrinsicMetric: objc.constants.NSViewNoIntrinsicMetric,
    zeroRect: objc.constants.NSZeroRect,
    zeroSize: objc.constant("NSZeroSize"),
    string: String(objc.constants),
    // A scoped read gives back that read; the constant reads again afterwards.
    afterUsing: (() => {
      {
        using scoped = objc.constants.NSFontAttributeName;
        void scoped;
      }
      return String(objc.constants.NSFontAttributeName);
    })(),
    // Outside AppKit's own dependencies: found in whatever the process has loaded.
    otherFramework: (() => {
      objc.classes.NSBundle.bundleWithPath_("/System/Library/Frameworks/AVFoundation.framework").load();
      return String(objc.constants.AVMediaTypeVideo);
    })(),
  });
  // Outside the table a global is read as an object only if it holds one;
  // CoreFoundation's and libc's numbers are in the table.
  emit({
    step: "constants wider",
    since1970: objc.constants.kCFAbsoluteTimeIntervalSince1970,
    pageSize: objc.constants.vm_page_size === 16384 || objc.constants.vm_page_size === 4096,
    identity: objc.constants.CGAffineTransformIdentity,
    debugEnabled: objc.constants.NSDebugEnabled,
    callbacks: tryCall(() => objc.constants.NSObjectMapKeyCallBacks),
    stdinp: tryCall(() => objc.constants.__stdinp),
    environ: tryCall(() => objc.constants.environ),
    explicit: tryCall(() => objc.constant("kCFAbsoluteTimeIntervalSince1970", { type: "@" })),
  });
  attempt("constant unknown", () => objc.constants.NSDefinitelyNotAConstant);
  attempt("constant function", () => objc.constants.NSBeep);
  attempt("constant prototype name", () => objc.constants.constructor);
  attempt("constant void", () => objc.constant("NSFontAttributeName", { type: "v" }));
  attempt("constant bad name", () => (objc.constant as any)(3));
  attempt("constants read-only", () => ((objc.constants as any).NSFontAttributeName = 1));

  // Any struct of scalars passed by value crosses: the ones AppKit names
  // fields for as objects (or arrays going in), anonymous ones (CMTime is a
  // typedef of an unnamed struct with mixed member sizes) as arrays.
  {
    const { CALayer, NSValue } = objc.classes;
    const layer = CALayer.layer();
    const identity = layer.transform();
    layer.setTransform_([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    const moved = layer.transform();
    layer.setTransform_({ ...identity, m41: 9 });
    const time = NSValue.valueWithCMTime_([90, 30, 1, 0]);
    const range = NSValue.valueWithRange_([3, 4]).rangeValue();
    emit({
      step: "structs",
      identityKeys: Object.keys(identity).join(","),
      identityDiagonal: [identity.m11, identity.m22, identity.m33, identity.m44],
      moved: [moved.m41, moved.m42, moved.m43],
      spread: layer.transform().m41,
      cmTime: time.CMTimeValue(),
      cmTimeText: String(time).includes("90"),
      rangeFromArray: range,
      badLength: tryCall(() => layer.setTransform_([1, 2, 3])),
      badMember: tryCall(() => NSValue.valueWithCMTime_([90, "x", 1, 0])),
      badBigint: tryCall(() => NSValue.valueWithCMTime_([90, 1n << 40n, 1, 0])),
      fraction: tryCall(() => NSValue.valueWithRange_({ location: 1.5, length: 1 })),
    });
  }

  // Enums: short and full member names per type, and every member and static constant flat.
  const {
    NSWindowStyleMask,
    NSTextAlignment,
    NSEventType,
    NSBitmapImageFileType,
    NSKeyValueObservingOptions,
    NSLineBreakMode,
  } = objc.enums as any;
  const label = new Text({ text: "t", textAlign: "center" });
  const win = new Window({ title: "h", visible: false, width: 120, height: 80 });
  emit({
    step: "NSApp",
    early: earlyApp === null || objc.same(earlyApp, objc.classes.NSApplication.sharedApplication()),
    now: objc.constants.NSApp === objc.classes.NSApplication.sharedApplication(),
  });
  emit({
    step: "enums",
    titled: NSWindowStyleMask.titled,
    resizable: NSWindowStyleMask.resizable,
    fullName: NSWindowStyleMask.NSWindowStyleMaskFullSizeContentView,
    flat: objc.enums.NSWindowStyleMaskTitled,
    keyDown: NSEventType.keyDown,
    png: NSBitmapImageFileType.png,
    kvoNew: NSKeyValueObservingOptions.new,
    byWordWrapping: NSLineBreakMode.byWordWrapping,
    // The one architecture-dependent enum agrees with what AppKit reads back.
    centerMatches: label.native.alignment() === NSTextAlignment.center,
    stateOn: objc.enums.NSControlStateValueOn,
    stateMixed: objc.enums.NSControlStateValueMixed,
    modalOK: objc.enums.NSModalResponseOK,
    upArrow: objc.enums.NSUpArrowFunctionKey,
    // Constants of an unnamed NS_ENUM(Type) block.
    utf8: objc.enums.NSUTF8StringEncoding,
    undefinedComponent: objc.enums.NSDateComponentUndefined === objc.NSNotFound,
    notFound: objc.enums.NSNotFound === objc.NSNotFound,
    frozen: Object.isFrozen(NSWindowStyleMask),
    has: ["titled" in NSWindowStyleMask, "NSWindowStyleMaskTitled" in NSWindowStyleMask, "nope" in NSWindowStyleMask],
    keyCount: Object.keys(NSTextAlignment).length,
    same: objc.enums.NSWindowStyleMask === NSWindowStyleMask,
    tag: Object.prototype.toString.call(NSWindowStyleMask),
    // A mask built from the table is what NSWindow reports.
    windowMask: win.native.styleMask() & NSWindowStyleMask.titled,
  });
  const enums = objc.enums as any;
  emit({
    step: "enum names",
    byTruncatingTail: enums.NSLineBreakMode.byTruncatingTail,
    initial: enums.NSKeyValueObservingOptions.initial,
    jpeg2000: enums.NSBitmapImageFileType.jpeg2000,
    slideUp: enums.NSTableViewAnimationOptions.slideUp,
    dtdKind: enums.NSXMLNodeKind.dtdKind,
    scaleToFitFull: enums.NSImageScaling.NSScaleToFit,
    scaleAxesIndependently: enums.NSImageScaling.scaleAxesIndependently,
    scaleToFitShort: "scaleToFit" in enums.NSImageScaling,
    // QuartzCore and Metal: a CoreFoundation-style `k` stays with the prefix; the value is what the layer reads.
    layerLeftEdge: enums.CAEdgeAntialiasingMask.layerLeftEdge,
    kCALayerLeftEdge: enums.kCALayerLeftEdge,
    constraintMinX: enums.CAConstraintAttribute.minX,
    bgra8Unorm: enums.MTLPixelFormat.bgra8Unorm,
    depth32Float: enums.MTLPixelFormatDepth32Float,
    edgeMask:
      objc.classes.CALayer.layer().edgeAntialiasingMask() ===
      (enums.kCALayerLeftEdge | enums.kCALayerRightEdge | enums.kCALayerBottomEdge | enums.kCALayerTopEdge),
  });
  attempt("enum unknown", () => objc.enums.NSDefinitelyNotAnEnum);
  attempt("enum prototype name", () => (objc.enums as any).hasOwnProperty);
  attempt("enums read-only", () => ((objc.enums as any).NSWindowStyleMask = 1));

  // One object, one handle.
  const list = NSMutableArray.new();
  // Boxed by the bridge, so no handle of it exists yet.
  list.addObject_("element");
  let receiver: unknown;
  const Echo = objc.defineClass({
    methods: {
      "ping:": {
        types: "v@:@",
        fn() {
          receiver = this;
        },
      },
    },
  });
  const echo = Echo.new();
  echo.ping_(null);
  const first = list.objectAtIndex_(0);
  first.release();
  const second = list.objectAtIndex_(0);
  emit({
    step: "identity",
    element: list.objectAtIndex_(0) === list.objectAtIndex_(0),
    window: win.native === win.native.contentView().window(),
    classFromMessage: NSObject.new().class() === NSObject && list.class() === objc.classes[String(list.class())],
    classFromArray: objc.ns([NSString]).objectAtIndex_(0) === NSString,
    classTag: Object.prototype.toString.call(objc.ns([NSString]).objectAtIndex_(0)),
    self: NSObject.class() === NSObject,
    receiver: receiver === echo,
    afterRelease: first !== second && second === list.objectAtIndex_(0),
    same: [objc.same(second, list.objectAtIndex_(0)), objc.same(first, second), objc.same(null, null)],
  });
  // Arguments with a `value` of their own are left alone after a send.
  const { NSURLQueryItem } = objc.classes;
  emit({
    step: "value arguments",
    queryItem: tryCall(() => list.addObject_(NSURLQueryItem.queryItemWithName_value_("a", "b"))).threw,
    frozen: tryCall(() => list.addObject_(Object.freeze({ value: 1 }))).threw,
    stillItem: String(list.objectAtIndex_(1).value()),
  });
  list.removeObjectsInRange_({ location: 1, length: 2 });

  // What console.log / util.inspect print.
  const hi = NSString.stringWithString_("hi");
  const allocated = NSString.alloc();
  emit({
    step: "inspect",
    string: Bun.inspect(hi),
    util: inspect(hi),
    klass: Bun.inspect(NSString),
    released: Bun.inspect(first),
    alloc: Bun.inspect(allocated),
    custom: (hi as any)[Symbol.for("nodejs.util.inspect.custom")](),
    inArray: Bun.inspect([NSString]),
  });
  allocated.init();

  // `in`, Object.keys, property descriptors.
  const keys = Object.keys(list);
  const classKeys = Object.keys(NSString);
  emit({
    step: "traps",
    hasCount: "count" in list,
    hasSetter: "addObject_" in list,
    hasNope: "definitelyNot_" in list,
    hasThen: "then" in list,
    hasMsgSend: "msgSend" in list,
    hasPointer: objc.pointer in list,
    hasIterator: Symbol.iterator in list,
    objectHasIterator: Symbol.iterator in NSObject.new(),
    classHasRelease: "release" in NSString,
    keysIncludeCount: keys.includes("count") && keys.includes("objectAtIndex_") && keys.includes("addObject_"),
    keysExcludePrivate: keys.every(k => !k.startsWith("_")),
    keysUnique: new Set(keys).size === keys.length,
    manyKeys: keys.length > 50,
    classKeys: classKeys.includes("stringWithString_") && !classKeys.includes("length"),
    descriptor: typeof Object.getOwnPropertyDescriptor(list, "count")?.value,
    noDescriptor: Object.getOwnPropertyDescriptor(list, "definitelyNot_"),
    releasedHas: "count" in first,
    releasedKeys: Object.keys(first).length,
  });

  // Symbol.dispose gives the reference back: the handle's only one here, so
  // it ends; below, one of the two the two sends acquired, so it stays.
  const scoped = NSString.stringWithString_("scoped");
  {
    using inner = scoped;
    inner.length();
  }
  const holder = objc.ns(["kept"])!;
  const kept = holder.firstObject();
  {
    using again = holder.firstObject();
    void again;
  }
  emit({
    step: "dispose",
    use: tryCall(() => scoped.length()),
    classDispose: typeof (NSString as any)[Symbol.dispose],
    sameHandle: kept === holder.firstObject(),
    stillUsable: tryCall(() => kept.length()),
    // Two acquisitions left (the first read and the comparison's); two releases end it.
    afterTwoReleases: (kept.release(), kept.release(), tryCall(() => kept.length()).threw),
  });

  // for...of over the collections.
  const letters = objc.ns(["a", "b", "c"])!;
  const dict = objc.ns({ x: 1, y: 2 })!;
  const set = objc.classes.NSSet.setWithArray_(["p", "q"]);
  const indexes = letters.indexesOfObjectsPassingTest_((o: unknown) => `${o}` !== "b");
  emit({
    step: "iterate",
    array: [...letters].map(String),
    dictionary: [...dict].map(String).sort(),
    set: [...set].map(String).sort(),
    indexes: [...indexes],
    emptyIndexes: [...NSIndexSet.indexSet()],
    enumerator: [...letters.reverseObjectEnumerator()].map(String),
    arrayFrom: Array.from(letters, o => objc.js(o)),
    identity: [...letters][0] === letters.objectAtIndex_(0),
  });
  attempt("iterate object", () => [...NSObject.new()]);

  // NSData <-> Uint8Array, NSDate <-> Date, both ways and nested.
  const bytes = objc.ns(new Uint8Array([1, 2, 3]))!;
  const when = objc.ns(new Date(1000))!;
  list.addObject_(new Date(2000));
  const back = objc.js(bytes) as Uint8Array;
  const nested = objc.js(
    objc.ns({ d: new Date(0), b: new Uint8Array([9]).buffer, v: new DataView(new Uint8Array([7, 8]).buffer) }),
  ) as any;
  const { NSNumber } = objc.classes;
  emit({
    step: "numbers",
    notFound: objc.js(objc.ns(objc.NSNotFound)) === objc.NSNotFound,
    maxUnsigned: String(objc.js(NSNumber.numberWithUnsignedLongLong_(18446744073709551615n))),
    maxUnsignedType: typeof objc.js(NSNumber.numberWithUnsignedLongLong_(18446744073709551615n)),
    small: objc.js(objc.ns(3)),
    negative: objc.js(NSNumber.numberWithInt_(-7)),
    fraction: objc.js(objc.ns(2.5)),
    unsignedType: String(objc.ns(18446744073709551615n)!.objCType()),
    bool: objc.js(objc.ns(true)),
    json: JSON.stringify({ n: objc.ns(12) }),
  });
  emit({
    step: "data date",
    dataClass: bytes.isKindOfClass_(objc.classes.NSData),
    dataLength: bytes.length(),
    back: back instanceof Uint8Array && [...back].join(","),
    dateClass: when.isKindOfClass_(objc.classes.NSDate),
    seconds: when.timeIntervalSince1970(),
    date: objc.js(when) instanceof Date && (objc.js(when) as Date).getTime(),
    argument: (objc.js(list.lastObject()) as Date).getTime(),
    nestedDate: nested.d instanceof Date && nested.d.getTime(),
    nestedBuffer: nested.b instanceof Uint8Array && [...nested.b].join(","),
    nestedView: [...nested.v].join(","),
    empty: (objc.js(objc.ns(new Uint8Array(0))) as Uint8Array).length,
    json: JSON.stringify({ when: objc.ns(new Date(0)) }),
  });

  win.close();
  emit({ step: "done" });
});
