#!/usr/bin/env bun
// What the macOS SDK knows about Objective-C methods and protocols that the
// runtime's type encodings and registered metadata do not tell the `objc`
// bridge in bun:appkit. Writes src/appkit/objc/sdk.rs with four tables:
//
// - VARIADIC: methods that read a variable argument list (`...` or a
//   `va_list`), which an encoding does not show; from the headers of every
//   framework in the SDK.
// - ARRAY_PARAMS: parameters that are C arrays the method indexes (`unichar
//   *buffer` next to a `range:`, `id objects[]` next to a `count:`), which
//   encode exactly like a pointer to one value (`NSError **`); same source.
// - BLOCK_PARAMS: the type encoding of each block parameter, which the
//   runtime encodes as a bare `@?`; from the BridgeSupport metadata macOS
//   ships for Foundation, AppKit, QuartzCore, Metal and MetalKit, plus the
//   block-typed properties in those headers (BridgeSupport omits them).
// - PROTOCOLS: the protocols those frameworks declare but register no
//   `Protocol` object for at run time (nothing in them names `@protocol(X)`),
//   with their method descriptions as clang emits them, so the bridge can
//   register them itself; found by probing the loaded frameworks on this
//   machine and read back from a compiled Objective-C file. Which protocols a
//   framework registers varies by macOS version, so the ones bun:appkit itself
//   adopts (ADOPTED below) are always written, whatever this machine says.
//
// Why the headers and not BridgeSupport alone: on current macOS the
// .bridgesupport files mark 11 Foundation methods and 1 AppKit method
// variadic where the headers declare 52 (no NS_REQUIRES_NIL_TERMINATION
// method, no va_list method and no NSExpression/NSAttributedString format
// variant is in them), and they carry no sentinel or array-parameter facts
// (`getCharacters:range:` is a plain pointer there). They are used only for
// block parameter types, which they spell out and the headers give as
// typedef names. The tables here are as of the SDK and macOS named in the
// generated file's first line; rerun this after an Xcode or macOS update.
//
//   bun scripts/appkit-sdk-methods.ts           # rewrite the tables
//   bun scripts/appkit-sdk-methods.ts --check   # exit 1 if they are stale

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADOPTED, BRIDGED, objcRuntime, root, SDK, stamped } from "./appkit-sdk";

const ROOT = join(SDK, "System/Library/Frameworks");
const OUT = join(root, "src/appkit/objc/sdk.rs");

/** Comments and string literals may contain `...`; neither is part of a declaration. */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** The index just past the `)` that closes the `(` at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

type Param = { keyword: string; type: string; name: string };

/**
 * `- (id)initWithObjects:(const ObjectType [])objects count:(NSUInteger)cnt`
 * -> selector `initWithObjects:count:` and its (keyword, type, name) triples;
 * `- (NSUInteger)count` -> selector `count` and none. A parameter with no
 * `(type)` is an `id`; attribute macros and their arguments are skipped.
 */
function parseMethod(decl: string): { selector: string; params: Param[] } | null {
  let i = decl.indexOf("(");
  if (i < 0) return null;
  i = closeParen(decl, i);
  const params: Param[] = [];
  let unary: string | null = null;
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/;
  const spaces = /^\s*/;
  while (i < decl.length) {
    i += spaces.exec(decl.slice(i))![0].length;
    const word = identifier.exec(decl.slice(i))?.[0] ?? "";
    let j = i + word.length;
    j += spaces.exec(decl.slice(j))![0].length;
    if (decl[j] === ":") {
      j += 1 + spaces.exec(decl.slice(j + 1))![0].length;
      let type = "id";
      if (decl[j] === "(") {
        const close = closeParen(decl, j);
        type = decl.slice(j + 1, close - 1).trim();
        j = close + spaces.exec(decl.slice(close))![0].length;
      }
      const name = identifier.exec(decl.slice(j))?.[0] ?? "";
      params.push({ keyword: word, type, name });
      i = j + name.length;
    } else if (word) {
      if (params.length === 0) unary ??= word;
      i = j;
    } else if (decl[i] === "(") {
      i = closeParen(decl, i);
    } else if (decl[i] === "," || decl[i] === ";") {
      break;
    } else {
      i++;
    }
  }
  if (params.length > 0) return { selector: params.map(p => p.keyword + ":").join(""), params };
  return unary ? { selector: unary, params } : null;
}

