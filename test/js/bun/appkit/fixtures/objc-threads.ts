// The bridge on more than one thread: a Worker doing Foundation work, the
// classes it is refused, both threads sending at once with their own handle
// tables, a class name both define, and a Worker terminated mid-send whose
// blocks and class are called afterwards.
import { objc } from "bun:appkit";
import { emit, run } from "./_util";

await run(async () => {
  const { NSMutableArray, NSString, NSProcessInfo, NSThread, NSNotificationCenter } = objc.classes;
  // Read before anything else here starts a thread.
  const multiThreaded = NSThread.isMultiThreaded();

  const worker = new Worker(new URL("./_objc-threads-worker.ts", import.meta.url).href);
  const inbox: any[] = [];
  let wake: (() => void) | undefined;
  worker.onmessage = e => {
    inbox.push(e.data);
    wake?.();
  };
  worker.onerror = e => {
    throw e.error ?? e;
  };
  const next = async () => {
    while (inbox.length === 0) await new Promise<void>(resolve => (wake = resolve));
    return inbox.shift();
  };

  const { ready } = await next();
  // The Worker has defined a class of this name by now; the plain name is
  // still the main thread's.
  const Shared = objc.defineClass({
    name: "FixtureSharedName",
    methods: { "tag": { types: "q@:", fn: () => 1 } },
  }) as any;
  const target = objc.target(() => {}) as any;
  emit({
    step: "worker foundation",
    ...ready,
    multiThreaded,
    mainClass: String(Shared),
    mainTag: Shared.new().tag(),
    sameTargetClass: String(target.className()) === ready.target.className,
  });

  // Both threads send a few hundred messages at about the same time: the
  // Worker says when it has begun, and this thread starts then.
  const count = 300;
  worker.postMessage({ go: "burst", count });
  await next();
  const list = NSMutableArray.array();
  for (let i = 0; i < count; i++) list.addObject_(NSString.stringWithString_(`main ${i}`));
  let own = 0;
  for (let i = 0; i < count; i++) if (objc.js(list.objectAtIndex_(i)) === `main ${i}`) own++;
  const info = NSProcessInfo.processInfo();
  const fromWorker = await next();
  emit({
    step: "concurrent",
    main: { count: list.count(), own },
    worker: fromWorker.burst,
    processInfo: {
      mainSame: info === NSProcessInfo.processInfo(),
      workerSame: fromWorker.processInfo.same,
      sameObject: String(info[objc.pointer]) === fromWorker.processInfo.address,
    },
    subclass: fromWorker.subclass,
  });
  worker.terminate();

  // A Worker terminated while it is sending, holding handles, blocks and a
  // defined class: the process carries on.
  const busy = new Worker(new URL("./_objc-threads-busy.ts", import.meta.url).href);
  const { counterClass } = await new Promise<any>((resolve, reject) => {
    busy.onmessage = e => resolve(e.data);
    busy.onerror = e => reject(e.error ?? e);
  });
  const closed = new Promise<void>(resolve => busy.addEventListener("close", () => resolve()));
  busy.terminate();
  await closed;
  // The Worker's blocks and class are still registered; their functions have
  // no thread to run on any more, so they do nothing and answer zero, and
  // stderr says so once. The first block is called on a dispatch queue's
  // thread (posting waits for it), the second on this one.
  const center = NSNotificationCenter.defaultCenter();
  center.postNotificationName_object_("FixtureDeadQueue", null);
  center.postNotificationName_object_("FixtureDeadMain", null);
  const orphan = objc.classes[counterClass].new();
  emit({
    step: "terminated",
    after: objc.js(NSString.stringWithString_("still here")),
    mainTag: Shared.new().tag(),
    orphan: [orphan.count(), orphan.count()],
  });
});
