#!/usr/bin/env bun
// The NS_ENUM / NS_OPTIONS constants of the frameworks the `objc` bridge in
// bun:appkit loads (Foundation, AppKit, QuartzCore, Metal, MetalKit), by name.
//
// The Objective-C runtime knows nothing about enums, so the bridge carries a
// table of them (`objc.enums.NSWindowStyleMask.titled`). This asks the SDK's
// clang for the AST of those frameworks' umbrella headers on both
// architectures, reads out of it every enum declared in one of their headers
// and the C type of every exported non-object constant those headers pull in
// (CoreFoundation, CoreGraphics and the C library included, since
// `objc.constants` reaches every exported symbol and reads one as an object
// unless this table says otherwise), and writes src/js/internal/appkit_enums.ts. The table is as of the SDK and macOS named
// in the generated file's first line; rerun this after an Xcode update.
//
//   bun scripts/appkit-enums.ts           # rewrite the table
//   bun scripts/appkit-enums.ts --check   # exit 1 if the table is stale

import { join } from "node:path";
import { astDump, astLines, BRIDGED as FRAMEWORKS, root, stamped } from "./appkit-sdk";

const OUT = join(root, "src/js/internal/appkit_enums.ts");
const inScope = (file: string) => FRAMEWORKS.some(f => file.includes(`/${f}.framework/Headers/`));

type Member = { name: string; value: bigint; deprecated: boolean };
type Enum = { name: string | null; file: string; members: Member[] };
/** A `static const` number: its literal, or the enum member it copies. */
type Static = { negative: boolean; literal: string | null; alias: string | null; valid: boolean };
type Scan = { enums: Enum[]; constants: Map<string, string>; statics: Map<string, Static> };

/** A value as JavaScript source: a number when that is exact, else a bigint. */
const literal = (v: bigint) => (v > 9007199254740992n || v < -9007199254740992n ? `${v}n` : `${v}`);

/** The C type clang prints after desugaring -> the type encoding the bridge reads a constant as. */
function encodingOf(desugared: string): string | null {
  const t = desugared
    .replace(/\bconst\b/g, "")
    .replace(/\b_Nonnull\b|\b_Nullable\b|\b__strong\b/g, "")
    .trim();
  if (t.includes("*") || t === "id" || t === "Class") return "@";
  const scalars: Record<string, string> = {
    "double": "d",
    "float": "f",
    "long": "q",
    "unsigned long": "Q",
    "long long": "q",
    "unsigned long long": "Q",
    "int": "i",
    "unsigned int": "I",
    "short": "s",
    "unsigned short": "S",
    "bool": "B",
    "BOOL": "B",
    "signed char": "c",
    "unsigned char": "C",
  };
  if (t in scalars) return scalars[t];
  if (t.startsWith("enum ")) return null; // its underlying type is on the EnumDecl; every one in scope is NSInteger-sized
  const structs: Record<string, string> = {
    "struct CGRect": "{CGRect={CGPoint=dd}{CGSize=dd}}",
    "struct CGPoint": "{CGPoint=dd}",
    "struct CGSize": "{CGSize=dd}",
    "struct _NSRange": "{_NSRange=QQ}",
    "struct NSEdgeInsets": "{NSEdgeInsets=dddd}",
    "struct CGAffineTransform": "{CGAffineTransform=dddddd}",
  };
  return structs[t] ?? null;
}

