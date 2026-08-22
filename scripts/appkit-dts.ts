#!/usr/bin/env bun
// TypeScript declarations for the Objective-C classes bun:appkit's `objc`
// bridge hands out, so that `objc.classes.NSWindow`, `button.native` and
// what their methods return complete and type-check in an editor. Writes
// packages/bun-types/appkit-objc.generated.d.ts.
//
// The bridge reaches every class and selector of the frameworks it loads by
// name and converts arguments and results by each method's type encoding;
// the handle types in appkit.d.ts (ObjCObject, ObjCClass) say only that much
// (every property is a method taking `any`). This asks the SDK's clang for
// the AST of the five frameworks' headers and writes, for the classes named
// in ROOTS below and their superclasses, one interface per class with its
// instance methods (`objc.NSWindow`) and one with its class methods
// (`objc.classes.NSWindow`), named the way the bridge spells selectors
// (`setFrame:display:` -> `setFrame_display_`) and typed the way it converts
// each C type (see the table under "The Objective-C bridge" in
// docs/runtime/appkit.mdx). Methods a class inherits are not repeated; the
// index signature on ObjCObject/ObjCClass stays underneath, so a selector
// these headers do not declare still type-checks as `any`. The protocols
// those classes adopt, and the delegate and data-source protocols in
// PROTOCOL_ROOTS, get an interface each (`objc.protocols.X`). It also types
// `objc.enums` from src/js/internal/appkit_enums.ts.
//
// What is read per method: the selector and whether it is a class method;
// each parameter's name and C type with its nullability; the return type;
// `instancetype`; whether it is unavailable on macOS; its deprecation.
// Which methods are variadic (and so refused), which pointer parameters are
// C arrays rather than out-parameters, and which block parameters a plain
// function can be passed for, come from the tables the bridge itself
// consults (src/appkit/objc/sdk.rs, src/appkit/objc/block.rs), so the
// declarations agree with what a call does; which protocol methods are
// optional comes from the Objective-C runtime (the headers' `@optional` is
// not in the AST dump), else from sdk.rs for a protocol this machine does
// not register. The output is as of the SDK named in its first line; rerun
// this after an Xcode update.
//
//   bun scripts/appkit-dts.ts           # rewrite the declarations
//   bun scripts/appkit-dts.ts --check   # exit 1 if they are stale

import { readFileSync } from "node:fs";
import { join } from "node:path";
import enumTables from "../src/js/internal/appkit_enums";
import {
  ADOPTED,
  astDump,
  astLines,
  BRIDGED,
  type CType,
  objcRuntime,
  root,
  sdkProtocols,
  type SdkRow,
  sdkRows,
  stamped,
  typesIn,
} from "./appkit-sdk";
import { treeCounts } from "./appkit-tree-counts";

const OUT = join(root, "packages/bun-types/appkit-objc.generated.d.ts");

/**
 * The classes to declare, besides every superclass of these: what
 * src/js/bun/appkit.ts builds its windows, menus and views from (added
 * below from the source), and the Foundation and AppKit classes a script
 * dropping down to `objc` is likely to start from. A class outside this set
 * is still an `ObjCClass`/`ObjCObject`; this only decides what is spelled out.
 */
const ROOTS = new Set([
  // Foundation
  "NSObject",
  "NSString",
  "NSMutableString",
  "NSAttributedString",
  "NSMutableAttributedString",
  "NSNumber",
  "NSValue",
  "NSData",
  "NSMutableData",
  "NSDate",
  "NSURL",
  "NSArray",
  "NSMutableArray",
  "NSDictionary",
  "NSMutableDictionary",
  "NSSet",
  "NSMutableSet",
  "NSIndexSet",
  "NSMutableIndexSet",
  "NSEnumerator",
  "NSNull",
  "NSError",
  "NSException",
  "NSBundle",
  "NSProcessInfo",
  "NSUserDefaults",
  "NSNotification",
  "NSNotificationCenter",
  "NSFileManager",
  "NSRunLoop",
  "NSTimer",
  "NSThread",
  "NSJSONSerialization",
  "NSOperationQueue",
  "NSUndoManager",
  // AppKit
  "NSApplication",
  "NSRunningApplication",
  "NSWindow",
  "NSPanel",
  "NSView",
  "NSControl",
  "NSButton",
  "NSTextField",
  "NSSecureTextField",
  "NSSearchField",
  "NSTextView",
  "NSStackView",
  "NSScrollView",
  "NSClipView",
  "NSSplitView",
  "NSTableView",
  "NSTableColumn",
  "NSTableCellView",
  "NSBox",
  "NSImage",
  "NSImageView",
  "NSImageSymbolConfiguration",
  "NSBitmapImageRep",
  "NSColor",
  "NSColorSpace",
  "NSFont",
  "NSFontDescriptor",
  "NSMenu",
  "NSMenuItem",
  "NSScreen",
  "NSWorkspace",
  "NSPasteboard",
  "NSCursor",
  "NSEvent",
  "NSAlert",
  "NSOpenPanel",
  "NSSavePanel",
  "NSSound",
  "NSAnimationContext",
  "NSAppearance",
  "NSLayoutConstraint",
  "NSVisualEffectView",
  "NSSlider",
  "NSPopUpButton",
  "NSSegmentedControl",
  "NSProgressIndicator",
  "NSSwitch",
  "NSStatusBar",
  "NSStatusItem",
  // QuartzCore, MetalKit
  "CALayer",
  "CATransaction",
  "MTKView",
  ...treeCounts(root).bridgedClasses,
]);

/** The protocols to declare besides the ones those classes adopt: what a delegate or data source defined in JavaScript conforms to. */
const PROTOCOL_ROOTS = [...ADOPTED, "NSMenuDelegate", "NSSplitViewDelegate", "NSControlTextEditingDelegate"];

/** Selectors the bridge refuses or the handle answers itself (see src/js/internal/objc.ts). */
const RESERVED_SELECTORS = new Set([
  "retain",
  "autorelease",
  "retainCount",
  "dealloc",
  "zone",
  "performSelector:",
  "performSelector:withObject:",
  "performSelector:withObject:withObject:",
  "alloc",
  "new",
]);
/** Property names a handle answers itself, so a selector spelled that way is not reachable as a property. */
const RESERVED_PROPERTIES = new Set(["msgSend", "toString", "toJSON", "release", "invoke", "then", "constructor"]);

