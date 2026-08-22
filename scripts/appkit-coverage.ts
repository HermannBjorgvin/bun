#!/usr/bin/env bun
// How much of AppKit / Metal does Bun.AppKit reach, and how?
//
// Three layers, three numbers. The `objc` bridge reaches every class and
// selector of the frameworks it loads by name, so its reach is what the macOS
// SDK headers declare (counted here) plus the enumerations and constants in
// src/js/internal/appkit_enums.ts. The curated elements in src/js/bun/appkit.ts
// are built on the bridge; this lists them and the AppKit classes they make.
// What is compiled in natively is the typed binding tables in src/appkit/objc
// (the app lifecycle, the Metal view, `gpu`, and the bridge's own machinery);
// those are diffed against the SDK per class: selectors declared in the header
// (own declarations incl. categories; properties count as getter + setter),
// selectors bound, selectors transcribed but commented out, and which Rust
// modules use the class.
//
//   bun scripts/appkit-coverage.ts            # markdown to stdout
//   bun scripts/appkit-coverage.ts --json     # machine-readable

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BINDING_TABLES as FRAMEWORKS, treeCounts } from "./appkit-tree-counts";

const SDK =
  process.env.SDKROOT ??
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";
const root = join(import.meta.dir, "..");
const json = process.argv.includes("--json");
const tree = treeCounts(root);

// ───────────────────────────── SDK side ─────────────────────────────

type Decl = {
  framework: string;
  header: string;
  selectors: Set<string>;
  isProtocol: boolean;
  superclass?: string;
  primary: boolean;
};
const sdk = new Map<string, Decl>(); // ObjC class/protocol name -> declared selectors

function selectorsOfMethod(line: string): string | null {
  // "- (void)setFrame:(NSRect)frameRect display:(BOOL)flag;" -> "setFrame:display:"
  const m = line.match(/^[-+]\s*\([^)]*(?:\([^)]*\)[^)]*)*\)\s*(.*)$/);
  if (!m) return null;
  let rest = m[1];
  const parts = [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(x => x[1]);
  if (parts.length) {
    // keep only selector pieces that are followed by an argument "(type)name"; the regex above
    // also matches inside macros, so cut at the first attribute/semicolon.
    const cut = rest.search(/\b(NS_|API_|__|;)/);
    const head = cut >= 0 ? rest.slice(0, cut) : rest;
    const pieces = [...head.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\(/g)].map(x => x[1]);
    if (pieces.length) return pieces.map(p => p + ":").join("");
  }
  const bare = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return bare ? bare[1] : null;
}

function selectorsOfProperty(line: string): string[] {
  // "@property (nullable, copy, readonly, getter=isVisible) NSString *title;" -> ["title"] or ["title","setTitle:"]
  const attrs = line.match(/@property\s*\(([^)]*)\)/)?.[1] ?? "";
  const decl = line
    .replace(/@property\s*(\([^)]*\))?/, "")
    .replace(/\b(NS_|API_|__OSX|UI_APPEARANCE)\w*(\([^;]*?\))?/g, "");
  // last identifier before ';' is the name (handles "NSString *title", "BOOL hidden", block types crudely)
  const names = [...decl.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|,)/g)].map(m => m[1]);
  const name = names[0];
  if (!name) return [];
  const getter = attrs.match(/getter\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? name;
  const out = [getter];
  if (!/\breadonly\b/.test(attrs)) {
    const setter =
      attrs.match(/setter\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)/)?.[1] ?? "set" + name[0].toUpperCase() + name.slice(1) + ":";
    out.push(setter);
  }
  return out;
}

