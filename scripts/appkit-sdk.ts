// What the generators that read the macOS SDK for bun:appkit share:
// scripts/appkit-enums.ts (src/js/internal/appkit_enums.ts),
// scripts/appkit-sdk-methods.ts (src/appkit/objc/sdk.rs) and
// scripts/appkit-dts.ts (packages/bun-types/appkit-objc.generated.d.ts).
// That is clang's AST dump of framework headers and the reader for its
// lines, the Objective-C runtime through bun:ffi, the tables already
// written to sdk.rs, and the first-line stamp with the `--check` handling
// every generated file gets.

import { CString, dlopen, ptr as ffiPtr, read as ffiRead } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = join(import.meta.dir, "..");

/** The SDK the tables are read from: `$SDKROOT`, else the one xcrun selects. */
export const SDK =
  process.env.SDKROOT ?? spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).stdout.trim();

/** The frameworks the bridge loads (src/appkit/objc/mod.rs). */
export const BRIDGED = ["Foundation", "AppKit", "QuartzCore", "Metal", "MetalKit"];

/** The protocols bun:appkit's own classes adopt (src/js/bun/appkit.ts `delegateClass`, src/appkit/objc/delegate.rs). */
export const ADOPTED = [
  "MTKViewDelegate",
  "NSApplicationDelegate",
  "NSTableViewDataSource",
  "NSTableViewDelegate",
  "NSTextFieldDelegate",
  "NSTextViewDelegate",
  "NSWindowDelegate",
];

// ─────────────────────────────── output files ───────────────────────────────

const sdkVersion = spawnSync("xcrun", ["--show-sdk-version"], { encoding: "utf8" }).stdout.trim();
const osVersion = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim();
/** The first line of every generated file records what it was read from; `--check` compares everything after it. */
const STAMP = `// macOS SDK ${sdkVersion}, generated on macOS ${osVersion} (${process.arch}).\n`;
const afterStamp = (text: string) => text.replace(/^\/\/ macOS SDK .*\n/, "");

/**
 * Write `body` under the stamp line to `out`, or with `--check` on the
 * command line exit 1 when what is there differs past the stamp.
 */
export function stamped(out: string, body: string): void {
  const script = `bun scripts/${process.argv[1]?.split("/").at(-1) ?? ""}`;
  if (process.argv.includes("--check")) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (afterStamp(current) !== body) {
      console.error(`${out} is stale; run ${script}`);
      process.exit(1);
    }
    console.error("OK");
  } else {
    writeFileSync(out, STAMP + body);
    console.error(`wrote ${out}`);
  }
}

// ─────────────────────────────── clang's AST ────────────────────────────────

/**
 * `clang -Xclang -ast-dump` of a file importing `headers` (`Foundation/Foundation.h`, …)
 * for `arch`. With `preprocess`, the dump is of the preprocessed text, so
 * that a type carrying an attribute written as a macro (`NSURL *homeDirectory
 * API_AVAILABLE(…)`) prints with its nullability (`NSURL * _Nonnull`) rather
 * than as `API_AVAILABLE NSURL *`; source locations then point into the one
 * preprocessed file.
 */