// ─────────────────────────────── the AST ───────────────────────────────────

type Param = { name: string; type: CType };
type Method = {
  selector: string;
  isClass: boolean;
  returns: CType;
  params: Param[];
  unavailable: boolean;
  /** `@optional` in its protocol (set by `markOptional`; the AST does not say). */
  optional: boolean;
  /** The macOS version and message, when deprecated. */
  deprecated: string | null;
  /** Declared in a category (or an informal protocol) rather than the class's own `@interface`. */
  category: string | null;
  /** The class or protocol that declares it. */
  owner: string;
};
type Interface = { name: string; superclass: string | null; protocols: Set<string>; methods: Method[] };
type Protocol = { name: string; inherits: Set<string>; methods: Method[] };
/** `typedefs`: a typedef's (or an interface's type parameter's) underlying type, since clang leaves a pointee's typedef name in the canonical text (`unichar *`, `void (^)(NSUInteger)`). */
type Ast = { interfaces: Map<string, Interface>; protocols: Map<string, Protocol>; typedefs: Map<string, CType> };

function parse(text: string): Ast {
  const interfaces = new Map<string, Interface>();
  const protocols = new Map<string, Protocol>();
  const typedefs = new Map<string, CType>();
  const interfaceNamed = (name: string): Interface => {
    let found = interfaces.get(name);
    if (!found) interfaces.set(name, (found = { name, superclass: null, protocols: new Set(), methods: [] }));
    return found;
  };
  const protocolNamed = (name: string): Protocol => {
    let found = protocols.get(name);
    if (!found) protocols.set(name, (found = { name, inherits: new Set(), methods: [] }));
    return found;
  };

  // The declaration at depth 1 whose children are being read, and where its
  // methods go once known (a category names its class in a child node).
  type Container =
    | { kind: "interface"; target: Interface }
    | { kind: "category"; name: string; target: Interface | null; pending: Method[]; protocols: string[] }
    | { kind: "protocol"; target: Protocol };
  let container: Container | null = null;
  let method: Method | null = null;

  const addMethod = (m: Method) => {
    if (!container) return;
    if (container.kind === "category") {
      if (container.target) container.target.methods.push(m);
      else container.pending.push(m);
    } else {
      container.target.methods.push(m);
    }
  };

  for (const { line, depth, body, kind } of astLines(text)) {
    if (depth === 0) continue;

    if (kind === "TypedefDecl" || kind === "ObjCTypeParamDecl") {
      // `TypedefDecl 0x… col:14 [referenced] NSInteger 'long'`, `ObjCTypeParamDecl 0x… col:16 ObjectType [covariant] 'id'`
      const m = /\s([A-Za-z_][A-Za-z0-9_]*)(?: (?:covariant|contravariant))? ('.*')\s*$/.exec(body);
      const type = m ? typesIn(m[2]) : null;
      if (m && type && !["id", "Class", "SEL", "instancetype"].includes(m[1])) typedefs.set(m[1], type);
      if (depth !== 1) continue;
    }
    if (depth === 1) {
      container = null;
      method = null;
      // `ObjCInterfaceDecl 0x… [prev 0x…] [loc] [implicit] Name`
      const name = /\s([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(body)?.[1] ?? null;
      const named = name !== null && !/^(col|line|prev|implicit|0x[0-9a-f]+)$/.test(name) && !name.includes(":");
      if (kind === "ObjCInterfaceDecl" && named) {
        container = { kind: "interface", target: interfaceNamed(name) };
      } else if (kind === "ObjCProtocolDecl" && named) {
        container = { kind: "protocol", target: protocolNamed(name) };
      } else if (kind === "ObjCCategoryDecl") {
        // A class extension `()` has no name of its own.
        container = { kind: "category", name: named ? name : "", target: null, pending: [], protocols: [] };
      }
      continue;
    }
    if (!container) continue;

    if (depth === 2) {
      method = null;
      const quoted = /'([^']*)'/.exec(body)?.[1] ?? "";
      if (kind === "super" && container.kind === "interface") {
        container.target.superclass = quoted;
      } else if (kind === "ObjCInterface" && container.kind === "category") {
        container.target = interfaceNamed(quoted);
        for (const m of container.pending) container.target.methods.push(m);
        for (const p of container.protocols) container.target.protocols.add(p);
        container.pending = [];
      } else if (kind === "ObjCProtocol") {
        if (container.kind === "protocol") container.target.inherits.add(quoted);
        else if (container.kind === "interface") container.target.protocols.add(quoted);
        else if (container.target) container.target.protocols.add(quoted);
        else container.protocols.push(quoted);
      } else if (kind === "ObjCMethodDecl") {
        // `ObjCMethodDecl 0x… col:1 [implicit] [used] - setFrame:display: 'void' [variadic]`
        const m = /\s([-+]) (\S+) ('.*')( variadic)?\s*$/.exec(body);
        const returns = m ? typesIn(m[3]) : null;
        if (!m || !returns) throw new Error(`cannot read the method in: ${line}`);
        method = {
          selector: m[2],
          isClass: m[1] === "+",
          returns,
          params: [],
          unavailable: false,
          optional: false,
          deprecated: null,
          category: container.kind === "category" ? container.name : null,
          owner: container.kind === "category" ? (container.target?.name ?? "") : container.target.name,
        };
        addMethod(method);
      }
      continue;
    }

    if (depth === 3 && method) {
      if (kind === "ParmVarDecl") {
        // `ParmVarDecl 0x… col:43 [used] frameRect 'NSRect':'struct CGRect'`
        const m = /\s([A-Za-z_][A-Za-z0-9_]*) ('.*')\s*$/.exec(body);
        const type = m ? typesIn(m[2]) : null;
        if (!m || !type) throw new Error(`cannot read the parameter in: ${line}`);
        method.params.push({ name: m[1], type });
      } else if (kind === "UnavailableAttr") {
        method.unavailable = true;
      } else if (kind === "AvailabilityAttr") {
        // `AvailabilityAttr 0x… macos 10.0 10.14 0 [Unavailable] "message" "replacement" …`
        const m = /\s(\w+) ([\d._]+) ([\d._]+) ([\d._]+)( Unavailable)? "(.*?)" "/.exec(body);
        if (m && m[1] === "macos") {
          if (m[5]) method.unavailable = true;
          if (m[3] !== "0") method.deprecated = `${m[3].replace(/_/g, ".")}${m[6] ? `: ${m[6]}` : ""}`;
        }
      } else if (kind === "DeprecatedAttr") {
        method.deprecated ??= /"(.*?)"/.exec(body)?.[1] ?? "";
      }
    }
  }
  return { interfaces, protocols, typedefs };
}