function scan(arch: string): Scan {
  const dump = astDump({
    arch,
    headers: [...FRAMEWORKS.map(f => `${f}/${f}.h`), "Foundation/NSDebug.h"],
    preprocess: false,
  });

  const enums: Enum[] = [];
  const constants = new Map<string, string>();
  const statics = new Map<string, Static>();
  let staticVar: ({ depth: number; name: string } & Static) | null = null;
  // clang prints a source location's file only when it differs from the
  // previous location it printed, so each location's file is the last one
  // named before it. A declaration's file is where its source range ENDS,
  // unless that is not a file (`<built-in>`, `<scratch space>`): a macro
  // such as NS_ENUM starts the range, and puts the declaration's own
  // location, inside the header that defines the macro (CFAvailability.h)
  // and ends the range at the enum's own header.
  let lastFile = "";
  let declFile = "";
  const locPattern = /(\/[^:<>, ]+|<scratch space>|<built-in>|<command line>):\d+:\d+/g;
  let current: { depth: number; item: Enum; pending: Member | null; hasInit: boolean } | null = null;
  const enumTypes = new Map<string, string>();

  const finishMember = () => {
    if (!current?.pending) return;
    const members = current.item.members;
    if (!current.hasInit) {
      current.pending.value = members.length === 0 ? 0n : members[members.length - 1].value + 1n;
    }
    members.push(current.pending);
    current.pending = null;
  };
  const finishEnum = () => {
    if (!current) return;
    finishMember();
    if (current.item.members.length > 0) enums.push(current.item);
    current = null;
  };

  for (const { line, depth, body } of astLines(dump)) {
    // `<start, end> loc`: the end is a full location, `line:l:c` or `col:c`
    // (same file as the start); a lone `<loc>` is both.
    const range = /<([^<>]*(?:<[^<>]*>[^<>]*)*)>/.exec(line);
    const rangeEnd = range ? range.index + range[0].length : 0;
    let endFile = lastFile;
    for (const m of line.matchAll(locPattern)) {
      lastFile = m[1];
      if (m.index < rangeEnd) endFile = m[1];
    }
    declFile = endFile.startsWith("/") ? endFile : lastFile;

    if (current && depth <= current.depth) finishEnum();
    if (current && depth === current.depth + 1) finishMember();
    if (staticVar && depth <= staticVar.depth) {
      if (staticVar.valid && (staticVar.literal !== null || staticVar.alias !== null)) {
        statics.set(staticVar.name, staticVar);
      }
      staticVar = null;
    }
    if (staticVar) {
      // `static const NSModalResponse NSModalResponseOK = 1`: a literal,
      // maybe negated, or the name of an enum member.
      let m: RegExpMatchArray | null;
      if (/^UnaryOperator .* prefix '-'$/.test(body)) staticVar.negative = !staticVar.negative;
      else if ((m = body.match(/^IntegerLiteral .* (-?\d+)$/))) staticVar.literal ??= literal(BigInt(m[1]));
      else if ((m = body.match(/^FloatingLiteral .* ([-+.0-9eE]+)$/))) staticVar.literal ??= String(Number(m[1]));
      else if ((m = body.match(/^DeclRefExpr .* EnumConstant 0x[0-9a-f]+ '(\w+)'/))) staticVar.alias ??= m[1];
      else if (
        /^[A-Za-z]*(Operator|Expr|Literal) /.test(body) &&
        !/^(ImplicitCastExpr|ParenExpr|ConstantExpr) /.test(body)
      ) {
        staticVar.valid = false; // arithmetic or a call: not a plain constant
      }
      continue;
    }

    if (body.startsWith("EnumDecl ")) {
      finishEnum();
      // `... col:32 NSWindowStyleMask 'NSUInteger':'unsigned long'` or, unnamed, `... col:1 'NSUInteger':...`
      const named = body.match(/ ([A-Za-z_][A-Za-z0-9_]*) '([^']*)'/);
      const name = named && !/^(col|line)$/.test(named[1]) ? named[1] : null;
      if (name && named) enumTypes.set(name, named[2]);
      if (!inScope(declFile)) continue;
      current = { depth, item: { name, file: declFile, members: [] }, pending: null, hasInit: false };
      continue;
    }
    if (!current) {
      if (body.startsWith("VarDecl ") && body.endsWith(" extern")) {
        // `NSFontWeightBold 'const NSFontWeight':'const double' extern`; the
        // second quoted type (when present) is the desugared one.
        const m = body.match(/ ([A-Za-z_][A-Za-z0-9_]*) '([^']*)'(?::'([^']*)')? extern$/);
        if (m) {
          let desugared = m[3] ?? m[2];
          const viaEnum = desugared.match(/^(?:const )?enum (\w+)$/);
          if (viaEnum) desugared = enumTypes.get(viaEnum[1]) ?? desugared;
          const encoding = encodingOf(desugared);
          if (encoding && encoding !== "@") constants.set(m[1], encoding);
        }
      } else if (body.startsWith("VarDecl ") && body.endsWith(" static cinit") && inScope(declFile)) {
        const m = body.match(/ ([A-Za-z_][A-Za-z0-9_]*) '([^']*)'(?::'([^']*)')? static cinit$/);
        const type = m ? (m[3] ?? m[2]).replace(/\bconst /g, "") : "";
        if (m && (/^enum \w+$/.test(type) || /^[a-z ]+$/.test(type))) {
          staticVar = { depth, name: m[1], negative: false, literal: null, alias: null, valid: true };
        }
      }
      continue;
    }
    if (depth === current.depth + 1) {
      if (body.startsWith("EnumConstantDecl ")) {
        const m = body.match(/ ([A-Za-z_][A-Za-z0-9_]*) '/);
        if (!m) throw new Error(`cannot read the enumerator in: ${line}`);
        current.pending = { name: m[1], value: 0n, deprecated: false };
        current.hasInit = false;
      }
      continue;
    }
    if (!current.pending) continue;
    // Inside an EnumConstantDecl: its evaluated initializer and its availability.
    const value = body.match(/^value: Int (-?\d+)$/);
    if (value && !current.hasInit) {
      current.pending.value = BigInt(value[1]);
      current.hasInit = true;
      continue;
    }
    const availability = body.match(/^AvailabilityAttr .*?\bmacos ([0-9._]+) ([0-9._]+) ([0-9._]+)/);
    if (availability && availability[2] !== "0") current.pending.deprecated = true;
    if (body.startsWith("DeprecatedAttr ")) current.pending.deprecated = true;
  }
  finishEnum();
  return { enums, constants, statics };
}

