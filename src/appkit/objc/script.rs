//! Classes whose instance methods are functions a script gave: what
//! `objc.defineClass()` and `objc.target()` in `bun:appkit` build.
//!
//! Every such method is added to the class with the runtime's forwarding
//! trampoline as its IMP and the method's real type encoding, so
//! `respondsToSelector:`, `methodSignatureForSelector:`, `conformsToProtocol:`
//! and a superclass method being overridden all see an ordinary method, and
//! every call to one lands in a single `forwardInvocation:` that unpacks the
//! `NSInvocation` with [`super::dynamic`]'s machinery and hands it to the
//! class's [`Methods`]. The root script class of a chain (the first whose
//! superclass is a framework class) also gets one pointer ivar for data a
//! script attaches to an instance, and a `dealloc` that frees it.

use core::any::Any;
use core::cell::{Cell, RefCell};
use core::ffi::c_void;
use std::ffi::CString;

use super::define::{Declarations, ivar_offset};
use super::dynamic::{
    self, DynClass, DynObject, DynValue, Enc, Family, Frame, Keep, Reply, Signature, decode,
    encode, pool_if_none, read_out, unsupported, write_out,
};
use super::foundation::{NSInvocation, NSObject};
use super::{
    Bool, Class, ClassType, Id, Obj, Object, Sel, handoff, is_main_thread, load, register_sel, rt,
    sel,
};
use crate::error::{Error, Result};
use bun_core::strings;

/// One instance method: its selector and, when the script gave one, its type
/// encoding (`"v@:@"`; otherwise see [`define_class`]).
pub struct MethodSpec {
    pub selector: String,
    pub types: Option<String>,
    /// The method's result, when it is the same boolean, number or nil every
    /// time: then no function is called and any thread may send it.
    pub constant: Option<DynValue>,
}

pub struct ClassSpec {
    /// Empty for a generated name.
    pub name: String,
    pub superclass: DynClass,
    /// Adopted so `conformsToProtocol:` answers for them, and searched for
    /// the type encodings of methods the script did not type.
    pub protocols: Vec<String>,
    pub methods: Vec<MethodSpec>,
}

/// One message to an instance of a script-defined class.
pub struct Call<'a> {
    pub receiver: DynObject,
    /// The method's position among the function (non-constant) methods in
    /// [`ClassSpec::methods`] of the class that defines it (the receiver's,
    /// or the nearest script class above it).
    pub index: usize,
    /// For a per-instance table lookup.
    pub selector: &'a str,
    /// `-[Class selector]`, for messages.
    pub method: &'a str,
    /// One per parameter; an [`Enc::Out`] parameter arrives as the value it
    /// points at, zero for NULL.
    pub args: Vec<dynamic::DynValue>,
    pub params: &'a [Enc],
    /// What the returned value will be encoded as.
    pub ret: &'a Enc,
    /// What [`attach`] stored on the receiver, if anything.
    pub instance: Option<&'a dyn Any>,
}

/// The script side of a class. Both run on the main thread, inside whatever
/// sent the message (AppKit event dispatch, or a bridged send from the
/// script itself), so they may be re-entered.
pub trait Methods {
    fn call(&self, call: Call<'_>) -> Reply;
    /// A message that could not be delivered or answered for a reason on
    /// this side; the sender reads zero, so the script is told this way.
    fn report(&self, err: Error);
}

struct Method {
    sel: Sel,
    selector: String,
    sig: Signature,
}

/// A registered script class. Leaked: classes never go away.
struct Entry {
    class: Class,
    /// In [`ClassSpec::methods`] order.
    methods: Vec<Method>,
    /// Where instances keep their [`attach`]ed data (the root's ivar).
    data_offset: isize,
    handler: Box<dyn Methods>,
}

/// What the ivar points at while data is attached.
struct InstanceData(Box<dyn Any>);

const IVAR: &core::ffi::CStr = c"_bunScriptData";

thread_local! {
    /// Script classes by `Class`, on the main thread (the only one that
    /// defines them or runs their methods).
    static CLASSES: RefCell<Vec<&'static Entry>> = const { RefCell::new(Vec::new()) };
    static GENERATED_NAMES: Cell<usize> = const { Cell::new(0) };
}

/// Selectors a script may not define: the bridge owns reference counting,
/// and the two forwarding hooks are how every other method is delivered.
const RESERVED: &[&str] = &[
    "retain",
    "release",
    "autorelease",
    "retainCount",
    "allowsWeakReference",
    "retainWeakReference",
    "dealloc",
    "forwardInvocation:",
    "methodSignatureForSelector:",
];

/// The script classes at or above `class`, nearest first.
fn script_classes(class: Class) -> impl Iterator<Item = &'static Entry> {
    rt().class_chain(class).filter_map(|c| {
        CLASSES.with_borrow(|classes| classes.iter().find(|e| e.class == c).copied())
    })
}