// ──────────────────── what the bridge's own tables say ──────────────────────

/**
 * Mark the `@optional` methods of every protocol: the runtime says which
 * (`protocol_copyMethodDescriptionList` with required NO) for a protocol a
 * loaded framework registers, sdk.rs's PROTOCOLS table for one it does
 * not; a protocol in neither keeps every method required.
 */
function markOptional(protocols: Map<string, Protocol>): void {
  const runtime = objcRuntime();
  const table = sdkProtocols();
  for (const p of protocols.values()) {
    const optional = new Set<string>();
    const handle = runtime.protocol(p.name);
    if (handle !== null) {
      for (const instance of [true, false]) {
        for (const m of runtime.methods(handle, false, instance)) optional.add((instance ? "-" : "+") + m.selector);
      }
    } else {
      for (const m of table.get(p.name) ?? []) if (!m.required) optional.add((m.instance ? "-" : "+") + m.selector);
    }
    for (const m of p.methods) m.optional = optional.has((m.isClass ? "+" : "-") + m.selector);
  }
}

/** The block type encodings a JavaScript function can be called through (block.rs `shims!`). */
function blockShims(): Set<string> {
  const text = readFileSync(join(root, "src/appkit/objc/block.rs"), "utf8");
  const start = text.indexOf("shims! {");
  const body = text.slice(start, text.indexOf("\n}", start));
  return new Set([...body.matchAll(/^\s*"([^"]+)" =>/gm)].map(m => m[1]));
}

// ─────────────────────────────── C types ───────────────────────────────────

/** How the bridge treats one C type (mirrors `Enc::parse` in src/appkit/objc/dynamic.rs). */
type Shape =
  | { kind: "void" | "bool" | "float" | "class" | "sel" | "cstring" | "buffer" | "pointer" | "cf" | "other" }
  | { kind: "int"; bits: number }
  /** `class` is the static class name for `X *`, null for `id`. */
  | { kind: "object"; class: string | null; instancetype: boolean }
  | { kind: "struct"; name: string }
  | { kind: "out"; to: Shape }
  | { kind: "block"; returns: Shape; params: { shape: Shape; nullable: boolean }[] };

const INTEGERS: Record<string, number> = {
  "char": 8,
  "signed char": 8,
  "unsigned char": 8,
  "short": 16,
  "unsigned short": 16,
  "int": 32,
  "unsigned int": 32,
  "long": 64,
  "unsigned long": 64,
  "long long": 64,
  "unsigned long long": 64,
  "wchar_t": 32,
  "char16_t": 16,
  "char32_t": 32,
};
/** `^{CGColor=}` and the rest of `CF_OBJECTS` in dynamic.rs: CF types that cross as object handles. */
const CF_OBJECTS = new Set(["CGColor", "CGColorSpace", "CGImage", "CGPath", "CGContext"]);
/** Structs that cross as objects with field names (`StructType::field_names` in dynamic.rs) -> their type in appkit.d.ts. */
const STRUCTS: Record<string, string> = {
  CGRect: "CGRect",
  CGPoint: "CGPoint",
  CGSize: "CGSize",
  CGVector: "CGVector",
  _NSRange: "NSRange",
  NSEdgeInsets: "NSEdgeInsets",
  NSDirectionalEdgeInsets: "NSDirectionalEdgeInsets",
  CGAffineTransform: "CGAffineTransform",
  CATransform3D: "CATransform3D",
};

const stripQualifiers = (t: string) =>
  t
    .replace(/\b(const|volatile|__kindof|__strong|__weak|__autoreleasing|__unsafe_unretained)\b/g, "")
    .replace(/\b(_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*/g, " *")
    .replace(/\* (?=\*)/g, "*")
    .replace(/\( \*/g, "(*")
    .replace(/ ([>),])/g, "$1")
    .trim();

/** The parsed headers' typedefs and class names, for `shapeOf` (set by `generate`). */
let names: { typedefs: Map<string, CType>; interfaces: Map<string, Interface> } = {
  typedefs: new Map(),
  interfaces: new Map(),
};

/** A canonical type with a leading typedef name replaced by what it stands for, as far as the typedefs go (`unichar *` -> `unsigned short *`). */
function resolved(canon: string): string {
  for (;;) {
    const m = /^(?:(struct|enum) )?([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(canon);
    if (!m || m[1] !== undefined || names.interfaces.has(m[2])) return canon;
    const def = names.typedefs.get(m[2]);
    if (!def) return canon;
    const next = stripQualifiers(stripQualifiers(def.canon) === m[2] ? def.sugar : def.canon) + m[3];
    if (next === canon) return canon;
    canon = stripQualifiers(next);
  }
}

/** Splits `A, B (^)(C, D), E` at the top-level commas. */
function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "<") depth++;
    else if (c === ")" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map(s => s.trim()).filter(s => s !== "" && s !== "void");
}

/**
 * Whether the outermost pointer of a type as written is `_Nullable`: the
 * annotation trails an object pointer (`NSString * _Nullable`) and sits
 * inside a block pointer's declarator (`void (^ _Nullable)(BOOL)`). The few
 * declarations outside the audited headers (`<objc/NSObject.h>`: `-init`,
 * `-description`, `+alloc`) carry no annotation; those count as non-null for
 * a result and as nullable for a parameter, the way Swift imports them.
 */
const nullability = (sugar: string): "nullable" | "nonnull" | "unannotated" => {
  const block = /\(\^\s*(_Nonnull|_Nullable|_Null_unspecified)?\s*\)/.exec(sugar);
  const m = block
    ? block[1]
    : /\b(_Nonnull|_Nullable|_Null_unspecified)\s*$/.exec(sugar.replace(/\bconst\s*$/, "").trim())?.[1];
  return m === undefined ? "unannotated" : m === "_Nonnull" ? "nonnull" : "nullable";
};
const nullableResult = (sugar: string) => nullability(sugar) === "nullable";
const nullableParam = (sugar: string) => nullability(sugar) !== "nonnull";

function shapeOf(type: CType): Shape {
  const { sugar } = type;
  const canon = resolved(stripQualifiers(type.canon));
  const isConst = /\bconst\b/.test(type.canon.replace(/\*[^*]*$/, "")); // const on what is pointed at
  if (/^instancetype\b/.test(sugar)) return { kind: "object", class: null, instancetype: true };
  if (canon === "void") return { kind: "void" };
  if (canon === "bool" || canon === "_Bool" || canon === "BOOL") return { kind: "bool" };
  if (canon in INTEGERS) return { kind: "int", bits: INTEGERS[canon] };
  if (/^enum \w+$/.test(canon)) return { kind: "int", bits: 64 };
  if (canon === "float" || canon === "double") return { kind: "float" };
  if (canon === "id" || /^id<[^*]*>$/.test(canon)) return { kind: "object", class: null, instancetype: false };
  if (canon === "Class" || /^Class<[^*]*>$/.test(canon)) return { kind: "class" };
  // clang prints the canonical SEL (a pointer to `struct objc_selector`) as `SEL *`.
  if (canon === "SEL *" && /^SEL\b[^*]*$/.test(stripQualifiers(sugar))) return { kind: "sel" };
  const block = /^(.*?)\(\^\)\s*\((.*)\)$/.exec(canon);
  if (block) {
    // Parameter nullability lives in the canonical text here (`void (^)(NSEvent * _Nonnull)`).
    const params = splitParams(/\(\^[^)]*\)\s*\((.*)\)$/.exec(type.canon)?.[1] ?? block[2]);
    return {
      kind: "block",
      returns: shapeOf({ sugar: block[1].trim(), canon: block[1].trim() }),
      params: params.map(p => ({ shape: shapeOf({ sugar: p, canon: p }), nullable: nullableParam(p) })),
    };
  }
  if (/\(\*+\)/.test(canon)) return { kind: "pointer" }; // function pointer
  if (canon.endsWith("]")) return { kind: "buffer" }; // `id objects[]`
  if (canon.endsWith("*")) {
    const pointee = canon.slice(0, -1).trim();
    if (pointee === "char") return isConst ? { kind: "cstring" } : { kind: "buffer" };
    if (pointee === "void") return { kind: "pointer" };
    // `NSString *`, `NSArray<NSString *> *`, `NSObject<NSCopying> *`
    const objcClass = /^([A-Za-z_][A-Za-z0-9_]*)(?:<.*>)?$/.exec(pointee);
    if (objcClass && names.interfaces.has(objcClass[1])) {
      return { kind: "object", class: objcClass[1], instancetype: false };
    }
    const cf = /^struct (\w+)$/.exec(pointee);
    if (cf && CF_OBJECTS.has(cf[1])) return { kind: "cf" };
    const inner = shapeOf({ sugar: pointee, canon: pointee });
    if (["object", "bool", "int", "float", "struct"].includes(inner.kind)) {
      if (inner.kind === "struct" && !(inner.name in STRUCTS)) return { kind: "pointer" };
      return isConst ? { kind: "buffer" } : { kind: "out", to: inner };
    }
    return { kind: "pointer" };
  }
  const record = /^struct (\w+)$/.exec(canon);
  if (record) return { kind: "struct", name: record[1] };
  // A typedef of an anonymous struct keeps its typedef name as the canonical type (`MTLSize`, `CATransform3D`).
  if (/^[A-Za-z_]\w*$/.test(canon)) return { kind: "struct", name: canon };
  return { kind: "other" };
}

// ─────────────────────────────── mapping ───────────────────────────────────

type Context = {
  /** Classes that get interfaces of their own. */
  emitted: Set<string>;
  interfaces: Map<string, Interface>;
  /** NS_ENUM / NS_OPTIONS type names, for parameters typed as one. */
  enumNames: Set<string>;
  enumsUsed: Set<string>;
};

/** An index result is NSNotFound (2^63 - 1, a bigint) when there is no match, and so is an unset `-hash`; `-count` and the rest stay below 2^53. */
const mayBeNotFound = (selector: string) => /index(?!Path|es)/i.test(selector) || selector === "hash";

/** What a parameter of the given object class accepts besides a handle: the boxing `objc.ns()` does. */
function boxedAs(cls: string | null, cx: Context): string | null {
  if (cls === null) return "objc.Id";
  const chain: string[] = [];
  for (let c: string | null = cls; c !== null; c = cx.interfaces.get(c)?.superclass ?? null) chain.push(c);
  if (cls === "NSObject") return "objc.Id";
  if (chain.includes("NSString")) return "string";
  if (cls === "NSValue" || chain.includes("NSNumber")) return "number | boolean | bigint";
  if (cls === "NSArray") return "readonly unknown[]";
  if (cls === "NSDictionary") return "{ readonly [key: string]: unknown }";
  if (cls === "NSData") return "ArrayBufferView | ArrayBufferLike";
  if (cls === "NSDate") return "Date";
  return null;
}

/** The instance type for a class: its own interface when emitted, else the nearest emitted superclass's. */
function instanceType(cls: string | null, cx: Context): string {
  for (let c = cls; c !== null; c = cx.interfaces.get(c)?.superclass ?? null) {
    if (cx.emitted.has(c)) return `objc.${c}`;
  }
  return "ObjCObject";
}

/** The alias for an enum-typed value, so the declaration names the enumeration (`objc.NSWindowStyleMask`). */
function numberType(type: CType, cx: Context): string {
  const name = stripQualifiers(type.sugar);
  if (cx.enumNames.has(name)) {
    cx.enumsUsed.add(name);
    return `objc.${name}`;
  }
  return "number";
}

function structType(name: string): string | null {
  return name in STRUCTS ? `objc.${STRUCTS[name]}` : null;
}

/** The type of a result (or of what a block hands its function). `self` is what `instancetype` means here. */
function returnType(
  type: CType,
  shape: Shape,
  cx: Context,
  self: string,
  nullable = nullableResult(type.sugar),
): string {
  const orNull = (t: string) => (nullable ? `${t} | null` : t);
  switch (shape.kind) {
    case "void":
      return "void";
    case "bool":
      return "boolean";
    case "int":
      return numberType(type, cx);
    case "float":
      return "number";
    case "object":
      if (shape.instancetype) return orNull(self);
      return orNull(shape.class === null ? "ObjCObject" : instanceType(shape.class, cx));
    case "class":
      return orNull("ObjCClass");
    case "sel":
    case "cstring":
      return orNull("string");
    case "struct":
      return structType(shape.name) ?? "unknown[]";
    case "cf":
    case "block":
      return orNull("ObjCObject");
    case "out":
    case "buffer":
    case "pointer":
      return "bigint | null";
    case "other":
      return "unknown";
  }
}

/** The type a parameter accepts. */
function paramType(type: CType, shape: Shape, cx: Context, functionType: string | null): string {
  const nullable = nullableParam(type.sugar);
  const orNull = (t: string) => (nullable ? `${t} | null` : t);
  switch (shape.kind) {
    case "void":
      return "undefined";
    case "bool":
      return "boolean";
    case "int": {
      // A 64-bit value read back from one send (a bigint above 2^53: NSNotFound, an NSUIntegerMax mask) passes to the next.
      const t = numberType(type, cx);
      return shape.bits === 64 ? `${t} | bigint` : t;
    }
    case "float":
      return "number";
    case "object": {
      const boxed = shape.instancetype ? null : boxedAs(shape.class, cx);
      if (boxed === "objc.Id") return orNull("objc.Id");
      return orNull(boxed === null ? "ObjCObject" : `ObjCObject | ${boxed}`);
    }
    case "class":
      return orNull("ObjCClass");
    case "sel":
      return orNull("string | ObjCSelector");
    case "cstring":
      return orNull("string");
    case "struct": {
      // Every struct also takes an array of its members; a CGRect the flat `{x, y, width, height}` too.
      const t = structType(shape.name);
      if (t === null) return "readonly unknown[]";
      return `${t === "objc.CGRect" ? "objc.CGRect | Rect" : t} | readonly number[]`;
    }
    case "cf":
      return orNull("ObjCObject");
    case "block":
      return orNull(functionType === null ? "ObjCObject" : `(${functionType}) | ObjCObject`);
    case "out": {
      const to = shape.to;
      const inner =
        to.kind === "object"
          ? `${to.class === null ? "ObjCObject" : instanceType(to.class, cx)} | null`
          : to.kind === "bool"
            ? "boolean"
            : to.kind === "struct"
              ? (structType(to.name) ?? "unknown[]")
              : "number";
      return `Partial<ObjCOut<${inner}>> | null`;
    }
    case "buffer":
    case "pointer":
      return "null";
    case "other":
      return "unknown";
  }
}

/** The function type a block parameter accepts, given the encoding the bridge knows it by. */
function blockFunctionType(types: string, shape: Shape, cx: Context): string {
  // Names and classes from the header's block type when it lines up with the encoding; else from the encoding alone.
  const header = shape.kind === "block" ? shape : null;
  const codes = [...types.matchAll(/@\?|\^B|\{_NSRange=QQ\}|[vB@qQd]/g)].map(m => m[0]);
  const ret = codes[0];
  const args = codes.slice(2); // past the return and `@?`
  const params = args.map((code, i) => {
    const declared = header && header.params.length === args.length ? header.params[i] : null;
    const name = `arg${i}`;
    switch (code) {
      case "@": {
        const d = declared?.shape;
        const t = d && d.kind === "object" && d.class !== null ? instanceType(d.class, cx) : "ObjCObject";
        return `${name}: ${declared === null || declared.nullable ? `${t} | null` : t}`;
      }
      case "B":
        return `${name}: boolean`;
      case "q":
      case "Q":
      case "d":
        return `${name}: number`;
      case "^B":
        return `stop: ObjCOut<boolean>`;
      case "{_NSRange=QQ}":
        return `${name}: objc.NSRange`;
      default:
        return `${name}: unknown`;
    }
  });
  const returns = ret === "v" ? "void" : ret === "B" ? "boolean" : ret === "q" ? "number" : "objc.Id";
  return `(${params.join(", ")}) => ${returns}`;
}

// ─────────────────────────────── emission ──────────────────────────────────

/** `count:with:` -> `count_with_` (propertyFromSelector in src/js/internal/objc.ts). */
function propertyFromSelector(selector: string): string {
  let lead = 0;
  while (lead < selector.length && selector.charCodeAt(lead) === 95) lead++;
  return selector.slice(0, lead) + selector.slice(lead).replaceAll("_", "__").replaceAll(":", "_");
}

/** `PNGFileType` -> `pngFileType` (lowerFirstWord in src/js/internal/objc.ts). */
function lowerFirstWord(suffix: string): string {
  const first = /^[A-Z]+(?![a-z])|^[A-Z]/.exec(suffix)?.[0] ?? "";
  return first.toLowerCase() + suffix.slice(first.length);
}

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "arguments",
]); // prettier-ignore