export function astDump({
  arch,
  headers,
  preprocess,
}: {
  arch: string;
  headers: string[];
  preprocess: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "appkit-sdk-"));
  try {
    const source = join(dir, "frameworks.m");
    writeFileSync(source, headers.map(h => `#import <${h}>\n`).join(""));
    const run = (args: string[]) => {
      const clang = spawnSync("xcrun", ["clang", "-arch", arch, "-isysroot", SDK, "-fno-color-diagnostics", ...args], {
        encoding: "utf8",
        maxBuffer: 1 << 30,
      });
      if (clang.status !== 0) throw new Error(`clang ${args.join(" ")} failed:\n${clang.stderr}`);
      return clang.stdout;
    };
    let input = source;
    if (preprocess) {
      input = join(dir, "frameworks.mi");
      run(["-E", source, "-o", input]);
    }
    return run(["-fsyntax-only", "-Xclang", "-ast-dump", input]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type AstLine = {
  /** The line as clang printed it. */
  line: string;
  /** 1 for the translation unit's children; 0 for a line that is not a node. */
  depth: number;
  /** The node: its kind, address and the rest, less the source range after the address. */
  body: string;
  /** `ObjCMethodDecl`, `ParmVarDecl`, …; "" for a line that is not a node. */
  kind: string;
};

/** The lines of an `-ast-dump`, with each node's depth in the tree. */
export function* astLines(text: string): Generator<AstLine> {
  for (const line of text.split("\n")) {
    const marker = line.search(/[|`]-[A-Za-z<]/);
    if (marker < 0) {
      yield { line, depth: 0, body: line, kind: "" };
      continue;
    }
    // `Kind 0xaddr [prev 0xaddr] <line:1:2, col:3> …`: the source range carries nothing the readers need.
    const body = line
      .slice(marker + 2)
      .replace(/^(\w+ 0x[0-9a-f]+ (?:prev 0x[0-9a-f]+ )?)<[^<>]*(?:<[^<>]*>[^<>]*)*> ?/, "$1");
    yield { line, depth: marker / 2 + 1, body, kind: /^[A-Za-z]+/.exec(body)?.[0] ?? "" };
  }
}

export type CType = { sugar: string; canon: string };

/** `'NSString * _Nonnull':'NSString *'` (as written : canonical) or a lone `'void'`. */
export function typesIn(text: string): CType | null {
  const m = /'([^']*)'(?::'([^']*)')?/.exec(text);
  return m ? { sugar: m[1], canon: m[2] ?? m[1] } : null;
}

// ──────────────────────────── the tables in sdk.rs ───────────────────────────

const SDK_RS = join(root, "src/appkit/objc/sdk.rs");

export type SdkRow = { selector: string; class: string; index: number; types?: string };

/**
 * Rows of a `(selector, class[, index[, types]])` table in
 * src/appkit/objc/sdk.rs. `class` is "" for a protocol's method; `index` is
 * -1 for a table without one (VARIADIC).
 */
export function sdkRows(table: "VARIADIC" | "ARRAY_PARAMS" | "BLOCK_PARAMS"): SdkRow[] {
  const text = readFileSync(SDK_RS, "utf8");
  const start = text.indexOf(`const ${table}:`);
  if (start < 0) throw new Error(`no ${table} table in sdk.rs`);
  const body = text.slice(start, text.indexOf("\n];", start));
  return [...body.matchAll(/\("([^"]*)", c"([^"]*)"(?:, (\d+))?(?:, c"([^"]*)")?\)/g)].map(m => ({
    selector: m[1],
    class: m[2],
    index: m[3] === undefined ? -1 : Number(m[3]),
    types: m[4],
  }));
}

export type ProtocolMethod = { selector: string; types: string; required: boolean; instance: boolean };

/** The `PROTOCOLS` table in src/appkit/objc/sdk.rs: protocols this machine may not register, with their methods. */
export function sdkProtocols(): Map<string, ProtocolMethod[]> {
  const text = readFileSync(SDK_RS, "utf8");
  const start = text.indexOf("const PROTOCOLS:");
  if (start < 0) throw new Error("no PROTOCOLS table in sdk.rs");
  const out = new Map<string, ProtocolMethod[]>();
  for (const m of text
    .slice(start)
    .matchAll(/Protocol \{\n\s*name: c"(\w+)",[\s\S]*?methods: &\[\n([\s\S]*?)\s*\],\n\s*\},/g)) {
    out.set(
      m[1],
      [...m[2].matchAll(/\(c"([^"]*)", c"([^"]*)", (true|false), (true|false)\)/g)].map(r => ({
        selector: r[1],
        types: r[2],
        required: r[3] === "true",
        instance: r[4] === "true",
      })),
    );
  }
  return out;
}

// ───────────────────────── the Objective-C runtime ───────────────────────────

export type ObjCRuntime = {
  /** The `Protocol` object registered under `name`, or null. */
  protocol(name: string): bigint | null;
  /** The protocols `protocol` incorporates, by name. */
  adopted(protocol: bigint): string[];
  /** `protocol_copyMethodDescriptionList`: the protocol's own methods of one kind. */
  methods(protocol: bigint, required: boolean, instance: boolean): { selector: string; types: string }[];
  /** Load a dynamic library (a framework binary or a compiled probe); throws with dlerror's text. */
  load(path: string): void;
};

let runtime: ObjCRuntime | undefined;

/** libobjc through bun:ffi, with the bridged frameworks loaded so their classes and protocols are registered. */
export function objcRuntime(): ObjCRuntime {
  if (runtime) return runtime;
  const libobjc = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getProtocol: { args: ["cstring"], returns: "ptr" },
    protocol_copyMethodDescriptionList: { args: ["ptr", "bool", "bool", "ptr"], returns: "ptr" },
    protocol_copyProtocolList: { args: ["ptr", "ptr"], returns: "ptr" },
    protocol_getName: { args: ["ptr"], returns: "cstring" },
    sel_getName: { args: ["ptr"], returns: "cstring" },
  }).symbols;
  const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: ["cstring", "i32"], returns: "ptr" },
    dlerror: { args: [], returns: "cstring" },
    free: { args: ["ptr"], returns: "void" },
  }).symbols;
  const cstr = (s: string) => Buffer.from(s + "\0");
  const asPointer = (p: unknown): bigint | null => (p ? BigInt(p as number | bigint) : null);
  const count = new Uint32Array(1);
  runtime = {
    protocol: name => asPointer(libobjc.objc_getProtocol(cstr(name))),
    adopted(protocol) {
      const out: string[] = [];
      const list = libobjc.protocol_copyProtocolList(protocol as never, ffiPtr(count));
      if (!list) return out;
      for (let i = 0; i < count[0]; i++) out.push(String(libobjc.protocol_getName(ffiRead.ptr(list, i * 8) as never)));
      libSystem.free(list);
      return out;
    },
    methods(protocol, required, instance) {
      const out: { selector: string; types: string }[] = [];
      const list = libobjc.protocol_copyMethodDescriptionList(protocol as never, required, instance, ffiPtr(count));
      if (!list) return out;
      for (let i = 0; i < count[0]; i++) {
        out.push({
          selector: String(libobjc.sel_getName(ffiRead.ptr(list, i * 16) as never)),
          types: String(new CString(ffiRead.ptr(list, i * 16 + 8) as never)),
        });
      }
      libSystem.free(list);
      return out;
    },
    load(path) {
      if (!libSystem.dlopen(cstr(path), 2)) throw new Error(`dlopen ${path}: ${libSystem.dlerror()}`);
    },
  };
  for (const framework of BRIDGED) runtime.load(`/System/Library/Frameworks/${framework}.framework/${framework}`);
  return runtime;
}