/// The script method a message `sel` to an instance of `class` runs: the
/// nearest script class up the chain that defines it, and its index there.
fn script_method(class: Class, sel: Sel) -> Option<(&'static Entry, usize)> {
    script_classes(class).find_map(|e| e.methods.iter().position(|m| m.sel == sel).map(|i| (e, i)))
}

fn generated_name() -> String {
    loop {
        let n = GENERATED_NAMES.get() + 1;
        GENERATED_NAMES.set(n);
        let name = format!("BunScriptObject{n}");
        let c_name = CString::new(name.as_str()).expect("no NUL in a generated name");
        if super::lookup_class(&c_name).is_none() {
            return name;
        }
    }
}

/// Registers the class `spec` describes, delivering its methods to `handler`.
///
/// A method's type encoding is, in order: the one the script gave; what an
/// adopted protocol declares for the selector; what the superclass chain
/// implements for it; what Foundation's and AppKit's protocols declare for
/// it, when they agree; else object return and object arguments, one per
/// colon.
pub fn define_class(spec: &ClassSpec, handler: Box<dyn Methods>) -> Result<DynClass> {
    load()?;
    let _pool = pool_if_none();
    let name = if spec.name.is_empty() {
        generated_name()
    } else {
        spec.name.clone()
    };
    let bad_name = || Error::ClassName(name.clone());
    let c_name = CString::new(name.as_str()).map_err(|_| bad_name())?;
    let superclass = spec.superclass.0;
    let root = script_classes(superclass).next().is_none();
    let mut decls = Declarations::new(superclass, &c_name).ok_or_else(bad_name)?;
    let methods = match add_methods(&mut decls, &name, spec, root) {
        Ok(methods) => methods,
        Err(err) => {
            decls.dispose();
            return Err(err);
        }
    };
    let class = decls.register();
    let data_offset = ivar_offset(class, IVAR).expect("script data ivar missing");
    let entry: &'static Entry = Box::leak(Box::new(Entry {
        class,
        methods,
        data_offset,
        handler,
    }));
    CLASSES.with_borrow_mut(|classes| classes.push(entry));
    Ok(DynClass(class))
}