type Member = { property: string; text: string; returns: string; params: string; optional: boolean };

/** What for...of yields on the collections src/js/internal/objc.ts `iteratorOf` makes iterable (their subclasses inherit it). */
const ITERATES: Record<string, [type: string, doc: string]> = {
  NSArray: ["ObjCObject", "The elements, first to last (`-objectEnumerator`)."],
  NSSet: ["ObjCObject", "The members (`-objectEnumerator`)."],
  NSOrderedSet: ["ObjCObject", "The members, first to last (`-objectEnumerator`)."],
  NSHashTable: ["ObjCObject", "The members (`-objectEnumerator`)."],
  NSEnumerator: ["ObjCObject", "What the enumerator has left (`-nextObject` until nil)."],
  NSDictionary: ["ObjCObject", "The keys (`-keyEnumerator`)."],
  NSMapTable: ["ObjCObject", "The keys (`-keyEnumerator`)."],
  NSIndexSet: ["number", "The indexes in increasing order (`-firstIndex`, `-indexGreaterThanIndex:`)."],
};

/** Every superclass of `name`, nearest first. */
function ancestorsOf(name: string, interfaces: Map<string, Interface>): string[] {
  const out: string[] = [];
  for (let c = interfaces.get(name)?.superclass ?? null; c !== null; c = interfaces.get(c)?.superclass ?? null) {
    out.push(c);
  }
  return out;
}