// ───────────────────────────── member names ─────────────────────────────────

/** `NSURLBookmarkCreationOptions` -> ["NSURL", "Bookmark", "Creation", "Options"]: runs of capitals stay together up to the one that starts the next word. */
function words(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+|_+/g) ?? [name];
}

const singular = (w: string) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.replace(/e?s$/, ""));
const sameWord = (a: string, b: string) => a === b || singular(a) === singular(b);

/** Whether what `prefix` leaves of every name starts a new word (a capital). */
const leavesWords = (prefix: string, names: string[]) =>
  names.every(n => !n.startsWith(prefix) || /^[A-Z]/.test(n.slice(prefix.length)));

/**
 * The prefix every member of an enum drops for its short name: the text the
 * (non-deprecated) members share, cut back to where a word starts in each of
 * them, then to the words it also shares with the type name (plurals count:
 * `…Options` matches `…Option…`; a leading `k` is kept in the prefix). A lone
 * member shares all but its last word.
 */
function prefixOf(typeName: string, members: Member[]): string {
  const live = members.filter(m => !m.deprecated);
  const names = (live.length > 0 ? live : members).map(m => m.name);
  let prefix = names[0];
  if (names.length === 1) {
    prefix = prefix.slice(0, prefix.length - (words(prefix).at(-1)?.length ?? 0));
  } else {
    for (const n of names) {
      let i = 0;
      while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
      prefix = prefix.slice(0, i);
    }
  }
  while (prefix && !leavesWords(prefix, names)) prefix = prefix.slice(0, -1);
  const prefixWords = words(prefix);
  const typeWords = words(typeName);
  // CoreFoundation-style members carry a `k` the type name does not (`kCALayerLeftEdge` in `CAEdgeAntialiasingMask`).
  let shared = prefixWords[0] === "k" && typeWords[0] !== "k" ? 1 : 0;
  const skipped = shared;
  for (
    let i = 0;
    i + skipped < prefixWords.length && i < typeWords.length && sameWord(prefixWords[i + skipped], typeWords[i]);
    i++
  ) {
    shared += prefixWords[i + skipped].length;
  }
  return shared === skipped ? "" : prefix.slice(0, shared);
}

// ─────────────────────────────── output ─────────────────────────────────────