fn add_methods(
    decls: &mut Declarations,
    class_name: &str,
    spec: &ClassSpec,
    root: bool,
) -> Result<Vec<Method>> {
    for protocol in &spec.protocols {
        let adopted = CString::new(protocol.as_str()).is_ok_and(|p| decls.try_adopt(&p));
        if !adopted {
            return Err(Error::NoProtocol(protocol.clone()));
        }
    }
    let mut methods: Vec<Method> = Vec::with_capacity(spec.methods.len());
    let mut defined: Vec<Sel> = Vec::with_capacity(spec.methods.len());
    for MethodSpec {
        selector,
        types,
        constant,
    } in &spec.methods
    {
        let name = format!("-[{class_name} {selector}]");
        if selector.is_empty() || RESERVED.contains(&selector.as_str()) {
            return Err(unsupported(
                &name,
                "this selector cannot be defined by a script",
            ));
        }
        if Family::of(selector) == Family::Init {
            return Err(unsupported(
                &name,
                "init methods cannot be defined (there are no super calls yet); create the object with the superclass's alloc().init…() or new() and set it up afterwards",
            ));
        }
        let c_sel = CString::new(selector.as_str())
            .map_err(|_| unsupported(&name, "a selector cannot contain NUL"))?;
        let sel = register_sel(&c_sel);
        let colons = strings::count_char(selector.as_bytes(), b':');
        let default = format!("@@:{}", "@".repeat(colons));
        let types = match types.clone().or_else(|| decls.declared(sel)) {
            Some(types) => types,
            None => match decls.declared_by_any_protocol(sel, &default) {
                Ok(Some(types)) => types,
                Ok(None) => default,
                Err(protocols) => {
                    let list: Vec<String> = protocols
                        .into_iter()
                        .map(|(protocol, types)| format!("{protocol} ({types})"))
                        .collect();
                    return Err(unsupported(
                        &name,
                        format!(
                            "protocols declare this selector with different types: {}; list the one meant in `protocols`, or give `types`",
                            list.join(", ")
                        ),
                    ));
                }
            },
        };
        if defined.contains(&sel) {
            return Err(unsupported(&name, "defined twice"));
        }
        defined.push(sel);
        let (sig, c_types) = parse_types(name, sel, &types, colons)?;
        if let Some(value) = constant {
            let imp = constant_imp(&sig, value)?;
            // SAFETY: an IMP taking only `self`, which any method's caller
            // passes, and returning `sig.ret`, which `c_types` declares.
            unsafe { decls.add_raw(sel, imp, c_types.as_ptr()) };
            continue;
        }
        // SAFETY: the forwarding trampoline is a valid IMP for any method: it
        // reads no arguments itself, and `forward_invocation` marshals them
        // by these same types.
        unsafe { decls.add_raw(sel, forwarding_imp(&sig.ret), c_types.as_ptr()) };
        methods.push(Method {
            sel,
            selector: selector.clone(),
            sig,
        });
    }
    for (protocol, required) in decls.required() {
        let missing: Vec<String> = required
            .into_iter()
            .filter(|sel| !defined.contains(sel) && !decls.inherits(*sel))
            .map(|sel| rt().sel_name(sel))
            .collect();
        if !missing.is_empty() {
            return Err(Error::RequiredMethods {
                class: class_name.to_owned(),
                protocol: protocol.to_owned(),
                missing: missing.join(", "),
            });
        }
    }
    if root {
        decls.add_pointer_ivar(IVAR);
        // SAFETY: both transcribe NSObject's declarations, which debug builds check.
        unsafe {
            decls.add_method(
                sel!("forwardInvocation:"),
                forward_invocation as extern "C" fn(Obj, Sel, Obj),
            );
            decls.add_method(sel!("dealloc"), dealloc as extern "C" fn(Obj, Sel));
        }
    }
    Ok(methods)
}

/// `_objc_msgForward`, which makes the runtime build an `NSInvocation` and
/// call `forwardInvocation:` (the `_stret` variant where the ABI returns
/// `ret` through a hidden pointer).
fn forwarding_imp(ret: &Enc) -> *const c_void {
    #[cfg(target_arch = "x86_64")]
    if let Enc::Struct(t) = ret
        && t.size > 16
    {
        return rt()._objc_msgForward_stret;
    }
    let _ = ret;
    rt()._objc_msgForward
}

/// A global block (never copied or freed) that captures one machine word:
/// what [`constant_imp`] hands `imp_implementationWithBlock`.
#[repr(C)]
struct ConstantBlock {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const ConstantDescriptor,
    bits: u64,
}

#[repr(C)]
struct ConstantDescriptor {
    reserved: usize,
    size: usize,
}

static CONSTANT_DESCRIPTOR: ConstantDescriptor = ConstantDescriptor {
    reserved: 0,
    size: core::mem::size_of::<ConstantBlock>(),
};

const BLOCK_IS_GLOBAL: i32 = 1 << 28;

unsafe extern "C" {
    /// The class of a block with static storage, which `Block_copy` returns as is.
    static _NSConcreteGlobalBlock: [*const c_void; 32];
}

extern "C" fn constant_word(block: &ConstantBlock, _this: Obj) -> u64 {
    block.bits
}

extern "C" fn constant_f64(block: &ConstantBlock, _this: Obj) -> f64 {
    f64::from_bits(block.bits)
}

extern "C" fn constant_f32(block: &ConstantBlock, _this: Obj) -> f32 {
    f32::from_bits(block.bits as u32)
}