/** The protocols a class adopts (directly or through its categories), with the protocols those incorporate. */
function protocolsOf(iface: Interface, protocols: Map<string, Protocol>): Protocol[] {
  const seen = new Set<string>();
  const out: Protocol[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const p = protocols.get(name);
    if (!p) return;
    out.push(p);
    for (const parent of p.inherits) visit(parent);
  };
  for (const name of iface.protocols) visit(name);
  return out;
}

function generate(ast: Ast): string {
  const { interfaces, protocols } = ast;
  names = ast;
  markOptional(protocols);
  const variadics = sdkRows("VARIADIC");
  const arrayParams = sdkRows("ARRAY_PARAMS");
  const blockParams = sdkRows("BLOCK_PARAMS");
  const shims = blockShims();

  const emitted = new Set<string>();
  for (const name of ROOTS) {
    if (!interfaces.has(name)) throw new Error(`${name} is not a class these frameworks declare`);
    emitted.add(name);
    for (const a of ancestorsOf(name, interfaces)) emitted.add(a);
  }
  // Superclasses first, so a class can see what it inherits.
  const order = [...emitted].sort(
    (a, b) => ancestorsOf(a, interfaces).length - ancestorsOf(b, interfaces).length || (a < b ? -1 : 1),
  );
  const cx: Context = { emitted, interfaces, enumNames: new Set(Object.keys(enumTables.enums)), enumsUsed: new Set() };

  const inherits = (cls: string, from: string) => cls === from || ancestorsOf(cls, interfaces).includes(from);
  /** A `(selector, class[, index])` row applies to a class inheriting the row's class; a `c""` row (a protocol's method) to any. */
  const rowFor = (rows: SdkRow[], cls: string, selector: string, index: number) =>
    rows.find(r => r.selector === selector && r.index === index && (r.class === "" || inherits(cls, r.class)));
  /** Whether a result type is assignable to an inherited one: the same, or an object type narrowed to a subclass or `this`, not newly nullable. */
  const refines = (returns: string, inherited: string, cls: string): boolean => {
    const bare = (t: string) => t.replace(/ \| null$/, "");
    if (returns.endsWith(" | null") && !inherited.endsWith(" | null")) return false;
    const [sub, base] = [bare(returns), bare(inherited)];
    if (sub === base) return true;
    const object = /^(?:objc\.(\w+)|ObjCObject|this)$/;
    const [s, b] = [object.exec(sub), object.exec(base)];
    if (!s || !b || base === "this") return false;
    if (base === "ObjCObject") return true;
    const narrowed = sub === "this" ? cls : s[1];
    return narrowed !== undefined && b[1] !== undefined && inherits(narrowed, b[1]);
  };
  const memberText = (m: Omit<Member, "text">) => `${m.property}${m.optional ? "?" : ""}(${m.params}): ${m.returns};`;
  /** Whether member `a` may be declared where `b` is inherited: the same parameters, a result that refines, and not newly optional. */
  const fits = (a: Member, b: Member, cls: string): boolean =>
    a.params === b.params && refines(a.returns, b.returns, cls) && (!a.optional || b.optional);
  /** The one declaration that fits where both `a` and `b` are inherited (the narrower result, optional only if both are), or null. */
  const common = (a: Member, b: Member, cls: string): Member | null => {
    if (a.params !== b.params) return null;
    const returns = refines(a.returns, b.returns, cls)
      ? a.returns
      : refines(b.returns, a.returns, cls)
        ? b.returns
        : null;
    if (returns === null) return null;
    const merged = { property: a.property, params: a.params, returns, optional: a.optional && b.optional };
    return { ...merged, text: memberText(merged) };
  };

  /** One method as an interface member, or null when it is not reachable through a handle. */
  function member(m: Method, cls: string, side: "instance" | "class"): Member | null {
    // `origin::size:` (an empty selector part) has no property spelling; msgSend reaches it.
    if (m.unavailable || RESERVED_SELECTORS.has(m.selector) || m.selector.includes("::")) return null;
    if (rowFor(variadics, cls, m.selector, -1)) return null;
    const property = propertyFromSelector(m.selector);
    if (RESERVED_PROPERTIES.has(property)) return null;
    // Deprecated methods that a category puts on NSObject are the informal
    // protocols of old (delegate methods any object "might" implement);
    // nothing answers them unless it chose to, so they are left to the index
    // signature rather than listed on every object.
    if (m.owner === "NSObject" && m.category !== null && m.deprecated !== null) return null;

    const self = side === "instance" ? "this" : instanceType(cls, cx);
    const retShape = shapeOf(m.returns);
    let returns = returnType(m.returns, retShape, cx, self);
    if (retShape.kind === "int" && retShape.bits === 64 && returns === "number" && mayBeNotFound(m.selector)) {
      returns = "number | bigint";
    }

    // A pointer parameter the bridge's table lists as a C array takes only null.
    const shapes = m.params.map((p, i): Shape => {
      const shape = shapeOf(p.type);
      const listed = (shape.kind === "out" || shape.kind === "pointer") && rowFor(arrayParams, cls, m.selector, i);
      return listed ? { kind: "buffer" } : shape;
    });
    // Trailing out-parameters may be left off (the bridge passes NULL).
    let optionalFrom = shapes.length;
    while (optionalFrom > 0 && shapes[optionalFrom - 1].kind === "out") optionalFrom--;
    const taken = new Set<string>();
    const params = m.params.map((p, i) => {
      const shape = shapes[i];
      let functionType: string | null = null;
      if (shape.kind === "block") {
        const row = rowFor(blockParams, cls, m.selector, i);
        if (row?.types && shims.has(row.types)) functionType = blockFunctionType(row.types, shape, cx);
      }
      let name = p.name;
      if (KEYWORDS.has(name)) name += "_";
      while (taken.has(name)) name += "_";
      taken.add(name);
      return `${name}${i >= optionalFrom ? "?" : ""}: ${paramType(p.type, shape, cx, functionType)}`;
    });
    const built = { property, returns, params: params.join(", "), optional: m.optional };
    return { ...built, text: memberText(built) };
  }

  // An interface as built: its qualified name and every member it declares
  // or inherits, by property name (what an extending interface must fit).
  type Built = { type: string; declared: Map<string, Member> };
  const OBJECT: Built = { type: "ObjCObject", declared: new Map() };
  const CLASS: Built = { type: "ObjCClass", declared: new Map() };
  let methodCount = 0;

  /**
   * The body of an interface extending `bases` that declares `candidates`
   * (first wins per property). A member some base already declares is
   * declared again only when it narrows that result with the same
   * parameters (or makes an optional one required); anything else keeps
   * the inherited declaration, which TypeScript requires a redeclaration
   * to fit. Where two bases disagree about a member, the one declaration
   * that fits both (the narrower result; required unless both are
   * optional) is repeated in the body, as TypeScript also requires; when
   * there is none the later base cannot be extended and is reported in
   * `fold`, for the caller to declare its members in the body instead.
   */
  function build(
    candidates: Method[],
    cls: string,
    side: "instance" | "class",
    bases: Built[],
  ): { body: string[]; declared: Map<string, Member>; fold: Built | null } {
    const inherited = new Map<string, Member>();
    const restate = new Map<string, Member>();
    for (const base of bases) {
      for (const [property, mem] of base.declared) {
        const before = inherited.get(property);
        if (!before || before.text === mem.text) {
          inherited.set(property, mem);
          continue;
        }
        const merged = common(before, mem, cls);
        if (!merged) return { body: [], declared: inherited, fold: base };
        inherited.set(property, merged);
        restate.set(property, merged);
      }
    }
    const own = new Map<string, Member>();
    const body: string[] = [];
    for (const m of candidates) {
      if (m.isClass !== (side === "class")) continue;
      const mem = member(m, cls, side);
      if (!mem || own.has(mem.property)) continue;
      const before = inherited.get(mem.property);
      if (before && (mem.text === before.text || !fits(mem, before, cls))) continue;
      own.set(mem.property, mem);
      restate.delete(mem.property);
      if (m.deprecated !== null) body.push(`/** @deprecated ${m.deprecated.replace(/\*\//g, "* /")} */`);
      body.push(mem.text);
      methodCount++;
    }
    for (const mem of restate.values()) body.push(mem.text);
    return { body, declared: new Map([...inherited, ...own]), fold: null };
  }

  /** `build`, folding each base it cannot extend into the candidates until the rest fit. */
  function buildFolding(
    candidates: Method[],
    cls: string,
    side: "instance" | "class",
    bases: Built[],
    membersOf: (b: Built) => Method[],
  ) {
    for (;;) {
      const built = build(candidates, cls, side, bases);
      if (!built.fold) return { ...built, bases };
      const folded = built.fold;
      bases = bases.filter(b => b !== folded);
      candidates = [...candidates, ...membersOf(folded)];
    }
  }

  const emit = (into: string[], pad: string, doc: string, name: string, bases: string[], body: string[]) => {
    into.push(`${pad}/** ${doc} */`);
    if (body.length === 0) {
      into.push(`${pad}interface ${name} extends ${bases.join(", ")} {}`);
    } else {
      into.push(`${pad}interface ${name} extends ${bases.join(", ")} {`, ...body.map(l => `${pad}  ${l}`), `${pad}}`);
    }
  };

  // ── protocols: one interface each, for the classes below to extend ──
  const protocolLines: string[] = [];
  const builtProtocols = new Map<string, Built>();
  /** Every method a protocol requires or offers, its inherited protocols' included. */
  const protocolMethods = (name: string): Method[] => {
    const seen = new Set<string>();
    const out: Method[] = [];
    const visit = (n: string) => {
      const p = protocols.get(n);
      if (!p || seen.has(n)) return;
      seen.add(n);
      out.push(...p.methods);
      for (const q of p.inherits) visit(q);
    };
    visit(name);
    return out;
  };
  const protocolMethodsOf = (b: Built) => protocolMethods(b.type.replace(/^protocols\./, ""));
  /** Whether protocol `q` incorporates protocol `p` (directly or through the protocols it incorporates). */
  const incorporates = (q: string, p: string): boolean => {
    const inherits = protocols.get(q)?.inherits;
    return inherits !== undefined && (inherits.has(p) || [...inherits].some(r => incorporates(r, p)));
  };
  function buildProtocol(name: string): Built | null {
    const existing = builtProtocols.get(name);
    if (existing) return existing;
    const p = protocols.get(name);
    if (!p) return null;
    const parents = [...p.inherits].map(buildProtocol).filter((b): b is Built => b !== null);
    const { body, declared, bases } = buildFolding(
      p.methods,
      name,
      "instance",
      parents.length ? parents : [OBJECT],
      protocolMethodsOf,
    );
    const built: Built = { type: `protocols.${name}`, declared };
    builtProtocols.set(name, built);
    emit(
      protocolLines,
      "      ",
      `What an object conforming to \`${name}\` answers. The optional methods (\`@optional\`) it may not: test \`"method_" in object\` (\`respondsToSelector:\`) before calling one, since reading any selector off a handle gives a function and \`?.()\` therefore still sends.`,
      name,
      bases.map(b => b.type),
      body,
    );
    return built;
  }

  for (const name of PROTOCOL_ROOTS) {
    if (!buildProtocol(name)) throw new Error(`${name} is not a protocol these frameworks declare`);
  }

  // ── classes ──
  const builtClasses = { instance: new Map<string, Built>(), class: new Map<string, Built>() };
  const lines: string[] = [];
  const classLines: string[] = [];
  for (const cls of order) {
    const iface = interfaces.get(cls)!;
    const chain = ancestorsOf(cls, interfaces);
    const parent = chain[0] ?? null;
    // The protocols this class adds to what its superclasses adopt, less
    // those another one of them already incorporates.
    const inheritedProtocols = new Set(chain.flatMap(a => protocolsOf(interfaces.get(a)!, protocols).map(p => p.name)));
    const added = [...iface.protocols].filter(p => protocols.has(p) && !inheritedProtocols.has(p));
    const adopted = added.filter(p => !added.some(q => q !== p && incorporates(q, p)));

    // Instance side: the superclass, then each adopted protocol.
    {
      const bases = [parent !== null ? builtClasses.instance.get(parent)! : OBJECT];
      for (const p of adopted) {
        const b = buildProtocol(p);
        if (b) bases.push(b);
      }
      const { body, declared, bases: kept } = buildFolding(iface.methods, cls, "instance", bases, protocolMethodsOf);
      if (cls in ITERATES) {
        body.unshift(`/** ${ITERATES[cls][1]} */`, `[Symbol.iterator](): IterableIterator<${ITERATES[cls][0]}>;`);
      }
      builtClasses.instance.set(cls, { type: `objc.${cls}`, declared });
      emit(
        lines,
        "    ",
        `An \`${cls}\` instance.`,
        cls,
        kept.map(b => b.type),
        body,
      );
    }
    // Class side: the superclass's; a protocol's class methods are declared
    // here directly, and class methods that return `instancetype` are
    // declared again on each subclass with that subclass as the result
    // (`NSMutableArray.array()`).
    {
      const bases = [parent !== null ? builtClasses.class.get(parent)! : CLASS];
      const factories: Method[] = chain.flatMap(a => {
        const ai = interfaces.get(a)!;
        return [...ai.methods, ...protocolsOf(ai, protocols).flatMap(p => p.methods)].filter(
          m => m.isClass && shapeOf(m.returns).kind === "object" && /^instancetype\b/.test(m.returns.sugar),
        );
      });
      const candidates = [...iface.methods, ...adopted.flatMap(protocolMethods), ...factories];
      const { body, declared } = build(candidates, cls, "class", bases);
      body.unshift(`readonly alloc: () => objc.${cls};`, `readonly new: () => objc.${cls};`);
      builtClasses.class.set(cls, { type: `classes.${cls}`, declared });
      emit(
        classLines,
        "      ",
        `The \`${cls}\` class object (\`objc.classes.${cls}\`).`,
        cls,
        bases.map(b => b.type),
        body,
      );
    }
  }

  // ── objc.enums ──
  const enumLines: string[] = [];
  /** Members by full name: the `bigint` ones as lines of `Enums`, the rest as the names in `EnumMember`. */
  const bigMembers: string[] = [];
  const memberNames: string[] = [];
  /** Enumerations with a member above 2^53, whose alias is therefore `number | bigint`. */
  const bigEnums = new Set<string>();
  for (const [name, row] of Object.entries(enumTables.enums).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const prefix = row[0] as string;
    const numbers: string[] = [];
    const bigints: string[] = [];
    for (let i = 1; i < row.length; i += 2) {
      const suffix = row[i] as string;
      const value = row[i + 1];
      const full = suffix.startsWith("=") ? suffix.slice(1) : prefix + suffix;
      if (typeof value === "bigint") {
        bigEnums.add(name);
        bigMembers.push(`    readonly ${full}: bigint;`);
      } else {
        memberNames.push(JSON.stringify(full));
      }
      if (suffix.startsWith("=")) continue;
      (typeof value === "bigint" ? bigints : numbers).push(JSON.stringify(lowerFirstWord(suffix)));
    }
    const args = [numbers.length ? numbers.join(" | ") : "never"];
    if (bigints.length) args.push(bigints.join(" | "));
    enumLines.push(`    readonly ${name}: ObjCEnum<${args.join(", ")}>;`);
  }
  const looseLines = Object.entries(enumTables.loose)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `    readonly ${name}: ${typeof value === "bigint" ? "bigint" : "number"};`);

  const out: string[] = [];
  out.push("// Generated by scripts/appkit-dts.ts from the macOS SDK's Foundation, AppKit, QuartzCore, Metal");
  out.push("// and MetalKit headers; do not edit. `bun scripts/appkit-dts.ts` rewrites it.");
  out.push("//");
  out.push("// The Objective-C classes bun:appkit's `objc` bridge is most often asked for, as TypeScript sees");
  out.push("// them through a handle: `objc.NSWindow` is an NSWindow instance (its instance methods and its");
  out.push("// superclasses'), `objc.classes.NSWindow` the class (its class methods). Methods are named the");
  out.push("// way the bridge spells selectors (`setFrame:display:` is `setFrame_display_`) and typed the way");
  out.push("// it converts each argument and result; appkit.d.ts describes the conversions and declares the");
  out.push("// handle types these extend, whose index signature still admits any other selector.");
  out.push("");
  out.push('declare module "bun:appkit" {');
  out.push("  namespace objc {");
  for (const name of [...cx.enumsUsed].sort()) {
    const big = bigEnums.has(name);
    out.push(
      `    /** A member of {@link Enums.${name} \`objc.enums.${name}\`}${big ? "; a `bigint` for the ones above 2^53" : ""}. */`,
    );
    out.push(`    type ${name} = ${big ? "number | bigint" : "number"};`);
  }
  out.push("");
  out.push(
    "    /** Every enumeration member whose value is a plain number, by its full name (what `objc.enums` also answers flat). */",
  );
  out.push(`    type EnumMember = ${memberNames.join(" | ")};`);
  out.push("");
  out.push(
    "    /** What {@link ObjC.enums `objc.enums`} holds by name: each enumeration with its members, then every constant that stands alone, then (through `EnumMember` and the `bigint` lines) every member flat. */",
  );
  out.push("    interface Enums extends Readonly<Record<EnumMember, number>> {");
  out.push(...enumLines);
  out.push(...looseLines);
  out.push(...bigMembers);
  out.push("    }");
  out.push("");
  out.push("    namespace protocols {");
  out.push(...protocolLines);
  out.push("    }");
  out.push("");
  out.push(...lines);
  out.push("");
  out.push("    namespace classes {");
  out.push(...classLines);
  out.push("    }");
  out.push("  }");
  out.push("");
  out.push("  interface ObjCKnownClasses {");
  for (const cls of [...emitted].sort()) out.push(`    readonly ${cls}: objc.classes.${cls};`);
  out.push("  }");
  out.push("}");
  out.push("");
  console.error(
    `${emitted.size} classes, ${builtProtocols.size} protocols, ${methodCount} methods, ${enumLines.length} enums (${memberNames.length + bigMembers.length} members), ${looseLines.length} constants`,
  );
  return out.join("\n");
}

if (import.meta.main) {
  stamped(OUT, generate(parse(astDump({ arch: "arm64", headers: BRIDGED.map(f => `${f}/${f}.h`), preprocess: true }))));
}