for (const fw of new Set(Object.values(FRAMEWORKS).flat())) {
  const dir = join(SDK, "System/Library/Frameworks", `${fw}.framework/Headers`);
  if (!existsSync(dir)) continue;
  for (const h of readdirSync(dir).filter(f => f.endsWith(".h"))) {
    const text = readFileSync(join(dir, h), "utf8");
    let current: Decl | null = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const iface = line.match(
        /^@(interface|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\()?(?::\s*([A-Za-z_][A-Za-z0-9_]*))?/,
      );
      if (iface) {
        const [, kind, name, category, superclass] = iface;
        current = sdk.get(name) ?? {
          framework: fw,
          header: h,
          selectors: new Set(),
          isProtocol: kind === "protocol",
          superclass,
          primary: false,
        };
        // A class belongs to the framework of its primary @interface, not of the
        // first category some other framework declares on it (AppKit adds
        // categories to NSString, NSURL, NSObject...).
        if (!category && kind === "interface" && !current.primary) {
          current.framework = fw;
          current.header = h;
          current.primary = true;
          if (superclass) current.superclass = superclass;
        }
        sdk.set(name, current);
        continue;
      }
      if (line.startsWith("@end")) {
        current = null;
        continue;
      }
      if (!current) continue;
      if (line.startsWith("- (") || line.startsWith("+ (") || line.startsWith("-(") || line.startsWith("+(")) {
        const sel = selectorsOfMethod(line);
        if (sel) current.selectors.add(sel);
      } else if (line.startsWith("@property")) {
        for (const sel of selectorsOfProperty(line)) current.selectors.add(sel);
      }
    }
  }
}

// ───────────────────────────── our side ─────────────────────────────

type Bound = {
  rust: string;
  objc: string;
  file: string;
  active: Set<string>;
  commented: Set<string>;
  usedBy: Set<string>;
};
const bound = new Map<string, Bound>( // rust name -> binding
  [...tree.bound].map(([rust, b]) => [rust, { ...b, usedBy: new Set(b.parked ? ["(commented out)"] : []) }]),
);

// Which crate modules use each bound class.
const users = ["src/appkit", "src/appkit/gpu", "src/appkit/objc"].flatMap(dir =>
  readdirSync(join(root, dir))
    .filter(
      f =>
        f.endsWith(".rs") &&
        !(dir === "src/appkit/objc" && f in { "appkit.rs": 1, "foundation.rs": 1, "metal.rs": 1, "sdk.rs": 1 }),
    )
    .map(f => `${dir}/${f}`),
);
for (const file of users) {
  const text = readFileSync(join(root, file), "utf8");
  for (const b of bound.values()) {
    if (new RegExp(`\\b${b.rust}\\b`).test(text)) b.usedBy.add(basename(file, ".rs"));
  }
}

// ───────────────────────────── report ─────────────────────────────

type Row = {
  class: string;
  framework: string;
  declared: number;
  bound: number;
  commented: number;
  pct: number;
  usedBy: string[];
  missingSample: string[];
};
const rows: Row[] = [];
for (const b of bound.values()) {
  const decl = sdk.get(b.objc);
  const declared = decl?.selectors ?? new Set<string>();
  const framework = decl?.framework ?? "(runtime)";
  const boundHere = [...b.active].filter(s => declared.has(s) || declared.size === 0);
  const missing = [...declared].filter(s => !b.active.has(s));
  rows.push({
    class: b.objc,
    framework,
    declared: declared.size,
    bound: b.active.size,
    commented: b.commented.size,
    pct: declared.size ? Math.round((100 * boundHere.length) / declared.size) : 0,
    usedBy: [...b.usedBy].sort(),
    missingSample: missing.slice(0, 6),
  });
}
rows.sort((a, b) => a.framework.localeCompare(b.framework) || b.bound - a.bound);

const frameworks = [...new Set(Object.values(FRAMEWORKS).flat())];
const summary = frameworks.map(fw => {
  const classes = [...sdk.entries()].filter(([, d]) => d.framework === fw && !d.isProtocol);
  const protocols = [...sdk.entries()].filter(([, d]) => d.framework === fw && d.isProtocol);
  const ours = rows.filter(r => r.framework === fw);
  const declaredSelectors = classes.concat(protocols).reduce((n, [, d]) => n + d.selectors.size, 0);
  const boundSelectors = ours.reduce((n, r) => n + r.bound, 0);
  return {
    framework: fw,
    sdkClasses: classes.length,
    sdkProtocols: protocols.length,
    boundTypes: ours.length,
    declaredSelectors,
    boundSelectors,
  };
});

function inherits(name: string, base: string): boolean {
  for (let c: string | undefined = name, i = 0; c && i < 32; c = sdk.get(c)?.superclass, i++)
    if (c === base) return true;
  return false;
}
const viewClasses = [...sdk.entries()]
  .filter(([n, d]) => !d.isProtocol && d.framework === "AppKit" && inherits(n, "NSView"))
  .map(([n]) => n);