/// An IMP that returns `value` as `sig.ret` whoever calls it, on any thread:
/// a block capturing the encoded value, made a method by the runtime.
fn constant_imp(sig: &Signature, value: &DynValue) -> Result<*const c_void> {
    let wrong = |got: String| Error::ReturnType {
        method: sig.method().to_owned(),
        expected: sig.ret.to_string(),
        got,
    };
    let scalar = matches!(
        value,
        DynValue::Bool(_) | DynValue::I64(_) | DynValue::U64(_) | DynValue::F64(_)
    );
    let fits = match &sig.ret {
        Enc::Bool | Enc::Int { .. } | Enc::F32 | Enc::F64 => scalar,
        Enc::Void | Enc::Struct(_) => false,
        // Anything an object would have to be kept alive for is not a constant.
        _ => matches!(value, DynValue::Nil),
    };
    if !fits {
        return Err(wrong(format!(
            "the constant {}; a constant method returns a boolean, a number or null",
            value.kind()
        )));
    }
    let mut frame = Frame::new();
    encode(
        sig.method(),
        0,
        &sig.ret,
        value,
        &mut frame,
        &mut Keep::default(),
    )
    .map_err(|err| match err {
        Error::ArgType { got, .. } => wrong(got),
        err => err,
    })?;
    let invoke = match sig.ret {
        Enc::F64 => constant_f64 as extern "C" fn(&ConstantBlock, Obj) -> f64 as *const c_void,
        Enc::F32 => constant_f32 as extern "C" fn(&ConstantBlock, Obj) -> f32 as *const c_void,
        _ => constant_word as extern "C" fn(&ConstantBlock, Obj) -> u64 as *const c_void,
    };
    let block: &'static ConstantBlock = Box::leak(Box::new(ConstantBlock {
        isa: core::ptr::addr_of!(_NSConcreteGlobalBlock).cast(),
        flags: BLOCK_IS_GLOBAL,
        reserved: 0,
        invoke,
        descriptor: &raw const CONSTANT_DESCRIPTOR,
        bits: frame.read_u64(0),
    }));
    // SAFETY: a complete global block literal that lives, like the class the
    // IMP goes on, for the rest of the process; its invoke function takes
    // the block and the receiver, as `imp_implementationWithBlock` requires.
    Ok(unsafe { (rt().imp_implementationWithBlock)(core::ptr::from_ref(block).cast()) })
}

/// `types` checked and split by `NSMethodSignature`, then narrowed to what
/// [`forward_invocation`] can deliver and return.
fn parse_types(
    method: String,
    sel: Sel,
    types: &str,
    colons: usize,
) -> Result<(Signature, CString)> {
    let invalid = |why: &dyn core::fmt::Display| {
        unsupported(
            &method,
            format!("type encoding {types:?} is not valid{why}"),
        )
    };
    let c_types = CString::new(types).map_err(|_| invalid(&""))?;
    let ns = dynamic::method_signature(types, invalid)?;
    let selector = rt().sel_name(sel);
    let sig = Signature::new(ns, sel, method, Family::of(&selector));
    let method = sig.method();
    if !sig.has_self_and_cmd() {
        return Err(unsupported(
            method,
            format!(
                "type encoding {types:?} must start with the return type followed by \"@:\" for the receiver and _cmd"
            ),
        ));
    }
    if sig.args.len() != colons {
        return Err(unsupported(
            method,
            format!(
                "type encoding {types:?} has {} argument(s) but the selector takes {colons}",
                sig.args.len()
            ),
        ));
    }
    for (index, enc) in sig.args.iter().enumerate() {
        let refused = match enc {
            Enc::Buffer(b) => Some(format!("{b} (a C array; a C string parameter is r*)")),
            Enc::Other(_) => Some(enc.to_string()),
            _ => None,
        };
        if let Some(refused) = refused {
            return Err(unsupported(
                method,
                format!("argument {index} type {refused} is not supported for a script method"),
            ));
        }
    }
    sig.check_return()?;
    if let Enc::CString | Enc::Out(_) | Enc::Buffer(_) | Enc::Pointer = sig.ret {
        return Err(unsupported(
            method,
            format!(
                "return type {} is not supported for a script method",
                sig.ret
            ),
        ));
    }
    Ok((sig, c_types))
}