function generate(): string {
  const arm = scan("arm64");
  const intel = scan("x86_64");

  // Values by member name per architecture; the two SDK slices declare the
  // same names and differ in a handful of values.
  const intelValues = new Map<string, bigint>();
  for (const e of intel.enums) for (const m of e.members) intelValues.set(m.name, m.value);
  const value = (m: Member) => {
    const other = intelValues.get(m.name);
    if (other === undefined) throw new Error(`${m.name} is not declared for x86_64`);
    return other === m.value ? literal(m.value) : `A ? ${literal(m.value)} : ${literal(other)}`;
  };

  const named = new Map<string, Enum>();
  const loose = new Map<string, string>();
  const flat = new Map<string, string>();
  for (const e of arm.enums) {
    for (const m of e.members) {
      if (flat.has(m.name))
        throw new Error(`${m.name} is declared twice (${flat.get(m.name)} and ${e.name ?? e.file})`);
      flat.set(m.name, e.name ?? e.file);
    }
    if (e.name === null) {
      for (const m of e.members) loose.set(m.name, value(m));
    } else if (named.has(e.name)) {
      named.get(e.name)!.members.push(...e.members);
    } else {
      named.set(e.name, e);
    }
  }
  for (const name of named.keys()) {
    if (flat.has(name)) throw new Error(`${name} is both an enum and a member of ${flat.get(name)}`);
  }
  const armValues = new Map<string, bigint>();
  for (const e of arm.enums) for (const m of e.members) armValues.set(m.name, m.value);
  const staticValue = (s: Static, values: Map<string, bigint>): string | null => {
    const text = s.alias !== null ? (values.has(s.alias) ? literal(values.get(s.alias)!) : null) : s.literal;
    return text === null ? null : s.negative ? `-${text}` : text;
  };
  for (const [name, s] of arm.statics) {
    if (flat.has(name) || named.has(name)) continue;
    const a = staticValue(s, armValues);
    const other = intel.statics.get(name);
    const b = other ? staticValue(other, intelValues) : null;
    if (a === null || b === null) continue;
    loose.set(name, a === b ? a : `A ? ${a} : ${b}`);
  }

  const lines: string[] = [];
  lines.push("// Generated by scripts/appkit-enums.ts from the macOS SDK's Foundation, AppKit, QuartzCore,");
  lines.push("// Metal and MetalKit headers; do not edit. `bun scripts/appkit-enums.ts` rewrites it.");
  lines.push("//");
  lines.push("// enums: type name -> [prefix, suffix, value, suffix, value, ...]. A member's full name is");
  lines.push('// prefix + suffix, or the suffix alone after a leading "=" (a member outside the pattern);');
  lines.push("// its short name is the suffix with the first word in lower case.");
  lines.push("// loose: members of unnamed enums and `static const` numbers. constants: the type encoding");
  lines.push("// of each exported constant those headers see that is not an object.");
  lines.push('const A = process.arch === "arm64";');
  lines.push("// prettier-ignore");
  lines.push("const enums: Record<string, (string | number | bigint)[]> = {");
  for (const e of [...named.values()].sort((a, b) => (a.name! < b.name! ? -1 : 1))) {
    const prefix = prefixOf(e.name!, e.members);
    const parts = [JSON.stringify(prefix)];
    for (const m of e.members) {
      const suffix = prefix && m.name.startsWith(prefix) ? m.name.slice(prefix.length) : "=" + m.name;
      parts.push(JSON.stringify(suffix), value(m));
    }
    lines.push(`  ${e.name}: [${parts.join(",")}],`);
  }
  lines.push("};");
  lines.push("// prettier-ignore");
  lines.push("const loose: Record<string, number | bigint> = {");
  for (const [name, text] of [...loose].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push(`  ${name}: ${text},`);
  }
  lines.push("};");
  lines.push("// prettier-ignore");
  lines.push("const constants: Record<string, string> = {");
  for (const [name, encoding] of [...arm.constants].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const other = intel.constants.get(name);
    if (other === undefined) continue;
    // BOOL is `bool` (B) on arm64 and `signed char` (c) on x86_64.
    lines.push(
      `  ${name}: ${other === encoding ? JSON.stringify(encoding) : `A ? ${JSON.stringify(encoding)} : ${JSON.stringify(other)}`},`,
    );
  }
  lines.push("};");
  lines.push("export default { enums, loose, constants };");
  lines.push("");
  console.error(
    `${named.size} enums with ${[...named.values()].reduce((n, e) => n + e.members.length, 0)} members, ` +
      `${loose.size} loose constants, ${arm.constants.size} typed constants`,
  );
  return lines.join("\n");
}

if (import.meta.main) stamped(OUT, generate());
