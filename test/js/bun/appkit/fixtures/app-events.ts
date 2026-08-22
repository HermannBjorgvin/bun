// "reopen" and "menu" listeners and a menu item's onClick: one that throws is
// reported as an uncaught error and the rest still run. The Dock click and the
// menu choice are driven through the application delegate the way AppKit does.
import { app, objc } from "bun:appkit";
import { emit, run } from "./_util";

await run(async () => {
  app.activationPolicy = "accessory";
  app.keepAlive = true;
  const uncaught: string[] = [];
  process.on("uncaughtException", e => uncaught.push((e as Error).message));
  const boom = (what: string) => () => {
    throw new Error(`${what} boom`);
  };

  const nsapp = objc.classes.NSApplication.sharedApplication();
  const reopens: unknown[] = [];
  const throwingReopen = boom("reopen");
  app.on("reopen", throwingReopen);
  app.on("reopen", visible => reopens.push(visible));
  const handled = nsapp.delegate().applicationShouldHandleReopen_hasVisibleWindows_(nsapp, false);
  app.off("reopen", throwingReopen);
  nsapp.delegate().applicationShouldHandleReopen_hasVisibleWindows_(nsapp, true);
  emit({ step: "reopen", reopens, handled, uncaught: uncaught.splice(0) });

  const hello = { title: "Hello", onClick: boom("onClick") };
  const spec = [{ title: "Test", items: [hello] }];
  app.menu = spec;
  const chosen: unknown[] = [];
  app.on("menu", boom("menu"));
  app.on("menu", item => chosen.push(item === hello ? "same item" : item));
  nsapp.mainMenu().itemAtIndex_(0).submenu().performActionForItemAtIndex_(0);
  emit({ step: "menu", chosen, uncaught: uncaught.splice(0) });

  app.keepAlive = false;
});