/** Selector parts that give the element count of the array parameter just before them. */
const SIZING = new Set(["count", "length", "maxLength", "maxCount", "numIndices", "capacity", "range"]);
/** Names the SDK gives array parameters that no sizing part follows (the count is implied or elsewhere). */
const ARRAY_NAMES =
  /buf(fer)?$|Array$|^(indexes|indices|glyphs|components|positions|props|vals|charIndexes|points|rects|ranges|locations|pattern)$/i;
const NOISE =
  /\b(const|nullable|nonnull|null_unspecified|_Nullable|_Nonnull|_Null_unspecified|__nullable|__nonnull|__unsafe_unretained|__autoreleasing|__strong|__weak|__kindof|__unused|NS_NOESCAPE|inout|in|out|bycopy|byref|oneway|struct|volatile|NS_RELEASES_ARGUMENT|CF_RELEASES_ARGUMENT|CF_CONSUMED|NS_REFINED_FOR_SWIFT)\b/g;

/** The type names the SDK declares, sorted into what a pointer to one of them means. */
type Types = {
  /** Classes, protocols, generic placeholders: `NSString *` is the object, `NSString **` one out-value. */
  objects: Set<string>;
  /** Numbers, enums and structs: `NSUInteger *` is one out-value or an array. */
  values: Set<string>;
  /** Typedefs of a pointer to a value type (`NSRectArray`, `NSRangePointer`). */
  valuePointers: Set<string>;
};

/**
 * Whether `param` is declared as a C array the method reads or fills: an
 * array declarator (`ObjectType objects[]`), or a pointer to a value type
 * (`unichar *`, `NSUInteger *`, `char *`, `const CGFloat *`, `NSRectArray`)
 * that a sizing part follows (`count:`, `length:`, `maxLength:`, `range:`,
 * …) or whose name says so (`buffer`, `glyphs`, `components`, `…Array`).
 * Every other pointer (`NSError **`, `BOOL *isDirectory`, `NSRangePointer
 * effectiveRange`) points at one value. A pointer to a type the scan does not
 * know counts only with a sizing part after it.
 */
function isArrayParam(param: Param, next: Param | undefined, types: Types): boolean {
  const { type } = param;
  // Blocks and function pointers carry their own parameter lists.
  if (type.includes("^") || /\(\s*\*\s*\)/.test(type)) return false;
  if (/\[[^\]]*\]/.test(type)) return true;
  const bare = type
    .replace(/<[^<>]*>/g, " ")
    .replace(/<[^<>]*>/g, " ")
    .replace(NOISE, " ");
  let stars = (bare.match(/\*/g) ?? []).length;
  const base = bare.replace(/\*/g, " ").trim().replace(/\s+/g, " ");
  if (base === "" || base === "void" || types.objects.has(base) || /^id\b/.test(base)) return false;
  const sized = next !== undefined && SIZING.has(next.keyword);
  if (types.valuePointers.has(base)) stars += 1;
  else if (!types.values.has(base) && !SCALAR.test(base)) return stars === 1 && sized;
  return stars === 1 && (sized || ARRAY_NAMES.test(param.name) || (base.endsWith("Array") && !bare.includes("*")));
}

/** C's own arithmetic types and the ones <objc/objc.h>, <MacTypes.h> and CoreGraphics define outside a framework header. */
const SCALAR =
  /^(unsigned |signed )?(char|short|int|long|long long|unsigned|float|double|bool|_Bool|BOOL|Boolean|NSInteger|NSUInteger|CGFloat|unichar|UniChar|UTF32Char|UTF16Char|UTF8Char|OSType|OSStatus|FourCharCode|size_t|ssize_t|u?int(8|16|32|64)_t|[SU]Int(8|16|32|64)|Float(32|64)|GL[a-z]+)$/;

