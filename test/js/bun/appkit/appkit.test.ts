import { beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isMacOS, tempDir } from "harness";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const fixtures = join(import.meta.dir, "fixtures");

type FixtureResult = {
  /** One entry per JSON line the fixture printed. */
  events: Record<string, any>[];
  /** The fixture could not load the AppKit frameworks and bailed out. */
  skipped: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

async function runFixture(
  name: string,
  opts: { timeoutMs?: number; args?: string[]; expectFailure?: boolean } = {},
): Promise<FixtureResult> {
  // The bridge fixtures also run JSC's exception-scope validation where the
  // build has it, so a native glue path that leaves an exception unchecked
  // fails its test rather than only a dedicated run.
  const env = name.startsWith("objc-")
    ? { ...bunEnv, BUN_JSC_validateExceptionChecks: "1", BUN_JSC_dumpSimulatedThrows: "1" }
    : bunEnv;
  await using proc = Bun.spawn({
    cmd: [bunExe(), join(fixtures, name), ...(opts.args ?? [])],
    env,
    cwd: fixtures,
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 10_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const lines = stdout.split("\n").filter(Boolean);
  const skipped = lines.includes("SKIP no-window-server");
  if (skipped) {
    console.warn(`${name}: AppKit could not be loaded here, assertions skipped`);
    expect(exitCode).toBe(0);
  } else if (exitCode !== 0 && !opts.expectFailure) {
    // Surface the fixture's own error ahead of the assertion that is about to fail.
    console.error(`${name} exited with ${exitCode ?? proc.signalCode}\n${stderr}`);
  }
  const events = lines.filter(l => l.startsWith("{")).map(l => JSON.parse(l));
  return { events, skipped, stdout, stderr, exitCode, signal: proc.signalCode };
}

const step = (r: FixtureResult, name: string) => r.events.find(e => e.step === name);

test.skipIf(isMacOS)("off macOS bun:appkit is not a builtin and Bun.AppKit is absent", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const { isBuiltin, builtinModules } = require("node:module");
       const id = "bun:appkit";
       const importError = await import(id).then(() => null, e => e);
       let resolveError = null;
       try { require.resolve(id); } catch (e) { resolveError = e; }
       console.log(JSON.stringify({
         importError: importError && { name: importError.constructor.name, code: importError.code },
         resolveError: resolveError && resolveError.code,
         getBuiltinModule: typeof process.getBuiltinModule(id),
         isBuiltin: isBuiltin(id),
         listed: builtinModules.includes(id),
         hasKey: "AppKit" in Bun,
         type: typeof Bun.AppKit,
       }));`,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stdout.trim(), stderr).toStartWith("{");
  expect(JSON.parse(stdout.trim())).toEqual({
    importError: { name: "ResolveMessage", code: "ERR_MODULE_NOT_FOUND" },
    resolveError: "MODULE_NOT_FOUND",
    getBuiltinModule: "undefined",
    isBuiltin: false,
    listed: false,
    hasKey: false,
    type: "undefined",
  });
  expect(exitCode).toBe(0);
});

describe.skipIf(!isMacOS)("Bun.AppKit", () => {
  // Which arms of the display / GPU forks this run exercises: headless CI
  // agents and a logged-in desktop take different paths in app start, the
  // window class and MetalView, so the log should say which one ran.
  beforeAll(async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { app, gpu } = require("bun:appkit");
         const { release, arch } = require("node:os");
         console.log(JSON.stringify({ hasDisplay: app.hasDisplay, gpu: gpu.available, darwin: release(), arch: arch(), agent: process.env.BUILDKITE_AGENT_NAME ?? null }));`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "inherit",
    });
    const [stdout] = await Promise.all([proc.stdout.text(), proc.exited]);
    console.warn(`bun:appkit test mode: ${stdout.trim()}`);
  });

  test.concurrent(
    "every Objective-C binding and delegate method compiled in matches the frameworks on this machine",
    async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `require("bun:appkit");
           const { appKitInternals } = require("bun:internal-for-testing");
           console.log(JSON.stringify(appKitInternals.verifyBindings()));`,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      // One line per selector missing on this macOS, wrong integer width, BOOL or struct layout.
      expect(JSON.parse(stdout.trim() || "null"), stderr).toEqual([]);
      expect(exitCode).toBe(0);
    },
  );

  test.concurrent("Bun.AppKit is the bun:appkit namespace", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const ns = await import("bun:appkit");
         console.log(JSON.stringify({ same: Bun.AppKit.Window === ns.Window && Bun.AppKit.app === ns.app, keys: ["app","Window","VStack","Text","Button","TextField","Table","MetalView","gpu","objc"].map(k => typeof ns[k]) }));`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim(), stderr).toStartWith("{");
    expect(JSON.parse(stdout.trim())).toEqual({
      same: true,
      keys: [
        "object",
        "function",
        "function",
        "function",
        "function",
        "function",
        "function",
        "function",
        "object",
        "object",
      ],
    });
    expect(exitCode).toBe(0);
  });

  // bun test --isolate (which --parallel implies) gives every file a fresh
  // global object on the same thread; each loads bun:appkit anew and the
  // bridge follows it there instead of staying with the first.
  test.concurrent("every file under bun test --isolate can load bun:appkit", async () => {
    const file = `import { expect, test } from "bun:test";
      import { objc } from "bun:appkit";
      test("bridge", () => {
        expect(typeof Bun.AppKit).toBe("object");
        expect(Bun.AppKit.objc).toBe(objc);
        const text = objc.classes.NSString.stringWithString_("isolated");
        expect(String(text)).toBe("isolated");
        expect(objc.js(text)).toBe("isolated");
        const seen: unknown[] = [];
        objc.classes.NSArray.arrayWithArray_(["a", "b"]).enumerateObjectsUsingBlock_((item: unknown) => { seen.push(objc.js(item)); });
        expect(seen).toEqual(["a", "b"]);
        const Counter = objc.defineClass({ methods: { "twice:": { types: "q@:q", fn: (n: number) => n * 2 } } });
        const counter = Counter.new();
        expect(counter.twice_(21)).toBe(42);
      });`;
    using dir = tempDir("appkit-isolate", { "a.test.ts": file, "b.test.ts": file, "c.test.ts": file });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--isolate", "a.test.ts", "b.test.ts", "c.test.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const output = stdout + stderr;
    expect(output).not.toContain("error:");
    expect(output).toMatch(/\b3 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
    expect(exitCode).toBe(0);
  });

  // The counts docs/runtime/appkit.mdx quotes that come from this tree (not
  // from the installed SDK) are the tree's.
  test("the numbers in the documentation are the tree's", async () => {
    const root = join(import.meta.dir, "../../../..");
    const { treeCounts } = await import(join(root, "scripts/appkit-tree-counts.ts"));
    const counts = treeCounts(root);
    const docs = readFileSync(join(root, "docs/runtime/appkit.mdx"), "utf8");
    const paragraph = docs.split("\n").find(line => line.includes("In numbers:")) ?? "";
    expect(paragraph).toContain(`the ${counts.elements.length} curated elements`);
    expect(paragraph).toContain(`made of ${counts.bridgedClasses.length} AppKit and Foundation classes`);
    expect(paragraph).toContain(`${counts.enumTypes} enumerations with ${counts.enumMembers} members`);
    expect(paragraph).toContain(`${counts.looseConstants} loose constants`);
    expect(paragraph).toContain(
      `${counts.boundClasses} classes and ${counts.boundSelectors} selectors of typed bindings`,
    );
  });

  test.concurrent("reading app (including by reflection) never starts the application", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const { app } = require("bun:appkit");
         const copy = { ...app };
         JSON.stringify(app);
         console.log(JSON.stringify({
           hasDisplay: typeof app.hasDisplay,
           isDark: app.isDark,
           name: app.name,
           renamed: (app.name = "Tool", app.name),
           reset: (app.name = null, app.name),
           badge: (app.badge = 3, app.badge),
           copied: typeof copy.hasDisplay,
           liveViews: "liveViews" in app,
           dunder: Object.keys(require("bun:appkit")).filter(k => k.startsWith("__")),
           running: app.isRunning,
         }));`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (stderr.includes("ERR_APPKIT_UNAVAILABLE")) return;
    expect(stdout.trim(), stderr).toStartWith("{");
    const name = basename(bunExe());
    expect(JSON.parse(stdout.trim())).toEqual({
      hasDisplay: "boolean",
      isDark: false,
      name,
      renamed: "Tool",
      reset: name,
      badge: "3",
      copied: "boolean",
      liveViews: false,
      dunder: [],
      running: false,
    });
    expect(exitCode).toBe(0);
  });

  test.concurrent(
    "the runtime surface matches appkit.d.ts and unset props read as their documented defaults",
    async () => {
      const r = await runFixture("surface.ts");
      if (r.skipped) return;
      const surface = step(r, "surface");
      expect(surface, r.stderr).toBeDefined();
      const declared = declaredSurface();
      // Every accessor and method on a class's prototype chain is declared, and back.
      for (const [name, { members }] of Object.entries<{ members: Record<string, string> }>(surface.classes)) {
        const want = declared.classes[name];
        expect(want, `class ${name} is exported at runtime but not declared`).toBeDefined();
        expect({ class: name, members: Object.keys(members).sort() }).toEqual({
          class: name,
          members: [...want.members].sort(),
        });
      }
      for (const name of Object.keys(declared.classes)) {
        if (declared.classes[name].isView || name === "Window") expect(surface.classes[name], name).toBeDefined();
      }
      expect(Object.keys(surface.app).sort()).toEqual([...declared.app].sort());
      expect(surface.namespace.filter((k: string) => k !== "default").sort()).toEqual([...declared.exports].sort());
      // Getters of unset props answer the @default written in the .d.ts.
      const mismatches: string[] = [];
      let compared = 0;
      for (const [name, { defaults }] of Object.entries<{ defaults: Record<string, unknown> }>(surface.classes)) {
        const documented = declared.classes[name]?.defaults ?? {};
        for (const [prop, want] of Object.entries(documented)) {
          if (!(prop in defaults)) continue;
          compared++;
          if (!Bun.deepEquals(defaults[prop], want)) {
            mismatches.push(
              `${name}.${prop}: runtime ${JSON.stringify(defaults[prop])}, d.ts @default ${JSON.stringify(want)}`,
            );
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(compared).toBeGreaterThan(60);
      expect(surface.reset).toEqual({ lineLimit: 1, spacing: 8 });
      expect(surface.instanceOf).toEqual({ secureField: true, searchField: true, textFieldIsSecure: false });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("window + views: props round-trip, layout gives frames, closing the last window exits", async () => {
    const r = await runFixture("window-views.ts");
    if (r.skipped) return;
    expect(step(r, "props")).toEqual({
      step: "props",
      text: "World",
      tooltip: "tip",
      buttonTitle: "Go",
      buttonEnabled: false,
      fieldValue: "typed",
      sliderValue: 7.5,
      windowTitle: "retitled",
      children: 4,
      parentIsStack: true,
      windowOfText: true,
      windows: 1,
      visible: true,
    });
    const layout = step(r, "layout");
    expect(layout).toBeDefined();
    expect(layout.button.width).toBeGreaterThan(0);
    expect(layout.button.height).toBeGreaterThan(0);
    expect(layout.text.height).toBeGreaterThan(0);
    // A hugging child (the button) must not pull the window in from the size it was given.
    expect(layout.window).toEqual([300, 200]);
    expect(layout.text.width).toBeGreaterThan(layout.button.width);
    // grow back to 0/null, or leaving a SplitView, must lay out exactly as if neither ever applied.
    const restored = step(r, "priorities restored");
    expect(restored, r.stderr).toBeDefined();
    expect(restored.text[0]).toBeGreaterThan(restored.button[0]);
    // A vertical divider stretches to the 48pt row; a collapsed one is a dot.
    expect(restored.divider[0]).toBeGreaterThanOrEqual(48);
    expect(restored).toEqual({
      step: "priorities restored",
      text: [restored.text[0], restored.text[0], restored.text[0]],
      button: [restored.button[0], restored.button[0]],
      divider: [restored.divider[0], restored.divider[0], restored.divider[0]],
    });
    const split = step(r, "split spacer");
    expect(split, r.stderr).toBeDefined();
    expect(split.spacer).toBeGreaterThanOrEqual(300);
    expect(split.split).toBeGreaterThanOrEqual(300);
    expect(step(r, "split spacer turned").spacer.height).toBeGreaterThanOrEqual(300);
    expect(step(r, "zstack order")).toEqual({
      step: "zstack order",
      children: ["red", "blue"],
      reorderChangesPixels: true,
      restoredMatchesOriginal: true,
    });
    expect(step(r, "onClose")).toBeDefined();
    expect(step(r, "closed")).toEqual({ step: "closed", closed: true, windows: 0 });
    expect(step(r, "unexpected-timer")).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "layout: frames are current, groups wrap children, windows keep their limits, grow shares space",
    async () => {
      const r = await runFixture("layout.ts");
      if (r.skipped) return;
      // `frame` lays out first: a child appended a moment ago has a size, and a longer text is wider at once.
      const frame = step(r, "frame");
      expect(frame, r.stderr).toBeDefined();
      expect(frame.detached).toEqual({ x: 0, y: 0, width: 0, height: 0 });
      expect(frame.appended).toBeGreaterThan(10);
      expect(frame.grown).toBeGreaterThan(frame.appended);
      // Content taller than the window grew it; the onResize that caused ran
      // after the getter returned, once, and could read frames itself.
      expect(frame.height).toBeGreaterThan(300);
      expect(frame.events).toEqual(["appended", "resize", "nested:true", "read"]);
      // A Group is as tall as its two stacked buttons plus padding (and title), no more, and spans the stack.
      const group = step(r, "group");
      expect(group.a.height).toBeGreaterThan(0);
      expect(group.bare.height).toBeGreaterThan(group.a.height + group.b.height);
      expect(group.bare.height).toBeLessThan(120);
      expect(group.titled.height).toBeGreaterThan(group.bare.height);
      expect(group.titled.height).toBeLessThan(150);
      expect(Math.abs(group.a.y - group.b.y)).toBeGreaterThanOrEqual(group.b.height);
      expect(group.titled.width).toBe(group.stack.width);
      // Long titles truncate; the 300pt window stays 300pt.
      expect(step(r, "long labels")).toEqual({
        step: "long labels",
        widths: { button: 300, checkbox: 300, picker: 300, segmented: 300, text: 300, row: 300 },
      });
      expect(step(r, "tall content")).toEqual({
        step: "tall content",
        grown: [300, 500],
        kept: [300, 120],
        cappedSize: [400, 200, 400],
        setPastMax: 400,
        afterLowerMax: 350,
      });
      expect(step(r, "min max")).toEqual({
        step: "min max",
        minOverMax: 200,
        maxThenMin: 200,
        widthUnderMin: 100,
        widthOverMax: 120,
        maxCleared: 300,
      });
      const grow = step(r, "grow");
      expect(Math.abs(grow.centred.left - grow.centred.right)).toBeLessThanOrEqual(1);
      expect(grow.centred.left).toBeGreaterThan(50);
      expect(Math.abs(grow.centred.labelMid - grow.centred.rowWidth / 2)).toBeLessThanOrEqual(1);
      expect(grow.ratio.one).toBeGreaterThan(50);
      expect(Math.abs(grow.ratio.two - 2 * grow.ratio.one)).toBeLessThanOrEqual(2);
      expect(Math.round(grow.ratio.one + grow.ratio.two + grow.ratio.fixed)).toBe(340);
      expect(Math.abs(grow.nested.equal[0] - grow.nested.equal[1])).toBeLessThanOrEqual(1);
      expect(Math.round(grow.nested.equal[0] + grow.nested.equal[1])).toBe(300);
      expect(Math.abs(grow.nested.reweighted[1] - 2 * grow.nested.reweighted[0])).toBeLessThanOrEqual(2);
      expect(grow.nested.hidden).toBe(300);
      expect(Math.abs(grow.nested.restored[0] - grow.nested.restored[1])).toBeLessThanOrEqual(1);
      // Both labels span the 320pt column; hiding and showing one leaves it spanning again.
      const fill = step(r, "fill hidden");
      expect(fill.shown).toEqual([fill.shown[0], fill.shown[0]]);
      expect(fill.shown[0]).toBeGreaterThanOrEqual(320);
      expect(fill.whileHidden).toBe(fill.shown[0]);
      expect(fill.reshown).toEqual(fill.shown);
      expect(fill.constraints[1]).toBe(fill.constraints[0]);
      // The growing pane takes the 200pt the window gained; the other keeps its width.
      const split = step(r, "split grow");
      expect(split.after[1] - split.before[1]).toBeGreaterThanOrEqual(190);
      expect(Math.abs(split.after[0] - split.before[0])).toBeLessThanOrEqual(10);
      // Vertical in the 48pt row unless told otherwise, horizontal again once moved to the column.
      const divider = step(r, "divider");
      expect(divider.inRow.auto.height).toBeGreaterThanOrEqual(48);
      expect(divider.inRow.auto.width).toBeLessThan(10);
      expect(divider.inRow.flat.height).toBeLessThan(10);
      expect(divider.inColumn.height).toBeLessThan(10);
      expect(divider.inColumn.width).toBeGreaterThan(48);
      expect(step(r, "progress order")).toEqual({ step: "progress order", sameAsMaxFirst: true, sameAsHalf: false });
      expect(step(r, "click").message).toContain("click()");
      expect(step(r, "done")).toBeDefined();
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "event loop: timers, fetch, Worker and spawn keep working while a window is open; idle costs no CPU and a cross-thread wake is prompt",
    async () => {
      const r = await runFixture("event-loop.ts");
      if (r.skipped) return;
      const timer = step(r, "timer");
      expect(timer, r.stderr).toBeDefined();
      expect(timer.elapsed).toBeGreaterThanOrEqual(19);
      expect(timer.elapsed).toBeLessThan(150);
      // Parked in AppKit for ~500 ms with nothing to do: a busy loop would burn most of that.
      const idle = step(r, "idle");
      expect(idle.wallMs).toBeGreaterThanOrEqual(490);
      expect(idle.cpuMs).toBeLessThan(idle.wallMs * (isDebug || isASAN ? 0.5 : 0.25));
      // Twenty postMessage round trips with no timer or server pending on the main thread;
      // a lost wake would sit until the fixture is killed.
      const worker = step(r, "worker");
      expect(worker).toEqual({ step: "worker", message: "pong", rounds: 20, worstMs: expect.any(Number) });
      expect(worker.worstMs).toBeLessThan(isDebug || isASAN ? 1000 : 250);
      expect(step(r, "fetch")).toEqual({ step: "fetch", body: "served", status: 200 });
      expect(step(r, "spawn")).toEqual({ step: "spawn", stdout: "child", exitCode: 0 });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "event loop: timers armed by JavaScript that AppKit runs inside its wait fire on time; a synchronous wait there is serviced",
    async () => {
      const r = await runFixture("wait.ts");
      if (r.skipped) return;
      const inside = step(r, "inside-wait");
      expect(inside, r.stderr).toMatchObject({ step: "inside-wait", immediate: true });
      expect(inside.timerMs).toBeLessThan(isDebug || isASAN ? 1000 : 250);
      expect(step(r, "sync-wait")).toEqual({ step: "sync-wait", before: 0, during0: 1, resolved: 1, after: 1 });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("Radio: siblings in one container act as a group; separate containers do not", async () => {
    const r = await runFixture("radio.ts");
    if (r.skipped) return;
    expect(step(r, "set A"), r.stderr).toEqual({ step: "set A", a: true, b: false, c: false, events: [] });
    // AppKit clears A itself; only the clicked radio reports a change.
    expect(step(r, "click B")).toEqual({ step: "click B", a: false, b: true, c: false, events: ["B:true"] });
    expect(step(r, "set C")).toEqual({ step: "set C", a: false, b: false, c: true, events: [] });
    expect(step(r, "separate containers")).toEqual({
      step: "separate containers",
      x: true,
      y: true,
      events: ["Y:true"],
    });
    expect(r.exitCode).toBe(0);
  });

  test.concurrent("Button.click() fires onClick exactly once and the window snapshots as PNG", async () => {
    const r = await runFixture("button-click.ts");
    if (r.skipped) return;
    expect(step(r, "clicked")).toEqual({ step: "clicked", count: 1, text: "Count: 1" });
    expect(step(r, "cleared")).toEqual({ step: "cleared", count: 1 });
    const snap = step(r, "snapshot");
    expect(snap.isPng).toBe(true);
    expect(snap.windowBytes).toBeGreaterThan(100);
    expect(snap.viewBytes).toBeGreaterThan(0);
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "Button, Checkbox, Radio and Switch are bridge-built NSButtons: live getters, every NSBezelStyle, target/action events, placed in containers and windows",
    async () => {
      const r = await runFixture("controls.ts");
      if (r.skipped) return;
      expect(step(r, "live"), r.stderr).toEqual({
        step: "live",
        same: true,
        isButton: true,
        isSwitch: true,
        title: "Native",
        enabled: false,
        checked: true,
        hostedIn: "NSStackView",
        defaults: {
          bezelStyle: "push",
          bordered: true,
          hasDestructiveAction: false,
          keyEquivalent: null,
          switchEnabled: true,
        },
      });
      const bezel = step(r, "bezelStyle");
      expect(bezel.styles).toEqual({
        toolbar: ["toolbar", 11],
        accessoryBarAction: ["accessoryBarAction", 12],
        NSBezelStyleFlexiblePush: ["flexiblePush", 2],
        // A deprecated alias reads back as the current name for its value.
        texturedRounded: ["toolbar", 11],
        badge: ["badge", 15],
        number: "circular",
        // NSThickSquareBezelStyle: still accepted by AppKit, absent from the current header.
        unnamed: 3,
        unnamedRoundTrip: 3,
        reset: "push",
      });
      expect(bezel.bogus).toMatchObject({ isTypeError: true, code: "ERR_INVALID_ARG_TYPE" });
      expect(bezel.negative).toMatchObject({ isTypeError: true, code: "ERR_INVALID_ARG_TYPE" });
      expect(bezel.bogus.message).toStartWith(
        'Button.bezelStyle must be an NSBezelStyle name ("automatic", "push", "flexiblePush"',
      );
      expect(bezel.bogus.message).not.toContain('"NSBezelStylePush"');
      expect(step(r, "roles")).toEqual({
        step: "roles",
        roles: { keyEquivalent: ["\r", "\r"], bordered: [false, false], hasDestructiveAction: [true, true] },
        after: [null, true, false],
      });
      const kept = step(r, "kept");
      expect(kept).toEqual({
        step: "kept",
        hasImage: true,
        // NSImageOnly with an empty title, NSImageLeft beside one (also for an image set through .native).
        imagePositions: [1, 2, 2],
        pointSize: 18,
        boldTrait: true,
        tinted: true,
        reads: { symbol: "star.fill", font: { size: 18, weight: "bold", design: "rounded" }, tint: "red" },
        cleared: { image: null, position: 0, pointSize: true, tint: null },
        badSymbol: {
          message: 'Button.symbol: no system symbol named "no.such.symbol.anywhere"',
          code: "ERR_INVALID_ARG_VALUE",
          isTypeError: true,
        },
        badFont: {
          message: "Button.font.size must be a positive number or null",
          code: "ERR_INVALID_ARG_TYPE",
          isTypeError: true,
        },
        badTint: {
          message: 'Button.tint: invalid color "rgb(nan,0,0)"',
          code: "ERR_INVALID_ARG_VALUE",
          isTypeError: true,
        },
        badTitle: { message: "Button.title must be a string or null", code: "ERR_INVALID_ARG_TYPE", isTypeError: true },
      });
      const events = step(r, "events");
      expect(events).toEqual({
        step: "events",
        // Each handler ran inside its click, before click() returned.
        log: ["click:true", "after button.click()", "check:true", "switch:true", "after throwing click"],
        // Both throwing clicks (click() and a performClick: sent by hand) were reported, not swallowed or rethrown.
        uncaught: ["from onClick", "from onClick"],
        target: true,
        action: "action:",
        respondsToAction: true,
        states: { check: true, toggle: true },
        notClickable: {
          message: "click() only applies to a Button, Checkbox, Radio or Switch",
          code: undefined,
          isTypeError: true,
        },
      });
      const native = step(r, "native");
      expect(native).toEqual({
        step: "native",
        same: true,
        usable: "read",
        outsider: native.outsider,
        outsiderSymbol: native.outsider,
        // No view kinds by name: a subclass outside the module cannot construct one at all.
        unknownKind: native.outsider,
      });
      expect(native.outsider).toMatchObject({ isTypeError: true });
      expect(native.outsider.message).toStartWith("View is abstract");
      expect(step(r, "hosting")).toEqual({
        step: "hosting",
        soloFrame: true,
        laidOut: [true, true, true],
        pinned: [true, 3],
        created: 40,
        after: 0,
        collected: ["button with onClick"],
      });
      // Collecting the View objects leaves their NSViews in the superview and runs none of its methods.
      expect(step(r, "script superview")).toEqual({
        step: "script superview",
        under: 22,
        kept: 22,
        movesBefore: 0,
        left: 0,
        moves: 22,
        uncaught: [],
      });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "VStack, HStack, ZStack, Group, ScrollView and SplitView are bridge-built: children are subviews, props read the view, the common props are the child's NSView",
    async () => {
      const r = await runFixture("containers.ts");
      if (r.skipped) return;
      const badType = { code: "ERR_INVALID_ARG_TYPE" };
      expect(step(r, "stack"), r.stderr).toEqual({
        step: "stack",
        isStack: true,
        arranged: 2,
        sameChild: true,
        superview: true,
        spacing: 5,
        // Apple's names (short or full), the curated "gravity", or the number; reads back the short name.
        distributions: [
          ["fillEqually", 1],
          ["gravity", -1],
          ["gravity", -1],
          ["equalSpacing", 3],
          ["fillProportionally", 2],
          ["gravity", -1],
          ["gravity", -1],
        ],
        reset: true,
        vertical: true,
        alignments: ["fill", true, "lastBaseline", true],
        insets: { top: 2, left: 6, bottom: 2, right: 6 },
        // `padding` reads `-edgeInsets`, however it was given or set.
        padding: [
          { top: 2, left: 6, bottom: 2, right: 6 },
          { top: 1, left: 2, bottom: 1, right: 2 },
          { top: 0, left: 0, bottom: 0, right: 0 },
          { top: 1, left: 2, bottom: 3, right: 4 },
        ],
        // Curated names map to the axis's attribute ("bottom" is trailing in a column); any
        // NSLayoutAttribute name or number is taken as is and reads back by its own name.
        aligned: [
          ["center", 9],
          ["trailing", 6],
          ["trailing", 6],
          ["center", 9],
          ["trailing", 6],
          // NSStackView resolves leading/trailing to left/right from here on; they read back the same.
          ["trailing", 2],
          ["center", 9],
          ["fill", 1],
        ],
        badDistribution: {
          message: expect.stringContaining("VStack.distribution must be an NSStackViewDistribution name"),
          ...badType,
        },
        badNegative: {
          message: expect.stringContaining("VStack.distribution must be an NSStackViewDistribution name"),
          ...badType,
        },
        badPadding: { message: "HStack.padding array form is [vertical, horizontal]", ...badType },
        badAlign: { message: expect.stringContaining('HStack.align must be "fill", "leading"'), ...badType },
        badBaseline: {
          message: "firstBaseline/lastBaseline alignment only applies to a horizontal stack",
          code: "ERR_INVALID_ARG_VALUE",
        },
      });
      // width/minHeight are two constraints on the label; clearing width leaves one.
      expect(step(r, "common")).toEqual({
        step: "common",
        tooltip: "from native",
        hidden: true,
        id: "the-label",
        alpha: 0.5,
        constraints: [2, 1],
        reads: [null, 30, null],
        corner: [4, 4],
        background: true,
        autoresizing: false,
      });
      // A bridge TypeError naming the layer's class (NSViewBackingLayer here) and what was passed.
      const notCGColor = (got: RegExp) => ({
        message: expect.stringMatching(
          new RegExp(
            `^-\\[\\w+ setBackgroundColor:\\]: argument 0 must be a CGColor \\(\\^\\{CGColor=\\}\\), got ${got.source}$`,
          ),
        ),
      });
      expect(step(r, "counts")).toEqual({
        step: "counts",
        layer: true,
        constraint: true,
        labelColor: true,
        nsapp: true,
        stackUsable: true,
      });
      expect(step(r, "cgcolor")).toEqual({
        step: "cgcolor",
        cleared: null,
        string: notCGColor(/a string/),
        number: notCGColor(/a number/),
        array: notCGColor(/an array/),
        nscolor: notCGColor(/an? \w*Color/),
        colorSpace: notCGColor(/an? \w+/),
        set: true,
        roundTrip: true,
      });
      expect(step(r, "kinds")).toEqual({
        step: "kinds",
        group: {
          isBox: true,
          title: "Renamed",
          titlePositions: [2, 0, "", 3, 0, 2],
          innerStack: true,
          inContent: true,
        },
        zstack: { className: "NSView", order: [true, true], reordered: true },
        scroll: {
          isScrollView: true,
          document: true,
          clip: [true, true],
          scrollBars: { horizontal: true, vertical: true },
          second: { message: expect.stringContaining("ScrollView takes a single child"), code: "ERR_INVALID_STATE" },
          badBars: {
            message: 'ScrollView.scrollBars must be "none", "horizontal", "vertical" or "both", got "sideways"',
            ...badType,
          },
        },
        split: { isSplitView: true, vertical: true, panes: 2 },
      });
      expect(step(r, "collected")).toEqual({ step: "collected", created: 180, after: 0 });
      expect(step(r, "window")).toEqual({ step: "window", inFirst: true, detached: true, inSecond: true });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "Window is a bridge-built NSWindow: options are live properties, events are its NSWindowDelegate, closed windows are collected",
    async () => {
      const r = await runFixture("windows.ts");
      if (r.skipped) return;
      expect(step(r, "delegate"), r.stderr).toEqual({
        step: "delegate",
        isWindow: true,
        sameHandle: true,
        conforms: true,
        responds: [true, true, true, true],
        // win.width/x/center() are the program's own and not reported; the same
        // changes through .native are, then performClose: asks shouldClose (which
        // refuses), and key-window changes arrive as onFocus/onBlur.
        events: ["resize 320x120", "move 30,40", "shouldClose", "focus", "blur"],
        closedAfterRefusal: false,
        width: 320,
        x: 30,
        y: 40,
      });
      expect(step(r, "live")).toEqual({
        step: "live",
        title: "renamed",
        titleAgain: "again",
        initialBits: { resizable: true, closable: true, minimizable: true, fullSizeContent: false },
        flippedBits: { resizable: false, closable: false, minimizable: false, fullSizeContent: true },
        flippedProps: { resizable: false, closable: false, minimizable: false, fullSizeContent: true },
        fullScreenOff: false,
        resizableViaNative: true,
        fullScreenOn: true,
        titleHidden: [true, true],
        titlebarTransparent: [true, true],
        alphaClamped: 1,
        alphaViaNative: 0.5,
        backgroundSet: true,
        backgroundReset: "windowBackground",
        visible: [true, true],
      });
      expect(step(r, "restoreName")).toEqual({
        step: "restoreName",
        named: ["bun-appkit-windows-test", "bun-appkit-windows-test"],
        cleared: [null, ""],
        afterClose: "",
      });
      // minWidth 400 widened the 320pt window, maxHeight 90 shortened it; neither was reported.
      // The container holds the content's 5 pins and the 2 limits.
      expect(step(r, "limits")).toEqual({
        step: "limits",
        read: [400, 90, null],
        size: [400, 90],
        contentMin: 400,
        contentMax: 90,
        containerConstraints: 7,
        contentSuperviewIsContainer: true,
        resizeEvents: [],
      });
      expect(step(r, "closed")).toEqual({
        step: "closed",
        events: ["close"],
        closed: true,
        visible: false,
        key: false,
        contentWindow: true,
        superviewGone: true,
        nativeStillAnswers: "again",
        windows: 1,
      });
      expect(step(r, "native after close")).toEqual({ step: "native after close", same: true, frame: "number" });
      expect(step(r, "limits live")).toEqual({
        step: "limits live",
        // [minWidth, maxWidth, maxHeight, container constraint constants]
        initial: [null, 300, 150, [150, 300]],
        // minWidth 400 > maxWidth 300: the maximum is raised to it everywhere and the window widened.
        raised: [400, 400, 400, 400, [150, 400, 400]],
        // Clearing the minimum lets the maximum given (300) apply again.
        restored: [null, 300, 300, [150, 300]],
        // A limit set through .native reads back; assigning one axis keeps the other's.
        viaNative: [70, null],
        otherAxisKept: [70, 70, 250],
        // A maximum of 0 is a limit, not "none".
        zeroMax: [0, 0],
      });
      expect(step(r, "orphaned delegate")).toEqual({
        step: "orphaned delegate",
        gone: true,
        verdict: true,
        threw: false,
      });
      expect(step(r, "collected")).toEqual({ step: "collected", made: 40, collected: 20, nativesLeft: 0, windows: 0 });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "Text, TextField, Slider, Picker, Segmented, Progress, Image, Divider and Spacer are bridge-built: live getters, Apple's enum names, delegate and target/action events, axis-following layout",
    async () => {
      const r = await runFixture("leaves.ts");
      if (r.skipped) return;
      const badType = { code: "ERR_INVALID_ARG_TYPE", isTypeError: true };
      const badValue = { code: "ERR_INVALID_ARG_VALUE", isTypeError: true };
      expect(step(r, "text"), r.stderr).toEqual({
        step: "text",
        isTextField: true,
        editable: false,
        text: "Native",
        // Every NSTextAlignment member by short or full name or number; reads back the short name.
        align: {
          center: ["center", true],
          right: ["right", true],
          justified: ["justified", true],
          left: ["left", true],
          NSTextAlignmentCenter: ["center", true],
          number: "right",
          reset: "natural",
        },
        // lineLimit n>1 is word wrapping plus truncatesLastVisibleLine; 0 wraps without limit.
        wrapped: [3, 3, true],
        unlimited: [0, false, "0"],
        pointSize: 20,
        colored: true,
        selectable: [true, true],
        defaults: { text: "", font: null, color: null, textAlign: "natural", selectable: false, lineLimit: 1 },
        cleared: { label: true, pointSize: true },
        badAlign: {
          message:
            'Text.textAlign must be an NSTextAlignment name ("left", "center", "right", "justified" or "natural") or value',
          ...badType,
        },
        badLines: { message: "Text.lineLimit must be a non-negative integer or null", ...badType },
        negativeLines: { message: "Text.lineLimit must be a non-negative integer or null", ...badType },
        fractionalLines: { message: "Text.lineLimit must be a non-negative integer or null", ...badType },
        shorthand: "short",
      });
      expect(step(r, "field")).toEqual({
        step: "field",
        classes: [true, true, true],
        searchWhole: true,
        bezeled: [true, true],
        placeholder: "native",
        value: "from code",
        sameDelegate: true,
        delegateClassShared: true,
        conforms: true,
        action: "action:",
        // Begin/Change/action/End through the delegate and target; the value
        // setter fires nothing; continuous:false reports once at end or Return,
        // and not at all for an edit that code replaced.
        log: [
          "focus",
          ["change", "ab"],
          ["change", "abc"],
          ["submit", "abc"],
          "blur",
          ["quiet", "q2"],
          ["quiet", "q3"],
        ],
        live: [false, false],
        defaults: {
          value: "",
          placeholder: null,
          editable: true,
          enabled: true,
          font: null,
          textAlign: "natural",
          continuous: true,
        },
        badValue: { message: "TextField.value must be a string or null", ...badType },
      });
      // Editing a setter ends is delivered as the setter returns (pending change first), the
      // handler sees settled state and may change the view; its throw is reported.
      expect(step(r, "held")).toEqual({
        step: "held",
        log: ["change:pending", "blur hidden=true children=2", "hidden set"],
        uncaught: ["from onBlur"],
        tooltip: "set from onBlur",
        spacing: 2,
      });
      // The field's blur and the window's close arrive from two places (the
      // field's delegate, the window's) and are delivered in that order.
      expect(step(r, "close while editing")).toEqual({
        step: "close while editing",
        log: ["blur inWindow=true listed=true", "close inWindow=false listed=false", "closed"],
      });
      expect(step(r, "default button")).toEqual({
        step: "default button",
        withoutKey: [],
        withKey: ["default"],
        eventType: "number",
        withSubmit: ["submit:typed"],
        cell: true,
      });
      expect(step(r, "slider")).toEqual({
        step: "slider",
        isSlider: true,
        snappedValue: 6,
        dragged: [8, 8],
        log: [8, 4.4],
        ticks: 6,
        unevenTicks: 0,
        live: [0, 9, 9, false, false],
        enabled: [false, false],
        defaults: { value: 0, min: 0, max: 1, step: 0, continuous: true, enabled: true },
        badStep: { message: "Slider.step must be a positive number or null", ...badType },
        badValue: { message: "Slider.value must be a number or null", ...badType },
      });
      expect(step(r, "choices")).toEqual({
        step: "choices",
        nativeItems: { picker: [["a", "b", "c"], 2], segmented: ["p", "q"], none: [] },
        classes: [true, true],
        pullsDown: false,
        log: [
          ["picker", 2],
          ["segmented", 1],
        ],
        after: [0, 0],
        titles: ["A,B,C", "y"],
        enabled: [false, false, true],
        badItems: { message: "Picker.items[0] must be a string", ...badType },
      });
      expect(step(r, "progress")).toEqual({
        step: "progress",
        isProgress: true,
        bar: [150, 150, false, false],
        spinning: [true, true, true, true],
        running: false,
        keptSize: true,
        back: [true, false],
        defaults: { value: 0, min: 0, max: 100, indeterminate: false, running: true, spinner: false },
      });
      expect(step(r, "image")).toEqual({
        step: "image",
        isImageView: true,
        symbol: true,
        fromFile: [true, true],
        fromData: true,
        fromBuffer: true,
        scaling: {
          fit: ["fit", 3],
          fill: ["fill", 1],
          none: ["none", 2],
          down: ["down", 0],
          scaleAxesIndependently: ["fill", 1],
          NSImageScaleNone: ["none", 2],
          number: "fit",
        },
        configured: true,
        tinted: true,
        enabled: [false, false, true],
        cleared: [null, null],
        defaults: { image: null, scaling: "down", tint: null, size: 0 },
        missing: {
          message: 'could not load image file "/definitely/missing.png"',
          isTypeError: false,
          path: "/definitely/missing.png",
        },
        badData: { message: "Image.image: unrecognized image data", ...badValue },
        badSource: { message: "Image.image must be { symbol }, { file }, { data } or null", ...badType },
        badScaling: {
          message: 'Image.scaling must be "down", "fit", "fill" or "none", or an NSImageScaling name or value',
          ...badType,
        },
        badSymbol: { message: 'Image.image: no system symbol named "no.such.symbol.anywhere"', ...badValue },
      });
      expect(step(r, "axis")).toEqual({
        step: "axis",
        isBox: true,
        boxType: true,
        spacerClass: "NSView",
        inRow: { dividerTall: true, spacerWide: true },
        inColumn: { dividerWide: true, spacerTall: true },
        split: { across: true, down: true },
        grow: [0, 3],
        defaults: { vertical: null, minLength: 0 },
      });
      expect(step(r, "collected")).toEqual({ step: "collected", left: 0, uncaught: [] });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("programmatic value/checked setters do not fire onChange", async () => {
    const r = await runFixture("textfield-setter.ts");
    if (r.skipped) return;
    expect(step(r, "set")).toEqual({
      step: "set",
      events: [],
      fieldValue: "hello",
      editorValue: "multi\nline",
      sliderValue: 0.5,
      checked: true,
    });
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "text field events fired from inside a container or window change reach handlers that re-enter it",
    async () => {
      const r = await runFixture("textfield-reentrancy.ts");
      if (r.skipped) return;
      // onBlur runs once the removal has settled, before removeChild() returns,
      // and everything it did to the container and the field stuck.
      expect(step(r, "remove while editing"), r.stderr).toEqual({
        step: "remove while editing",
        log: ["blur", "appended", "removed"],
        children: ["Button", "Text"],
        spacing: 3,
        value: "edited from onBlur",
      });
      // A JS-defined delegate re-enters the container mid-call: refused with an error (reported,
      // since it threw inside a callback), the field's own setter goes through, nothing aborts;
      // a bridge target changes its button from inside click().
      expect(step(r, "bridge delegate while editing")).toEqual({
        step: "bridge delegate while editing",
        log: ["delegate", "field ok", "removed", "before clicked"],
        errors: [expect.stringMatching(/this view is inside a call into AppKit that called back into JavaScript/)],
        children: ["Button", "Button"],
        value: "edited from delegate",
        title: "before clicked",
      });
      // Editing that a setter ends is still reported (it is not the setter's echo).
      expect(step(r, "hide while editing")).toEqual({ step: "hide while editing", log: ["blur", "hidden set"] });
      expect(step(r, "replace content while editing")).toEqual({
        step: "replace content while editing",
        log: ["blur", "width=number", "replaced"],
        title: "blurred",
        content: ["Text"],
      });
      // A same-parent insertBefore is a move: the field never leaves the window, so no blur until it is removed.
      expect(step(r, "reorder keeps focus")).toEqual({
        step: "reorder keeps focus",
        log: [],
        afterMoveToEnd: ["Button", "Button", "TextField"],
        afterMoveToFront: ["TextField", "Button", "Button"],
        afterSiblingMove: ["TextField", "Button", "Button"],
        framesAscend: true,
      });
      expect(step(r, "reorder then remove")).toEqual({ step: "reorder then remove", log: ["blur"] });
      expect(step(r, "zstack reorder")).toEqual({
        step: "zstack reorder",
        children: ["TextField", "Text"],
        sameFrame: true,
      });
      // Like view setters, window geometry setters do not echo into onResize/onMove.
      expect(step(r, "window setters")).toEqual({ step: "window setters", events: [], width: 320, height: 240 });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("Table: columns, rows, selection, prop order and collection", async () => {
    const r = await runFixture("table.ts");
    if (r.skipped) return;
    const mounted = step(r, "mounted");
    expect(mounted, r.stderr).toMatchObject({ step: "mounted", isPng: true, selected: [], headerVisible: null });
    expect(mounted.frame.width).toBeGreaterThan(100);
    expect(mounted.frame.height).toBeGreaterThan(100);
    const selection = step(r, "selection");
    expect(selection).toMatchObject({ step: "selection", single: [1], multi: [0, 2], selectEvents: [] });
    // Turning `multiple` off keeps exactly one of the rows that were selected.
    expect(selection.trimmed).toHaveLength(1);
    expect([0, 2]).toContain(selection.trimmed[0]);
    expect(step(r, "rows")).toEqual({
      step: "rows",
      beforeGrow: [],
      afterGrow: [4],
      afterShrink: [],
      selectEvents: [],
    });
    const ragged = step(r, "ragged");
    expect(ragged.snapshot).toBe(true);
    expect(ragged.frame.width).toBeGreaterThan(100);
    expect(step(r, "many rows")).toEqual({ step: "many rows", selected: [19_999], snapshot: true });
    const collected = step(r, "collected");
    expect(collected.after).toBeLessThanOrEqual(collected.baseline + 5);
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "TextEditor and Table are bridge-built: the NSTextView and NSTableView inside .native, their delegate and data source, live props, events from the delegate",
    async () => {
      const r = await runFixture("editors.ts");
      if (r.skipped) return;
      expect(step(r, "text editor"), r.stderr).toEqual({
        step: "text editor",
        outer: "NSScrollView",
        inner: "NSTextView",
        richText: false,
        conforms: true,
        // undoManagerForTextView: hands each editor an undo manager of its own.
        ownUndo: true,
        undoClass: "NSUndoManager",
        // A user edit reaches onChange (textDidChange:) and undo; the value setter reports nothing and clears undo.
        afterInsert: { value: "xabc", changes: ["xabc"], canUndo: true },
        afterSet: { value: "reset", changes: ["xabc"], canUndo: false },
        editable: false,
        pointSize: 13,
        font: { design: "monospaced", size: 13 },
        red: true,
        colorBack: true,
        uncaught: [],
      });
      expect(step(r, "table")).toEqual({
        step: "table",
        outer: "NSScrollView",
        inner: "NSTableView",
        sameDelegate: true,
        target: expect.stringMatching(/^BunScriptObject\d+$/),
        conforms: [true, true],
        doubleAction: "action:",
        action: null,
        numberOfRows: 3,
        // tableView:viewForTableColumn:row: read straight off the data source: ragged rows give "", numbers their text, an unknown column nil.
        cells: [
          { kind: "NSTableCellView", text: "alpha" },
          { kind: "NSTableCellView", text: "1" },
          { kind: "NSTableCellView", text: "" },
          { kind: "NSTableCellView", text: "3" },
          null,
        ],
        strangerCell: null,
        afterUser: [[1]],
        afterSetter: [[1]],
        activations: [],
        // columns read -tableColumns, so a width the user dragged shows.
        liveColumns: [
          { id: "Name", title: "Name", width: 100 },
          { id: "size", title: "Size", width: 77 },
        ],
        withStranger: { ids: ["Name", "size", "stranger"], cell: null },
        hiddenHeader: null,
        implicit: { columns: [], count: 1, id: "value", header: null },
        rowHeight: { set: 30, native: 30 },
        rowHeightBack: true,
        alternating: true,
        multiple: true,
        rows: [["alpha", "1"], ["beta"], ["gamma", "3", "extra"]],
        badRows: {
          threw: true,
          isTypeError: true,
          message: "Table.rows[0] must be an array of cell strings",
          code: "ERR_INVALID_ARG_TYPE",
        },
        badColumns: {
          threw: true,
          isTypeError: true,
          message: "Table.columns[0] must be a string or a { id, title, width } object",
          code: "ERR_INVALID_ARG_TYPE",
        },
        badColumnTitle: {
          threw: true,
          isTypeError: true,
          message: "Table.columns[0].title must be a string",
          code: "ERR_INVALID_ARG_TYPE",
        },
        badIndexes: {
          threw: true,
          isTypeError: true,
          message: "Table.selectedIndexes[] must be a number",
          code: "ERR_INVALID_ARG_TYPE",
        },
        badIndexesShape: {
          threw: true,
          isTypeError: true,
          message: "Table.selectedIndexes must be an array of row indexes",
          code: "ERR_INVALID_ARG_TYPE",
        },
        uncaught: [],
      });
      // selectedIndexes given before rows (and before the data source exists) still ends up selected, without an onSelect.
      expect(step(r, "selected at construction")).toEqual({
        step: "selected at construction",
        selected: [1],
        native: [true, 1],
        rows: 2,
        selects: [],
        later: [0],
        uncaught: [],
      });
      expect(step(r, "remembered index")).toEqual({
        step: "remembered index",
        selected: [1, 5],
        selects: [],
        uncaught: [],
      });
      expect(step(r, "orphaned data source")).toEqual({
        step: "orphaned data source",
        rows: 0,
        cell: null,
        uncaught: [],
      });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "the menu bar is built through the bridge: the standard menus, app.name, every item shape of app.menu, dispatch and refusals",
    async () => {
      const r = await runFixture("menus.ts", { timeoutMs: 5_000 });
      if (r.skipped) return;
      const name = basename(bunExe());
      // A spec assigned before the application starts is installed when it does.
      expect(step(r, "before start"), r.stderr).toEqual({
        step: "before start",
        running: false,
        menu: true,
        mainMenu: true,
        // menuItem() is null until the bar exists, then the very NSMenuItem.
        item: null,
        after: ["Early"],
        itemAfter: true,
      });
      expect(step(r, "standard")).toEqual({
        step: "standard",
        earlyGone: null,
        name,
        titles: [name, "Edit", "View", "Window"],
        appItems: [
          `About ${name}|orderFrontStandardAboutPanel:|`,
          "-",
          "Services|submenuAction:|",
          "-",
          `Hide ${name}|hide:|h`,
          "Hide Others|hideOtherApplications:|h",
          "Show All|unhideAllApplications:|",
          "-",
          `Quit ${name}|terminate:|q`,
        ],
        edit: [
          "Undo|undo:|z",
          "Redo|redo:|Z",
          "-",
          "Cut|cut:|x",
          "Copy|copy:|c",
          "Paste|paste:|v",
          "Delete|delete:|",
          "Select All|selectAll:|a",
        ],
        view: ["Enter Full Screen|toggleFullScreen:|f"],
        window: ["Minimize|performMiniaturize:|m", "Zoom|performZoom:|", "-", "Bring All to Front|arrangeInFront:|"],
        hideOthersMask: true,
        targets: true,
        windowsMenu: true,
        servicesMenu: true,
        terminateTarget: true,
      });
      expect(step(r, "renamed")).toEqual({ step: "renamed", title: "Renamed", quit: "Quit Renamed", back: name });
      expect(step(r, "custom")).toEqual({
        step: "custom",
        // app.menuItem(x) is the NSMenuItem built for x, by identity: setEnabled:/setTitle:/setState: change the installed bar, not the spec.
        menuItem: {
          doIs: true,
          twice: true,
          inner: true,
          holder: true,
          top: true,
          separator: {
            threw: true,
            isTypeError: true,
            message: "app.menuItem() expects an item or menu object from app.menu",
          },
          copy: null,
          after: "Done|false",
          checked: 0,
          sameBar: true,
          spec: "Do",
        },
        titles: ["Main", "Second"],
        second: [],
        // title|action|key|enabled|state: a function is `action:` on the shared target, a selector goes untargeted, disabled items get neither.
        items: [
          "Do|action:||true|0",
          "-",
          "Copy|copy:|c|true|0",
          "Custom|customAction:||true|0",
          "Fn|action:||true|0",
          "Off|null||false|0",
          "Checked|action:||true|1",
          "Sub|submenuAction:||true|0",
          "Held|submenuAction:||false|0",
          "Bare|action:|b|true|0",
          "Upper|action:|S|true|0",
        ],
        oneTarget: true,
        selectorTargets: [null, null],
        offTarget: null,
        tags: [1, 2, 4, 5],
        masks: { copy: true, inner: true, bare: true, upper: true },
        held: { enabled: false, deep: ["Deep|copy:"] },
        calls: ["do", "fn", "inner"],
        chosen: ["Do", "Fn", "Checked", "Inner"],
        getter: true,
        uncaught: [],
      });
      const refused = step(r, "refused");
      for (const key of [
        "both",
        "twoColons",
        "noColon",
        "badClick",
        "submenuAndAction",
        "notArray",
        "badMenu",
        "badItem",
      ]) {
        expect(refused[key], key).toMatchObject({ threw: true, isTypeError: true });
      }
      expect(refused.twoColons.message).toMatch(/selector that takes the sender/);
      expect(refused.still).toBe("Main");
      expect(step(r, "restored")).toEqual({
        step: "restored",
        titles: [name, "Edit", "View", "Window"],
        getter: null,
        doItem: null,
        // An NSMenuItem held over from the replaced bar dispatches to nothing.
        staleCalls: 3,
        windowsMenu: true,
      });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "Picker and Segmented: selectedIndex defaults, duplicate titles, out-of-range and prop order",
    async () => {
      const r = await runFixture("picker.ts");
      if (r.skipped) return;
      expect(step(r, "defaults"), r.stderr).toEqual({ step: "defaults", picker: 0, segmented: 0 });
      // A duplicate title must keep its own slot so indexes line up with items[].
      expect(step(r, "duplicate titles")).toEqual({
        step: "duplicate titles",
        picker: 2,
        segmented: 2,
        items: ["A", "B", "A"],
      });
      expect(step(r, "index before items")).toEqual({ step: "index before items", before: -1, after: 2 });
      // Same answer whichever prop is applied first, and the wanted index survives until items grow to reach it.
      expect(step(r, "out of range")).toEqual({
        step: "out of range",
        picker: [-1, -1],
        segmented: [-1, -1],
        grown: [5, 5],
      });
      expect(step(r, "none")).toEqual({ step: "none", explicit: -1, reset: 0 });
      expect(step(r, "shrunk")).toEqual({ step: "shrunk", picker: -1, segmented: -1 });
      expect(step(r, "selectedIndex=fraction")).toEqual({ step: "selectedIndex=fraction", picker: 1, segmented: 1 });
      for (const name of ["negative", "huge"]) {
        expect(step(r, `selectedIndex=${name}`)).toEqual({ step: `selectedIndex=${name}`, picker: -1, segmented: -1 });
      }
      expect(step(r, "selectedIndex=NaN")).toEqual({
        step: "selectedIndex=NaN",
        threw: { isTypeError: true, message: "Picker.selectedIndex must be a finite number" },
      });
      expect(step(r, "selectedIndex=string")).toEqual({
        step: "selectedIndex=string",
        threw: { isTypeError: true, message: "Picker.selectedIndex must be a number or null" },
      });
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("unparented views are garbage collected", async () => {
    const r = await runFixture("gc-views.ts");
    if (r.skipped) return;
    const created = step(r, "created");
    expect(created.live).toBeGreaterThanOrEqual(created.baseline + 300);
    expect(created.natives).toBe(300);
    const collected = step(r, "collected");
    expect(collected.after).toBeLessThanOrEqual(collected.baseline + 5);
    // Not only the View objects: the NSViews behind the collected ones are deallocated too.
    expect(collected.nativesLeft).toBeLessThanOrEqual(Math.max(collected.after - collected.baseline, 0));
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "app.keepAlive holds the process after the last window closes, and releasing it lets it exit",
    async () => {
      const r = await runFixture("keep-alive.ts", { timeoutMs: 5_000 });
      if (r.skipped) return;
      // keepAlive = true starts the application by itself, before any window exists.
      expect(step(r, "started"), r.stderr).toEqual({ step: "started", running: true });
      expect(step(r, "closed")).toEqual({ step: "closed", closed: true, windows: 0, keepAlive: true });
      expect(step(r, "still-alive")).toBeDefined();
      expect(step(r, "unexpected-timer")).toBeUndefined();
      // A SIGKILL here means keepAlive = false did not release the process.
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "reopen and menu listeners all run even when one of them, or the item's onClick, throws",
    async () => {
      const r = await runFixture("app-events.ts", { timeoutMs: 5_000 });
      if (r.skipped) return;
      expect(step(r, "reopen"), r.stderr).toEqual({
        step: "reopen",
        reopens: [false, true],
        handled: true,
        uncaught: ["reopen boom"],
      });
      expect(step(r, "menu")).toEqual({ step: "menu", chosen: ["same item"], uncaught: ["onClick boom", "menu boom"] });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "a modal session run through the bridge holds timers until it ends, then the loop resumes, also when begun inside the wait",
    async () => {
      const r = await runFixture("modal.ts", { timeoutMs: 15_000 });
      if (r.skipped) return;
      // NSModalResponseStop; the timeout armed before the session ran only after it.
      expect(step(r, "top level"), r.stderr).toEqual({
        step: "top level",
        response: -1000,
        ranDuring: false,
        ranAfter: true,
      });
      expect(step(r, "inside wait")).toEqual({ step: "inside wait", response: -1000 });
      expect(step(r, "watchdog")).toBeUndefined();
      expect(step(r, "done")).toEqual({ step: "done" });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "app.quit(): beforequit and shouldClose can veto; otherwise every window closes, 'exit' runs and the process ends despite keepAlive and a timer",
    async () => {
      const r = await runFixture("quit.ts", { timeoutMs: 5_000, expectFailure: true });
      if (r.skipped) return;
      const open = [false, false, false];
      expect(step(r, "preventDefault"), r.stderr).toEqual({ step: "preventDefault", closed: open });
      expect(step(r, "return-false")).toEqual({ step: "return-false", closed: open });
      // A throwing listener is reported and does not hide another listener's veto, in either order.
      expect(step(r, "prevent-then-throw")).toEqual({
        step: "prevent-then-throw",
        closed: open,
        uncaught: ["listener boom"],
      });
      expect(step(r, "throw-then-prevent")).toEqual({
        step: "throw-then-prevent",
        closed: open,
        uncaught: ["listener boom"],
      });
      // Windows are asked in creation order and closed as they agree; the first refusal stops the quit.
      expect(step(r, "shouldClose-false")).toEqual({
        step: "shouldClose-false",
        closed: [true, false, false],
        onClose: 1,
        shouldCloseCalls: 1,
        order: ["main", "palette"],
      });
      // Every window closed, hidden and non-closable ones included; a second
      // quit after the accepted one does not ask beforequit again; the throw
      // from the accepted quit's listener was reported once.
      expect(step(r, "exit")).toEqual({
        step: "exit",
        closed: [true, true, true],
        code: 3,
        onClose: 3,
        shouldCloseCalls: 1,
        lateCalls: 0,
        uncaught: ["listener boom"],
      });
      // The exit happens at the next turn of the loop, not inside quit().
      expect(step(r, "after-quit")).toMatchObject({ step: "after-quit", closed: [true, true, true], lateCalls: 0 });
      expect(step(r, "beforeExit")).toBeUndefined();
      // A SIGKILL here means the quit left the process running.
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(3);
    },
  );

  test.concurrent(
    "-[NSApplication terminate:] (Quit menu item, Dock, logout) takes the same path and exits in place",
    async () => {
      const r = await runFixture("quit.ts", { timeoutMs: 5_000, args: ["terminate"], expectFailure: true });
      if (r.skipped) return;
      expect(step(r, "shouldClose-false"), r.stderr).toMatchObject({ closed: [true, false, false] });
      expect(step(r, "exit")).toEqual({
        step: "exit",
        closed: [true, true, true],
        code: 3,
        onClose: 3,
        shouldCloseCalls: 1,
        lateCalls: 0,
        uncaught: ["listener boom"],
      });
      // AppKit exits before terminate: returns.
      expect(step(r, "unreachable")).toBeUndefined();
      expect(step(r, "beforeExit")).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(3);
    },
  );

  // The bridge loads the Objective-C runtime itself: bun links the same
  // libraries as before it existed and registers no Objective-C image. And
  // the one frame that catches NSException must keep DWARF unwind info (an
  // __eh_frame FDE with its LSDA), since release builds strip __unwind_info
  // and ld64.lld drops the FDE of any frame it managed to encode compactly.
  test.concurrent("bun links no Objective-C runtime and the catch frame keeps its DWARF unwind entry", async () => {
    const tool = (...cmd: string[]) => {
      const { stdout, exitCode } = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
      return exitCode === 0 ? stdout.toString() : null;
    };
    if (tool("xcode-select", "-p") === null) {
      console.warn("no developer tools here; linkage and unwind checks skipped");
      return;
    }
    const exe = bunExe();
    const libraries = tool("otool", "-L", exe)!;
    expect(libraries).toContain("libSystem");
    expect(libraries).not.toContain("libobjc");
    const sections = tool("size", "-m", exe)!;
    expect(sections).not.toContain("__objc_imageinfo");
    expect(sections).toMatch(/__gcc_except_tab: [1-9]/);
    expect(sections).toMatch(/__eh_frame: [1-9]/);
    const symbols = tool("nm", exe) ?? "";
    const symbol = symbols.split("\n").find(line => line.endsWith(" _Bun__NSInvocation__tryInvoke"));
    if (symbol === undefined) {
      // A stripped binary: the sections above are all that can be checked.
      expect(symbols.trim().split("\n").length).toBeLessThan(100);
      return;
    }
    const address = BigInt("0x" + symbol.split(" ")[0]);
    const frames = tool("dwarfdump", "--eh-frame", exe)!;
    const covering = [...frames.matchAll(/FDE cie=[0-9a-f]+ pc=([0-9a-f]+)\.\.\.([0-9a-f]+)\n((?:  .*\n)*)/g)].find(
      m => BigInt("0x" + m[1]) <= address && address < BigInt("0x" + m[2]),
    );
    expect(covering?.[0] ?? "no FDE covers Bun__NSInvocation__tryInvoke").toContain("LSDA Address");
  });

  test.concurrent("an uncaught NSException names itself before the crash report", async () => {
    const r = await runFixture("objc-exception.ts", { timeoutMs: 10_000, expectFailure: true });
    if (r.skipped) return;
    expect(r.stdout).not.toContain("not reached");
    expect(r.stderr).toContain("uncaught Objective-C exception BunTestException: raised on purpose");
    expect(r.exitCode).not.toBe(0);
  });

  test.concurrent("app.quit() with no window open ends a process that only keepAlive started and holds", async () => {
    const r = await runFixture("quit.ts", { timeoutMs: 5_000, args: ["no-windows"] });
    if (r.skipped) return;
    expect(step(r, "exit"), r.stderr).toEqual({ step: "exit", closed: [], code: 0, running: true });
    expect(step(r, "after-quit")).toEqual({ step: "after-quit", closed: [] });
    expect(step(r, "beforeExit")).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  test.concurrent("app.quit() before anything started AppKit is process.exit(process.exitCode)", async () => {
    const r = await runFixture("quit.ts", { timeoutMs: 5_000, args: ["not-started"], expectFailure: true });
    if (r.skipped) return;
    expect(step(r, "exit"), r.stderr).toEqual({ step: "exit", closed: [], code: 4, running: false });
    expect(step(r, "after-quit")).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.exitCode).toBe(4);
  });

  test.concurrent(
    "app.quit() with only windows holding the process exits through process.exit, not by draining",
    async () => {
      const r = await runFixture("quit.ts", { timeoutMs: 5_000, args: ["plain"], expectFailure: true });
      if (r.skipped) return;
      expect(step(r, "exit"), r.stderr).toEqual({ step: "exit", closed: [true, true, true], code: 5, onClose: 3 });
      expect(step(r, "after-quit")).toMatchObject({ step: "after-quit", closed: [true, true, true] });
      expect(step(r, "beforeExit")).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(5);
    },
  );

  test.concurrent("process.exit() inside a callback AppKit is running exits with that code", async () => {
    const r = await runFixture("quit.ts", { timeoutMs: 5_000, args: ["exit-in-shouldClose"], expectFailure: true });
    if (r.skipped) return;
    expect(step(r, "unreachable"), r.stderr).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.exitCode).toBe(7);
  });

  test.concurrent("ScrollView scrollBars: a horizontal scroller lets the document keep its width", async () => {
    const r = await runFixture("scroll-view.ts");
    if (r.skipped) return;
    const both = step(r, "both");
    expect(both, r.stderr).toBeDefined();
    // The window keeps the size it was given; the document scrolls instead of pushing it wider.
    expect(both.window).toBe(200);
    expect(both.document).toBeGreaterThan(2 * both.scroll);
    const vertical = step(r, "vertical");
    expect(vertical.window).toBe(200);
    expect(vertical.document).toBeLessThanOrEqual(vertical.scroll + 8);
    const again = step(r, "both again");
    expect(again.document).toBeGreaterThan(2 * again.scroll);
    expect(step(r, "vstack align")).toEqual({
      step: "vstack align",
      align: "trailing",
      threw: { isTypeError: true, message: expect.stringContaining("horizontal stack") },
    });
    expect(r.exitCode).toBe(0);
  });

  test.concurrent("a Worker that touches AppKit first is refused and the main thread still works", async () => {
    const r = await runFixture("wrong-thread.ts");
    const worker = step(r, "worker");
    expect(worker, r.stderr).toBeDefined();
    // The app's thread check runs before the frameworks are loaded, so this holds even where they cannot load.
    const refused = { threw: true, message: expect.stringMatching(/main thread/) };
    expect(worker.start).toMatchObject(refused);
    // A refused start is not remembered as a start: the next call is refused the same way.
    expect(worker.window).toMatchObject(refused);
    expect(worker.keepAlive).toMatchObject(refused);
    expect({ running: worker.running, keptAlive: worker.keptAlive }).toEqual({ running: false, keptAlive: false });
    if (r.skipped) return;
    // A view is refused by its AppKit class, which takes the frameworks to name.
    expect(worker.view).toMatchObject({
      ...refused,
      message: expect.stringMatching(/^objc: NSTextField \(a kind of NSResponder\)/),
    });
    expect(step(r, "main")).toEqual({ step: "main", windows: 1 });
    expect(r.exitCode).toBe(0);
  });

  test.concurrent(
    "objc: classes and selectors by name, conversion by type encoding, ownership, .native, and the errors",
    async () => {
      const r = await runFixture("objc-bridge.ts");
      if (r.skipped) return;
      // Foundation works in a Worker; a window (any NSResponder) is the main thread's, and the error names the class.
      expect(step(r, "worker"), r.stderr).toEqual({
        step: "worker",
        lookup: { threw: false },
        ns: { threw: false },
        sel: { threw: false },
        window: {
          threw: true,
          code: "ERR_INVALID_STATE",
          message: expect.stringMatching(
            /^objc: NSWindow \(a kind of NSResponder\) can only be used on the process's main thread, not in a Worker/,
          ),
        },
      });
      expect(step(r, "nsstring"), r.stderr).toEqual({
        step: "nsstring",
        length: 2,
        utf8: "hi",
        template: "hi",
        string: "hi",
        description: "hi",
        js: "hi",
        memoized: true,
        tag: "[object ObjCObject]",
        classTag: "[object ObjCClass]",
        className: "NSString",
        sameClass: true,
        pointer: "bigint",
        classPointer: "bigint",
        isEqual: true,
        hasPrefix: false,
        unicode: "héllo",
        unicodeLength: 5,
        thenable: "undefined",
        resolvesToItself: true,
      });
      expect(step(r, "array")).toEqual({
        step: "array",
        count: 2,
        second: "there",
        firstIsS: true,
        addReturns: "undefined",
        js: ["hi", "there"],
        isKindOfArray: true,
        isKindOfString: false,
        classIsSubclass: true,
        superclassShared: true,
        respondsToCount: true,
        respondsToSel: true,
        respondsToNope: false,
        instancesRespond: true,
        selName: "terminate:",
        selString: "terminate:",
      });
      expect(step(r, "processName")).toEqual({ step: "processName", type: "string", matchesExecutable: true });
      expect(step(r, "conversion")).toEqual({
        step: "conversion",
        intValue: 3,
        doubleValue: 2.5,
        floatValue: 2.5,
        boolValue: true,
        longLong: -5,
        unsignedLongLong: "18446744073709551615",
        unsignedLongLongType: "bigint",
        jsNumber: 3,
        jsDouble: 2.5,
        jsBool: true,
        jsString: "s",
        jsStrings: ["a", "b"],
        jsNested: { a: 1, b: [true, null, "s"] },
        jsPassthrough: [7, "x", null, true],
        nsNull: null,
        nsUndefined: null,
        nsHandle: true,
        nsArrayCount: 3,
        nsDictLookup: "v",
        nilReturn: null,
        json: '{"s":"hi","strings":["a","b"],"n":4}',
        jsonPlain: expect.stringMatching(/^<NSObject: 0x[0-9a-f]+>$/),
        range: { location: 6, length: 5 },
        notFound: "9223372036854775807",
        notFoundType: "bigint",
        notFoundRange: true,
        notFoundIndex: true,
        foundIndex: 0,
        notFoundConstant: ["bigint", "9223372036854775807"],
        substring: "hello",
        bigRange: "9223372036854775807",
        badRange: true,
        loneSurrogate: true,
        loneSurrogateLength: 3,
        // A selector only fits a SEL argument; anywhere else it is refused like any other class instance.
        selectorForId: { threw: true, isTypeError: true, message: expect.stringContaining("ObjCSelector") },
        nsSelector: { threw: true, isTypeError: true, message: expect.stringContaining("ObjCSelector") },
        classesProbes: { then: "undefined", string: "[objc.classes]", json: '{"c":"[objc.classes]"}', awaited: true },
      });
      // SEL arguments take a string or objc.sel(); SEL results are strings.
      expect(step(r, "selectors")).toEqual({ step: "selectors", fromString: "terminate:", fromSel: "hide:" });
      expect(step(r, "view")).toEqual({
        step: "view",
        frame: { origin: { x: 1, y: 2 }, size: { width: 30, height: 40 } },
        flat: { origin: { x: 5, y: 6 }, size: { width: 70, height: 80 } },
        moved: { origin: { x: 3, y: 4 }, size: { width: 50, height: 60 } },
        identity: true,
        isView: true,
        isWindow: false,
        vstackIsStackView: true,
        tableOuter: "NSScrollView",
        tableDocument: true,
        scrollInsets: { top: 0, left: 0, bottom: 0, right: 0 },
      });
      // Changes made through the NSWindow show in the curated getters, which read the live object.
      expect(step(r, "window")).toEqual({
        step: "window",
        titleBefore: "t",
        titleAfter: "u",
        isVisible: false,
        frameKeys: ["origin", "size"],
        frameWidth: 300,
        frameAtLeastContentHeight: true,
        widthAfterNested: 320,
        widthAfterFlat: 340,
        nativeFrameWidth: 340,
        identity: true,
        isWindow: true,
        contentViewIsView: true,
        sameThroughContentView: true,
        samePointer: true,
        sameDifferent: false,
        sameNulls: false,
        sameStrings: false,
      });
      expect(step(r, "native after close")).toEqual({ step: "native after close", same: true });
      expect(step(r, "handle after close")).toEqual({ step: "handle after close", title: "u" });
      // Windows created through objc are told not to release themselves on close, so their handles survive it.
      expect(step(r, "bridge window")).toEqual({
        step: "bridge window",
        releasedWhenClosed: [false, false, false],
        titlesAfterClose: ["raw", "new"],
        frameWidthAfterClose: 120,
      });
      // An NSProxy receiver gets only the message sent (no respondsToSelector: probe), so a recording proxy records that.
      expect(step(r, "proxy")).toEqual({
        step: "proxy",
        isProxy: [true, false],
        recorded: "undefined",
        untouchedBeforeUndo: true,
        replayed: ["undone"],
        jsLeavesProxy: "[object ObjCObject]",
        stringifies: "string",
        typo: { threw: true, isTypeError: true },
      });
      // An NSException inside a send is an ERR_OBJC_EXCEPTION Error named after it; nothing aborts.
      const objcException = { threw: true, isError: true, code: "ERR_OBJC_EXCEPTION", stack: "string" };
      expect(step(r, "exception range")).toEqual({
        step: "exception range",
        ...objcException,
        name: "NSRangeException",
        message: expect.stringContaining("index 3 beyond bounds for empty array"),
        exceptionName: "NSRangeException",
        countAfter: 0,
      });
      expect(step(r, "exception nil object")).toMatchObject({
        ...objcException,
        name: "NSInvalidArgumentException",
        message: expect.stringContaining("object cannot be nil (key: k)"),
        exceptionName: "NSInvalidArgumentException",
      });
      expect(step(r, "exception userInfo")).toEqual({
        step: "exception userInfo",
        ...objcException,
        name: "BunFixtureException",
        message: "because",
        userInfo: expect.stringMatching(/detail = 42/),
        exceptionName: "BunFixtureException",
      });
      expect(step(r, "exception nil name")).toEqual({
        step: "exception nil name",
        ...objcException,
        name: "NSException",
        message: "",
        exceptionName: "null",
      });
      expect(step(r, "exception init")).toMatchObject({
        ...objcException,
        name: "NSInvalidArgumentException",
        message: expect.stringContaining("initWithString:"),
        consumedAfter: true,
      });
      expect(step(r, "exception proxy")).toMatchObject({
        ...objcException,
        name: "NSInternalInconsistencyException",
        message: expect.stringContaining("must begin a group before registering undo"),
        untouched: true,
      });
      const typeError = { threw: true, isTypeError: true };
      expect(step(r, "unknown class")).toEqual({
        step: "unknown class",
        ...typeError,
        message: 'objc: no class named "NSDefinitelyNotAClass"',
      });
      // Checked with respondsToSelector: before sending, so no NSException.
      expect(step(r, "unrecognized selector")).toMatchObject(typeError);
      expect(step(r, "unrecognized selector").message).toMatch(/definitelyNotASelector:\]: unrecognized selector/);
      expect(step(r, "unrecognized class selector")).toMatchObject(typeError);
      expect(step(r, "unrecognized class selector").message).toContain(
        "+[NSString definitelyNot]: unrecognized selector",
      );
      expect(step(r, "wrong arg count")).toMatchObject(typeError);
      expect(step(r, "wrong arg count").message).toMatch(/compare:\]: expected 1 argument\(s\), got 0/);
      expect(step(r, "wrong arg count extra")).toMatchObject(typeError);
      expect(step(r, "wrong arg count extra").message).toMatch(/length\]: "length".*0 arguments.*1 was passed/);
      expect(step(r, "wrong arg count msgSend")).toMatchObject(typeError);
      expect(step(r, "wrong arg count msgSend").message).toContain("compare:");
      expect(step(r, "msgSend works")).toEqual({ step: "msgSend works", threw: false, value: 0 });
      expect(step(r, "block arg")).toEqual({ step: "block arg", threw: false });
      expect(step(r, "block arg number")).toMatchObject(typeError);
      expect(step(r, "block arg number").message).toMatch(
        /must be a function or a block made with objc\.block\(\) \(@\?\), got a number/,
      );
      expect(step(r, "pointer arg")).toMatchObject(typeError);
      expect(step(r, "pointer arg").message).toMatch(/pointer/i);
      for (const name of ["fractional index", "negative unsigned", "string for number", "symbol for object"]) {
        expect(step(r, name)).toMatchObject({ step: name, ...typeError });
      }
      expect(step(r, "fractional index").message).toContain("removeObjectAtIndex:");
      expect(step(r, "bad struct")).toMatchObject(typeError);
      expect(step(r, "bad struct").message).toMatch(/setFrame:.*(origin, size|\.y)/);
      expect(step(r, "assign property")).toMatchObject(typeError);
      expect(step(r, "bad msgSend selector")).toMatchObject(typeError);
      expect(step(r, "bad sel")).toMatchObject(typeError);
      for (const name of ["retainCount refused", "retain refused"]) {
        expect(step(r, name)).toMatchObject({
          step: name,
          ...typeError,
          message: expect.stringMatching(/release\(\)/),
        });
      }
      expect(step(r, "autorelease pool refused")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/NSAutoreleasePool.*managed/),
      });
      for (const name of ["performSelector refused", "performSelector withObject refused"]) {
        expect(step(r, name)).toMatchObject({ step: name, ...typeError, message: expect.stringMatching(/msgSend/) });
      }
      // The void-returning variants have nothing to mistype.
      expect(step(r, "performSelector afterDelay allowed")).toEqual({
        step: "performSelector afterDelay allowed",
        threw: false,
      });
      for (const name of [
        "variadic format",
        "variadic subclass",
        "variadic instance",
        "variadic init",
        "variadic appkit",
        "variadic unconventional name",
        "variadic core image",
        "va_list",
      ]) {
        expect(step(r, name)).toMatchObject({ step: name, ...typeError, message: expect.stringMatching(/variadic/) });
      }
      expect(step(r, "object arguments:")).toEqual({ step: "object arguments:", threw: false, value: "sum:" });
      expect(step(r, "non-variadic format")).toEqual({
        step: "non-variadic format",
        threw: false,
        value: 'SELF == "a"',
      });
      expect(step(r, "non-variadic format int")).toMatchObject({ step: "non-variadic format int", threw: false });
      for (const name of ["init on class", "init on class msgSend"]) {
        expect(step(r, name)).toMatchObject({ step: name, ...typeError, message: expect.stringMatching(/alloc\(\)/) });
      }
      expect(step(r, "alloc then bad init")).toMatchObject(typeError);
      expect(step(r, "alloc then bad init").message).toMatch(/-\[NSButton initWithFrame:\]: argument 0/);
      expect(step(r, "alloc then wrong count")).toMatchObject(typeError);
      expect(step(r, "alloc then wrong count").message).toContain("initWithFrame:");
      const notInitialized = { ...typeError, message: expect.stringMatching(/came from alloc\(\).*init/) };
      for (const name of ["alloc then not init", "alloc toString", "alloc json", "alloc as argument"]) {
        expect(step(r, name)).toMatchObject({ step: name, ...notInitialized });
      }
      expect(step(r, "alloc")).toEqual({
        step: "alloc",
        pointer: "0",
        sameAsItself: true,
        sameAsOther: false,
        thenInit: 0,
        consumed: { threw: true, isTypeError: true, message: expect.stringMatching(/consumed by init/) },
      });
      // A View or Window where an object is expected names `.native`; other class instances are not dictionaries.
      expect(step(r, "view for id")).toMatchObject({ ...typeError, message: expect.stringMatching(/view\.native/) });
      expect(step(r, "window for id")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/window\.native/),
      });
      expect(step(r, "class instance for id")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/cannot convert an object/),
      });
      expect(step(r, "null-proto object for id")).toEqual({ step: "null-proto object for id", threw: false, value: 0 });
      expect(step(r, "map for id")).toMatchObject(typeError);
      for (const name of ["NUL in char*", "NUL in SEL"]) {
        expect(step(r, name)).toMatchObject({ step: name, ...typeError, message: expect.stringMatching(/NUL/) });
      }
      expect(step(r, "2^60 for Q")).toMatchObject({ ...typeError, message: expect.stringMatching(/bigint/) });
      // None of the refused calls above was sent.
      expect(step(r, "still two")).toEqual({ step: "still two", count: 2 });
      // alloc/new results are taken over, +0 returns retained once per handle, init consumes its receiver.
      const ownership = step(r, "ownership");
      expect(ownership).toEqual({
        step: "ownership",
        consumed: { threw: true, isTypeError: true, message: expect.stringMatching(/consumed by init/) },
        owned: "x0",
        heldBeforeRelease: true,
        releasedNow: true,
        useAfterRelease: {
          threw: true,
          isTypeError: false,
          code: "ERR_INVALID_STATE",
          message: expect.stringMatching(/released/),
        },
        // A released handle is still itself but no longer any object.
        sameAfterRelease: [true, false],
        stillInArray: "NSObject",
        left: true,
      });
      expect(step(r, "done")).toEqual({ step: "done", length: 2, count: 2 });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "objc.defineClass / objc.target: AppKit calls JavaScript methods, encodings from types, protocol or superclass",
    async () => {
      const r = await runFixture("objc-define.ts", { timeoutMs: 40_000 });
      if (r.skipped) return;
      expect(step(r, "data source")).toEqual({
        step: "data source",
        className: "FixtureDataSource",
        sameClass: true,
        instanceClass: "FixtureDataSource",
        isKindOfNSObject: true,
        // reloadData asked the JS data source synchronously.
        numberOfRows: 3,
        direct: "gamma",
        askedRows: true,
        askedValue: true,
        respondsRows: true,
        respondsValue: true,
        respondsNope: false,
        conforms: true,
        conformsOther: false,
        classConforms: true,
        instancesRespond: true,
        // q@:@ from the NSTableViewDataSource protocol, not the all-object default.
        signature: "q",
        protocolsString: "[objc.protocols]",
        sameProtocol: true,
      });
      expect(step(r, "target")).toEqual({
        step: "target",
        generatedClassName: true,
        // Still the target after a reader's `using` gave its read back: a third click lands.
        stillTarget: true,
        clicks: 3,
        senderIsButton: true,
        secondSender: null,
        thisIsTarget: true,
        responds: true,
        buttonTarget: true,
      });
      expect(step(r, "subclass")).toEqual({
        step: "subclass",
        superclassName: "NSView",
        flipped: true,
        plainFlipped: false,
        accepts: true,
        plainAccepts: false,
        moved: true,
        isKindOfNSView: true,
        frameWidth: 10,
      });
      // NSView's dealloc removes its subviews; the deallocating parent's override is skipped.
      expect(step(r, "dealloc")).toEqual({
        step: "dealloc",
        whileAlive: ["NSButton"],
        afterRelease: ["NSButton"],
        childSuperview: null,
        childClass: "NSButton",
      });
      expect(step(r, "inherit")).toEqual({
        step: "inherit",
        fromObjectSuperclass: "NSObject",
        generatedNames: true,
        base: "base",
        derived: "derived",
        inheritedTwice: 42,
        derivedSuperclass: true,
      });
      const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const misfit = (selector: string, expected: string, got: string) => ({
        threw: true,
        isTypeError: true,
        message: expect.stringMatching(
          new RegExp(`^-\\[BunScriptObject\\d+ ${selector}\\]: must return ${escaped(expected)}, got ${escaped(got)}$`),
        ),
      });
      expect(step(r, "constants")).toEqual({
        step: "constants",
        flipped: true,
        opaque: false,
        tag: -7,
        alpha: 0.25,
        menu: null,
        big: "18446744073709551615",
        ratio: 1.5,
        level: 3,
        kvc: -7,
        responds: true,
        mainThread: [42, 1],
        uncaught: [
          "objc: -[FixtureAsks level] was called on another thread; its JavaScript function only runs on the thread that created it, so the caller received 0 / NO / nil",
        ],
        wrongBool: misfit("isFlipped", "a boolean (B)", "an integer"),
        wrongObject: misfit(
          "menu",
          "an object, string, number, boolean or null (@)",
          "the constant a boolean; a constant method returns a boolean, a number or null",
        ),
        wrongVoid: misfit(
          "poke:",
          "nothing (v)",
          "the constant null; a constant method returns a boolean, a number or null",
        ),
        wrongStruct: misfit(
          "frame",
          "a {origin, size} or {x, y, width, height} object ({CGRect={CGPoint=dd}{CGSize=dd}})",
          "the constant null; a constant method returns a boolean, a number or null",
        ),
        wrongRange: misfit("small", "an integer (C)", "300"),
        wrongFraction: misfit("whole", "an integer (q)", "a number"),
        wrongKind: {
          threw: true,
          isTypeError: true,
          message:
            'objc.defineClass(): methods["text"] must be a function, a constant (boolean, number or null), or { types, fn } or { types, value } with types a string',
        },
      });
      expect(step(r, "types")).toEqual({
        step: "types",
        rect: { origin: { x: 2, y: 2 }, size: { width: 6, height: 4 } },
        add: 3.75,
        not: [false, true],
        sel: "some:extra:",
        cls: true,
        big: "1152921504606846977",
        describe: "got 42",
        describeString: "got s",
        list: ["a", 1, true, null],
        nothing: null,
        keepSame: true,
        keepNull: null,
      });
      // A throw (or an unconvertible result) is an uncaught JS error; the sender reads zero / nil.
      expect(step(r, "throws")).toEqual({
        step: "throws",
        boom: { threw: false, value: null },
        count: { threw: false, value: 0 },
        flag: { threw: false, value: false },
        badRows: { threw: false, value: 0 },
        badSel: { threw: false, value: null },
        uncaught: [
          "boom from js",
          "count failed",
          expect.stringMatching(/-\[FixtureThrows flag\]: must return a boolean \(B\), got a string/),
          expect.stringMatching(/-\[FixtureThrows rows\]: must return an integer \(q\), got 1\.5/),
          expect.stringMatching(
            /-\[FixtureThrows badSel\]: must return a selector name \(:\), got a string containing a NUL/,
          ),
        ],
      });
      expect(step(r, "forward by hand")).toEqual({ step: "forward by hand", threw: false });
      // The IMP never reads an argument the invocation lacks; the mismatch is reported.
      expect(step(r, "forward wrong signature")).toEqual({
        step: "forward wrong signature",
        sent: { threw: false },
        uncaught: [expect.stringMatching(/invocation whose signature takes 0 argument\(s\).*the method takes 3/)],
      });
      // q from NSTableViewDataSource and B from NSWindowDelegate without naming them; @ for a selector of its own.
      expect(step(r, "untyped encodings")).toEqual({
        step: "untyped encodings",
        rows: "q@",
        shouldClose: "B@",
        own: "@@",
        rowsValue: 0,
      });
      expect(step(r, "untyped conflict")).toMatchObject({
        threw: true,
        isTypeError: true,
        message: expect.stringMatching(/state\]: protocols declare this selector with different types: .*NS\w+ \(/),
      });
      // N^@: the script sees the caller's object and what it stores comes back.
      expect(step(r, "inout")).toEqual({ step: "inout", ok: true, out: "in+k", types: "N^@" });
      const typeError = { threw: true, isTypeError: true };
      expect(step(r, "name taken")).toMatchObject({ ...typeError, message: expect.stringContaining('"NSObject"') });
      expect(step(r, "name taken twice")).toMatchObject({
        ...typeError,
        message: expect.stringContaining('"FixtureTypes"'),
      });
      expect(step(r, "bad name")).toMatchObject(typeError);
      expect(step(r, "no protocol")).toMatchObject({
        ...typeError,
        message: 'objc: no protocol named "NSDefinitelyNotAProtocol" is registered by the loaded frameworks',
      });
      expect(step(r, "protocol lookup")).toMatchObject({
        ...typeError,
        message: expect.stringContaining("NSDefinitelyNotAProtocol"),
      });
      expect(step(r, "bad superclass")).toMatchObject({
        ...typeError,
        message: 'objc: no class named "NSDefinitelyNotAClass"',
      });
      expect(step(r, "bad types")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/x:\]: type encoding "v@:\{\{\{" is not valid/),
      });
      expect(step(r, "types arity")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/"v@:" has 0 argument\(s\) but the selector takes 1/),
      });
      expect(step(r, "types no self")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/x\]: type encoding "v" must start with the return type followed by "@:"/),
      });
      expect(step(r, "types bad self")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/"vq:@" must start with the return type followed by "@:"/),
      });
      expect(step(r, "fn arity")).toMatchObject({
        ...typeError,
        message: 'objc.defineClass(): "x:" takes 1 argument but its function declares 2',
      });
      expect(step(r, "init refused")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/ init\]: init methods cannot be defined/),
      });
      expect(step(r, "initWith refused")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/ initWithRows:\]: init methods cannot be defined/),
      });
      expect(step(r, "required missing")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(
          /adopts NSCopying but does not define copyWithZone:, which the protocol requires/,
        ),
      });
      expect(step(r, "required inherited")).toEqual({ step: "required inherited", threw: false, value: "NSCell" });
      expect(step(r, "required defined")).toEqual({ step: "required defined", threw: false, value: "NSObject" });
      // @? both ways in a defined method: the parameter is callable, the return takes a block handle.
      expect(step(r, "block param")).toEqual({
        step: "block param",
        received: ["function", 49, 4],
        result: 100,
        same: true,
        direct: 81,
        released: true,
      });
      // A bare function where a block is returned has no type to go by: reported, nil returned.
      expect(step(r, "block return fn")).toEqual({ step: "block return fn", threw: false, value: null });
      expect(step(r, "reserved")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/dealloc\]: this selector cannot be defined/),
      });
      expect(step(r, "not a function")).toMatchObject({
        ...typeError,
        message: expect.stringContaining('methods["x"]'),
      });
      expect(step(r, "no methods")).toMatchObject(typeError);
      expect(step(r, "target not a function")).toMatchObject(typeError);
      expect(step(r, "name reusable")).toMatchObject(typeError);
      expect(step(r, "name reused")).toEqual({ step: "name reused", threw: false, value: "FixtureRetry" });
      expect(step(r, "lifetime")).toEqual({ step: "lifetime", aliveWhileHeld: true, collectedAfterRelease: true });
      expect(step(r, "lifetime off thread")).toEqual({ step: "lifetime off thread", collected: true });
      expect(step(r, "assign delegate")).toEqual({
        step: "assign delegate",
        heldWhileSet: 1,
        parsed: true,
        elements: 3,
        sameObject: true,
        goneAfterNil: true,
      });
      expect(step(r, "assign delegate owner released")).toEqual({ step: "assign delegate owner released", gone: true });
      expect(step(r, "done")).toEqual({ step: "done" });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "objc.block / functions as block arguments: enumeration, predicates, comparators, run-loop callbacks",
    async () => {
      const r = await runFixture("objc-blocks.ts", { timeoutMs: 40_000 });
      if (r.skipped) return;
      expect(step(r, "enumerate")).toEqual({
        step: "enumerate",
        // stop.value = true at index 2 ends the enumeration; list.count() re-enters the bridge from inside the block.
        seen: [
          ["alpha", 0, false, 4],
          ["beta", 1, false, 4],
          ["gamma", 2, false, 4],
        ],
        receiverUndefined: true,
      });
      expect(step(r, "passing test")).toEqual({
        step: "passing test",
        isIndexSet: true,
        count: 2,
        hasOne: true,
        hasThree: true,
        hasTwo: false,
        first: 2,
        none: true,
        yes: true,
        no: false,
      });
      expect(step(r, "comparator")).toEqual({
        step: "comparator",
        sorted: ["gamma", "delta", "beta", "alpha"],
        pairs: [
          ["one", 1],
          ["two", 2],
        ],
      });
      expect(step(r, "explicit")).toEqual({
        step: "explicit",
        seen: [0, 1, 2, 3, 3, 2, 1, 0],
        description: true,
        expression: "value:x",
        expressionNull: "value:null",
        defaultTypes: true,
        same: true,
      });
      // A block's recorded signature types a call from JavaScript, out-parameters included.
      expect(step(r, "invoke")).toEqual({
        step: "invoke",
        compare: [-1, 1],
        stopBefore: false,
        stopAfter: true,
        omitted: { threw: false },
        fromFramework: "got:z",
        selector: "function",
        tooMany: {
          threw: true,
          isTypeError: true,
          message: expect.stringMatching(/block q@\?@@: expected 2 argument\(s\), got 3/),
        },
        notBlockClass: "function",
      });
      // Nothing runs before the loop turns; then the operation, the performBlock: and the timer all do.
      expect(step(r, "run loop")).toEqual({
        step: "run loop",
        before: { operation: 0, performed: 0, timers: 0 },
        operation: 1,
        performed: 1,
        timers: ["__NSCFTimer"],
        timerValid: false,
      });
      expect(step(r, "animation")).toEqual({
        step: "animation",
        syncContexts: ["NSAnimationContext", "NSAnimationContext"],
        syncCompleted: 0,
        completed: 1,
      });
      expect(step(r, "throws")).toEqual({
        step: "throws",
        // The throw set *stop, so the block ran once; the misfit return read as NO.
        calls: 1,
        matched: 0,
        uncaught: ["thrown in block", "block B@?@Q^B: must return a boolean (B), got a string"],
      });
      // Releasing the block's only reference from inside its own function is safe for that call.
      expect(step(r, "release inside")).toMatchObject({
        step: "release inside",
        calls: 1,
        released: { threw: true, message: "ObjCObject has been released" },
      });
      // A background queue calling the block gets zero; the main thread reports it.
      expect(step(r, "off thread")).toEqual({
        step: "off thread",
        ran: 0,
        uncaught: [
          "objc: block v@? was called on another thread; its JavaScript function only runs on the thread that created it, so the caller received 0 / NO / nil",
        ],
      });
      const typeError = { threw: true, isTypeError: true };
      const unsupported = step(r, "unsupported types");
      expect(unsupported).toMatchObject(typeError);
      expect(unsupported.message).toStartWith(
        'objc: block type encoding "v@?@@@@@@" is not one a JavaScript function can be called through; the supported ones are ',
      );
      // The documentation lists exactly the encodings the bridge supports.
      const supported = (unsupported.message as string).split("the supported ones are ")[1].split(", ");
      const docs = readFileSync(join(import.meta.dir, "../../../../docs/runtime/appkit.mdx"), "utf8");
      const documented = [...docs.matchAll(/^\| `([^`]*@\?[^`]*)` +\|/gm)].map(m => m[1]);
      expect(documented).toEqual(supported);
      expect(step(r, "no block marker")).toMatchObject({
        ...typeError,
        message:
          'objc: block type encoding "v@:" must start with the return type followed by "@?" for the block itself',
      });
      expect(step(r, "invalid types")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/^objc: block type encoding "\{\{" is not a valid type encoding \(/),
      });
      expect(step(r, "not a function")).toMatchObject({
        ...typeError,
        message: "objc.block(fn, types): fn must be a function",
      });
      expect(step(r, "types not a string")).toMatchObject({
        ...typeError,
        message: "objc.block(fn, types): types must be a string",
      });
      expect(step(r, "unsupported known")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(
          /enumerateSubstringsInRange:options:usingBlock:\]: argument 2 takes a block of type v@\?@\{_NSRange=QQ\}\{_NSRange=QQ\}\^B, which is not one a JavaScript function can be called through/,
        ),
      });
      expect(step(r, "unknown selector")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(
          /loadValuesAsynchronouslyForKeys:completionHandler:\]: argument 1 is a block whose type the bridge does not know for this method; pass objc\.block\(fn, types\)/,
        ),
      });
      expect(step(r, "not a block object")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(
          /enumerateObjectsUsingBlock:\]: argument 0 must be a function or a block made with objc\.block\(\) \(@\?\), got an object of class NSObject/,
        ),
      });
      // The bridge knows -[NSArray enumerateObjectsUsingBlock:] takes v@?@Q^B, and the block says what it is.
      expect(step(r, "wrong block type")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(
          /enumerateObjectsUsingBlock:\]: argument 0 must be a block of type v@\?@Q\^B, got a block of type q@\?@@$/,
        ),
      });
      // -[NSOperation completionBlock] runs on a secondary thread, so the bridge does not offer it.
      // A property setter BridgeSupport omits, read from the header: accepted (an unstarted operation never calls it).
      expect(step(r, "completion block")).toEqual({ step: "completion block", threw: false });
      expect(step(r, "invoke non-block")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/-\[NSObject invoke\]: unrecognized selector|does not respond/),
      });
      expect(step(r, "message to block")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/Block__ className\]: the receiver is a block/),
      });
      expect(step(r, "null block")).toMatchObject({ threw: true, code: "ERR_OBJC_EXCEPTION" });
      // Two functions go once their blocks are released (one on a background thread); the third once Foundation lets go.
      expect(step(r, "lifetime")).toEqual({ step: "lifetime", whileHeld: 2, afterRemoval: 3 });
      expect(step(r, "done")).toEqual({ step: "done" });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "objc: out-parameters, constants, enums, one handle per object, inspect, in/keys, using, for...of, NSData/NSDate",
    async () => {
      const r = await runFixture("objc-ergonomics.ts", { timeoutMs: 40_000 });
      if (r.skipped) return;
      // NSError ** is filled on failure and left nil on success; a plain {} works like objc.out().
      expect(step(r, "out error"), r.stderr).toEqual({
        step: "out error",
        failed: null,
        errorClass: true,
        domain: "NSCocoaErrorDomain",
        code: 260,
        plainCode: 260,
        unusedIsNull: true,
        rootIsDictionary: true,
        withNull: null,
        omitted: null,
      });
      // Only out-parameters may be left off; anything else is still counted.
      expect(step(r, "omitted non-out")).toMatchObject({
        threw: true,
        isTypeError: true,
        message: expect.stringMatching(/compare:\]: expected 1 argument\(s\), got 0/),
      });
      expect(step(r, "out scalars")).toEqual({
        step: "out scalars",
        scanned: [true, true, true, true],
        d: 3.25,
        q: -17,
        hex: 255,
        word: "word",
        again: false,
        exhausted: 7.5,
      });
      expect(step(r, "out struct")).toEqual({
        step: "out struct",
        font: null,
        range: { location: 0, length: 5 },
        lineEnd: 3,
      });
      // A defined method sees the caller's initial value and the caller sees what it wrote.
      expect(step(r, "out defined")).toEqual({
        step: "out defined",
        counter: 42,
        wasNull: true,
        text: "filled",
        textIsString: true,
        withNull: true,
        presetReadsNull: true,
        frame: { origin: { x: 1, y: 2 }, size: { width: 42, height: 4 } },
      });
      const typeError = { threw: true, isTypeError: true };
      expect(step(r, "out number")).toMatchObject({ ...typeError, message: expect.stringMatching(/objc\.out\(\)/) });
      expect(step(r, "out handle")).toMatchObject({ ...typeError, message: expect.stringMatching(/objc\.out\(\)/) });
      expect(step(r, "out bad initial")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/scanDouble:\]: argument 0 must be a number \(d\), got a string/),
      });
      // C arrays and buffers (declared as arrays in the SDK, const pointers, non-const char *) take only null.
      for (const [name, pattern] of [
        ["array objects", /getObjects:range:\]: argument 0 must be null, .*C array.*bun:ffi.*, got an object/],
        ["array unichar", /getCharacters:range:\]: argument 0 .*bun:ffi/],
        ["array char", /getCString:maxLength:encoding:\]: argument 0 .*bun:ffi.*, got a string/],
        ["array const", /arrayWithObjects:count:\]: argument 0 .*bun:ffi/],
        ["array no count", /getComponents:\]: argument 0 .*bun:ffi/],
        ["array read", /read:maxLength:\]: argument 0 .*bun:ffi/],
      ] as const) {
        expect(step(r, name)).toMatchObject({ ...typeError, message: expect.stringMatching(pattern) });
      }
      expect(step(r, "array null")).toEqual({
        step: "array null",
        getCharacters: undefined,
        constChar: "hi",
        utf8: "abc",
      });
      // A class cluster's alloc is sent when the init is looked up, but the handle stays an alloc until an init succeeds.
      expect(step(r, "cluster bad init")).toMatchObject({
        ...typeError,
        message: expect.stringMatching(/initWithString:\]: expected 1 argument\(s\), got 0/),
      });
      expect(step(r, "cluster not initialized")).toMatchObject({
        ...typeError,
        message: "this object came from alloc(); call an init… method on it first",
      });
      expect(step(r, "cluster alloc")).toEqual({
        step: "cluster alloc",
        inspect: "[objc NSAttributedString alloc]",
        keys: 0,
        length: 2,
        consumed: true,
      });
      expect(step(r, "constants")).toEqual({
        step: "constants",
        fontAttribute: "NSFont",
        didResize: "NSWindowDidResizeNotification",
        runLoopMode: "kCFRunLoopDefaultMode",
        cached: true,
        viaFunction: true,
        weightRegular: 0,
        weightBoldPositive: true,
        typed: 0,
        noIntrinsicMetric: -1,
        zeroRect: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
        zeroSize: { width: 0, height: 0 },
        string: "[objc.constants]",
        afterUsing: "NSFont",
        otherFramework: "vide",
      });
      const wider = step(r, "constants wider");
      expect(wider).toMatchObject({
        step: "constants wider",
        since1970: 978307200,
        pageSize: true,
        identity: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        debugEnabled: false,
        callbacks: { threw: true, isTypeError: true },
        stdinp: { threw: true, isTypeError: true },
        environ: { threw: true, isTypeError: true },
        explicit: { threw: true, isTypeError: true },
      });
      expect(wider.callbacks.message).toBe(
        'objc: the constant NSObjectMapKeyCallBacks does not hold an Objective-C object; pass its C type, as in objc.constant("NSObjectMapKeyCallBacks", { type: "d" }) for a double or { type: "{CGRect=dddd}" } for a struct',
      );
      expect(step(r, "structs")).toEqual({
        step: "structs",
        identityKeys: "m11,m12,m13,m14,m21,m22,m23,m24,m31,m32,m33,m34,m41,m42,m43,m44",
        identityDiagonal: [1, 1, 1, 1],
        moved: [5, 6, 7],
        spread: 9,
        cmTime: [90, 30, 1, 0],
        cmTimeText: true,
        rangeFromArray: { location: 3, length: 4 },
        badLength: {
          threw: true,
          isTypeError: true,
          message:
            "-[CALayer setTransform:]: argument 0 must be a {m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44} object ({CATransform3D=dddddddddddddddd}), 16 of them, got an array of 3",
        },
        badMember: {
          threw: true,
          isTypeError: true,
          code: "ERR_INVALID_ARG_TYPE",
          message: "+[NSValue valueWithCMTime:] argument 0.[1] must be a number",
        },
        badBigint: {
          threw: true,
          isTypeError: true,
          message:
            "+[NSValue valueWithCMTime:]: argument 0 must be an array of 4 numbers ({?=qiIq}) with [1] from -2147483648 to 2147483647, got 1099511627776",
        },
        fraction: {
          threw: true,
          isTypeError: true,
          message:
            "+[NSValue valueWithRange:]: argument 0 must be a {location, length} object ({_NSRange=QQ}) with location an integer from 0 to 2^53, or a bigint, got location 1.5",
        },
      });
      // An object constant is read each time, so one that was nil earlier is the object once it exists.
      expect(step(r, "NSApp")).toEqual({ step: "NSApp", early: true, now: true });
      expect(step(r, "constant unknown")).toMatchObject({
        ...typeError,
        message:
          'objc: no constant named "NSDefinitelyNotAConstant" is exported by AppKit, Foundation or any other library loaded in the process',
      });
      expect(step(r, "constant function")).toMatchObject({
        ...typeError,
        message: "objc: NSBeep is a function, not a constant; call it through bun:ffi",
      });
      expect(step(r, "constant prototype name")).toMatchObject({
        ...typeError,
        message:
          'objc: no constant named "constructor" is exported by AppKit, Foundation or any other library loaded in the process',
      });
      expect(step(r, "constant void")).toMatchObject({
        ...typeError,
        message: "constant NSFontAttributeName: cannot be read as nothing (v)",
      });
      expect(step(r, "constant bad name")).toMatchObject(typeError);
      expect(step(r, "constants read-only")).toMatchObject(typeError);
      expect(step(r, "enums")).toEqual({
        step: "enums",
        titled: 1,
        resizable: 8,
        fullName: 32768,
        flat: 1,
        keyDown: 10,
        png: 4,
        kvoNew: 1,
        byWordWrapping: 0,
        centerMatches: true,
        stateOn: 1,
        stateMixed: -1,
        modalOK: 1,
        upArrow: 0xf700,
        utf8: 4,
        undefinedComponent: true,
        notFound: true,
        frozen: true,
        has: [true, true, false],
        // Five members, each under its short and its full name.
        keyCount: 10,
        same: true,
        tag: "[object NSWindowStyleMask]",
        windowMask: 1,
      });
      // The prefix a short name drops is the part shared with the type name (plurals count);
      // a leading acronym is lower-cased whole; members outside the pattern keep only the full name.
      expect(step(r, "enum names")).toEqual({
        step: "enum names",
        byTruncatingTail: 4,
        initial: 4,
        jpeg2000: 5,
        slideUp: 16,
        dtdKind: 8,
        scaleToFitFull: 1,
        scaleAxesIndependently: 1,
        scaleToFitShort: false,
        layerLeftEdge: 1,
        kCALayerLeftEdge: 1,
        constraintMinX: 0,
        bgra8Unorm: 80,
        depth32Float: 252,
        edgeMask: true,
      });
      expect(step(r, "enum unknown")).toMatchObject({
        ...typeError,
        message:
          'objc.enums: no enum or constant named "NSDefinitelyNotAnEnum" in the Foundation, AppKit, QuartzCore or Metal headers',
      });
      expect(step(r, "enum prototype name")).toMatchObject({
        ...typeError,
        message:
          'objc.enums: no enum or constant named "hasOwnProperty" in the Foundation, AppKit, QuartzCore or Metal headers',
      });
      expect(step(r, "enums read-only")).toMatchObject(typeError);
      // The same object read twice is the same JavaScript object; a class is always the class handle.
      expect(step(r, "identity")).toEqual({
        step: "identity",
        element: true,
        window: true,
        classFromMessage: true,
        classFromArray: true,
        classTag: "[object ObjCClass]",
        self: true,
        receiver: true,
        afterRelease: true,
        same: [true, false, false],
      });
      // An argument's own `value` (a -value method, a frozen record) is not mistaken for an out-parameter.
      expect(step(r, "value arguments")).toEqual({
        step: "value arguments",
        queryItem: false,
        frozen: false,
        stillItem: "b",
      });
      expect(step(r, "inspect")).toEqual({
        step: "inspect",
        string: expect.stringMatching(/^\[objc \w*String: hi\]$/),
        util: expect.stringMatching(/^\[objc \w*String: hi\]$/),
        klass: "[objc class NSString]",
        released: "[objc released]",
        alloc: "[objc NSString alloc]",
        custom: expect.stringMatching(/^\[objc \w*String: hi\]$/),
        inArray: "[\n  [objc class NSString]\n]",
      });
      expect(step(r, "traps")).toEqual({
        step: "traps",
        hasCount: true,
        hasSetter: true,
        hasNope: false,
        hasThen: false,
        hasMsgSend: true,
        hasPointer: true,
        hasIterator: true,
        objectHasIterator: false,
        classHasRelease: false,
        keysIncludeCount: true,
        keysExcludePrivate: true,
        keysUnique: true,
        manyKeys: true,
        classKeys: true,
        descriptor: "function",
        releasedHas: false,
        releasedKeys: 0,
      });
      expect(step(r, "dispose")).toEqual({
        step: "dispose",
        use: { threw: true, isTypeError: false, code: "ERR_INVALID_STATE", message: "ObjCObject has been released" },
        classDispose: "undefined",
        sameHandle: true,
        stillUsable: { threw: false, value: 4 },
        afterTwoReleases: true,
      });
      // Boxed integers keep 64 bits: bigint above 2^53 like every other integer the bridge returns.
      expect(step(r, "numbers")).toEqual({
        step: "numbers",
        notFound: true,
        maxUnsigned: "18446744073709551615",
        maxUnsignedType: "bigint",
        small: 3,
        negative: -7,
        fraction: 2.5,
        unsignedType: "Q",
        bool: true,
        json: '{"n":12}',
      });
      expect(step(r, "iterate")).toEqual({
        step: "iterate",
        array: ["a", "b", "c"],
        dictionary: ["x", "y"],
        set: ["p", "q"],
        indexes: [0, 2],
        emptyIndexes: [],
        enumerator: ["c", "b", "a"],
        arrayFrom: ["a", "b", "c"],
        identity: true,
      });
      expect(step(r, "iterate object")).toMatchObject({ ...typeError, message: expect.stringMatching(/iterable/) });
      expect(step(r, "data date")).toEqual({
        step: "data date",
        dataClass: true,
        dataLength: 3,
        back: "1,2,3",
        dateClass: true,
        seconds: 1,
        date: 1000,
        argument: 2000,
        nestedDate: 0,
        nestedBuffer: "9",
        nestedView: "7,8",
        empty: 0,
        json: '{"when":"1970-01-01T00:00:00.000Z"}',
      });
      expect(step(r, "done")).toEqual({ step: "done" });
      expect(r.signal).toBeNull();
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent(
    "objc: Foundation in a Worker, the classes it is refused there, both threads at once, and a Worker terminated mid-send",
    async () => {
      const r = await runFixture("objc-threads.ts", { timeoutMs: 60_000 });
      if (r.skipped) return;
      const mainThreadOnly = (cls: string) => ({
        threw: true,
        code: "ERR_INVALID_STATE",
        message: expect.stringMatching(
          new RegExp(`^objc: ${cls} can only be used on the process's main thread, not in a Worker: `),
        ),
      });
      expect(step(r, "worker foundation"), r.stderr).toEqual({
        step: "worker foundation",
        // Cocoa is in multithreaded mode before either thread uses it.
        multiThreaded: true,
        workerMultiThreaded: true,
        string: { js: "from a worker", length: 13, sameHandle: true },
        array: ["a", 2, true],
        fileExists: { execPath: true, nowhere: false },
        defaults: { nested: [1, "two"] },
        json: { parsed: { k: [1, 2, 3] }, nonEmpty: true, failed: null, error: "NSCocoaErrorDomain" },
        // A bare function passed for a known block parameter, made and called on the Worker's thread.
        block: [
          ["a", 0],
          [2, 1],
        ],
        // The Worker defined the name first and still got a numbered one; the plain name went to the main thread after.
        defined: { name: expect.stringMatching(/^FixtureSharedName_\d+$/), tag: 2, isKind: true },
        mainClass: "FixtureSharedName",
        mainTag: 1,
        // objc.target() in the Worker: the process's one target class, the function run on the Worker.
        target: { className: expect.stringMatching(/^BunScriptObject\d+$/), actions: 1 },
        sameTargetClass: true,
        refused: {
          windowAlloc: mainThreadOnly("NSWindow \\(a kind of NSResponder\\)"),
          viewNew: mainThreadOnly("NSView \\(a kind of NSResponder\\)"),
          menuClass: mainThreadOnly("NSMenu"),
          subclass: mainThreadOnly("NSView \\(a kind of NSResponder\\)"),
          color: { threw: false, value: expect.stringMatching(/Color/) },
        },
      });
      // Each thread read back only its own 300 strings; one object is one handle per thread.
      expect(step(r, "concurrent")).toEqual({
        step: "concurrent",
        main: { count: 300, own: 300 },
        worker: { count: 300, own: 300 },
        processInfo: { mainSame: true, workerSame: true, sameObject: true },
        // A class the main thread defined cannot be the superclass of one a Worker defines.
        subclass: {
          threw: true,
          code: "ERR_INVALID_STATE",
          message: expect.stringMatching(
            /superclass is a script-defined class whose methods do not run on this thread/,
          ),
        },
      });
      // The terminated Worker's blocks (called on a dispatch queue's thread, then on the main
      // thread) and class do nothing and answer zero from then on; stderr says why once, in all.
      expect(step(r, "terminated")).toEqual({ step: "terminated", after: "still here", mainTag: 1, orphan: [0, 0] });
      expect(r.stderr.match(/was called after the thread that created it/g) ?? []).toHaveLength(1);
      expect(r.stderr).toContain("objc: block v@?@ was called after the thread that created it exited");
      expect(r.exitCode).toBe(0);
    },
  );

  test.concurrent("bad prop values throw TypeErrors that name the prop; misuse of the tree throws", async () => {
    const r = await runFixture("errors.ts");
    if (r.skipped) return;
    for (const [name, prop] of [
      ["slider.value=string", "value"],
      ["text.lineLimit=object", "lineLimit"],
      ["button.bezelStyle=bogus", "bezelStyle"],
    ] as const) {
      const e = step(r, name);
      expect(e).toMatchObject({ step: name, threw: true, isTypeError: true });
      expect(e.message).toContain(prop);
    }
    // The common props of a bridge-built control are checked natively and still name the element.
    expect(step(r, "button.width=string")).toMatchObject({
      threw: true,
      isTypeError: true,
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(step(r, "button.width=string").message).toStartWith("Button.width must be");
    expect(step(r, "switch.hidden=string")).toMatchObject({
      threw: true,
      isTypeError: true,
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(step(r, "switch.hidden=string").message).toStartWith("Switch.hidden must be");
    expect(step(r, "text.background=badcolor")).toMatchObject({ threw: true });
    expect(step(r, "text.background=badcolor").message).toMatch(/colou?r/i);
    expect(step(r, "text.background=rgb(nan)")).toMatchObject({
      threw: true,
      isTypeError: true,
      code: "ERR_INVALID_ARG_VALUE",
    });
    expect(step(r, "text.background=rgb(nan)").message).toMatch(/colou?r/i);
    expect(step(r, "slider.step=-1")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "slider.step=-1").message).toMatch(/positive/);
    expect(step(r, "text.font.size=Infinity")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "text.font.size=Infinity").message).toMatch(/positive/);
    expect(step(r, "abstract View")).toMatchObject({ threw: true });
    expect(step(r, "method as prop")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "method as prop").message).toBe('Unknown property "click" for Button');
    expect(step(r, "unregistered prop")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "unregistered prop").message).toBe('Unknown property "kind" for Text');
    expect(step(r, "getter as prop")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "getter as prop").message).toBe('Unknown property "frame" for Text');
    expect(step(r, "subclass props")).toEqual({ step: "subclass props", threw: false });
    // Tree state (wrong parent, not a child) is ERR_INVALID_STATE; a wrong argument is a TypeError.
    const badState = { threw: true, isTypeError: false, code: "ERR_INVALID_STATE" };
    expect(step(r, "append twice")).toMatchObject(badState);
    expect(step(r, "append twice").message).toMatch(/parent/i);
    expect(step(r, "removeChild stranger")).toMatchObject(badState);
    for (const name of [
      "insertBefore stranger ref",
      "insertBefore move stranger ref",
      "replaceChildren foreign child",
    ]) {
      expect(step(r, name)).toMatchObject({ step: name, ...badState });
    }
    for (const name of ["replaceChildren duplicate", "replaceChildren non-view"]) {
      expect(step(r, name)).toMatchObject({ step: name, threw: true, isTypeError: true });
    }
    expect(step(r, "tree after rejected edits")).toEqual({
      step: "tree after rejected edits",
      a: ["x"],
      b: ["first"],
      textParent: true,
      firstParent: true,
    });
    expect(step(r, "image missing file")).toMatchObject({
      threw: true,
      isTypeError: false,
      path: "/definitely/missing.png",
    });
    expect(step(r, "valid props")).toEqual({ step: "valid props", threw: false });
    expect(step(r, "window x without y")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window x without y").message).toMatch(/together/);
    expect(step(r, "restoreName after close")).toMatchObject({ threw: false });
    expect(step(r, "window show option")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window show option").message).toBe('Unknown Window option "show"');
    expect(step(r, "unknown window option")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "unknown window option").message).toBe('Unknown Window option "bogus"');
    expect(step(r, "unknown window option leak")).toEqual({ step: "unknown window option leak", leaked: 0 });
    expect(step(r, "window bad handler")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window bad handler").message).toBe("Window.onClose must be a function");
    expect(step(r, "window bad handler leak")).toEqual({ step: "window bad handler leak", leaked: 0 });
    expect(step(r, "window bad content")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window bad content").message).toBe("Window.content must be a View or null");
    expect(step(r, "window bad content leak")).toEqual({ step: "window bad content leak", leaked: 0 });
    expect(step(r, "window width NaN")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window width NaN").message).toMatch(/finite/);
    expect(step(r, "window width NaN leak")).toEqual({ step: "window width NaN leak", leaked: 0 });
    expect(step(r, "window x Infinity")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window x Infinity").message).toMatch(/finite/);
    expect(step(r, "window width 3e9")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window width 3e9").message).toMatch(/Window\.width must be .*no larger than/);
    expect(step(r, "window width 3e9 leak")).toEqual({ step: "window width 3e9 leak", leaked: 0 });
    expect(step(r, "window released content")).toMatchObject({ threw: true, code: "ERR_INVALID_STATE" });
    expect(step(r, "window released content").message).toMatch(/released/);
    expect(step(r, "window released content onClose")).toBeUndefined();
    expect(step(r, "window released content leak")).toEqual({ step: "window released content leak", leaked: 0 });
    expect(step(r, "window x 1e15")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "window x 1e15").message).toMatch(/Window\.x must be .*no larger than/);
    expect(step(r, "shown text width 3e9")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "shown text width 3e9").message).toMatch(/Text\.width must be .*no larger than/);
    expect(step(r, "window resizable=string")).toMatchObject({
      threw: true,
      isTypeError: true,
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(step(r, "window resizable=string").message).toStartWith("Window.resizable must be");
    const closedWindow = { threw: true, isTypeError: false, code: "ERR_INVALID_STATE" };
    expect(step(r, "hide after close")).toMatchObject(closedWindow);
    expect(step(r, "hide after close").message).toMatch(/closed/);
    expect(step(r, "title after close")).toMatchObject(closedWindow);
    expect(step(r, "resizable after close")).toMatchObject(closedWindow);
    expect(step(r, "content after close")).toMatchObject(closedWindow);
    expect(step(r, "content after close").message).toMatch(/closed/);
    expect(step(r, "content after close state")).toEqual({ step: "content after close state", content: true });
    expect(step(r, "menu action without colon")).toMatchObject({ threw: true, isTypeError: true });
    expect(step(r, "menu action without colon").message).toMatch(/selector/);
    // Any one-argument action method is a menu action; AppKit validates it against the responder chain.
    expect(step(r, "menu action outside the standard list")).toEqual({
      step: "menu action outside the standard list",
      threw: false,
    });
    const badType = { threw: true, isTypeError: true, code: "ERR_INVALID_ARG_TYPE" };
    const badValue = { threw: true, isTypeError: true, code: "ERR_INVALID_ARG_VALUE" };
    expect(step(r, "metal.clearColor=number")).toMatchObject({
      ...badType,
      message: "MetalView.clearColor must be a color string or null",
    });
    expect(step(r, "metal.clearColor=bogus")).toMatchObject({
      ...badValue,
      message: 'MetalView.clearColor: invalid color "bogus"',
    });
    expect(step(r, "metal.clearColor=rgb(nan)")).toMatchObject(badValue);
    expect(step(r, "metal.running=string")).toMatchObject(badType);
    expect(step(r, "metal.running=string").message).toStartWith("MetalView.running must be");
    expect(step(r, "metal.preferredFPS=string")).toMatchObject(badType);
    expect(step(r, "metal.preferredFPS=string").message).toStartWith("MetalView.preferredFPS must be");
    expect(step(r, "metal.onFrame=number")).toMatchObject({
      threw: true,
      isTypeError: true,
      message: "MetalView.onFrame must be a function",
    });
    expect(step(r, "metal props")).toEqual({
      step: "metal props",
      afterRejected: "#0000ff",
      accepted: {
        red: "red",
        " windowBackground ": " windowBackground ",
        "rgba(0, 0, 255, 0.5)": "rgba(0, 0, 255, 0.5)",
        "#fff": "#fff",
        null: "#000000",
      },
      running: true,
      preferredFPS: 30,
      onFrame: null,
      unknown: 'Unknown property "colour" for MetalView',
    });
    expect(r.exitCode).toBe(0);
  });

  describe("metal", () => {
    // These need a Metal device. On machines without one (VMs, sandboxes) each fixture prints
    // {step:"skip-no-gpu"} and its GPU assertions are skipped; metal-struct.ts is pure layout
    // arithmetic and always asserts.
    const noGpu = (r: FixtureResult, name: string) => {
      if (!step(r, "skip-no-gpu")) return false;
      console.warn(`${name}: no Metal device here, GPU assertions skipped`);
      expect(r.exitCode).toBe(0);
      return true;
    };

    test.concurrent("gpu.struct lays fields out by MSL rules and packs values", async () => {
      const r = await runFixture("metal-struct.ts");
      if (r.skipped) return;
      expect(step(r, "layout"), r.stderr).toEqual({
        step: "layout",
        offsets: { a: 0, b: 16, c: 32 },
        sizes: { a: 4, b: 16, c: 64 },
        size: 96,
        align: 16,
        msl: "struct Uniforms {\n  float a;\n  float3 b;\n  float4x4 c;\n};",
        name: "Uniforms",
      });
      expect(step(r, "mixed")).toEqual({
        step: "mixed",
        fields: {
          m2: [0, 16, 8],
          h: [16, 2, 2],
          h3: [24, 8, 8],
          u: [32, 4, 4],
          flag: [36, 1, 1],
          m3: [48, 48, 16],
          s: [96, 2, 2],
          i2: [104, 8, 8],
        },
        size: 112,
        align: 16,
        firstLine: "struct Mixed {",
      });
      expect(step(r, "pack")).toEqual({
        step: "pack",
        isArrayBuffer: true,
        byteLength: 96,
        a: 1.5,
        b: [1, 2, 3, 0],
        diagonal: [1, 1, 1, 1],
      });
      expect(step(r, "pack into")).toEqual({ step: "pack into", same: true, before: [7, 7], a: 7, b: [9, 8, 7, 7] });
      expect(step(r, "pack mixed")).toEqual({
        step: "pack mixed",
        h: 0.5,
        h3: [1, 2, 3],
        u: [1, 2, 3, 255],
        flag: 1,
        s: -2,
        i2: [-1, 1],
        m3: [1, 4, 7],
      });
      for (const [name, pattern] of [
        ["unknown type", /"a".*float5/],
        ["no fields", /at least one field/],
        ["bad name", /identifier/],
        ["wrong length", /Uniforms\.b .*3.*float3.*got 2/],
        ["unknown field", /nope/],
        ["scalar as string", /Uniforms\.a must be a number/],
      ] as const) {
        expect(step(r, name)).toMatchObject({ step: name, threw: true, isTypeError: true });
        expect(step(r, name).message).toMatch(pattern);
      }
      expect(step(r, "too small")).toMatchObject({ threw: true, isTypeError: false });
      expect(step(r, "too small").message).toMatch(/do not fit/);
      expect(r.exitCode).toBe(0);
    });

    test.concurrent("offscreen render pass draws a triangle that readPixels sees; errors are typed", async () => {
      const r = await runFixture("metal-triangle.ts");
      if (r.skipped || noGpu(r, "metal-triangle.ts")) return;
      expect(step(r, "device"), r.stderr).toEqual({ step: "device", name: "string", unifiedMemory: "boolean" });
      expect(step(r, "library")).toEqual({ step: "library", names: ["red", "vs"] });
      expect(step(r, "objects")).toEqual({
        step: "objects",
        texture: { width: 64, height: 64, format: "bgra8unorm" },
        pipeline: { colorFormats: ["bgra8unorm"], depthFormat: null },
      });
      // BGRA bytes: the triangle is red, the untouched corner is the blue clear colour.
      expect(step(r, "pixels")).toEqual({
        step: "pixels",
        byteLength: 64 * 64 * 4,
        center: [0, 0, 255, 255],
        corner: [255, 0, 0, 255],
        committed: true,
      });
      expect(step(r, "use after commit")).toMatchObject({ threw: true });
      expect(step(r, "use after commit").message).toMatch(/committed/);
      expect(step(r, "buffer")).toEqual({
        step: "buffer",
        byteLength: 8,
        roundTrip: [1, 2, 3, 4, 5, 6, 7, 8],
        tail: [7, 8],
      });
      expect(step(r, "buffer write out of bounds")).toMatchObject({ threw: true });
      expect(step(r, "compile error")).toMatchObject({
        threw: true,
        name: "GpuCompileError",
        isCompileError: true,
        message: expect.stringMatching(/error/i),
      });
      const missing = step(r, "no such function");
      expect(missing).toMatchObject({ threw: true });
      expect(missing.message).toContain("missing");
      expect(missing.message).toContain("vs");
      expect(step(r, "draw without pipeline")).toMatchObject({ threw: true });
      expect(step(r, "draw without pipeline").message).toMatch(/pipeline/i);
      expect(step(r, "function types")).toEqual({
        step: "function types",
        vs: "vertex",
        red: "fragment",
        noop: "kernel",
      });
      expect(step(r, "after commitAndWait")).toEqual({
        step: "after commitAndWait",
        state: "committed",
        gpuStatus: "completed",
        error: null,
        inFlight: false,
      });
      // BGRA: cleared to green; readPixels waited for the un-waited commit by itself.
      expect(step(r, "commit then read")).toEqual({
        step: "commit then read",
        corner: [0, 255, 0, 255],
        gpuStatus: "completed",
      });
      expect(step(r, "two vertex buffers")).toEqual({ step: "two vertex buffers", center: [0, 255, 0, 255] });
      // A colour string clears like the array form (BGRA bytes); a bad one is refused before anything is encoded.
      expect(step(r, "string clear")).toEqual({
        step: "string clear",
        red: [0, 0, 255, 255],
        white: [255, 255, 255, 255],
      });
      expect(step(r, "bad clear string")).toMatchObject({
        threw: true,
        isTypeError: true,
        code: "ERR_INVALID_ARG_VALUE",
        message: 'frame.renderPass() clear: invalid color "nope"',
      });
      expect(step(r, "attribute described twice")).toMatchObject({ threw: true, isCompileError: true });
      expect(step(r, "bind offset equal to length")).toMatchObject({ threw: true, isRangeError: true });
      expect(step(r, "bind offset misaligned")).toMatchObject({ threw: true, isTypeError: true });
      expect(step(r, "kernel as vertex function")).toMatchObject({ threw: true, isTypeError: true });
      expect(step(r, "kernel as vertex function").message).toMatch(/vertex/);
      expect(step(r, "vertex function as kernel")).toMatchObject({ threw: true, isTypeError: true });
      expect(step(r, "destroyed")).toEqual({ step: "destroyed", destroyed: true, byteLength: 0 });
      expect(step(r, "write after destroy")).toMatchObject({
        threw: true,
        isTypeError: false,
        code: "ERR_INVALID_STATE",
        message: expect.stringMatching(/destroyed/),
      });
      expect(step(r, "bytesPerRow not whole pixels")).toMatchObject({ threw: true, isTypeError: true });
      expect(step(r, "mipmaps of an integer format")).toMatchObject({ threw: true, isTypeError: true });
      // A few earlier attempts leave frames open until they are collected.
      const limit = step(r, "open frame limit");
      expect(limit.opened).toBeLessThanOrEqual(32);
      expect(limit.opened).toBeGreaterThan(20);
      expect(limit.threw).toMatch(/frames are open/);
      expect(r.exitCode).toBe(0);
    });

    test.concurrent("compute pass doubles a Float32Array in shared and private buffers", async () => {
      const r = await runFixture("metal-compute.ts");
      if (r.skipped || noGpu(r, "metal-compute.ts")) return;
      expect(step(r, "pipeline"), r.stderr).toEqual({ step: "pipeline", widthPositive: true, maxAtLeastWidth: true });
      expect(step(r, "doubled")).toEqual({ step: "doubled", values: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] });
      expect(step(r, "private")).toEqual({
        step: "private",
        storage: "private",
        values: [20, 40, 60, 80, 100, 120, 140, 160, 180, 200],
      });
      // `buffer` held the doubled values (the x10 pass ran on the private copy); the x0.5 pass was
      // committed without waiting and read() waited for it by itself.
      expect(step(r, "read after commit")).toEqual({
        step: "read after commit",
        values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        inFlightAfter: false,
      });
      expect(step(r, "managed alias")).toEqual({ step: "managed alias", storage: "shared" });
      expect(r.exitCode).toBe(0);
    });

    test.concurrent("MetalView.draw() runs onFrame with a frame and timing info", async () => {
      const r = await runFixture("metal-view.ts");
      if (r.skipped) return;
      const constructed = step(r, "constructed");
      expect(constructed, r.stderr).toMatchObject({ step: "constructed", sameGpu: true, running: false });
      if (!constructed.available) {
        // Without a device the view is a placeholder: it lays out but never produces frames.
        expect(step(r, "no-gpu")).toEqual({ step: "no-gpu", frames: 0, drawableSize: { width: 0, height: 0 } });
        noGpu(r, "metal-view.ts");
        return;
      }
      const frames = step(r, "frames");
      expect(frames).toMatchObject({
        step: "frames",
        count: 2,
        increasing: true,
        firstDt: 0,
        types: [
          ["number", "number", "number", "number"],
          ["number", "number", "number", "number"],
        ],
      });
      expect(frames.passes).toEqual(["ok", "ok"]);
      expect(frames.drawableSize).toEqual({ width: expect.any(Number), height: expect.any(Number) });
      expect(step(r, "cleared")).toEqual({ step: "cleared", count: 2 });
      expect(step(r, "string clear")).toEqual({
        step: "string clear",
        passes: {
          white: "ok",
          "rgba(255, 0, 0, 0.5)": "ok",
          nope: { message: 'frame.renderPass() clear: invalid color "nope"', code: "ERR_INVALID_ARG_VALUE" },
          7: {
            message: expect.stringMatching(/clear must be an \[r, g, b, a\] array or a color string/),
            code: "ERR_INVALID_ARG_TYPE",
          },
        },
        clamped: [240, 240],
        live: 24,
      });
      expect(step(r, "outside onFrame").outside).toEqual({
        message: expect.stringMatching(/onFrame/),
        code: "ERR_INVALID_STATE",
      });
      const thrown = step(r, "thrown handler");
      expect(thrown.dropped).toEqual({ committed: false, state: "dropped" });
      expect(thrown.uncaught).toEqual(["handler failed"]);
      expect(thrown.secondPass).toBe("ok");
      expect(thrown.depthPass).toBe("ok");
      // draw() inside onFrame is refused; the frame in progress carries on and no nested frame ran.
      expect(thrown.nestedDraw).toEqual({ message: expect.stringMatching(/inside/), code: "ERR_INVALID_STATE" });
      expect(thrown.afterNested).toBe("ok");
      expect(thrown.runs).toBe(1);
      expect(r.exitCode).toBe(0);
    });
  });
});

type DeclaredClass = { members: Set<string>; defaults: Record<string, unknown>; isView: boolean };

/**
 * Reads packages/bun-types/appkit.d.ts: the members each class declares
 * (own and inherited), the `@default` of each prop in its `*Props` /
 * `WindowOptions` interface where that is a plain literal, the members of
 * `App`, and the runtime exports of the module.
 */
function declaredSurface() {
  const source = readFileSync(join(import.meta.dir, "../../../../packages/bun-types/appkit.d.ts"), "utf8");
  const start = source.indexOf('declare module "bun:appkit" {');
  const lines = source.slice(start).split("\n");

  type Block = {
    kind: "class" | "interface";
    name: string;
    bases: string[];
    own: string[];
    defaults: Record<string, unknown>;
  };
  const blocks = new Map<string, Block>();
  const exports: string[] = [];
  let current: Block | null = null;
  let comment = "";
  for (const line of lines) {
    const exported = /^  export (?:const|abstract class|class|function) (\w+)/.exec(line);
    if (exported) exports.push(exported[1]);
    const open = /^  export (?:abstract )?(class|interface) (\w+)(?:<[^>]*>)?(?: extends ([\w, ]+))? \{(\})?$/.exec(
      line,
    );
    if (open) {
      const block: Block = {
        kind: open[1] as Block["kind"],
        name: open[2],
        bases: (open[3] ?? "").split(/,\s*/).filter(Boolean),
        own: [],
        defaults: {},
      };
      blocks.set(block.name, block);
      current = open[4] ? null : block;
      comment = "";
      continue;
    }
    if (!current) continue;
    if (line === "  }") {
      current = null;
      continue;
    }
    if (/^    (\/\*\*| \*)/.test(line)) {
      comment += line + "\n";
      continue;
    }
    const member = /^    (?:readonly |get |set )?(\w+)\??(?:<[^>]*>)?[:(]/.exec(line);
    if (member && member[1] !== "constructor") {
      if (!current.own.includes(member[1])) current.own.push(member[1]);
      const documented = /@default (.+?)(?:\s*\*\/)?\n/.exec(comment);
      // Only literal defaults are checked; prose ("0 once there are items") is skipped.
      if (documented && /^(?:-?\d+(?:\.\d+)?|true|false|null|"[^"]*"|\[\])$/.test(documented[1].trim())) {
        current.defaults[member[1]] = JSON.parse(documented[1].trim());
      }
    }
    comment = "";
  }

  const collect = (name: string, pick: (b: Block) => Iterable<[string, unknown]>, into: Map<string, unknown>) => {
    const block = blocks.get(name);
    if (!block) return;
    for (const base of block.bases) collect(base, pick, into);
    for (const [key, value] of pick(block)) into.set(key, value);
  };
  const isView = (name: string): boolean => name === "View" || (blocks.get(name)?.bases.some(isView) ?? false);

  const classes: Record<string, DeclaredClass> = {};
  for (const block of blocks.values()) {
    if (block.kind !== "class") continue;
    const members = new Map<string, unknown>();
    collect(block.name, b => b.own.map(m => [m, true] as [string, unknown]), members);
    const defaults = new Map<string, unknown>();
    collect(
      block.name === "Window" ? "WindowOptions" : `${block.name}Props`,
      b => Object.entries(b.defaults),
      defaults,
    );
    classes[block.name] = {
      members: new Set(members.keys()),
      defaults: Object.fromEntries(defaults),
      isView: isView(block.name),
    };
  }
  return { classes, app: new Set(blocks.get("App")?.own ?? []), exports };
}
