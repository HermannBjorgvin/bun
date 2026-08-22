// VStack, HStack, ZStack, Group, ScrollView and SplitView are NSStackView,
// NSView, NSBox, NSScrollView and NSSplitView objects built through the objc
// bridge: `.native` is that object, children are its subviews, the readable
// props answer from it, and the common props are constraints and sends on
// each child's own NSView.
import {
  app,
  Button,
  Group,
  HStack,
  objc,
  ScrollView,
  SplitView,
  Text,
  TextEditor,
  VStack,
  Window,
  ZStack,
} from "bun:appkit";
import { appKitInternals } from "bun:internal-for-testing";
import { emit, run, waitFor } from "./_util";

await run(async () => {
  app.activationPolicy = "accessory";
  const { NSStackView, NSBox, NSScrollView, NSSplitView, NSClipView, NSColor, NSColorSpace } = objc.classes;
  const { NSStackViewDistribution, NSLayoutAttribute, NSTitlePosition } = objc.enums;
  const attempt = (f: () => unknown) => {
    try {
      f();
      return null;
    } catch (e) {
      return { message: String((e as Error).message), code: (e as { code?: string }).code };
    }
  };

  // A stack's children are its arranged subviews, and its props read the
  // NSStackView, so a change made through `.native` shows.
  {
    const a = new Button("a");
    const b = new Text("b");
    const stack = new VStack({ spacing: 3, children: [a, b] });
    stack.native.setSpacing_(5);
    const distributions: unknown[] = [];
    for (const value of [
      "fillEqually",
      "gravity",
      "gravityAreas",
      "NSStackViewDistributionEqualSpacing",
      2,
      -1,
      NSStackViewDistribution.gravityAreas,
    ]) {
      stack.distribution = value as never;
      distributions.push([stack.distribution, stack.native.distribution()]);
    }
    (stack as { distribution: unknown }).distribution = null;
    const row = new HStack({ align: "lastBaseline", padding: { x: 6, y: 2 } });
    // `align` takes the curated names or any NSLayoutAttribute, and reads
    // whatever the stack's alignment now is; `padding` reads its edge insets.
    const column = new VStack();
    const aligned: unknown[] = [];
    for (const value of [
      "center",
      "trailing",
      "bottom",
      "centerX",
      NSLayoutAttribute.trailing,
      "NSLayoutAttributeRight",
    ]) {
      column.align = value as never;
      aligned.push([column.align, column.native.alignment()]);
    }
    column.native.setAlignment_(NSLayoutAttribute.centerX);
    aligned.push([column.align, column.native.alignment()]);
    (column as { align: unknown }).align = null;
    aligned.push([column.align, column.native.alignment()]);
    column.native.setEdgeInsets_({ top: 1, left: 2, bottom: 3, right: 4 });
    emit({
      step: "stack",
      isStack: stack.native.isKindOfClass_(NSStackView),
      arranged: stack.native.arrangedSubviews().count(),
      sameChild: stack.native.arrangedSubviews().objectAtIndex_(0) === a.native,
      superview: a.native.superview() === stack.native,
      spacing: stack.spacing,
      distributions,
      reset: stack.distribution === "fill" && stack.native.distribution() === NSStackViewDistribution.fill,
      vertical: stack.native.orientation() === 1 && row.native.orientation() === 0,
      alignments: [
        stack.align,
        stack.native.alignment() === NSLayoutAttribute.leading,
        row.align,
        row.native.alignment() === NSLayoutAttribute.lastBaseline,
      ],
      insets: row.native.edgeInsets(),
      padding: [row.padding, new VStack({ padding: [1, 2] }).native.edgeInsets(), new VStack().padding, column.padding],
      aligned,
      badDistribution: attempt(() => (stack.distribution = "spread" as never)),
      badNegative: attempt(() => (stack.distribution = -2)),
      badPadding: attempt(() => (row.padding = [1, 2, 3] as never)),
      badAlign: attempt(() => (row.align = "middle" as never)),
      badBaseline: attempt(() => (column.align = NSLayoutAttribute.firstBaseline)),
    });
  }

  // The common props are the child's own NSView: sizes are constraints on
  // it, the rest are its properties, read back live.
  {
    const label = new Text({ text: "sized", width: 80, minHeight: 30, tooltip: "t", id: "the-label", alpha: 0.5 });
    label.native.setToolTip_("from native");
    label.native.setHidden_(true);
    const before = label.native.constraints().count();
    label.width = 90;
    label.width = null;
    emit({
      step: "common",
      tooltip: label.tooltip,
      hidden: label.hidden,
      id: `${label.native.identifier()}`,
      alpha: label.native.alphaValue(),
      constraints: [before, label.native.constraints().count()],
      reads: [label.width, label.minHeight, label.maxWidth],
      corner: ((label.cornerRadius = 4), [label.cornerRadius, label.native.layer().cornerRadius()]),
      background: ((label.background = "red"), label.native.layer().backgroundColor() !== null),
      autoresizing: label.native.translatesAutoresizingMaskIntoConstraints(),
    });
    // A CGColorRef argument takes a CGColor object and nothing else: not a
    // boxed string or number, and not another Core Foundation type.
    const layer = label.native.layer();
    layer.setBackgroundColor_(null);
    emit({
      step: "cgcolor",
      cleared: layer.backgroundColor(),
      string: attempt(() => layer.setBackgroundColor_("red")),
      number: attempt(() => layer.setBackgroundColor_(42)),
      array: attempt(() => layer.setBackgroundColor_([1, 0, 0])),
      nscolor: attempt(() => layer.setBackgroundColor_(NSColor.redColor())),
      colorSpace: attempt(() => layer.setBackgroundColor_(NSColorSpace.sRGBColorSpace().CGColorSpace())),
      set: (layer.setBackgroundColor_(NSColor.redColor().CGColor()), layer.backgroundColor() !== null),
      roundTrip: (layer.setBorderColor_(layer.backgroundColor()), layer.borderColor() === layer.backgroundColor()),
    });
  }

  // What the views read for their own use (a layer, the window, a shared
  // colour, NSApp, the constraints they add) is given back, so a handle the
  // script read once ends with one release() however many props it touched.
  {
    const ended = (handle: any) => {
      handle.release();
      return attempt(() => handle.self()) !== null;
    };
    const box = new VStack({ children: [new Text("counted")] });
    const win = new Window({ title: "counts", content: box, visible: false });
    const stack = box.native;
    stack.setWantsLayer_(true);
    const layer = stack.layer();
    box.width = 120;
    const constraint = stack.constraints().lastObject();
    box.cornerRadius = 6;
    box.background = "red";
    box.border = 2;
    box.width = null;
    void [box.cornerRadius, box.frame, box.frame, box.hidden];
    const labelColor = NSColor.labelColor();
    const words = new Text({ text: "words", color: "red" });
    words.color = null;
    const nsapp = objc.classes.NSApplication.sharedApplication();
    app.menu = [{ title: "Counts", items: [{ title: "Item", onClick() {} }] }];
    app.menu = null;
    emit({
      step: "counts",
      layer: ended(layer),
      constraint: ended(constraint),
      labelColor: ended(labelColor),
      nsapp: ended(nsapp),
      // The view holds its own NSView too, so the script's one release leaves it usable.
      stackUsable: !ended(stack),
    });
    win.close();
  }

  // A Group is an NSBox around a stack; ZStack a plain NSView whose subview
  // order is the children's; ScrollView an NSScrollView whose document is
  // the child and whose clip view is flipped; SplitView an NSSplitView.
  {
    const inner = new Button("in");
    const group = new Group({ title: "Box", children: [inner] });
    group.native.setTitle_("Renamed");
    const untitled = new Group();
    // A title position chosen through `.native` survives retitling; only an
    // empty title moves it (to none) and the next title back (to the top).
    const positioned = new Group({ title: "Low" });
    positioned.native.setTitlePosition_(NSTitlePosition.belowTop);
    const kept = ((positioned.title = "Lower"), positioned.native.titlePosition());
    const none = ((positioned.title = ""), positioned.native.titlePosition());
    const top = ((positioned.title = "Back"), positioned.native.titlePosition());
    const back = new Text("back");
    const front = new Text("front");
    const layers = new ZStack({ children: [back, front] });
    const editor = new TextEditor();
    const scroll = new ScrollView({ children: [editor] });
    scroll.native.setHasHorizontalScroller_(true);
    const split = new SplitView({ children: [new Text("l"), new Text("r")] });
    split.native.setVertical_(false);
    emit({
      step: "kinds",
      group: {
        isBox: group.native.isKindOfClass_(NSBox),
        title: group.title,
        titlePositions: [
          group.native.titlePosition(),
          untitled.native.titlePosition(),
          untitled.title,
          kept,
          none,
          top,
        ],
        innerStack: inner.native.superview().isKindOfClass_(NSStackView),
        inContent: inner.native.superview().superview() === group.native.contentView(),
      },
      zstack: {
        className: `${layers.native.class()}`,
        order: [
          layers.native.subviews().objectAtIndex_(0) === back.native,
          layers.native.subviews().objectAtIndex_(1) === front.native,
        ],
        reordered: (layers.insertBefore(front, back), layers.native.subviews().objectAtIndex_(0) === front.native),
      },
      scroll: {
        isScrollView: scroll.native.isKindOfClass_(NSScrollView),
        document: scroll.native.documentView() === editor.native,
        clip: [scroll.native.contentView().isKindOfClass_(NSClipView), scroll.native.contentView().isFlipped()],
        scrollBars: scroll.scrollBars,
        second: attempt(() => scroll.append(new Text("two"))),
        badBars: attempt(() => (scroll.scrollBars = "sideways" as never)),
      },
      split: {
        isSplitView: split.native.isKindOfClass_(NSSplitView),
        vertical: split.vertical,
        panes: split.native.arrangedSubviews().count(),
      },
    });
  }

  // Containers count as live views and are collected with their children.
  {
    // Views the steps above dropped go first, so the baseline holds only what something still refers to.
    let before = -1;
    await waitFor(
      () => {
        const last = before;
        Bun.gc(true);
        before = appKitInternals.liveViews();
        return before === last;
      },
      "the live view count to settle",
      3000,
    );
    (() => {
      for (let i = 0; i < 20; i++) {
        new VStack({ children: [new Button(`b${i}`), new HStack({ children: [new Text("t")] })] });
        new Group({ children: [new ScrollView({ children: [new ZStack()] })] });
        new SplitView({ children: [new Text("p")] });
      }
    })();
    const created = appKitInternals.liveViews() - before;
    let after = created;
    await waitFor(
      () => {
        Bun.gc(true);
        after = appKitInternals.liveViews() - before;
        return after === 0;
      },
      "containers to be collected",
      3000,
    );
    emit({ step: "collected", created, after });
  }

  // A window takes any of them as content; closing it lets the content go elsewhere.
  {
    const content = new HStack({ children: [new Text("moved")] });
    const first = new Window({ width: 200, height: 80, content });
    const inFirst = content.native.window() === first.native;
    first.close();
    const second = new Window({ width: 200, height: 80, content });
    emit({
      step: "window",
      inFirst,
      detached: content.parent === null,
      inSecond: content.native.window() === second.native,
    });
    second.close();
  }
});
