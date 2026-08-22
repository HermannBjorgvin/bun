// objc.block and bare functions as block arguments: Foundation calling back
// into JavaScript synchronously (enumeration, predicates, comparators) and
// from the main run loop (operation queue, timers, completion handlers).
import { objc, Window } from "bun:appkit";
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
  const {
    NSObject,
    NSMutableArray,
    NSIndexSet,
    NSPredicate,
    NSExpression,
    NSOperation,
    NSOperationQueue,
    NSRunLoop,
    NSTimer,
    NSAnimationContext,
    NSString,
  } = objc.classes;
  const list = objc.ns(["alpha", "beta", "gamma", "delta"]) as any;

  // -[NSArray enumerateObjectsUsingBlock:]: void (^)(id, NSUInteger, BOOL *stop).
  {
    const seen: unknown[] = [];
    let receiver: unknown = "unset";
    list.enumerateObjectsUsingBlock_(function (this: unknown, obj: any, idx: number, stop: { value: boolean }) {
      receiver = this;
      seen.push([objc.js(obj), idx, stop.value, list.count()]);
      if (idx === 2) stop.value = true;
    });
    emit({ step: "enumerate", seen, receiverUndefined: receiver === undefined });
  }

  // BOOL-returning blocks: indexesOfObjectsPassingTest:, indexOfObjectPassingTest:, predicateWithBlock:.
  {
    const indexes = list.indexesOfObjectsPassingTest_((_obj: unknown, idx: number) => idx % 2 === 1);
    const first = list.indexOfObjectPassingTest_((obj: any) => objc.js(obj) === "gamma");
    const none = list.indexOfObjectPassingTest_(() => false);
    const predicate = NSPredicate.predicateWithBlock_((obj: any, _bindings: unknown) => objc.js(obj) === "yes");
    emit({
      step: "passing test",
      isIndexSet: indexes.isKindOfClass_(NSIndexSet),
      count: indexes.count(),
      hasOne: indexes.containsIndex_(1),
      hasThree: indexes.containsIndex_(3),
      hasTwo: indexes.containsIndex_(2),
      first,
      none: none === objc.NSNotFound,
      yes: predicate.evaluateWithObject_("yes"),
      no: predicate.evaluateWithObject_("no"),
    });
  }

  // NSComparator (NSComparisonResult (^)(id, id)) and a dictionary enumeration.
  {
    const sorted = list.sortedArrayUsingComparator_((a: any, b: any) => {
      const [x, y] = [objc.js(a) as string, objc.js(b) as string];
      return x < y ? 1 : x > y ? -1 : 0;
    });
    const pairs: unknown[] = [];
    (objc.ns({ one: 1, two: 2 }) as any).enumerateKeysAndObjectsUsingBlock_((k: any, v: any, _stop: unknown) =>
      pairs.push([objc.js(k), objc.js(v)]),
    );
    pairs.sort();
    emit({ step: "comparator", sorted: objc.js(sorted), pairs });
  }

  // objc.block(fn, types): an explicit block, reusable, passed where any block goes.
  {
    const seen: number[] = [];
    const block = objc.block((_obj: unknown, idx: number, _stop: unknown) => seen.push(idx), "v@?@Q^B") as any;
    list.enumerateObjectsUsingBlock_(block);
    list.enumerateObjectsWithOptions_usingBlock_(2, block); // NSEnumerationReverse
    // An object-returning block, called by NSExpression (not in the known list, so types are required).
    const expression = NSExpression.expressionForBlock_arguments_(
      objc.block((obj: any, _exprs: unknown, _context: unknown) => `value:${objc.js(obj)}`, "@@?@@@"),
      [],
    );
    const defaultTypes = objc.block((_a: unknown) => {}) as any;
    emit({
      step: "explicit",
      seen,
      description: /Block/.test(String(block)),
      expression: objc.js(expression.expressionValueWithObject_context_("x", null)),
      expressionNull: objc.js(expression.expressionValueWithObject_context_(null, null)),
      defaultTypes: /Block/.test(String(defaultTypes)),
      same: objc.same(block, block),
    });
  }

  // Calling a block from JavaScript: its own signature types the call. One a
  // framework hands back (NSExpression's) calls the same way; `invoke` on
  // anything that is not a block is the selector of that name.
  {
    const compare = objc.block((a: unknown, b: unknown) => (String(a) < String(b) ? -1 : 1), "q@?@@") as any;
    const stop = objc.out(false);
    const each = objc.block((_o: unknown, i: number, s: { value: boolean }) => (s.value = i === 1), "v@?@Q^B") as any;
    const expression = NSExpression.expressionForBlock_arguments_(
      objc.block((obj: any) => `got:${objc.js(obj)}`, "@@?@@@"),
      [],
    );
    const fromFramework = expression.expressionBlock();
    const { NSInvocation } = objc.classes;
    const inv = NSInvocation.invocationWithMethodSignature_(list.methodSignatureForSelector_("count"));
    inv.setSelector_("count");
    inv.setTarget_(list);
    emit({
      step: "invoke",
      compare: [compare.invoke("a", "b"), compare.invoke("b", "a")],
      stopBefore: stop.value,
      stopAfter: (each.invoke("x", 1, stop), stop.value),
      omitted: tryCall(() => each.invoke("x", 0)),
      fromFramework: objc.js(fromFramework.invoke("z", [], null)),
      selector: (inv.invoke(), typeof inv.invoke),
      tooMany: tryCall(() => compare.invoke(1, 2, 3)),
      notBlockClass: typeof (list as any).invoke,
    });
  }

  // Blocks Foundation runs later, from the main run loop: they need the app started.
  const win = new Window({ title: "blocks", width: 200, height: 100, visible: false });
  {
    let operation = 0;
    let performed = 0;
    const timers: string[] = [];
    NSOperationQueue.mainQueue().addOperationWithBlock_(() => operation++);
    NSRunLoop.mainRunLoop().performBlock_(() => performed++);
    const timer = NSTimer.scheduledTimerWithTimeInterval_repeats_block_(0.001, false, (t: any) =>
      timers.push(String(t.className())),
    );
    const before = { operation, performed, timers: timers.length };
    await waitFor(() => operation === 1 && performed === 1 && timers.length === 1, "main run loop blocks");
    emit({ step: "run loop", before, operation, performed, timers, timerValid: timer.isValid() });
  }

  // +[NSAnimationContext runAnimationGroup:completionHandler:]: the group runs
  // now with the context, the completion handler after; a null block is nil.
  {
    const contexts: string[] = [];
    let completed = 0;
    NSAnimationContext.runAnimationGroup_completionHandler_(
      (context: any) => {
        context.setDuration_(0);
        contexts.push(String(context.className()));
      },
      () => completed++,
    );
    NSAnimationContext.runAnimationGroup_completionHandler_(
      (context: any) => contexts.push(String(context.className())),
      null,
    );
    const syncContexts = contexts.slice();
    const syncCompleted = completed;
    await waitFor(() => completed === 1, "animation completion handler");
    emit({ step: "animation", syncContexts, syncCompleted, completed });
  }

  // A throw is an uncaught error, the caller reads zero, and enumeration stops;
  // a result that does not fit the return type likewise.
  {
    let calls = 0;
    list.enumerateObjectsUsingBlock_(() => {
      calls++;
      throw new Error("thrown in block");
    });
    const matched = list.indexesOfObjectsPassingTest_((_obj: unknown, _idx: unknown, stop: { value: boolean }) => {
      stop.value = true;
      return "not a boolean";
    });
    await waitFor(() => uncaught.length >= 2, "two uncaught errors");
    emit({ step: "throws", calls, matched: matched.count(), uncaught: uncaught.slice() });
  }

  // A function that lets go of the only reference to its own block while it runs.
  {
    let calls = 0;
    const block: any = objc.block((_obj: unknown, _idx: unknown, stop: { value: boolean }) => {
      calls++;
      block.release();
      stop.value = true;
    }, "v@?@Q^B");
    list.enumerateObjectsUsingBlock_(block);
    emit({ step: "release inside", calls, released: tryCall(() => list.enumerateObjectsUsingBlock_(block)) });
  }

  // A block invoked on another thread: the function does not run there, and
  // the main thread hears about it.
  {
    let ran = 0;
    const before = uncaught.length;
    const queue = NSOperationQueue.new();
    queue.addOperationWithBlock_(() => ran++);
    queue.waitUntilAllOperationsAreFinished();
    await waitFor(() => uncaught.length > before, "the off-thread call to be reported");
    emit({ step: "off thread", ran, uncaught: uncaught.slice(before) });
  }

  // What is refused.
  attempt("unsupported types", () => objc.block(() => {}, "v@?@@@@@@"));
  attempt("no block marker", () => objc.block(() => {}, "v@:"));
  attempt("invalid types", () => objc.block(() => {}, "{{"));
  attempt("not a function", () => (objc as any).block("nope"));
  attempt("types not a string", () => (objc as any).block(() => {}, 3));
  // In the table, but of a type no function can be called through yet.
  attempt("unsupported known", () =>
    NSString.stringWithString_("a b").enumerateSubstringsInRange_options_usingBlock_(
      { location: 0, length: 3 },
      0,
      () => {},
    ),
  );
  // A framework outside the ones the table covers.
  attempt("unknown selector", () => {
    objc.classes.NSBundle.bundleWithPath_("/System/Library/Frameworks/AVFoundation.framework").load();
    const asset = objc.classes.AVURLAsset.URLAssetWithURL_options_(
      objc.classes.NSURL.fileURLWithPath_("/nonexistent"),
      null,
    );
    return asset.loadValuesAsynchronouslyForKeys_completionHandler_([], () => {});
  });
  attempt("not a block object", () => list.enumerateObjectsUsingBlock_(NSObject.new()));
  attempt("wrong block type", () =>
    list.enumerateObjectsUsingBlock_(objc.block((_a: unknown, _b: unknown) => 0, "q@?@@")),
  );
  attempt("completion block", () => NSOperation.new().setCompletionBlock_(() => {}));
  attempt("message to block", () => (objc.block(() => {}) as any).className());
  attempt("invoke non-block", () => (NSObject.new() as any).invoke());
  attempt("null block", () => list.sortedArrayUsingComparator_(null));

  // Lifetime: the block keeps its function while anything retains the block.
  {
    let collected = 0;
    const registry = new FinalizationRegistry(() => collected++);
    const holder = NSMutableArray.new();
    (() => {
      const released = () => {};
      registry.register(released, "released");
      (objc.block(released) as any).release();
      const held = () => {};
      registry.register(held, "held");
      const block = objc.block(held) as any;
      holder.addObject_(block); // Foundation retains (Block_copy) it
      block.release();
      // Released for the last time by a background queue, once its operation has run.
      const elsewhere = () => {};
      registry.register(elsewhere, "elsewhere");
      const queue = NSOperationQueue.new();
      queue.addOperationWithBlock_(elsewhere);
      queue.waitUntilAllOperationsAreFinished();
    })();
    await waitFor(
      () => {
        Bun.gc(true);
        return collected >= 2;
      },
      "the released blocks' functions to be collected",
      30_000,
    );
    // Give the collector a few more turns to show the held one stays.
    for (let i = 0; i < 5; i++) {
      Bun.gc(true);
      await new Promise(r => setImmediate(r));
    }
    const whileHeld = collected;
    holder.removeAllObjects();
    await waitFor(
      () => {
        Bun.gc(true);
        return collected >= 3;
      },
      "the held block's function to be collected after Foundation released it",
      30_000,
    );
    emit({ step: "lifetime", whileHeld, afterRemoval: collected });
  }

  win.close();
  emit({ step: "done" });
});