/// Stores `data` on `object`, an instance of a script class, until the object
/// deallocates. Once only, so a method running with the data in hand cannot
/// see it freed.
pub fn attach(object: &DynObject, data: Box<dyn Any>) -> Result<()> {
    load()?;
    let live = object.live()?;
    let Some(entry) = script_classes(rt().class_of(live.as_id())).next() else {
        return Err(Error::InvalidState(
            "only an instance of a class made with objc.defineClass() carries script data",
        ));
    };
    // SAFETY: every instance of the chain has the root's pointer ivar at
    // this offset; only this function and `dealloc` write it, on this thread.
    unsafe {
        let slot = live
            .as_obj()
            .byte_offset(entry.data_offset)
            .cast::<*mut InstanceData>();
        if !(*slot).is_null() {
            return Err(Error::InvalidState(
                "script data is already attached to this object",
            ));
        }
        *slot = bun_core::heap::into_raw(Box::new(InstanceData(data)));
    }
    Ok(())
}

/// The nearest ancestor of `class` whose `sel` is not `imp`: where a `super`
/// send from the script class that installed `imp` goes. Also yields that
/// script class (the last one walked that still inherits `imp`).
fn below_imp(class: Class, sel: Sel, imp: usize) -> Option<(Class, Class)> {
    let mut installed = class;
    loop {
        let base = rt().superclass(installed)?;
        if rt().method_implementation(base, sel) as usize != imp {
            return Some((installed, base));
        }
        installed = base;
    }
}

/// Whether `class` answers `forwardInvocation:` with something other than a
/// root class's implementation, which only raises "unrecognized selector".
fn forwards_beyond_root(class: Class, cmd: Sel) -> bool {
    let imp = rt().method_implementation(class, cmd);
    let root_imp = |root: Option<Class>| root.map(|c| rt().method_implementation(c, cmd));
    Some(imp) != root_imp(Some(NSObject::class()))
        && Some(imp) != root_imp(super::lookup_class(c"NSProxy"))
}

extern "C" fn forward_invocation(this: Obj, cmd: Sel, invocation: Obj) {
    // JavaScript runs on the main thread only; a sender elsewhere reads zero,
    // and the main thread is told.
    if !is_main_thread() {
        // SAFETY: `-[NSInvocation selector]` is `:@:`, and `invocation` is the
        // live NSInvocation forwardInvocation: was sent with; `this` is the
        // receiver, whose class name is a static string.
        let (class, selector) = unsafe {
            let send: unsafe extern "C" fn(Obj, Sel) -> Sel =
                core::mem::transmute(rt().objc_msgSend);
            (
                rt().class_name_of(this),
                rt().sel_name(send(invocation, sel!("selector"))),
            )
        };
        handoff::wrong_thread(format!("-[{class} {selector}]"));
        return;
    }
    // SAFETY: `invocation` is the live NSInvocation forwardInvocation: was sent with.
    let Some(invocation) = (unsafe { Id::retain(invocation).map(|id| NSInvocation::from_id(id)) })
    else {
        return;
    };
    let Some(sel) = invocation.selector() else {
        return;
    };
    // SAFETY: `this` is the receiver, which has not finished deallocating
    // while it is being sent messages.
    let class = unsafe { rt().class_of_raw(this) };
    let Some((entry, index)) = script_method(class, sel) else {
        // A selector no script class defines but something up the chain gave
        // a signature for: a framework superclass that forwards for real
        // decides what that means; the root classes would only raise.
        let ours = forward_invocation as extern "C" fn(Obj, Sel, Obj) as usize;
        if let Some((_, base)) = below_imp(class, cmd, ours)
            && forwards_beyond_root(base, cmd)
        {
            // SAFETY: `base` implements or inherits forwardInvocation: as
            // `v@:@`; receiver and argument are the ones we were called with.
            let imp: extern "C" fn(Obj, Sel, Obj) =
                unsafe { core::mem::transmute(rt().method_implementation(base, cmd)) };
            imp(this, cmd, invocation.as_obj());
        }
        return;
    };
    if let Err(err) = deliver(this, &invocation, entry, index) {
        entry.handler.report(err);
    }
}