type Header = { where: string; text: string };
const headers: Header[] = [];
const types: Types = {
  objects: new Set(["id", "instancetype", "Class", "Protocol", "SEL"]),
  values: new Set(),
  valuePointers: new Set(),
};
const frameworks = existsSync(ROOT) ? readdirSync(ROOT).filter(f => f.endsWith(".framework")) : [];
for (const framework of frameworks) {
  const dir = join(ROOT, framework, "Headers");
  if (!existsSync(dir)) continue;
  for (const header of readdirSync(dir).filter(f => f.endsWith(".h"))) {
    const text = stripCommentsAndStrings(readFileSync(join(dir, header), "utf8"));
    headers.push({ where: `${framework}/${header}`, text });
    for (const m of text.matchAll(
      /@(?:interface|class|protocol)[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:[ \t]*,[ \t]*[A-Za-z_][A-Za-z0-9_]*)*)/g,
    )) {
      for (const name of m[1].split(",")) types.objects.add(name.trim());
    }
    // `@interface NSArray<__covariant ObjectType>`: the placeholders stand for objects.
    for (const m of text.matchAll(/@interface[ \t]+\w+[ \t]*<([^>]*(?:__covariant|__contravariant)[^>]*)>/g)) {
      for (const g of m[1].split(","))
        types.objects.add(
          g
            .replace(/__covariant|__contravariant/g, "")
            .trim()
            .split(/[\s:]/)[0],
        );
    }
    // `typedef NS_ENUM(NSInteger, NSTIFFCompression)`, `typedef struct _NSRange {…} NSRange;`: value types.
    for (const m of text.matchAll(/\btypedef\s+(?:NS|CF)_(?:CLOSED_)?(?:ENUM|OPTIONS)\s*\([^,)]*,\s*(\w+)/g)) {
      types.values.add(m[1]);
    }
    for (const m of text.matchAll(/\btypedef\s+(?:struct|union)\b[^{};]*\{[^}]*\}\s*(\w+)\s*;/g)) {
      types.values.add(m[1]);
    }
  }
}
if (headers.length === 0) throw new Error(`no framework headers under ${SDK}; set SDKROOT`);
// `typedef unsigned int NSGlyph;`, `typedef CGRect NSRect;`: value types. `typedef NSRect
// *NSRectArray;`: a pointer to one. `typedef NSString *NSFontWeight;`: an object. One
// typedef may name another from a header read later, so this runs to a fixed point.
const aliases = headers.flatMap(({ text }) =>
  [...text.matchAll(/\btypedef\s+([^{}();#@=]+?)\s*\b(\w+)\s*(?:[A-Z_]+\([^)]*\)\s*|[A-Z_]+\s*)*;/g)].flatMap(m => {
    const body = m[1].replace(NOISE, " ").trim();
    if (body.includes("^") || body.includes("[") || body.startsWith("enum ")) return [];
    const stars = (body.match(/\*/g) ?? []).length;
    const base = body.replace(/\*/g, " ").trim().split(/\s+/).at(-1) ?? "";
    return [{ name: m[2], base, stars }];
  }),
);
for (let changed = true; changed; ) {
  changed = false;
  for (const { name, base, stars } of aliases) {
    const known = (set: Set<string>) => set.has(name) || (changed = set.add(name).size > 0);
    const value = types.values.has(base) || SCALAR.test(base);
    if (stars === 0 && types.objects.has(base)) known(types.objects);
    else if (stars === 0 && value) known(types.values);
    else if (stars === 1 && value) known(types.valuePointers);
    else if (stars === 1 && types.objects.has(base)) known(types.objects);
  }
}

/** `selector\0class` */
const variadic = new Set<string>();
/** `selector\0class\0index`; class is empty for a method a protocol declares. */
const arrays = new Set<string>();
for (const { where, text } of headers) {
  // Either the `@interface`/`@protocol` line a declaration belongs to (a
  // category names its class first), or a method declaration: it starts a
  // line with - or + and runs to the next `;`, possibly across lines.
  let container: { kind: string; name: string } | null = null;
  for (const m of text.matchAll(
    /^[ \t]*@(interface|protocol)[ \t]+([A-Za-z_][A-Za-z0-9_]*)|^[ \t]*[-+][ \t]*\([^;@{}]*;/gm,
  )) {
    if (m[1]) {
      container = { kind: m[1], name: m[2] };
      continue;
    }
    const decl = m[0];
    const isVariadic = /,\s*\.\.\./.test(decl) || /\(\s*va_list\s*\)/.test(decl);
    if (!isVariadic && !/[*\[]|Array\s*\)/.test(decl)) continue;
    const method = parseMethod(decl);
    if (!method) throw new Error(`${where}: cannot read the selector of ${JSON.stringify(decl)}`);
    if (isVariadic) {
      if (container?.kind !== "interface") {
        // The bridge matches on the receiver's class chain; a protocol would
        // need a conformance check it does not have.
        throw new Error(
          `${where}: ${method.selector} is declared outside an @interface (${container?.kind} ${container?.name})`,
        );
      }
      variadic.add(`${method.selector}\0${container.name}`);
    }
    method.params.forEach((param, index) => {
      if (!isArrayParam(param, method.params[index + 1], types)) return;
      const owner = container?.kind === "interface" ? container.name : "";
      arrays.add(`${method.selector}\0${owner}\0${index}`);
    });
  }
}

// ─── block parameters ───

/** `selector\0class\0index\0types`; class is empty for a method a protocol declares. */
const blocks = new Set<string>();
for (const framework of BRIDGED) {
  const file = `/System/Library/Frameworks/${framework}.framework/Resources/BridgeSupport/${framework}.bridgesupport`;
  if (!existsSync(file)) throw new Error(`${file} is missing; BridgeSupport metadata ships with macOS`);
  let owner: string | null = null;
  let selector: string | null = null;
  let block: { index: number; types: string } | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^<class name='(\w+)'/))) owner = m[1];
    else if ((m = line.match(/^<informal_protocol name='(\w+)'/))) owner = "";
    else if (line.startsWith("</class>") || line.startsWith("</informal_protocol>")) owner = null;
    else if ((m = line.match(/^<method (?:class_method='true' )?selector='([^']+)'/))) selector = m[1];
    else if (line.startsWith("</method>")) selector = null;
    else if (owner !== null && selector !== null && block === null) {
      if ((m = line.match(/^<arg .*function_pointer='true'.* index='(\d+)'.* type64='@\?'/))) {
        block = { index: Number(m[1]), types: "@?" };
        if (line.endsWith("/>")) block = null; // no signature recorded
      }
    } else if (block !== null) {
      if ((m = line.match(/^<arg .*type64='([^']+)'/))) block.types += m[1];
      else if ((m = line.match(/^<retval .*type64='([^']+)'/))) block.types = m[1] + block.types;
      else if (line.startsWith("</arg>")) {
        blocks.add(`${selector}\0${owner}\0${block.index}\0${block.types}`);
        block = null;
      }
    }
  }
}
/** The C types block-typed properties are declared with, as encodings; anything else is left out. */
const PROPERTY_TYPES: Record<string, string> = {
  void: "v",
  BOOL: "B",
  float: "f",
  double: "d",
  CGFloat: "d",
  NSInteger: "q",
  NSUInteger: "Q",
  id: "@",
};
const propertyType = (c: string): string | undefined => {
  const bare = c
    .replace(NOISE, " ")
    .replace(/<[^<>]*>/g, " ")
    .trim();
  if (/^\w+\s*\*$/.test(bare) && types.objects.has(bare.replace("*", "").trim())) return "@";
  return PROPERTY_TYPES[bare.replace(/\s+\w+$/, "")] ?? PROPERTY_TYPES[bare];
};
for (const { where, text } of headers) {
  if (!BRIDGED.some(f => where.startsWith(f + ".framework/"))) continue;
  let owner: string | null = null;
  for (const m of text.matchAll(
    /^[ \t]*@(interface|protocol)[ \t]+([A-Za-z_][A-Za-z0-9_]*)|^[ \t]*@property\s*\(([^)]*)\)\s*([^;^]*?)\(\s*(?:\w+\s+)*\^\s*(\w+)\s*\)\s*\(([^)]*)\)[^;]*;/gm,
  )) {
    if (m[1]) {
      owner = m[1] === "interface" ? m[2] : "";
      continue;
    }
    if (owner === null || /\breadonly\b/.test(m[3])) continue;
    const ret = propertyType(m[4]);
    const params = m[6].trim() === "void" || m[6].trim() === "" ? [] : m[6].split(",").map(propertyType);
    if (ret === undefined || params.some(p => p === undefined)) continue;
    const name = m[5];
    blocks.add(`set${name[0].toUpperCase()}${name.slice(1)}:\0${owner}\0${0}\0${ret}@?${params.join("")}`);
  }
}