const boundViews = viewClasses.filter(n => [...bound.values()].some(b => b.objc === n && b.active.size > 0));
const jsElements = tree.elements;
const bridgedClasses = tree.bridgedClasses;
const bridgedAppKit = bridgedClasses.filter(n => sdk.get(n)?.framework === "AppKit");
const bridge = {
  frameworks: summary.map(s => s.framework),
  classes: summary.reduce((n, s) => n + s.sdkClasses, 0),
  protocols: summary.reduce((n, s) => n + s.sdkProtocols, 0),
  selectors: summary.reduce((n, s) => n + s.declaredSelectors, 0),
  enumTypes: tree.enumTypes,
  enumMembers: tree.enumMembers,
  looseConstants: tree.looseConstants,
  typedConstants: tree.typedConstants,
};

if (json) {
  console.log(
    JSON.stringify(
      { summary, rows, bridge, viewClasses: viewClasses.length, boundViews, jsElements, bridgedClasses, bridgedAppKit },
      null,
      2,
    ),
  );
  process.exit(0);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log("# Bun.AppKit — Objective-C surface coverage\n");
console.log(
  `SDK: ${SDK.split("/").slice(-1)[0]}  ·  generated ${new Date().toISOString().slice(0, 10)} by scripts/appkit-coverage.ts\n`,
);
console.log(`## Headline\n`);
console.log(
  `- The \`objc\` bridge reaches by name every class and selector the loaded frameworks register: the SDK headers for ${bridge.frameworks.join(", ")} declare **${bridge.classes} classes, ${bridge.protocols} protocols and ${bridge.selectors} selectors**; \`objc.enums\` knows **${bridge.enumTypes} enumerations (${bridge.enumMembers} members)** and ${bridge.looseConstants} loose constants of Foundation and AppKit, \`objc.constants\` any exported global (${bridge.typedConstants} typed as numbers or structs, the rest as objects).`,
);
console.log(
  `- Curated JavaScript elements written on the bridge: **${jsElements.length}** (${jsElements.join(", ")}), built out of **${bridgedAppKit.length} AppKit classes** (${bridgedAppKit.join(", ")}).`,
);
console.log(
  `- \`NSView\` subclasses in the SDK: ${viewClasses.length}; with a curated element or used by one: ${viewClasses.filter(n => bridgedAppKit.includes(n) || boundViews.includes(n)).length}. Every other one is an \`objc.classes.X\` away.`,
);
console.log(
  `- Compiled in natively (the rows below): the typed bindings the app lifecycle, the event-loop integration, \`MetalView\`, \`gpu\` and the bridge's own machinery use. A curated prop is not a binding line any more; it is a send through the bridge.\n`,
);
console.log("## By framework\n");
console.log(
  "| framework | classes in SDK | protocols in SDK | types we bind | selectors declared (SDK) | selectors we bind |",
);
console.log("|---|---:|---:|---:|---:|---:|");
for (const s of summary) {
  console.log(
    `| ${s.framework} | ${s.sdkClasses} | ${s.sdkProtocols} | ${s.boundTypes} | ${s.declaredSelectors} | ${s.boundSelectors} (${s.declaredSelectors ? ((100 * s.boundSelectors) / s.declaredSelectors).toFixed(1) : 0}%) |`,
  );
}
console.log("\n## By bound class\n");
console.log(
  "`declared` = selectors the SDK header declares on that class itself (properties count getter+setter; inherited ones are on the superclass row). `bound` = compiled bindings; `parked` = transcribed but commented out until something needs them.\n",
);
console.log("| class | framework | declared | bound | parked | % | used by |");
console.log("|---|---|---:|---:|---:|---:|---|");
for (const r of rows) {
  console.log(
    `| ${r.class} | ${r.framework} | ${r.declared} | ${r.bound} | ${r.commented} | ${r.declared ? r.pct + "%" : "–"} | ${r.usedBy.join(", ")} |`,
  );
}
const totalDeclared = rows.reduce((n, r) => n + r.declared, 0);
const totalBound = rows.reduce((n, r) => n + r.bound, 0);
console.log(
  `\n**Bound classes: ${rows.length}. On those classes: ${totalBound} of ${totalDeclared} declared selectors bound (${((100 * totalBound) / Math.max(1, totalDeclared)).toFixed(1)}%), ${rows.reduce((n, r) => n + r.commented, 0)} more parked as comments.**`,
);