/// Runs the script method and stores its result in `invocation`; anything
/// short of that leaves the result zero.
fn deliver(this: Obj, invocation: &NSInvocation, entry: &Entry, index: usize) -> Result<()> {
    let method = &entry.methods[index];
    let sig = &method.sig;
    // An invocation built by hand can carry any signature; reading an
    // argument it does not have would raise inside this frame.
    let carried = invocation.method_signature();
    if carried.number_of_arguments() != sig.args.len() + 2
        || carried.method_return_length() != sig.ret_len()
    {
        return Err(unsupported(
            sig.method(),
            format!(
                "was sent an invocation whose signature takes {} argument(s) and returns {} bytes; the method takes {} and returns {}",
                carried.number_of_arguments().saturating_sub(2),
                carried.method_return_length(),
                sig.args.len(),
                sig.ret_len()
            ),
        ));
    }
    // A receiver part way through deallocating (its superclass's dealloc
    // sending something the script overrides) cannot be kept alive for the
    // script, so the script never sees it.
    // SAFETY: `this` is the receiver forwardInvocation: was sent to, valid for
    // its duration even then; `retainWeakReference` is `B@:` on both root
    // classes and has taken a reference when it answers YES.
    let retained: Bool = unsafe { rt().send(this, sel!("retainWeakReference"), ()) };
    if !retained.get() {
        return Ok(());
    }
    // SAFETY: the reference just taken moves into the wrapper.
    let Some(receiver) = (unsafe { DynObject::from_retained(this) }) else {
        return Ok(());
    };
    let mut args = Vec::with_capacity(sig.args.len());
    let mut frames = Vec::with_capacity(sig.args.len());
    for (i, enc) in sig.args.iter().enumerate() {
        let mut frame = Frame::new();
        invocation.get_argument_raw(frame.as_mut_ptr(), (i + 2) as isize);
        args.push(match enc {
            Enc::Out(pointee) => read_out(sig.method(), *pointee, &frame)?,
            _ => decode(sig.method(), enc, false, &frame)?,
        });
        frames.push(frame);
    }
    // SAFETY: instances of the chain carry the root's ivar at `data_offset`:
    // null, or what `attach` leaked, which only `dealloc` frees, and the
    // object cannot deallocate while `receiver` holds a reference.
    let instance = unsafe {
        (*this
            .byte_offset(entry.data_offset)
            .cast::<*const InstanceData>())
        .as_ref()
    }
    .map(|data| &*data.0);
    let reply = entry.handler.call(Call {
        receiver,
        index,
        selector: &method.selector,
        method: sig.method(),
        args,
        params: &sig.args,
        ret: &sig.ret,
        instance,
    });
    for (index, value) in &reply.outs {
        if let (Some(Enc::Out(pointee)), Some(frame)) = (sig.args.get(*index), frames.get(*index)) {
            write_out(sig.method(), *index, *pointee, frame, value)?;
        }
    }
    let Some(result) = reply.value else {
        return Ok(());
    };
    if sig.ret == Enc::Void {
        return Ok(());
    }
    let mut frame = Frame::new();
    let mut keep = Keep::default();
    encode(sig.method(), 0, &sig.ret, &result, &mut frame, &mut keep)?;
    if let Enc::Object | Enc::CFObject(_) | Enc::Block = sig.ret {
        let object = frame.read_word() as Obj;
        if !object.is_null() {
            // SAFETY: `encode` just stored a live object (held by `keep`, or a
            // class). The reference taken here is the sender's: theirs to
            // release for a creating selector, else the enclosing pool's.
            unsafe {
                let object = (rt().objc_retain)(object);
                if !sig.family.returns_retained() {
                    (rt().objc_autorelease)(object);
                }
            }
        }
    }
    invocation.set_return_value_raw(frame.as_ptr());
    Ok(())
}

extern "C" fn dealloc(this: Obj, cmd: Sel) {
    let ours = dealloc as extern "C" fn(Obj, Sel) as usize;
    // SAFETY: an object in dealloc is still a valid pointer with its class intact.
    let class = unsafe { rt().class_of_raw(this) };
    let Some((root, base)) = below_imp(class, cmd, ours) else {
        unreachable!("dealloc override on a root class");
    };
    if let Some(offset) = ivar_offset(root, IVAR) {
        // SAFETY: the root script class declares this pointer ivar; it is
        // null or what `attach` leaked, and nothing else can reach the
        // object any more. The script's values are let go on its thread.
        unsafe {
            let slot = this.byte_offset(offset).cast::<*mut InstanceData>();
            let data = core::ptr::replace(slot, core::ptr::null_mut());
            if !data.is_null() {
                handoff::free_on_main_thread(data);
            }
        }
    }
    // SAFETY: `base` is a framework class, whose dealloc is `v@:`.
    let imp: extern "C" fn(Obj, Sel) =
        unsafe { core::mem::transmute(rt().method_implementation(base, cmd)) };
    imp(this, cmd);
}