// ─── unregistered protocols ───

/** Protocols the bridged frameworks declare (not merely forward-declare), with the framework. */
const declaredProtocols = new Map<string, string>();
for (const { where, text } of headers) {
  const framework = BRIDGED.find(f => where.startsWith(f + ".framework/"));
  if (!framework) continue;
  for (const m of text.matchAll(/^[ \t]*@protocol[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*([<\n]|$)/gm)) {
    declaredProtocols.set(m[1], framework);
  }
}
const runtime = objcRuntime();
// The protocols bun:appkit itself adopts are in the table whether or not this machine registers them.
for (const name of ADOPTED) {
  if (!declaredProtocols.has(name)) throw new Error(`${name} is not declared in ${BRIDGED.join(", ")}`);
}
const unregistered = [
  ...new Set([...ADOPTED, ...[...declaredProtocols.keys()].filter(name => runtime.protocol(name) === null)]),
].sort();
type ProtocolRow = {
  name: string;
  adopts: string[];
  methods: { selector: string; types: string; required: boolean; instance: boolean }[];
};
const protocolRows: ProtocolRow[] = [];
if (unregistered.length > 0) {
  // clang writes the metadata; loading the result registers it, and the
  // runtime reads it back the way the bridge will rebuild it.
  const work = join(root, "tmp", "appkit-sdk-protocols");
  mkdirSync(work, { recursive: true });
  const source = join(work, "protocols.m");
  const dylib = join(work, "protocols.dylib");
  writeFileSync(
    source,
    BRIDGED.map(f => `#import <${f}/${f}.h>\n`).join("") +
      `void BunSDKProtocols(Protocol **out) {\n${unregistered.map((n, i) => `  out[${i}] = @protocol(${n});\n`).join("")}}\n`,
  );
  const compiled = spawnSync(
    "xcrun",
    [
      "clang",
      "-dynamiclib",
      "-isysroot",
      SDK,
      "-Wno-everything",
      "-fobjc-arc",
      "-o",
      dylib,
      source,
      "-lobjc",
      ...BRIDGED.flatMap(f => ["-framework", f]),
    ],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) throw new Error(`clang failed on the protocol probe:\n${compiled.stderr}`);
  runtime.load(dylib);
  for (const name of unregistered) {
    const protocol = runtime.protocol(name);
    if (protocol === null) throw new Error(`protocol ${name} did not register from the compiled probe`);
    const row: ProtocolRow = { name, adopts: runtime.adopted(protocol), methods: [] };
    for (const required of [true, false]) {
      for (const instance of [true, false]) {
        for (const m of runtime.methods(protocol, required, instance)) row.methods.push({ ...m, required, instance });
      }
    }
    row.methods.sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
    protocolRows.push(row);
  }
  rmSync(work, { recursive: true, force: true });
}

const byColumns = (a: string[], b: string[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};
const variadicRows = [...variadic]
  .map(key => key.split("\0"))
  .sort(byColumns)
  .map(([selector, cls]) => `    ("${selector}", c"${cls}"),\n`)
  .join("");
const arrayRows = [...arrays]
  .map(key => key.split("\0"))
  .sort((a, b) => byColumns([a[0], a[1]], [b[0], b[1]]) || Number(a[2]) - Number(b[2]))
  .map(([selector, cls, index]) => `    ("${selector}", c"${cls}", ${index}),\n`)
  .join("");
const blockRows = [...blocks]
  .map(key => key.split("\0"))
  .sort((a, b) => byColumns([a[0], a[1]], [b[0], b[1]]) || Number(a[2]) - Number(b[2]))
  // A property setter re-declared in a subclass header repeats the row.
  .filter((row, i, rows) => i === 0 || byColumns(row.slice(0, 3), rows[i - 1].slice(0, 3)) !== 0)
  .map(([selector, cls, index, types]) => `    ("${selector}", c"${cls}", ${index}, c"${types}"),\n`)
  .join("");
const rustString = (s: string) => JSON.stringify(s);
const protocolRowsText = protocolRows
  .map(
    ({ name, adopts, methods }) =>
      `    Protocol {\n        name: c${rustString(name)},\n        adopts: &[${adopts.map(a => `c${rustString(a)}`).join(", ")}],\n        methods: &[\n${methods
        .map(m => `            (c${rustString(m.selector)}, c${rustString(m.types)}, ${m.required}, ${m.instance}),\n`)
        .join("")}        ],\n    },\n`,
  )
  .join("");
const source = `//! What the macOS SDK headers say about methods that their type encodings
//! do not: which read a variable argument list (a trailing \`...\` or a
//! \`va_list\` parameter), and which parameters are C arrays the method reads
//! or fills (\`unichar *buffer\`, \`id objects[]\`, \`const CGFloat *components\`)
//! rather than pointers to one value; what type each block parameter has,
//! which the runtime encodes as a bare \`@?\`; and the protocols Foundation,
//! AppKit, QuartzCore, Metal and MetalKit declare without registering on
//! the generating machine (plus the ones bun:appkit adopts itself), with
//! their method descriptions. Generated from the SDK headers and the
//! BridgeSupport metadata by \`bun scripts/appkit-sdk-methods.ts\`; do not
//! edit by hand.

use core::ffi::CStr;

/// A protocol the headers declare that no loaded framework registers a
/// \`Protocol\` object for, as clang describes it.
pub(super) struct Protocol {
    pub name: &'static CStr,
    /// The protocols it incorporates, by name.
    pub adopts: &'static [&'static CStr],
    /// (selector, type encoding, required, instance method), sorted by selector.
    pub methods: &'static [(&'static CStr, &'static CStr, bool, bool)],
}

/// (selector, declaring class), sorted by selector for binary search.
#[rustfmt::skip]
pub(super) const VARIADIC: &[(&str, &CStr)] = &[
${variadicRows}];

/// (selector, declaring class or \`c""\` for a protocol's method, argument
/// index from 0), sorted by selector for binary search.
#[rustfmt::skip]
pub(super) const ARRAY_PARAMS: &[(&str, &CStr, usize)] = &[
${arrayRows}];

/// (selector, declaring class or \`c""\` for a protocol's method, argument
/// index from 0, the block's type encoding: return type, \`@?\`, one code per
/// argument), sorted by selector then class for binary search.
#[rustfmt::skip]
pub(super) const BLOCK_PARAMS: &[(&str, &CStr, usize, &CStr)] = &[
${blockRows}];

/// Sorted by name for binary search.
#[rustfmt::skip]
pub(super) const PROTOCOLS: &[Protocol] = &[
${protocolRowsText}];
`;

console.error(
  `${variadic.size} variadic methods, ${arrays.size} array parameters, ${blocks.size} block parameters, ${protocolRows.length} unregistered protocols from ${headers.length} headers in ${frameworks.length} frameworks`,
);
stamped(OUT, source);
