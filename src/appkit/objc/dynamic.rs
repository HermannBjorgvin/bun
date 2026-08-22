//! Messages chosen at run time: any selector on any object or class, typed
//! from the receiver's `NSMethodSignature` rather than from a binding line.
//! `NSInvocation` does the calling-convention work (struct and float returns
//! included), so nothing here depends on the CPU beyond the width of `BOOL`.
//!
//! The typed bindings in the sibling modules stay the way the crate itself
//! talks to AppKit; this is the escape hatch `bun:appkit` hands to scripts.

use bun_collections::HashMap;
use core::cell::{Ref, RefCell};
use core::ffi::{CStr, c_void};
use core::fmt;
use core::mem::ManuallyDrop;
use core::ptr::{self, NonNull};
use std::borrow::Cow;
use std::ffi::CString;
use std::rc::Rc;
use std::sync::OnceLock;

use super::appkit::NSWindow;
use super::foundation::{
    NSArray, NSData, NSDate, NSDictionary, NSException, NSInvocation, NSMethodSignature,
    NSMutableArray, NSMutableDictionary, NSNull, NSNumber, NSObject, NSString, Upcast,
};
use super::{
    AutoreleasePool, Class, ClassType, Id, NsStr, Obj, Object, Ptr, block, load, register_sel, rt,
    sdk,
};
use crate::error::{Error, Result};
use bun_core::strings;

// ───────────────────────────────── receivers ─────────────────────────────────

enum Slot {
    Live(NSObject),
    /// `+alloc` asked for on `class`, to be followed by an `init…`. Usually
    /// not sent until then, with arguments that converted, so a failed or
    /// forgotten init leaves nothing to deallocate; `instance` is the sent
    /// `+alloc`'s result for a class whose instances alone know their
    /// `init…` methods (see [`DynObject::allocate_now`]). Either way nothing
    /// but an `init…` may be sent to it.
    Allocated {
        class: DynClass,
        instance: Option<NSObject>,
    },
    Consumed,
    Released,
}

/// Any Objective-C object, retained for as long as this value lives (or until
/// [`release`](DynObject::release)). Class objects can be held this way too.
pub struct DynObject {
    slot: RefCell<Slot>,
    addr: usize,
}

impl fmt::Debug for DynObject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.slot.borrow() {
            Slot::Live(o) => fmt::Debug::fmt(o, f),
            Slot::Allocated { class, .. } => write!(f, "allocated({class:?})"),
            Slot::Consumed => write!(f, "consumed({:#x})", self.addr),
            Slot::Released => write!(f, "released({:#x})", self.addr),
        }
    }
}

impl DynObject {
    fn wrap(object: NSObject) -> DynObject {
        DynObject {
            addr: object.as_obj() as usize,
            slot: RefCell::new(Slot::Live(object)),
        }
    }

    fn allocated(class: DynClass) -> DynObject {
        DynObject {
            addr: 0,
            slot: RefCell::new(Slot::Allocated {
                class,
                instance: None,
            }),
        }
    }

    /// Sends the `+alloc` this wrapper stands for now rather than with the
    /// `init…`, for a class whose own method table lacks that `init…` (a
    /// class cluster whose concrete subclass has it), and returns the class
    /// of what came back, which is where the `init…` is looked up instead.
    /// The wrapper still counts as not initialised.
    fn allocate_now(&self, method: &str) -> Result<DynClass> {
        let mut slot = self.slot.borrow_mut();
        let Slot::Allocated { class, instance } = &mut *slot else {
            return Err(DynObject::unusable(&slot));
        };
        if instance.is_none() {
            *instance =
                Some(
                    class
                        .alloc_instance()
                        .ok_or_else(|| Error::UnsupportedSignature {
                            method: method.to_owned(),
                            what: "+alloc returned nil".into(),
                        })?,
                );
        }
        let object = instance.as_ref().expect("just set");
        Ok(DynClass(rt().class_of(object.as_id())))
    }

    /// The class `alloc()` was called on, while no `init…` has been sent.
    fn allocated_class(&self) -> Option<DynClass> {
        match &*self.slot.borrow() {
            Slot::Allocated { class, .. } => Some(*class),
            _ => None,
        }
    }

    /// Another reference to an object the crate already holds typed.
    pub(crate) fn from_object<T: Object>(object: &T) -> DynObject {
        DynObject::wrap(object.upcast().clone())
    }

    /// # Safety
    /// `ptr` is nil or a live object; one reference is taken.
    pub(super) unsafe fn retain(ptr: Obj) -> Option<DynObject> {
        // SAFETY: per contract; every object is an NSObject for our purposes.
        unsafe { Id::retain(ptr).map(|id| DynObject::wrap(NSObject::from_id(id))) }
    }

    /// # Safety
    /// `ptr` is nil or a +1 reference whose ownership moves here.
    pub(super) unsafe fn from_retained(ptr: Obj) -> Option<DynObject> {
        // SAFETY: per contract.
        unsafe { Id::from_retained(ptr).map(|id| DynObject::wrap(NSObject::from_id(id))) }
    }

    fn unusable(slot: &Slot) -> Error {
        match slot {
            Slot::Allocated { .. } => Error::NotInitialized,
            Slot::Consumed => Error::Consumed,
            _ => Error::ObjectReleased,
        }
    }

    pub(super) fn live(&self) -> Result<Ref<'_, NSObject>> {
        Ref::filter_map(self.slot.borrow(), |slot| match slot {
            Slot::Live(o) => Some(o),
            _ => None,
        })
        .map_err(|slot| DynObject::unusable(&slot))
    }

    /// Hands the one reference this wrapper owns (allocating it now, for an
    /// unsent `alloc`) to an `init…` message.
    fn take_for_init(&self, method: &str) -> Result<ManuallyDrop<NSObject>> {
        let mut slot = self.slot.borrow_mut();
        match core::mem::replace(&mut *slot, Slot::Consumed) {
            Slot::Live(o)
            | Slot::Allocated {
                instance: Some(o), ..
            } => Ok(ManuallyDrop::new(o)),
            Slot::Allocated {
                class,
                instance: None,
            } => match class.alloc_instance() {
                Some(o) => Ok(ManuallyDrop::new(o)),
                None => Err(Error::UnsupportedSignature {
                    method: method.to_owned(),
                    what: "+alloc returned nil".into(),
                }),
            },
            other => {
                let err = DynObject::unusable(&other);
                *slot = other;
                Err(err)
            }
        }
    }

    /// The object with a reference of its own, for the duration of a send.
    fn target(&self) -> Result<NSObject> {
        Ok(self.live()?.clone())
    }

    /// A second wrapper holding its own reference.
    pub fn try_clone(&self) -> Result<DynObject> {
        Ok(DynObject::wrap(self.target()?))
    }

    /// The object's address, kept after release for identity and debugging;
    /// 0 for an `alloc` awaiting its `init…`.
    pub fn address(&self) -> usize {
        self.addr
    }

    /// Drops this wrapper's reference now. Idempotent.
    pub fn release(&self) {
        let object = {
            let mut slot = self.slot.borrow_mut();
            match core::mem::replace(&mut *slot, Slot::Released) {
                Slot::Live(object) => Some(object),
                Slot::Allocated { instance, .. } => instance,
                other => {
                    *slot = other;
                    None
                }
            }
        };
        // The last release runs `dealloc`, which may autorelease, and may
        // send messages that come back to this wrapper; so it goes with the
        // slot no longer borrowed.
        if let Some(object) = object {
            let _pool = pool_if_none();
            drop(object);
        }
    }

    pub fn is_released(&self) -> bool {
        matches!(*self.slot.borrow(), Slot::Consumed | Slot::Released)
    }

    pub fn class_name(&self) -> Result<String> {
        if let Some(class) = self.allocated_class() {
            return Ok(class.name());
        }
        Ok(rt().class_name_of(self.live()?.as_obj()))
    }

    /// Whether the object is itself a class (or metaclass).
    pub fn is_class(&self) -> bool {
        match self.live() {
            // SAFETY: a live object.
            Ok(o) => unsafe { (rt().object_isClass)(o.as_obj()) }.get(),
            Err(_) => false,
        }
    }

    /// The object as a class, when it is one.
    pub fn as_class(&self) -> Option<DynClass> {
        if !self.is_class() {
            return None;
        }
        NonNull::new(self.live().ok()?.as_obj()).map(|p| DynClass(Class(p)))
    }

    /// `-description`, as UTF-16 for JavaScript; empty when it answers nil.
    pub fn description(&self) -> Result<Vec<u16>> {
        load()?;
        let _pool = pool_if_none();
        Ok(self
            .target()?
            .description()
            .map(|d| d.to_utf16())
            .unwrap_or_default())
    }

    /// A new `NSString`.
    pub fn string(text: NsStr<'_>) -> Result<DynObject> {
        load()?;
        Ok(DynObject::from_object(&NSString::from_str(text)))
    }

    /// A new `NSNumber`; see [`nsnumber`].
    pub fn number(value: f64) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&nsnumber(value)))
    }

    pub fn integer(value: i64) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSNumber::with_i64(value)))
    }

    pub fn unsigned(value: u64) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSNumber::with_u64(value)))
    }

    pub fn boolean(value: bool) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSNumber::with_bool(value)))
    }

    /// A new `NSData` holding a copy of `bytes`.
    pub fn data(bytes: &[u8]) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSData::from_bytes(bytes)))
    }

    /// A new `NSDate`, from milliseconds since 1970 the way JavaScript counts.
    pub fn date(milliseconds: f64) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSDate::with_seconds_since_1970(
            milliseconds / 1000.0,
        )))
    }

    /// `+[NSNull null]`.
    pub fn null() -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        Ok(DynObject::from_object(&NSNull::null()))
    }

    /// A new `NSMutableArray` holding `items` in order.
    pub fn array(items: &[DynObject]) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        let array = NSMutableArray::with_capacity(items.len());
        for item in items {
            array.add(&*item.live()?);
        }
        Ok(DynObject::from_object(&array))
    }

    /// A new `NSMutableDictionary` from `(key, value)` pairs; keys are
    /// usually `NSString`s from [`DynObject::string`].
    pub fn dictionary(entries: &[(DynObject, DynObject)]) -> Result<DynObject> {
        load()?;
        let _pool = pool_if_none();
        let dict = NSMutableDictionary::with_capacity(entries.len());
        for (key, value) in entries {
            dict.insert(&*value.live()?, &*key.live()?);
        }
        Ok(DynObject::from_object(&dict))
    }

    /// The Foundation value classes as plain data; anything else, and
    /// anything nested deeper than [`PLAIN_DEPTH`], stays an object.
    pub fn to_plain(&self) -> Result<Plain> {
        load()?;
        let _pool = pool_if_none();
        Ok(plain(&self.target()?, 0))
    }
}

/// `f64`s below this magnitude with no fraction convert to `i64` exactly.
const I64_EXACT_LIMIT: f64 = 9_223_372_036_854_775_808.0;

/// Integral values that fit `long long` keep an integer `objCType` (so they
/// print and compare as integers); everything else is a `double`.
fn nsnumber(value: f64) -> NSNumber {
    if value.fract() == 0.0 && value.abs() < I64_EXACT_LIMIT {
        NSNumber::with_i64(value as i64)
    } else {
        NSNumber::with_f64(value)
    }
}

/// How deep [`DynObject::to_plain`] unpacks nested arrays and dictionaries.
pub const PLAIN_DEPTH: usize = 32;

/// See [`DynObject::to_plain`].
#[derive(Debug)]
pub enum Plain {
    /// `NSNull`.
    Null,
    String(Vec<u16>),
    Number(f64),
    /// An `NSNumber` made from a signed integer type.
    Integer(i64),
    /// An `NSNumber` made from an unsigned integer type.
    Unsigned(u64),
    Boolean(bool),
    /// `NSData`'s bytes, copied.
    Data(Vec<u8>),
    /// `NSDate` as milliseconds since 1970.
    Date(f64),
    Array(Vec<Plain>),
    /// Keys are the `NSString` keys' text, or `-description` for other keys.
    Dictionary(Vec<(Vec<u16>, Plain)>),
    Other(DynObject),
}

/// Whether `object`'s class descends from `NSObject`. The one other root in
/// practice is `NSProxy`, whose instances forward nearly every message
/// (`respondsToSelector:` and `isKindOfClass:` included) to whatever they stand
/// for; `-[NSUndoManager prepareWithInvocationTarget:]`'s proxy even records
/// the first message it gets as the undo action. So a proxy is only ever sent
/// `methodSignatureForSelector:` and the message a script asked for.
fn is_proxy(object: &NSObject) -> bool {
    !rt().class_inherits(rt().class_of(object.as_id()), NSObject::class())
}

fn plain(object: &NSObject, depth: usize) -> Plain {
    if let Some(string) = view_as::<NSString>(object) {
        return Plain::String(string.to_utf16());
    }
    if let Some(number) = view_as::<NSNumber>(object) {
        if number.as_obj() == NSNumber::with_bool(true).as_obj() {
            return Plain::Boolean(true);
        }
        if number.as_obj() == NSNumber::with_bool(false).as_obj() {
            return Plain::Boolean(false);
        }
        return match number.objc_type().0.as_deref() {
            Some("c" | "s" | "i" | "l" | "q") => Plain::Integer(number.i64_value()),
            Some("C" | "S" | "I" | "L" | "Q") => Plain::Unsigned(number.u64_value()),
            _ => Plain::Number(number.f64_value()),
        };
    }
    if view_as::<NSNull>(object).is_some() {
        return Plain::Null;
    }
    if let Some(data) = view_as::<NSData>(object) {
        return Plain::Data(data.to_vec());
    }
    if let Some(date) = view_as::<NSDate>(object) {
        return Plain::Date(date.seconds_since_1970() * 1000.0);
    }
    if depth < PLAIN_DEPTH
        && let Some(array) = view_as::<NSArray>(object)
    {
        return Plain::Array(array.iter().map(|item| plain(&item, depth + 1)).collect());
    }
    if depth < PLAIN_DEPTH
        && let Some(dict) = view_as::<NSDictionary>(object)
    {
        let entries = dict
            .all_keys()
            .iter()
            .map(|key| {
                let name = match view_as::<NSString>(&key) {
                    Some(name) => name.to_utf16(),
                    None => key.description().map(|d| d.to_utf16()).unwrap_or_default(),
                };
                let value = dict.get(&key).map_or(Plain::Null, |v| plain(&v, depth + 1));
                (name, value)
            })
            .collect();
        return Plain::Dictionary(entries);
    }
    Plain::Other(DynObject::wrap(object.clone()))
}

/// `object` typed as `T` when its class is `T`'s or a subclass, read from the
/// runtime rather than asked with `isKindOfClass:` (the object may be a proxy,
/// which would forward the question).
pub(super) fn view_as<T: ClassType>(object: &NSObject) -> Option<T> {
    if !rt().class_inherits(rt().class_of(object.as_id()), T::class()) {
        return None;
    }
    let owned = ManuallyDrop::new(object.clone());
    // SAFETY: the class was just checked; the clone's one reference moves
    // into the `T`.
    Some(unsafe { T::from_id(ptr::read(owned.as_id())) })
}

/// A class, by name or from a `Class`-typed return.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct DynClass(pub(super) Class);

impl fmt::Debug for DynClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name())
    }
}

impl DynClass {
    pub fn name(&self) -> String {
        // SAFETY: a registered class; the name is a static C string.
        unsafe { CStr::from_ptr((rt().class_getName)(self.0.as_obj())) }
            .to_string_lossy()
            .into_owned()
    }

    pub fn address(&self) -> usize {
        self.0.as_obj() as usize
    }

    /// The class object held as an object, for `id`-typed uses.
    pub fn to_object(&self) -> DynObject {
        // SAFETY: a class is a live, never-deallocated object.
        match unsafe { DynObject::retain(self.0.as_obj()) } {
            Some(o) => o,
            None => unreachable!("Class is non-null"),
        }
    }

    /// The class object as a message target: never dropped, so no `release`
    /// pairs with the `retain` that was never sent.
    fn target(self) -> ManuallyDrop<NSObject> {
        // SAFETY: class objects are immortal; see above for why the wrapper
        // must not drop.
        ManuallyDrop::new(unsafe { NSObject::from_id(Id(self.0.0)) })
    }

    /// `+alloc`, sent for real.
    fn alloc_instance(self) -> Option<NSObject> {
        // SAFETY: `+alloc` is `(Class) -> id` on every class and returns +1.
        unsafe {
            let raw = rt().send::<Obj, _>(self.0.as_obj(), super::sel!("alloc"), ());
            Id::from_retained(raw).map(|id| NSObject::from_id(id))
        }
    }

    /// The type encoding the runtime records for `sel` on this class's
    /// instances (or on the class itself), before Foundation parses it.
    fn raw_types(self, sel: super::Sel, class_method: bool) -> Option<String> {
        rt().class_method_types(self.0, sel, class_method)
    }
}

/// `objc_getClass`.
pub fn lookup_class(name: &str) -> Result<DynClass> {
    load()?;
    let c_name = CString::new(name).map_err(|_| Error::NoClass(name.to_owned()))?;
    super::lookup_class(&c_name)
        .map(DynClass)
        .ok_or_else(|| Error::NoClass(name.to_owned()))
}

/// `objc_getProtocol`: the `Protocol` object, for `conformsToProtocol:` and the like.
pub fn lookup_protocol(name: &str) -> Result<DynObject> {
    load()?;
    let no_protocol = || Error::NoProtocol(name.to_owned());
    let c_name = CString::new(name).map_err(|_| no_protocol())?;
    let protocol = rt().protocol(&c_name).ok_or_else(no_protocol)?;
    // SAFETY: a registered protocol is a live, never-deallocated object.
    unsafe { DynObject::retain(protocol.as_ptr()) }.ok_or_else(no_protocol)
}

/// What a message is sent to.
#[derive(Clone, Copy, Debug)]
pub enum Receiver<'a> {
    Object(&'a DynObject),
    Class(&'a DynClass),
}

impl Receiver<'_> {
    fn class_name(&self) -> Result<String> {
        match self {
            Receiver::Object(o) => o.class_name(),
            Receiver::Class(c) => Ok(c.name()),
        }
    }

    fn is_instance(&self) -> bool {
        match self {
            Receiver::Object(o) => !o.is_class(),
            Receiver::Class(_) => false,
        }
    }

    /// `-[NSWindow setTitle:]` / `+[NSString stringWithString:]`, for messages.
    fn method_name(&self, sel: &str) -> Result<String> {
        let sign = if self.is_instance() { '-' } else { '+' };
        Ok(format!("{sign}[{} {sel}]", self.class_name()?))
    }

    /// `f` gets its own reference rather than a borrow of the wrapper's, so
    /// a script releasing the wrapper from inside the send is harmless.
    fn with_target<R>(&self, f: impl FnOnce(&NSObject) -> R) -> Result<R> {
        match self {
            Receiver::Object(o) => Ok(f(&o.target()?)),
            Receiver::Class(c) => Ok(f(&c.target())),
        }
    }

    /// The receiver as a class, when it is one (held either way).
    fn as_class(&self) -> Option<DynClass> {
        match self {
            Receiver::Object(o) => o.as_class(),
            Receiver::Class(c) => Some(**c),
        }
    }

    fn allocated_class(&self) -> Option<DynClass> {
        match self {
            Receiver::Object(o) => o.allocated_class(),
            Receiver::Class(_) => None,
        }
    }

    /// Where the runtime keeps `sel`'s method for this receiver: (class,
    /// whether it is a class method).
    fn method_owner(&self) -> Result<(DynClass, bool)> {
        if let Some(class) = self.allocated_class() {
            return Ok((class, false));
        }
        if let Some(class) = self.as_class() {
            return Ok((class, true));
        }
        self.with_target(|t| (DynClass(rt().class_of(t.as_id())), false))
    }

    /// See [`is_proxy`]; class objects and unsent allocs are not.
    fn is_proxy(&self) -> Result<bool> {
        if !self.is_instance() || self.allocated_class().is_some() {
            return Ok(false);
        }
        self.with_target(is_proxy)
    }

    /// Whether the receiver is a block object (class objects and unsent
    /// allocs are not).
    pub fn is_block(&self) -> Result<bool> {
        if !self.is_instance() || self.allocated_class().is_some() {
            return Ok(false);
        }
        self.with_target(|t| block::is_block(rt().class_of(t.as_id())))
    }

    /// `respondsToSelector:`; answered from the class's method table for an
    /// unsent `alloc` or a proxy, which must not be messaged (see [`is_proxy`]).
    pub fn responds_to(&self, sel: &str) -> Result<bool> {
        load()?;
        let _pool = pool_if_none();
        let Ok(c_sel) = CString::new(sel) else {
            return Ok(false);
        };
        let raw_sel = register_sel(&c_sel);
        let (owner, class_method) = self.method_owner()?;
        if self.allocated_class().is_some() || self.is_proxy()? {
            return Ok(owner.raw_types(raw_sel, class_method).is_some());
        }
        self.with_target(|t| t.responds_to_selector(raw_sel))
    }

    /// The selectors the receiver's class and its superclasses implement for
    /// it (instance methods for an instance, class methods for a class),
    /// less the ones that start with `_` or `.`, sorted, each once.
    pub fn method_names(&self) -> Result<Vec<String>> {
        load()?;
        let (owner, class_method) = self.method_owner()?;
        // Class methods live on the metaclass, which is the class's class.
        let start = if class_method {
            // SAFETY: a class object is a live object.
            unsafe { rt().class_of_raw(owner.0.as_obj()) }
        } else {
            owner.0
        };
        let mut names: Vec<String> = rt()
            .class_chain(start)
            .flat_map(|c| rt().method_names(c))
            .filter(|n| !n.starts_with('_') && !n.starts_with('.'))
            .collect();
        names.sort_unstable();
        names.dedup();
        Ok(names)
    }
}

// ───────────────────────────────── encodings ─────────────────────────────────

/// One argument or return type, reduced from its `@encode` string to what
/// decides how a value is marshalled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Enc {
    Void,
    /// `@`
    Object,
    /// `^{CGColor=}` and the other [`CF_OBJECTS`]: a Core Foundation object,
    /// retained and released like any `id`, but only ever that one type.
    CFObject(&'static CFType),
    /// `@?`
    Block,
    /// `#`
    Class,
    /// `:`
    Sel,
    /// `B`, and `c` where that is what `BOOL` is (x86_64).
    Bool,
    Int {
        bits: u8,
        signed: bool,
    },
    F32,
    F64,
    /// `r*`: a `const char *` C string.
    CString,
    /// `^@`, `^B`, `^q`, `^d`, `^{CGRect=…}`, …: a pointer to one value the
    /// bridge marshals, for a method to read and write back (`NSError **`,
    /// `BOOL *stop`, `NSRangePointer`).
    Out(Pointee),
    /// A C array the method reads or fills, which the bridge cannot size:
    /// `r^d` (`const CGFloat *components`), `*` without `r` (`char *buffer`),
    /// and the parameters [`sdk::ARRAY_PARAMS`] lists. Carries the encoding
    /// text; only NULL can be passed.
    Buffer(String),
    /// `^v`, `^{Opaque=}`, `^^@`, `^?`: any other pointer, carried as an
    /// address.
    Pointer,
    /// `{CGRect={CGPoint=dd}{CGSize=dd}}`, `{?=QQQ}`: a struct of scalars passed by value.
    Struct(&'static StructType),
    /// Arrays, unions, bit-fields, `long double`, vectors, and structs that
    /// contain any of those or a pointer: carried as the encoding text for
    /// the error message.
    Other(String),
}

/// A scalar member of a by-value struct.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    Bool,
    Int { bits: u8, signed: bool },
    F32,
    F64,
}

impl Scalar {
    /// From one encoding character; `c` is `BOOL` where the platform says so.
    fn of(c: char) -> Option<Scalar> {
        Some(match c {
            'B' => Scalar::Bool,
            'c' if cfg!(target_arch = "x86_64") => Scalar::Bool,
            'c' => Scalar::Int {
                bits: 8,
                signed: true,
            },
            'C' => Scalar::Int {
                bits: 8,
                signed: false,
            },
            's' => Scalar::Int {
                bits: 16,
                signed: true,
            },
            'S' => Scalar::Int {
                bits: 16,
                signed: false,
            },
            'i' | 'l' => Scalar::Int {
                bits: 32,
                signed: true,
            },
            'I' | 'L' => Scalar::Int {
                bits: 32,
                signed: false,
            },
            'q' => Scalar::Int {
                bits: 64,
                signed: true,
            },
            'Q' => Scalar::Int {
                bits: 64,
                signed: false,
            },
            'f' => Scalar::F32,
            'd' => Scalar::F64,
            _ => return None,
        })
    }

    /// Size in bytes, which is also the alignment for every scalar here.
    pub const fn size(self) -> usize {
        match self {
            Scalar::Bool => 1,
            Scalar::Int { bits, .. } => bits as usize / 8,
            Scalar::F32 => 4,
            Scalar::F64 => 8,
        }
    }

    pub fn enc(self) -> Enc {
        match self {
            Scalar::Bool => Enc::Bool,
            Scalar::Int { bits, signed } => Enc::Int { bits, signed },
            Scalar::F32 => Enc::F32,
            Scalar::F64 => Enc::F64,
        }
    }
}

/// One scalar member of a struct, flattened: where it sits and what it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub offset: usize,
    pub scalar: Scalar,
}

/// A struct passed by value, as its type encoding lays it out under C's
/// rules: `{CGRect={CGPoint=dd}{CGSize=dd}}` is four doubles at 0, 8, 16
/// and 24 in 32 bytes. Members of nested structs are flattened into
/// [`fields`](StructType::fields) with their offsets.
#[derive(Debug, PartialEq, Eq)]
pub struct StructType {
    /// `CGRect`, `_NSRange`; `?` for a struct the compiler left anonymous (a
    /// typedef of an unnamed struct, as `MTLSize` and `CMTime` are).
    pub name: &'static str,
    /// The encoding this was parsed from, qualifiers removed.
    pub encoding: &'static str,
    pub fields: &'static [Field],
    pub size: usize,
}

const fn f64_fields<const N: usize>() -> [Field; N] {
    let mut fields = [Field {
        offset: 0,
        scalar: Scalar::F64,
    }; N];
    let mut i = 0;
    while i < N {
        fields[i].offset = i * 8;
        i += 1;
    }
    fields
}

/// `NSRange`, for the block shims that take one.
pub static NS_RANGE: StructType = StructType {
    name: "_NSRange",
    encoding: "{_NSRange=QQ}",
    fields: &[
        Field {
            offset: 0,
            scalar: Scalar::Int {
                bits: 64,
                signed: false,
            },
        },
        Field {
            offset: 8,
            scalar: Scalar::Int {
                bits: 64,
                signed: false,
            },
        },
    ],
    size: 16,
};

/// `CGRect`, for the typed out-parameters and tests that name it.
pub static CG_RECT: StructType = StructType {
    name: "CGRect",
    encoding: "{CGRect={CGPoint=dd}{CGSize=dd}}",
    fields: &f64_fields::<4>(),
    size: 32,
};

impl StructType {
    /// The property names of the members when `bun:appkit` presents this
    /// struct as an object (`{ x, y, width, height }`), in layout order;
    /// any other struct crosses as an array of its members.
    pub fn field_names(&self) -> Option<&'static [&'static str]> {
        let names: &'static [&'static str] = match self.name {
            "CGRect" | "NSRect" => &["x", "y", "width", "height"],
            "CGPoint" | "NSPoint" => &["x", "y"],
            "CGSize" | "NSSize" => &["width", "height"],
            "CGVector" => &["dx", "dy"],
            "_NSRange" | "NSRange" => &["location", "length"],
            "NSEdgeInsets" | "UIEdgeInsets" => &["top", "left", "bottom", "right"],
            "NSDirectionalEdgeInsets" => &["top", "leading", "bottom", "trailing"],
            "CGAffineTransform" => &["a", "b", "c", "d", "tx", "ty"],
            "CATransform3D" => &[
                "m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24", "m31", "m32", "m33", "m34",
                "m41", "m42", "m43", "m44",
            ],
            _ => return None,
        };
        (names.len() == self.fields.len()).then_some(names)
    }

    /// `CGRect`/`NSRect`, which also reads and writes as `{ origin, size }`.
    pub fn is_rect(&self) -> bool {
        matches!(self.name, "CGRect" | "NSRect") && self.fields.len() == 4
    }

    /// `encoding` (`{name=members}`, qualifiers already stripped) laid out,
    /// or `None` when a member is not a scalar or a struct of scalars, or
    /// the whole is empty or larger than a [`Frame`].
    fn parse(encoding: &str) -> Option<&'static StructType> {
        thread_local! {
            /// Every struct type met so far, by encoding; each is leaked once.
            static TYPES: RefCell<HashMap<Box<str>, &'static StructType>> = RefCell::new(HashMap::default());
        }
        if let Some(known) = TYPES.with_borrow(|types| types.get(encoding).copied()) {
            return Some(known);
        }
        let mut chars = encoding.chars().peekable();
        let mut fields = Vec::new();
        let (name, size, _) = StructType::layout(&mut chars, 0, &mut fields)?;
        if chars.next().is_some() || fields.is_empty() || size > FRAME_SIZE {
            return None;
        }
        let interned: &'static StructType = Box::leak(Box::new(StructType {
            name: Box::leak(name.into_boxed_str()),
            encoding: Box::leak(encoding.to_owned().into_boxed_str()),
            fields: Box::leak(fields.into_boxed_slice()),
            size,
        }));
        TYPES.with_borrow_mut(|types| types.insert(encoding.into(), interned));
        Some(interned)
    }

    /// One `{name=members}` starting at `base`: appends its scalars to
    /// `fields` and returns (name, size, alignment). Each member sits at the
    /// next multiple of its alignment; a struct is aligned as its most
    /// aligned member and padded to a multiple of that.
    fn layout(
        chars: &mut core::iter::Peekable<core::str::Chars<'_>>,
        base: usize,
        fields: &mut Vec<Field>,
    ) -> Option<(String, usize, usize)> {
        if chars.next() != Some('{') {
            return None;
        }
        let mut name = String::new();
        loop {
            match chars.next()? {
                '=' => break,
                // `{CGColor}`: a name and no members says nothing about layout.
                '}' => return None,
                c => name.push(c),
            }
        }
        let (mut offset, mut align) = (0usize, 1usize);
        loop {
            match *chars.peek()? {
                '}' => {
                    chars.next();
                    let size = offset.next_multiple_of(align);
                    return Some((name, size, align));
                }
                '{' => {
                    let start = fields.len();
                    let (_, size, inner_align) = StructType::layout(chars, 0, fields)?;
                    let at = offset.next_multiple_of(inner_align);
                    for field in &mut fields[start..] {
                        field.offset += base + at;
                    }
                    offset = at + size;
                    align = align.max(inner_align);
                }
                c if is_qualifier(c) => {
                    chars.next();
                }
                c => {
                    chars.next();
                    let scalar = Scalar::of(c)?;
                    let at = offset.next_multiple_of(scalar.size());
                    fields.push(Field {
                        offset: base + at,
                        scalar,
                    });
                    offset = at + scalar.size();
                    align = align.max(scalar.size());
                }
            }
        }
    }

    /// What a script should pass, for messages.
    fn describe(&self) -> String {
        if self.is_rect() {
            return "a {origin, size} or {x, y, width, height} object".into();
        }
        match self.field_names() {
            Some(names) => format!("a {{{}}} object", names.join(", ")),
            None => format!("an array of {} numbers", self.fields.len()),
        }
    }
}

/// What an [`Enc::Out`] points at: the by-value types, less `void`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pointee {
    /// `^@`, `o^@` (`NSError **`): storage the callee fills and the caller
    /// need not initialise, so it is not read going in.
    Object,
    /// `N^@` (`inout id *`: KVC's `validateValue:forKey:error:`, a
    /// formatter's partial string): holds an object going in as well.
    InOutObject,
    Bool,
    Int {
        bits: u8,
        signed: bool,
    },
    F32,
    F64,
    Struct(&'static StructType),
}

impl Pointee {
    fn of(enc: &Enc) -> Option<Pointee> {
        Some(match enc {
            Enc::Object => Pointee::Object,
            Enc::Bool => Pointee::Bool,
            Enc::Int { bits, signed } => Pointee::Int {
                bits: *bits,
                signed: *signed,
            },
            Enc::F32 => Pointee::F32,
            Enc::F64 => Pointee::F64,
            Enc::Struct(t) => Pointee::Struct(t),
            _ => return None,
        })
    }

    /// The pointed-at type as a type of its own.
    pub fn enc(self) -> Enc {
        match self {
            Pointee::Object | Pointee::InOutObject => Enc::Object,
            Pointee::Bool => Enc::Bool,
            Pointee::Int { bits, signed } => Enc::Int { bits, signed },
            Pointee::F32 => Enc::F32,
            Pointee::F64 => Enc::F64,
            Pointee::Struct(t) => Enc::Struct(t),
        }
    }

    fn byte_len(self) -> usize {
        match self {
            Pointee::Object | Pointee::InOutObject | Pointee::F64 => 8,
            Pointee::Bool => 1,
            Pointee::Int { bits, .. } => usize::from(bits / 8),
            Pointee::F32 => 4,
            Pointee::Struct(t) => t.size,
        }
    }
}

/// A Core Foundation / Core Graphics type that is an Objective-C object at run
/// time (retained and released like any `id`), so a `CGColorRef` argument or
/// result crosses as an object handle: what `-[NSColor CGColor]` returns is
/// what `-[CALayer setBackgroundColor:]` takes. Going in, the object's
/// `CFGetTypeID` must be the type's, since the callee reads the struct.
#[derive(Debug, PartialEq, Eq)]
pub struct CFType {
    /// `CGColor`: the struct name in the encoding, less `Ref`.
    pub name: &'static str,
    /// `CGColorGetTypeID`.
    type_id_fn: &'static CStr,
    type_id: OnceLock<Option<usize>>,
}

impl CFType {
    const fn new(name: &'static str, type_id_fn: &'static CStr) -> CFType {
        CFType {
            name,
            type_id_fn,
            type_id: OnceLock::new(),
        }
    }

    /// Whether `object` is one (`CFGetTypeID(object) == CGColorGetTypeID()`).
    fn holds(&self, object: &NSObject) -> bool {
        let Some(expected) = *self.type_id.get_or_init(|| {
            let f = rt().symbol(self.type_id_fn)?;
            // SAFETY: every `…GetTypeID` is `CFTypeID (*)(void)`.
            Some(unsafe {
                core::mem::transmute::<*mut c_void, extern "C" fn() -> usize>(f.as_ptr())()
            })
        }) else {
            return false;
        };
        // `CFGetTypeID` sends `_cfTypeID` to an object that is not a CF
        // instance; NSObject answers it, NSProxy does not.
        // SAFETY: a live object rooted in NSObject.
        !is_proxy(object) && unsafe { (rt().cf.CFGetTypeID)(object.as_obj().cast()) } == expected
    }
}

static CF_OBJECTS: [CFType; 5] = [
    CFType::new("CGColor", c"CGColorGetTypeID"),
    CFType::new("CGColorSpace", c"CGColorSpaceGetTypeID"),
    CFType::new("CGImage", c"CGImageGetTypeID"),
    CFType::new("CGPath", c"CGPathGetTypeID"),
    CFType::new("CGContext", c"CGContextGetTypeID"),
];

/// `{CGColor=}` (the pointee of `^{CGColor=}`): an opaque struct named in [`CF_OBJECTS`].
fn cf_object(pointee: &str) -> Option<&'static CFType> {
    let rest = pointee.strip_prefix('{')?;
    CF_OBJECTS.iter().find(|t| {
        rest.strip_prefix(t.name)
            .is_some_and(|tail| tail.starts_with("=}"))
    })
}

/// Type qualifiers (`const`, `in`, `inout`, `out`, `bycopy`, `byref`,
/// `oneway`, `_Atomic`) and frame offsets that precede or follow a type.
fn is_qualifier(c: char) -> bool {
    matches!(c, 'r' | 'n' | 'N' | 'o' | 'O' | 'R' | 'V' | 'A') || c.is_ascii_digit()
}

impl Enc {
    /// Parses one type as `NSMethodSignature` reports it.
    pub fn parse(encoding: &str) -> Enc {
        let s = encoding.trim_start_matches(is_qualifier);
        let qualified = |q: char| {
            encoding
                .chars()
                .take_while(|&c| is_qualifier(c))
                .any(|c| c == q)
        };
        // `r`: what is pointed at is `const`, so not storage for a result.
        let constant = qualified('r');
        let mut chars = s.chars();
        let Some(first) = chars.next() else {
            return Enc::Other(encoding.to_owned());
        };
        match first {
            'v' => Enc::Void,
            '@' => {
                if chars.next() == Some('?') {
                    Enc::Block
                } else {
                    Enc::Object
                }
            }
            '#' => Enc::Class,
            ':' => Enc::Sel,
            'B' => Enc::Bool,
            'c' if cfg!(target_arch = "x86_64") => Enc::Bool,
            'c' => Enc::Int {
                bits: 8,
                signed: true,
            },
            'C' => Enc::Int {
                bits: 8,
                signed: false,
            },
            's' => Enc::Int {
                bits: 16,
                signed: true,
            },
            'S' => Enc::Int {
                bits: 16,
                signed: false,
            },
            'i' | 'l' => Enc::Int {
                bits: 32,
                signed: true,
            },
            'I' | 'L' => Enc::Int {
                bits: 32,
                signed: false,
            },
            'q' => Enc::Int {
                bits: 64,
                signed: true,
            },
            'Q' => Enc::Int {
                bits: 64,
                signed: false,
            },
            'f' => Enc::F32,
            'd' => Enc::F64,
            '*' if constant => Enc::CString,
            '*' => Enc::Buffer(s.to_owned()),
            '^' => match Pointee::of(&Enc::parse(chars.as_str())) {
                Some(_) if constant => Enc::Buffer(format!("r{s}")),
                // `N`: `inout`.
                Some(Pointee::Object) if qualified('N') => Enc::Out(Pointee::InOutObject),
                Some(pointee) => Enc::Out(pointee),
                None => cf_object(chars.as_str()).map_or(Enc::Pointer, Enc::CFObject),
            },
            '{' => Enc::parse_struct(s),
            _ => Enc::Other(s.to_owned()),
        }
    }

    /// `{Name=members…}`: see [`StructType`].
    fn parse_struct(s: &str) -> Enc {
        StructType::parse(s).map_or_else(|| Enc::Other(s.to_owned()), Enc::Struct)
    }

    /// The canonical encoding, for messages.
    pub fn encoding(&self) -> Cow<'_, str> {
        Cow::Borrowed(match self {
            Enc::Out(Pointee::InOutObject) => "N^@",
            Enc::Out(pointee) => return Cow::Owned(format!("^{}", pointee.enc().encoding())),
            Enc::CFObject(t) => return Cow::Owned(format!("^{{{}=}}", t.name)),
            Enc::Buffer(s) => s,
            Enc::Void => "v",
            Enc::Object => "@",
            Enc::Block => "@?",
            Enc::Class => "#",
            Enc::Sel => ":",
            Enc::Bool => "B",
            Enc::Int {
                bits: 8,
                signed: true,
            } => "c",
            Enc::Int {
                bits: 8,
                signed: false,
            } => "C",
            Enc::Int {
                bits: 16,
                signed: true,
            } => "s",
            Enc::Int {
                bits: 16,
                signed: false,
            } => "S",
            Enc::Int {
                bits: 32,
                signed: true,
            } => "i",
            Enc::Int {
                bits: 32,
                signed: false,
            } => "I",
            Enc::Int { signed: true, .. } => "q",
            Enc::Int { signed: false, .. } => "Q",
            Enc::F32 => "f",
            Enc::F64 => "d",
            Enc::CString => "r*",
            Enc::Pointer => "^v",
            Enc::Struct(t) => t.encoding,
            Enc::Other(s) => s,
        })
    }

    /// What a script should pass, for messages.
    pub fn describe(&self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
            Enc::Void => "nothing",
            Enc::Object => "an object, string, number, boolean or null",
            Enc::CFObject(t) => return Cow::Owned(format!("a {}", t.name)),
            Enc::Block => "a function or a block made with objc.block()",
            Enc::Class => "a class",
            Enc::Sel => "a selector name",
            Enc::Bool => "a boolean",
            Enc::Int { .. } => "an integer",
            Enc::F32 | Enc::F64 => "a number",
            Enc::CString => "a string or null",
            Enc::Out(_) => "an objc.out() object to receive the value, or null",
            Enc::Buffer(_) => {
                "null, since it is a C array the method reads or fills: allocate one with bun:ffi and call the method through bun:ffi instead"
            }
            Enc::Pointer => "a pointer",
            Enc::Struct(t) => return Cow::Owned(t.describe()),
            Enc::Other(_) => "an unsupported type",
        })
    }
}

impl fmt::Display for Enc {
    /// `an integer (q)`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.describe(), self.encoding())
    }
}

/// The selector families whose object result the caller already owns, from
/// clang's rule: the first selector component, less leading underscores,
/// is the family name alone or followed by something other than a lowercase
/// letter (`newValue` is `new`; `newsstand` is not).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    None,
    Alloc,
    New,
    Copy,
    MutableCopy,
    /// Also consumes the receiver.
    Init,
    /// Core Foundation's Create Rule (`-[CIContext createCGImage:fromRect:]`):
    /// a family only for a method that returns a [`CFType`].
    Create,
}

impl Family {
    pub fn of(selector: &str) -> Family {
        let s = selector.trim_start_matches('_');
        for (prefix, family) in [
            ("alloc", Family::Alloc),
            ("new", Family::New),
            ("copy", Family::Copy),
            ("mutableCopy", Family::MutableCopy),
            ("init", Family::Init),
            ("create", Family::Create),
            ("Create", Family::Create),
        ] {
            if let Some(rest) = s.strip_prefix(prefix)
                && !rest.starts_with(|c: char| c.is_ascii_lowercase())
            {
                return family;
            }
        }
        Family::None
    }

    pub fn returns_retained(self) -> bool {
        self != Family::None
    }
}

/// A method's (or a block's) argument and return types as the receiver
/// reports them.
pub struct Signature {
    pub args: Vec<Enc>,
    pub ret: Enc,
    pub family: Family,
    ns: NSMethodSignature,
    /// `None` for a block, whose invocation carries no `_cmd`: its
    /// arguments follow the block itself at index 1 rather than 2.
    sel: Option<super::Sel>,
    ret_len: usize,
    method: String,
    /// (argument index, block type encoding) for the block arguments
    /// [`sdk::BLOCK_PARAMS`] lists for this method.
    blocks: Vec<(usize, &'static CStr)>,
    /// The setter of an object `@property` declared `assign` (neither weak,
    /// strong nor copy: `NSComboBox.dataSource`, `NSXMLParser.delegate`),
    /// whose receiver would otherwise be left pointing at freed memory once
    /// the value's last reference goes; see [`keep_assigned`].
    assigns: bool,
}

impl fmt::Debug for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Signature")
            .field("method", &self.method)
            .field("args", &self.args)
            .field("ret", &self.ret)
            .field("family", &self.family)
            .finish()
    }
}

impl Signature {
    /// `ns` parsed; `family` only holds for an object return.
    pub(super) fn new(
        ns: NSMethodSignature,
        sel: super::Sel,
        method: String,
        family: Family,
    ) -> Signature {
        Signature::parsed(ns, Some(sel), method, family)
    }

    fn parsed(
        ns: NSMethodSignature,
        sel: Option<super::Sel>,
        method: String,
        family: Family,
    ) -> Signature {
        let first = if sel.is_some() { 2 } else { 1 };
        let args: Vec<Enc> = (first..ns.number_of_arguments())
            .map(|i| Enc::parse(&ns.argument_type_at(i).0.unwrap_or_default()))
            .collect();
        let ret = Enc::parse(ns.method_return_type().0.as_deref().unwrap_or("v"));
        let family = match (&ret, family) {
            (Enc::Object, Family::Create) => Family::None,
            (Enc::Object | Enc::CFObject(_), family) => family,
            _ => Family::None,
        };
        Signature {
            args,
            ret,
            family,
            ret_len: ns.method_return_length(),
            ns,
            sel,
            method,
            blocks: Vec::new(),
            assigns: false,
        }
    }

    /// The invocation index of argument `index`.
    fn slot(&self, index: usize) -> isize {
        (index + if self.sel.is_some() { 2 } else { 1 }) as isize
    }

    /// `-[NSWindow setTitle:]`, for messages.
    pub fn method(&self) -> &str {
        &self.method
    }

    /// The bytes the return value takes (`methodReturnLength`).
    pub(super) fn ret_len(&self) -> usize {
        self.ret_len
    }

    /// The type encoding of the block argument `index` takes, when the
    /// bridge knows it for this method (so a bare function can be passed).
    pub fn block_types(&self, index: usize) -> Option<&'static CStr> {
        self.blocks
            .iter()
            .find_map(|(i, types)| (*i == index).then_some(*types))
    }

    /// Whether the encoding starts with the receiver and `_cmd` every
    /// method takes (one a script wrote may not).
    pub(super) fn has_self_and_cmd(&self) -> bool {
        self.ns.number_of_arguments() >= 2
            && Enc::parse(&self.ns.argument_type_at(0).0.unwrap_or_default()) == Enc::Object
            && Enc::parse(&self.ns.argument_type_at(1).0.unwrap_or_default()) == Enc::Sel
    }

    /// Refuses a return type a [`Frame`] cannot carry back.
    pub(super) fn check_return(&self) -> Result<()> {
        match &self.ret {
            Enc::Other(e) => Err(unsupported(
                &self.method,
                format!("return type {e} is not supported yet"),
            )),
            Enc::Struct(t) if t.size != self.ret_len => Err(unsupported(
                &self.method,
                format!(
                    "{} return is {} bytes here, expected {}",
                    t.encoding, self.ret_len, t.size
                ),
            )),
            _ if self.ret_len > core::mem::size_of::<Frame>() => Err(unsupported(
                &self.method,
                format!("a {}-byte return value is not supported", self.ret_len),
            )),
            _ => Ok(()),
        }
    }
}

/// Selectors whose effect the wrappers already account for; sending them by
/// hand unbalances the reference this crate holds.
const MANAGED_SELECTORS: &[&str] = &["retain", "release", "autorelease", "dealloc", "retainCount"];

pub(super) fn pool_if_none() -> Option<AutoreleasePool> {
    (AutoreleasePool::live_count() == 0).then(AutoreleasePool::new)
}

/// Drops `items` inside one autorelease pool: whatever holds Objective-C
/// references whose release may run a `dealloc` that autoreleases.
pub fn drop_pooled<T>(items: T) {
    let _pool = pool_if_none();
    drop(items);
}

/// `+[NSMethodSignature signatureWithObjCTypes:]` for text that did not come
/// from the runtime, sent through the bridge because it raises for text it
/// cannot parse. `invalid` builds that error from `""` or ` (the reason)`.
pub(super) fn method_signature(
    types: &str,
    invalid: impl Fn(&dyn fmt::Display) -> Error,
) -> Result<NSMethodSignature> {
    let factory = DynClass(NSMethodSignature::class());
    let sent = send(
        Receiver::Class(&factory),
        "signatureWithObjCTypes:",
        &mut [DynValue::Str(types.to_owned())],
    );
    match sent {
        Ok(DynValue::Object(o)) => view_as::<NSMethodSignature>(&*o.live()?),
        Ok(_) => None,
        Err(Error::Exception { reason, .. }) => return Err(invalid(&format_args!(" ({reason})"))),
        Err(err) => return Err(err),
    }
    .ok_or_else(|| invalid(&""))
}

fn selector(name: &str, receiver: Receiver<'_>) -> Result<super::Sel> {
    match CString::new(name) {
        Ok(c) => Ok(register_sel(&c)),
        Err(_) => Err(Error::Unrecognized {
            class: receiver.class_name()?,
            sel: name.to_owned(),
            instance: receiver.is_instance(),
        }),
    }
}

/// The rows of an [`sdk`] table (sorted by selector) that apply to `sel`
/// sent to `class`: those the SDK declares on it or a superclass, or in a
/// protocol (an empty class name), since the type encodings cannot tell.
fn sdk_rows<'t, Row>(
    table: &'t [Row],
    key: fn(&Row) -> (&str, &CStr),
    class: DynClass,
    sel: &'t str,
) -> impl Iterator<Item = &'t Row> + 't {
    table[table.partition_point(|row| key(row).0 < sel)..]
        .iter()
        .take_while(move |row| key(row).0 == sel)
        .filter(move |row| {
            let owner = key(row).1;
            owner.is_empty()
                || super::lookup_class(owner)
                    .is_some_and(|owner| rt().class_inherits(class.0, owner))
        })
}

/// Whether the SDK declares `sel` for `class` as reading a variable
/// argument list.
fn is_variadic(class: DynClass, sel: &str) -> bool {
    sdk_rows(sdk::VARIADIC, |(s, c)| (s, c), class, sel)
        .next()
        .is_some()
}

/// Retypes the arguments of `sel` on `class` the SDK declares as C arrays
/// (see [`Enc::Buffer`]) that their encoding alone left as a C string or a
/// pointer to one value.
fn mark_array_params(class: DynClass, sel: &str, args: &mut [Enc]) {
    for (_, _, index) in sdk_rows(sdk::ARRAY_PARAMS, |(s, c, _)| (s, c), class, sel) {
        if let Some(enc) = args.get_mut(*index)
            && matches!(enc, Enc::CString | Enc::Out(_))
        {
            *enc = Enc::Buffer(enc.encoding().into_owned());
        }
    }
}

thread_local! {
    /// Signatures already looked up, by (class, selector, class method):
    /// a class's methods and their types do not change once it answers, and
    /// the lookup (two method-table walks, `methodSignatureForSelector:`,
    /// the SDK tables) costs more than the send it precedes.
    static SIGNATURES: RefCell<HashMap<(usize, usize, bool), Rc<Signature>>> =
        RefCell::new(HashMap::new());
}

/// Looks the method up on the receiver. `Unrecognized` unless the receiver
/// responds to `sel`, so a typo is an error here rather than an exception
/// inside the send.
pub fn signature(receiver: Receiver<'_>, sel: &str) -> Result<Rc<Signature>> {
    load()?;
    let _pool = AutoreleasePool::new();
    // A live, ordinary receiver's answer holds for every instance of its
    // class; an unsent `alloc` and a proxy are looked up their own way
    // below each time.
    let cacheable = receiver.allocated_class().is_none() && !receiver.is_proxy()?;
    let key = |owner: DynClass, raw_sel: super::Sel, class_method: bool| {
        (owner.address(), raw_sel.0.as_ptr() as usize, class_method)
    };
    if cacheable && let Ok(c_sel) = CString::new(sel) {
        let (owner, class_method) = receiver.method_owner()?;
        let key = key(owner, register_sel(&c_sel), class_method);
        if let Some(hit) = SIGNATURES.with_borrow(|cache| cache.get(&key).cloned()) {
            return Ok(hit);
        }
    }
    let method = receiver.method_name(sel)?;
    let unsupported = |what: &str| Error::UnsupportedSignature {
        method: method.clone(),
        what: what.into(),
    };
    if MANAGED_SELECTORS.contains(&sel) {
        return Err(unsupported(
            "reference counting is managed by the wrapper; use release() on it instead",
        ));
    }
    if receiver.class_name()? == "NSAutoreleasePool" {
        return Err(unsupported(
            "autorelease pools are managed by the bridge; every send already runs inside one",
        ));
    }
    // `-[NSInvocation invokeWithTarget:]` calls a block target instead of
    // messaging it, whatever the selector.
    if receiver.is_block()? {
        return Err(unsupported(
            "the receiver is a block, which can be called with invoke(...args), passed as an argument or released, but not sent messages",
        ));
    }
    let family = Family::of(sel);
    let allocated = receiver.allocated_class();
    if allocated.is_some() && family != Family::Init {
        return Err(Error::NotInitialized);
    }
    if family == Family::Init && allocated.is_none() && !receiver.is_instance() {
        return Err(unsupported(
            "init on a class object; call alloc() (or new()) first",
        ));
    }
    let raw_sel = selector(sel, receiver)?;
    let unrecognized = || Error::Unrecognized {
        class: receiver.class_name().unwrap_or_default(),
        sel: sel.to_owned(),
        instance: receiver.is_instance(),
    };
    let (mut owner, class_method) = receiver.method_owner()?;
    // An `alloc` awaiting its `init…` is not messaged: its class's method
    // table answers for it (what `+instancesRespondToSelector:` reads too),
    // or, when the class leaves this `init…` to whatever `+alloc` returns,
    // that object's class's table.
    let mut types = owner.raw_types(raw_sel, class_method);
    if let (Some(_), None, Receiver::Object(o)) = (allocated, &types, receiver) {
        owner = o.allocate_now(&method)?;
        types = owner.raw_types(raw_sel, class_method);
    }
    let proxy = allocated.is_none() && receiver.is_proxy()?;
    let responds = match allocated {
        Some(_) => types.is_some(),
        None if proxy => true,
        None => receiver.with_target(|t| t.responds_to_selector(raw_sel))?,
    };
    if !responds {
        return Err(unrecognized());
    }
    if is_variadic(owner, sel) {
        return Err(unsupported(
            "variadic methods (declared with `...` or a va_list) are not supported",
        ));
    }
    // NSMethodSignature raises on encodings it cannot size (SIMD vectors,
    // `<2f>`), so those are refused from the runtime's copy first. A method
    // reached by forwarding has no copy there; Foundation's answer stands.
    if let Some(types) = &types
        && (types.is_empty() || strings::contains_char(types.as_bytes(), b'<'))
    {
        return Err(unsupported(&format!(
            "type encoding {types:?} is not supported"
        )));
    }
    let in_table = types.is_some();
    let ns = match allocated {
        Some(_) => types
            .and_then(|t| CString::new(t).ok())
            .and_then(|t| NSMethodSignature::with_objc_types(&t)),
        None if proxy => proxy_method_signature(receiver, sel)?,
        None => receiver.with_target(|t| t.method_signature_for_selector(raw_sel))?,
    }
    .ok_or_else(unrecognized)?;
    let mut sig = Signature::new(ns, raw_sel, method, family);
    mark_array_params(owner, sel, &mut sig.args);
    sig.assigns = !class_method && sig.args == [Enc::Object] && sets_assign_property(owner, sel);
    if sig.args.contains(&Enc::Block) {
        sig.blocks = sdk_rows(sdk::BLOCK_PARAMS, |(s, c, ..)| (s, c), owner, sel)
            .map(|(_, _, index, types)| (*index, *types))
            .collect();
    }
    // `performSelector:…` is declared to return an object whatever the
    // performed method returns; retaining a `BOOL` or a `void` would crash.
    if sig.ret == Enc::Object
        && strings::split(sel.as_bytes(), b":").next() == Some(b"performSelector")
    {
        return Err(Error::UnsupportedSignature {
            method: sig.method,
            what: "the result cannot be typed; send that selector itself (receiver.msgSend(name, ...args) for a name in a variable)".into(),
        });
    }
    let sig = Rc::new(sig);
    // A method only forwarding answers for has no entry in the class's
    // table and may be answered differently next time.
    if cacheable && in_table {
        SIGNATURES.with_borrow_mut(|cache| {
            cache.insert(key(owner, raw_sel, class_method), Rc::clone(&sig))
        });
    }
    Ok(sig)
}

/// The signature for calling `block` itself (through [`invoke`], which
/// `-[NSInvocation invokeWithTarget:]` does for a block target), read from
/// the type encoding the block was compiled with.
pub fn block_signature(block: &DynObject) -> Result<Signature> {
    load()?;
    let _pool = AutoreleasePool::new();
    let method = || format!("block of class {}", block.class_name().unwrap_or_default());
    if !Receiver::Object(block).is_block()? {
        return Err(unsupported(&method(), "is not a block"));
    }
    // SAFETY: a live block object (just checked).
    let Some(types) = (unsafe { block::signature_of(block.live()?.as_obj()) }) else {
        return Err(unsupported(
            &method(),
            "records no type signature, so it cannot be called from JavaScript",
        ));
    };
    let types = types.to_string_lossy();
    let ns = method_signature(&types, |why| {
        unsupported(
            &method(),
            format!("has a type signature {types:?} that is not valid{why}"),
        )
    })?;
    let name = format!("block {}", block::spelled(&ns));
    if ns.number_of_arguments() < 1
        || Enc::parse(&ns.argument_type_at(0).0.unwrap_or_default()) != Enc::Block
    {
        return Err(unsupported(&name, "does not take the block itself first"));
    }
    Ok(Signature::parsed(ns, None, name, Family::None))
}

/// `-methodSignatureForSelector:` sent to a proxy the way a script's own
/// message is, since `NSProxy`'s implementation raises for a selector it has
/// no signature for.
fn proxy_method_signature(receiver: Receiver<'_>, sel: &str) -> Result<Option<NSMethodSignature>> {
    const QUERY: &str = "methodSignatureForSelector:";
    // `- (NSMethodSignature *)methodSignatureForSelector:(SEL)sel`
    let Some(ns) = NSMethodSignature::with_objc_types(c"@@::") else {
        return Ok(None);
    };
    let query = Signature::new(
        ns,
        selector(QUERY, receiver)?,
        receiver.method_name(QUERY)?,
        Family::None,
    );
    match invoke(receiver, &query, &mut [DynValue::Sel(sel.to_owned())])? {
        DynValue::Object(o) => Ok(view_as::<NSMethodSignature>(&*o.live()?)),
        _ => Ok(None),
    }
}

// ─────────────────────────────────── values ──────────────────────────────────

/// A value crossing the bridge in either direction.
#[derive(Debug)]
pub enum DynValue {
    Nil,
    Object(DynObject),
    Class(DynClass),
    Sel(String),
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    /// A C string in, a copied C string out; also boxed to `NSString` for an `@` argument.
    Str(String),
    /// A by-value struct as its scalar members in layout order (`Bool`,
    /// `I64`, `U64` or `F64` each).
    Struct(&'static StructType, Box<[DynValue]>),
    /// An opaque address from a pointer-typed return.
    Pointer(usize),
    /// For an [`Enc::Out`] argument: what the pointed-at storage holds going
    /// in (`None` for zero / `nil`), replaced by what it holds coming out.
    Out(Option<Box<DynValue>>),
    /// A `void` return.
    Void,
}

impl DynValue {
    /// What kind of value this is, for messages.
    pub fn kind(&self) -> &'static str {
        match self {
            DynValue::Nil => "null",
            DynValue::Object(_) => "an object",
            DynValue::Class(_) => "a class",
            DynValue::Sel(_) => "a selector name",
            DynValue::Bool(_) => "a boolean",
            DynValue::I64(_) | DynValue::U64(_) => "an integer",
            DynValue::F64(_) => "a number",
            DynValue::Str(_) => "a string",
            DynValue::Struct(t, _) if t.name == "?" => "a struct",
            DynValue::Struct(t, _) => t.name,
            DynValue::Pointer(_) => "a pointer",
            DynValue::Out(_) => "an objc.out() object",
            DynValue::Void => "undefined",
        }
    }
}

/// The largest by-value argument or return the bridge carries (a
/// `CATransform3D`, sixteen doubles); a struct type bigger than this parses
/// as unsupported.
const FRAME_SIZE: usize = 128;

/// One argument or return value in C layout, 16-aligned.
#[repr(C, align(16))]
pub(super) struct Frame([u8; FRAME_SIZE]);

const _: () = assert!(
    cfg!(target_endian = "little"),
    "Frame reads and writes assume little endian"
);

impl Frame {
    pub(super) fn new() -> Frame {
        Frame([0; FRAME_SIZE])
    }

    /// For a message that reads the frame.
    pub(super) fn as_ptr(&self) -> Ptr {
        Ptr(self.0.as_ptr().cast())
    }

    /// For a message that fills the frame.
    pub(super) fn as_mut_ptr(&mut self) -> Ptr {
        Ptr(self.0.as_mut_ptr().cast_const().cast())
    }

    pub(super) fn put(&mut self, at: usize, bytes: &[u8]) {
        self.0[at..at + bytes.len()].copy_from_slice(bytes);
    }

    pub(super) fn word(&mut self, v: usize) {
        self.put(0, &v.to_ne_bytes());
    }

    pub(super) fn read_word(&self) -> usize {
        usize::from_ne_bytes(self.0[..8].try_into().expect("8 bytes"))
    }

    pub(super) fn read_u64(&self, i: usize) -> u64 {
        u64::from_ne_bytes(self.0[i * 8..i * 8 + 8].try_into().expect("8 bytes"))
    }

    /// `N` bytes at `at`.
    fn bytes<const N: usize>(&self, at: usize) -> [u8; N] {
        self.0[at..at + N].try_into().expect("in frame")
    }

    /// Writes `value` as `scalar` at byte `at`: `Ok(false)` when `value` is
    /// not that kind of scalar at all, `Err((min, max, got))` for an
    /// integer out of range. Integers convert to floating point; nothing
    /// converts to an integer or a boolean.
    fn put_scalar(
        &mut self,
        at: usize,
        scalar: Scalar,
        value: &DynValue,
    ) -> core::result::Result<bool, (i128, i128, i128)> {
        match (scalar, value) {
            (Scalar::Bool, DynValue::Bool(b)) => self.put(at, &[u8::from(*b)]),
            (Scalar::Int { bits, signed }, DynValue::I64(_) | DynValue::U64(_)) => {
                let v: i128 = match value {
                    DynValue::I64(v) => i128::from(*v),
                    DynValue::U64(v) => i128::from(*v),
                    _ => unreachable!(),
                };
                let (min, max) = if signed {
                    (-(1i128 << (bits - 1)), (1i128 << (bits - 1)) - 1)
                } else {
                    (0, (1i128 << bits) - 1)
                };
                if v < min || v > max {
                    return Err((min, max, v));
                }
                // Two's complement and little endian, so the low bytes are
                // the value at any width.
                self.put(at, &(v as i64).to_le_bytes()[..bits as usize / 8]);
            }
            (Scalar::F32, DynValue::F64(v)) => self.put(at, &(*v as f32).to_ne_bytes()),
            (Scalar::F32, DynValue::I64(v)) => self.put(at, &(*v as f32).to_ne_bytes()),
            (Scalar::F32, DynValue::U64(v)) => self.put(at, &(*v as f32).to_ne_bytes()),
            (Scalar::F64, DynValue::F64(v)) => self.put(at, &v.to_ne_bytes()),
            (Scalar::F64, DynValue::I64(v)) => self.put(at, &(*v as f64).to_ne_bytes()),
            (Scalar::F64, DynValue::U64(v)) => self.put(at, &(*v as f64).to_ne_bytes()),
            _ => return Ok(false),
        }
        Ok(true)
    }

    /// The `scalar` at byte `at` as a `Bool`, `I64`, `U64` or `F64`.
    fn scalar(&self, at: usize, scalar: Scalar) -> DynValue {
        match scalar {
            Scalar::Bool => DynValue::Bool(self.0[at] != 0),
            Scalar::Int { bits, signed } => {
                // Only `bits` are the value's; shift them to the top and back
                // to sign- or zero-extend.
                let mut word = [0u8; 8];
                let len = bits as usize / 8;
                word[..len].copy_from_slice(&self.0[at..at + len]);
                let shift = 64 - u32::from(bits);
                let raw = u64::from_le_bytes(word) << shift;
                if signed {
                    DynValue::I64((raw as i64) >> shift)
                } else {
                    DynValue::U64(raw >> shift)
                }
            }
            Scalar::F32 => DynValue::F64(f64::from(f32::from_ne_bytes(self.bytes(at)))),
            Scalar::F64 => DynValue::F64(f64::from_ne_bytes(self.bytes(at))),
        }
    }
}

/// What must outlive the invoke: boxed objects and C strings the argument
/// frames point at, and the storage [`Enc::Out`] arguments point at (by
/// argument index).
#[derive(Default)]
pub(super) struct Keep {
    objects: Vec<NSObject>,
    strings: Vec<CString>,
    outs: Vec<(usize, Pointee, NonNull<Frame>)>,
}

impl Keep {
    /// Heap storage for [`Enc::Out`] argument `index`, starting as `initial`,
    /// that the method writes through the returned pointer; no Rust reference
    /// to it exists until [`Keep::outs`] reads it back.
    fn out(&mut self, index: usize, pointee: Pointee, initial: Frame) -> NonNull<Frame> {
        let cell = NonNull::from(Box::leak(Box::new(initial)));
        self.outs.push((index, pointee, cell));
        cell
    }

    /// (argument index, what the method left in that argument's storage).
    fn outs<'a>(&'a self, method: &'a str) -> impl Iterator<Item = Result<(usize, DynValue)>> + 'a {
        self.outs.iter().map(move |(index, pointee, cell)| {
            // SAFETY: allocated by `out` and freed only by `drop`; the method
            // that wrote through the pointer has returned.
            let cell = unsafe { cell.as_ref() };
            Ok((*index, decode(method, &pointee.enc(), false, cell)?))
        })
    }
}

impl Drop for Keep {
    fn drop(&mut self) {
        for (_, _, cell) in self.outs.drain(..) {
            // SAFETY: allocated by `out` with `Box::new`; nothing else frees it.
            drop(unsafe { Box::from_raw(cell.as_ptr()) });
        }
    }
}

/// [`signature`] then [`invoke`].
pub fn send(receiver: Receiver<'_>, sel: &str, args: &mut [DynValue]) -> Result<DynValue> {
    let sig = signature(receiver, sel)?;
    invoke(receiver, &sig, args)
}

/// Sends the message `sig` was looked up for with `args`, which must match
/// `sig.args` one for one. Object results are retained (or adopted, for the
/// owning families). `alloc…` on a class is not sent: its result allocates
/// when an `init…` reaches it, and that init consumes it (as it does any
/// object receiver), which reads as [`Error::Consumed`] from then on. An
/// exception raised inside the method is [`Error::Exception`] once
/// [`catch_exceptions_with`] has run, and ends the process before. Each
/// [`DynValue::Out`] in `args` holds what the method left there afterwards.
pub fn invoke(receiver: Receiver<'_>, sig: &Signature, args: &mut [DynValue]) -> Result<DynValue> {
    load()?;
    // A pool of the send's own, whatever encloses it: everything the method
    // autoreleases (and the invocation itself) goes when the send returns,
    // and what comes back below is retained or copied first.
    let _pool = AutoreleasePool::new();
    if args.len() != sig.args.len() {
        return Err(Error::ArgCount {
            method: sig.method.clone(),
            expected: sig.args.len(),
            got: args.len(),
        });
    }
    sig.check_return()?;

    let invocation = NSInvocation::with_method_signature(&sig.ns);
    if let Some(sel) = sig.sel {
        invocation.set_selector(sel);
    }
    let mut keep = Keep::default();
    for (index, (enc, value)) in sig.args.iter().zip(args.iter()).enumerate() {
        if let (Enc::Block, DynValue::Object(o)) = (enc, value) {
            block::check_block_object(&sig.method, index, o, sig.block_types(index))?;
        }
        let mut frame = Frame::new();
        encode(&sig.method, index, enc, value, &mut frame, &mut keep)?;
        invocation.set_argument_raw(frame.as_ptr(), sig.slot(index));
    }
    if sig.family == Family::Alloc
        && let Some(class) = receiver.as_class()
    {
        return Ok(DynValue::Object(DynObject::allocated(class)));
    }

    let mut ret = Frame::new();
    match receiver {
        Receiver::Object(o) if sig.family == Family::Init => {
            // init takes over the reference this wrapper owned and may hand
            // back a different object, so the receiver is never released here.
            let target = o.take_for_init(&sig.method)?;
            invoke_catching(&invocation, &target)?;
        }
        _ => receiver.with_target(|t| invoke_catching(&invocation, t))??,
    }
    if sig.assigns {
        receiver.with_target(|t| keep_assigned(t, &invocation, sig))?;
    }
    if sig.ret != Enc::Void && sig.ret_len > 0 {
        invocation.get_return_value_raw(ret.as_mut_ptr());
    }
    for out in keep.outs(&sig.method) {
        let (index, value) = out?;
        args[index] = DynValue::Out(Some(Box::new(value)));
    }
    drop(keep);
    let result = decode(&sig.method, &sig.ret, sig.family.returns_retained(), &ret)?;
    keep_window_past_close(receiver, sig, &result)?;
    Ok(result)
}

// ──────────────────────────────── exceptions ─────────────────────────────────

/// `[invocation invokeWithTarget:target]` sent through `msg_send` under a
/// catch frame: `true` when it returned, `false` with a +1 reference (taken
/// with `retain`) to the thrown object in `exception` when it raised.
pub type ExceptionFrame = unsafe extern "C" fn(
    msg_send: *const c_void,
    retain: unsafe extern "C" fn(Obj) -> Obj,
    invocation: *mut c_void,
    invoke_with_target: *const c_void,
    target: *mut c_void,
    exception: *mut *mut c_void,
) -> bool;

unsafe extern "C" {
    /// The [`ExceptionFrame`] in `src/jsc/bindings/darwin/objc-try-invoke.cpp`.
    /// Only the full `bun` link has it, so nothing in this crate names it:
    /// the runtime crate hands it to [`catch_exceptions_with`], and this
    /// crate's own test binaries link without it.
    pub fn Bun__NSInvocation__tryInvoke(
        msg_send: *const c_void,
        retain: unsafe extern "C" fn(Obj) -> Obj,
        invocation: *mut c_void,
        invoke_with_target: *const c_void,
        target: *mut c_void,
        exception: *mut *mut c_void,
    ) -> bool;
}

static EXCEPTION_FRAME: OnceLock<ExceptionFrame> = OnceLock::new();

/// From now on an Objective-C exception raised inside [`invoke`] comes back as
/// [`Error::Exception`] instead of ending the process. `frame` is
/// [`Bun__NSInvocation__tryInvoke`]; see there for why the caller passes it.
pub fn catch_exceptions_with(frame: ExceptionFrame) {
    EXCEPTION_FRAME.get_or_init(|| frame);
}

/// `-[NSInvocation invokeWithTarget:]`, through the catching frame when one is installed.
fn invoke_catching(invocation: &NSInvocation, target: &NSObject) -> Result<()> {
    let Some(frame) = EXCEPTION_FRAME.get() else {
        invocation.invoke_with_target(target);
        return Ok(());
    };
    let mut thrown: Obj = ptr::null_mut();
    let rt = rt();
    // SAFETY: `frame` is `Bun__NSInvocation__tryInvoke`, whose parameters
    // these are: the runtime's own send and retain entry points, and two
    // objects live for the call.
    if unsafe {
        frame(
            rt.objc_msgSend,
            rt.objc_retain,
            invocation.as_obj(),
            super::sel!("invokeWithTarget:").0.as_ptr().cast_const(),
            target.as_obj(),
            &raw mut thrown,
        )
    } {
        return Ok(());
    }
    // SAFETY: on `false` the frame stored nil or a +1 reference to the thrown
    // object, which is an Objective-C object of some class.
    let object = unsafe { Id::from_retained(thrown).map(|id| NSObject::from_id(id)) };
    Err(exception(object))
}

/// [`Error::Exception`] for a caught object.
fn exception(object: Option<NSObject>) -> Error {
    let Some(object) = object else {
        return Error::Exception {
            name: "nil".into(),
            reason: "nil was thrown".into(),
            user_info: None,
            object: None,
        };
    };
    let described = |o: &NSObject| {
        o.description()
            .map(|d| d.to_string_lossy())
            .unwrap_or_default()
    };
    let class_name = || rt().class_name_of(object.as_obj());
    let (name, reason, user_info) = match view_as::<NSException>(&object) {
        Some(e) => (
            e.name().map_or_else(class_name, |n| n.to_string_lossy()),
            e.reason().map(|r| r.to_string_lossy()).unwrap_or_default(),
            e.user_info().map(|d| described(d.upcast())),
        ),
        None => (class_name(), described(&object), None),
    };
    Error::Exception {
        name,
        reason,
        user_info,
        object: Some(DynObject::wrap(object)),
    }
}

/// Whether `-[owner sel]` (a one-argument `set…:`) is the setter of an
/// object property declared `assign`: its attributes name an object type and
/// none of weak (`W`), retain (`&`) or copy (`C`).
fn sets_assign_property(owner: DynClass, sel: &str) -> bool {
    let Some(rest) = sel.strip_prefix("set").and_then(|s| s.strip_suffix(':')) else {
        return false;
    };
    if rest.is_empty() || strings::contains_char(rest.as_bytes(), b':') {
        return false;
    }
    let mut lowered = rest.to_owned();
    lowered[..1].make_ascii_lowercase();
    [lowered.as_str(), rest]
        .iter()
        .filter_map(|name| CString::new(*name).ok())
        .find_map(|name| rt().property_attributes(owner.0, &name))
        .is_some_and(|attributes| {
            let mut parts = strings::split(attributes.as_bytes(), b",");
            parts.next().is_some_and(|t| t.starts_with(b"T@"))
                && !parts.any(|a| matches!(a, b"W" | b"&" | b"C"))
        })
}

/// After an `assign` property's setter ran: has the receiver hold whatever
/// object the setter was given (nil clears it), keyed by the selector, so
/// the property cannot outlive what it points at. AppKit declares nearly
/// every delegate, data source and target zeroing-weak; this covers the few
/// it still does not.
fn keep_assigned(target: &NSObject, invocation: &NSInvocation, sig: &Signature) {
    let mut value = Frame::new();
    invocation.get_argument_raw(value.as_mut_ptr(), sig.slot(0));
    let key = sig.sel.map_or(ptr::null(), |s| s.0.as_ptr().cast_const());
    // SAFETY: the receiver just answered the send; the argument word is the
    // object pointer (or nil) `encode` wrote, whose object `Keep` still holds.
    unsafe { rt().associate_retained(target.as_obj(), key, value.read_word() as Obj) };
}

/// A window made in code releases itself when it closes unless told not to;
/// that release, on top of the one the returned wrapper owes, would free the
/// object under the wrapper. So a window that comes back from `init…`, `new…`
/// or a class method of a window class is told not to.
fn keep_window_past_close(
    receiver: Receiver<'_>,
    sig: &Signature,
    result: &DynValue,
) -> Result<()> {
    let DynValue::Object(object) = result else {
        return Ok(());
    };
    let is_window = |class: Class| rt().class_inherits(class, NSWindow::class());
    let created = matches!(sig.family, Family::Init | Family::New)
        || receiver.as_class().is_some_and(|c| is_window(c.0));
    if created && let Some(window) = view_as::<NSWindow>(&*object.live()?) {
        window.set_released_when_closed(false);
    }
    Ok(())
}

pub(super) fn unsupported(method: &str, what: impl Into<String>) -> Error {
    Error::UnsupportedSignature {
        method: method.to_owned(),
        what: what.into(),
    }
}

/// Lays `value` out in `frame` as the C type `enc`; whatever the frame ends
/// up pointing at goes in `keep`. `method` and `index` are for messages. An
/// object in a block slot is taken as one (see [`block::check_block_object`]).
pub(super) fn encode(
    method: &str,
    index: usize,
    enc: &Enc,
    value: &DynValue,
    frame: &mut Frame,
    keep: &mut Keep,
) -> Result<()> {
    let mismatch = || Error::ArgType {
        method: method.to_owned(),
        index,
        expected: enc.to_string(),
        got: value.kind().to_owned(),
    };
    let c_string = |s: &str| {
        CString::new(s).map_err(|_| Error::ArgType {
            method: method.to_owned(),
            index,
            expected: enc.to_string(),
            got: "a string containing a NUL character".into(),
        })
    };
    let mut object = |o: NSObject, frame: &mut Frame| {
        frame.word(o.as_obj() as usize);
        keep.objects.push(o);
    };
    match (enc, value) {
        (
            Enc::Object
            | Enc::CFObject(_)
            | Enc::Block
            | Enc::Class
            | Enc::Sel
            | Enc::CString
            | Enc::Out(_)
            | Enc::Buffer(_)
            | Enc::Pointer,
            DynValue::Nil,
        )
        | (Enc::Pointer, DynValue::Pointer(0)) => frame.word(0),
        (Enc::Out(pointee), DynValue::Out(initial)) => {
            let mut cell = Frame::new();
            if let Some(initial) = initial {
                encode(method, index, &pointee.enc(), initial, &mut cell, keep)?;
            }
            frame.word(keep.out(index, *pointee, cell).as_ptr() as usize);
        }
        (Enc::Object, DynValue::Object(o)) => object(o.live()?.clone(), frame),
        (Enc::Object, DynValue::Class(c)) => frame.word(c.address()),
        (Enc::Object, DynValue::Str(s)) => {
            object(NSString::from_str(NsStr::Utf8(s)).upcast().clone(), frame)
        }
        (Enc::Object, DynValue::Bool(b)) => object(NSNumber::with_bool(*b).upcast().clone(), frame),
        (Enc::Object, DynValue::F64(n)) => object(nsnumber(*n).upcast().clone(), frame),
        (Enc::Object, DynValue::I64(n)) => object(NSNumber::with_i64(*n).upcast().clone(), frame),
        (Enc::Object, DynValue::U64(n)) => object(NSNumber::with_u64(*n).upcast().clone(), frame),
        (Enc::Block, DynValue::Object(o)) => object(o.live()?.clone(), frame),
        (Enc::CFObject(t), DynValue::Object(o)) => {
            let o = o.live()?;
            if !t.holds(&o) {
                return Err(Error::ArgType {
                    method: method.to_owned(),
                    index,
                    expected: enc.to_string(),
                    got: format!("a {}", rt().class_name_of(o.as_obj())),
                });
            }
            object(o.clone(), frame);
        }
        (Enc::Class, DynValue::Class(c)) => frame.word(c.address()),
        (Enc::Class, DynValue::Object(o)) if o.is_class() => {
            frame.word(o.live()?.as_obj() as usize)
        }
        (Enc::Sel, DynValue::Sel(name) | DynValue::Str(name)) => {
            frame.word(register_sel(&c_string(name)?).0.as_ptr() as usize);
        }
        (Enc::Bool | Enc::Int { .. } | Enc::F32 | Enc::F64, _) => {
            let scalar = match enc {
                Enc::Bool => Scalar::Bool,
                Enc::Int { bits, signed } => Scalar::Int {
                    bits: *bits,
                    signed: *signed,
                },
                Enc::F32 => Scalar::F32,
                _ => Scalar::F64,
            };
            match frame.put_scalar(0, scalar, value) {
                Ok(true) => {}
                Ok(false) => return Err(mismatch()),
                Err((min, max, got)) => {
                    return Err(Error::ArgType {
                        method: method.to_owned(),
                        index,
                        expected: format!("{enc} from {min} to {max}"),
                        got: got.to_string(),
                    });
                }
            }
        }
        (Enc::CString, DynValue::Str(s)) => {
            let c = c_string(s)?;
            frame.word(c.as_ptr() as usize);
            keep.strings.push(c);
        }
        (Enc::Pointer, _) => {
            return Err(unsupported(
                method,
                "pointer arguments are not supported yet",
            ));
        }
        (Enc::Struct(t), DynValue::Struct(vt, values))
            if vt.fields.len() == t.fields.len() && values.len() == t.fields.len() =>
        {
            for (i, (field, v)) in t.fields.iter().zip(values.iter()).enumerate() {
                let member = || match t.field_names() {
                    Some(names) => names[i].to_owned(),
                    None => format!("[{i}]"),
                };
                match frame.put_scalar(field.offset, field.scalar, v) {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(Error::ArgType {
                            method: method.to_owned(),
                            index,
                            expected: format!("{enc} with {} {}", member(), field.scalar.enc()),
                            got: format!("{} there", v.kind()),
                        });
                    }
                    Err((min, max, got)) => {
                        return Err(Error::ArgType {
                            method: method.to_owned(),
                            index,
                            expected: format!("{enc} with {} from {min} to {max}", member()),
                            got: got.to_string(),
                        });
                    }
                }
            }
        }
        (Enc::Other(e), _) => {
            return Err(unsupported(
                method,
                format!("argument type {e} is not supported yet"),
            ));
        }
        _ => return Err(mismatch()),
    }
    Ok(())
}

/// Reads a value of C type `enc` out of `frame`. An object in it is a
/// reference the caller owns when `retained`, else borrowed (+0).
pub(super) fn decode(method: &str, enc: &Enc, retained: bool, frame: &Frame) -> Result<DynValue> {
    Ok(match enc {
        Enc::Void => DynValue::Void,
        Enc::Object | Enc::CFObject(_) | Enc::Block => {
            let raw = frame.read_word() as Obj;
            // SAFETY: an object of the declared type, live on this thread
            // (just returned, or an argument being delivered); owned already
            // when `retained`, otherwise retained before any pool can drain.
            let object = unsafe {
                if retained {
                    DynObject::from_retained(raw)
                } else {
                    DynObject::retain(raw)
                }
            };
            object.map_or(DynValue::Nil, DynValue::Object)
        }
        Enc::Class => NonNull::new(frame.read_word() as Obj)
            .map_or(DynValue::Nil, |p| DynValue::Class(DynClass(Class(p)))),
        Enc::Sel => match NonNull::new(frame.read_word() as Obj) {
            Some(p) => DynValue::Sel(rt().sel_name(super::Sel(p))),
            None => DynValue::Nil,
        },
        Enc::Bool => frame.scalar(0, Scalar::Bool),
        Enc::Int { bits, signed } => frame.scalar(
            0,
            Scalar::Int {
                bits: *bits,
                signed: *signed,
            },
        ),
        Enc::F32 => frame.scalar(0, Scalar::F32),
        Enc::F64 => frame.scalar(0, Scalar::F64),
        Enc::CString => {
            let p = frame.read_word() as *const core::ffi::c_char;
            if p.is_null() {
                DynValue::Nil
            } else {
                // SAFETY: a `char *` result is NUL-terminated and valid at
                // least until the current pool drains; copied now.
                DynValue::Str(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
            }
        }
        Enc::Out(_) | Enc::Buffer(_) | Enc::Pointer => DynValue::Pointer(frame.read_word()),
        Enc::Struct(t) => DynValue::Struct(
            t,
            t.fields
                .iter()
                .map(|f| frame.scalar(f.offset, f.scalar))
                .collect(),
        ),
        Enc::Other(e) => {
            return Err(unsupported(
                method,
                format!("return type {e} is not supported yet"),
            ));
        }
    })
}

/// What the script behind a block or a script-class method answered.
pub struct Reply {
    /// Already shaped for the return type; `None` (the function threw, or
    /// returned something that does not fit, both of which were reported)
    /// leaves the caller a zero / `nil` result.
    pub value: Option<DynValue>,
    /// Values to store through [`Enc::Out`] arguments, by argument index.
    pub outs: Vec<(usize, DynValue)>,
}

/// The value an [`Enc::Out`] argument being delivered to a script points
/// at (zero for a NULL pointer). `frame` holds the pointer. Out-only object
/// storage is not read: a caller passing `NSError **` need not initialise
/// it, so what is there may not be an object, and the script starts from
/// `nil`; an `inout` object is read and retained.
pub(super) fn read_out(method: &str, pointee: Pointee, frame: &Frame) -> Result<DynValue> {
    let ptr = frame.read_word() as *const u8;
    let mut cell = Frame::new();
    if !ptr.is_null() && pointee != Pointee::Object {
        // SAFETY: a non-NULL out-parameter the caller passed for the callee to
        // read and write during the call: valid for the pointee's size.
        unsafe { ptr::copy_nonoverlapping(ptr, cell.0.as_mut_ptr(), pointee.byte_len()) };
    }
    decode(method, &pointee.enc(), false, &cell)
}

/// Stores `value` through the [`Enc::Out`] argument pointer in `frame`, if
/// it is not NULL. An object stored this way is autoreleased, as a method
/// filling an `NSError **` does.
pub(super) fn write_out(
    method: &str,
    index: usize,
    pointee: Pointee,
    frame: &Frame,
    value: &DynValue,
) -> Result<()> {
    let ptr = frame.read_word() as *mut u8;
    if ptr.is_null() {
        return Ok(());
    }
    let mut cell = Frame::new();
    let mut keep = Keep::default();
    encode(method, index, &pointee.enc(), value, &mut cell, &mut keep)?;
    if let Pointee::Object | Pointee::InOutObject = pointee {
        let object = cell.read_word() as Obj;
        if !object.is_null() {
            // SAFETY: `encode` just stored a live object (held by `keep`, or a
            // class); the reference taken here is the caller's pool's.
            unsafe { (rt().objc_autorelease)((rt().objc_retain)(object)) };
        }
    }
    // SAFETY: a non-NULL out-parameter the caller passed for the callee to
    // write during the call: valid for the pointee's size.
    unsafe { ptr::copy_nonoverlapping(cell.0.as_ptr(), ptr, pointee.byte_len()) };
    Ok(())
}

/// Part of `verify_bindings`: the layout [`StructType`] computes from an
/// encoding agrees with Foundation's `NSGetSizeAndAlignment` for the structs
/// the frameworks pass by value, named and anonymous, nested and padded.
pub(super) fn verify_struct_layouts(problems: &mut Vec<String>) {
    type SizeAndAlignment = unsafe extern "C" fn(
        *const core::ffi::c_char,
        *mut usize,
        *mut usize,
    ) -> *const core::ffi::c_char;
    let Some(symbol) = rt().symbol(c"NSGetSizeAndAlignment") else {
        problems.push("NSGetSizeAndAlignment is not exported by Foundation".into());
        return;
    };
    // SAFETY: Foundation's `NSGetSizeAndAlignment`, which has this signature.
    let size_and_alignment: SizeAndAlignment = unsafe { core::mem::transmute(symbol.as_ptr()) };
    for encoding in [
        c"{CGRect={CGPoint=dd}{CGSize=dd}}",
        c"{_NSRange=QQ}",
        c"{NSEdgeInsets=dddd}",
        c"{CGAffineTransform=dddddd}",
        c"{CATransform3D=dddddddddddddddd}",
        c"{?=qiIq}",
        c"{?={?=QQQ}{?=QQQ}}",
        c"{?=dddd}",
        c"{outer={inner=dc}c}",
        c"{s=cs}",
        c"{b=fB}",
        c"{m=Cq}",
    ] {
        let text = encoding.to_string_lossy();
        let Enc::Struct(t) = Enc::parse(&text) else {
            problems.push(format!("{text} does not parse as a struct"));
            continue;
        };
        let (mut size, mut align) = (0usize, 0usize);
        // SAFETY: a NUL-terminated encoding and two words to fill.
        unsafe { size_and_alignment(encoding.as_ptr(), &raw mut size, &raw mut align) };
        if t.size != size {
            problems.push(format!(
                "{text}: laid out as {} bytes, Foundation says {size}",
                t.size
            ));
        }
        if let Some(last) = t.fields.last()
            && last.offset + last.scalar.size() > size
        {
            problems.push(format!(
                "{text}: last member ends past Foundation's {size} bytes"
            ));
        }
    }
}

/// The exported global `name` (`NSString *const NSFontAttributeName`,
/// `const CGFloat NSFontWeightBold`) read as the C type `types` encodes:
/// an object, `BOOL`, an integer, `float`/`double`, or one of the structs.
pub fn constant(name: &str, types: &str) -> Result<DynValue> {
    load()?;
    let no_symbol = || Error::NoSymbol(name.to_owned());
    let c_name = CString::new(name).map_err(|_| no_symbol())?;
    let symbol = rt().symbol(&c_name).ok_or_else(no_symbol)?;
    if is_function(symbol) {
        return Err(Error::NotAConstant(name.to_owned()));
    }
    let enc = Enc::parse(types);
    let Some(pointee) = Pointee::of(&enc) else {
        return Err(Error::UnsupportedSignature {
            method: format!("constant {name}"),
            what: format!("cannot be read as {enc}"),
        });
    };
    let mut cell = Frame::new();
    // SAFETY: the symbol is a variable of the type `types` says, per the
    // caller; its bytes are copied out.
    unsafe {
        ptr::copy_nonoverlapping(
            symbol.as_ptr().cast::<u8>(),
            cell.0.as_mut_ptr(),
            pointee.byte_len(),
        )
    };
    if pointee == Pointee::Object && !holds_object(cell.read_word()) {
        return Err(Error::NotAnObject(name.to_owned()));
    }
    decode(name, &pointee.enc(), false, &cell)
}

unsafe extern "C" {
    /// `<mach/mach_init.h>`: the calling task's own port.
    static mach_task_self_: u32;
    /// `<mach/mach_vm.h>`: copies `size` bytes at `address` in `target_task`
    /// to `data`, or fails (rather than faulting) when they are not mapped
    /// readable.
    fn mach_vm_read_overwrite(
        target_task: u32,
        address: u64,
        size: u64,
        data: u64,
        outsize: *mut u64,
    ) -> i32;
}

/// Whether `word`, read from a global taken to hold an object, plausibly
/// does: nil, a tagged pointer of a registered class, or the aligned address
/// of readable memory whose first word, masked the way the runtime masks an
/// isa, is a class the runtime has registered. A `double`, a
/// `CGAffineTransform` or a table of callbacks read this way fails the test
/// instead of crashing in `objc_retain` (or in `object_getClass`, which traps
/// on a corrupt isa rather than answering).
fn holds_object(word: usize) -> bool {
    if word == 0 {
        return true;
    }
    #[cfg(target_arch = "aarch64")]
    let tagged = word >> 63 == 1;
    #[cfg(target_arch = "x86_64")]
    let tagged = word & 1 == 1;
    let class = if tagged {
        // SAFETY: for a tagged pointer `object_getClass` indexes the tag
        // table by the tag bits and dereferences nothing; an unused tag
        // answers Nil.
        unsafe { (rt().object_getClass)(word as Obj) as usize }
    } else {
        if !word.is_multiple_of(8) {
            return false;
        }
        let mut isa = 0usize;
        let mut got = 0u64;
        // SAFETY: reads our own address space through the kernel, which
        // answers an error for an unmapped or unreadable range; `isa` is 8
        // writable bytes.
        let readable = unsafe {
            mach_vm_read_overwrite(
                mach_task_self_,
                word as u64,
                8,
                (&raw mut isa) as u64,
                &raw mut got,
            ) == 0
                && got == 8
        };
        if !readable {
            return false;
        }
        static ISA_MASK: OnceLock<Option<usize>> = OnceLock::new();
        let mask = ISA_MASK.get_or_init(|| {
            // SAFETY: `objc_debug_isa_class_mask` is the `uintptr_t` libobjc
            // exports for debuggers to do exactly this with.
            rt().symbol(c"objc_debug_isa_class_mask")
                .map(|p| unsafe { p.cast::<usize>().read() })
        });
        match mask {
            Some(mask) => isa & mask,
            None => return false,
        }
    };
    class != 0 && is_registered_class(class)
}

thread_local! {
    /// Sorted addresses of every class the runtime had registered when last asked.
    static CLASSES: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

/// Whether `address` is a registered class, re-reading the class list once
/// on a miss (an image loaded since may have added it).
fn is_registered_class(address: usize) -> bool {
    let known = |refresh: bool| {
        CLASSES.with_borrow_mut(|classes| {
            if refresh || classes.is_empty() {
                *classes = rt()
                    .class_list()
                    .into_iter()
                    .map(|c| c.as_obj() as usize)
                    .collect();
                classes.sort_unstable();
            }
            classes.binary_search(&address).is_ok()
        })
    };
    known(false) || known(true)
}

unsafe extern "C" {
    /// `<mach-o/getsect.h>`: the address and `size` of section `sectname` of
    /// segment `segname` in the loaded image whose Mach header is at `mhp`.
    fn getsectiondata(
        mhp: *const c_void,
        segname: *const core::ffi::c_char,
        sectname: *const core::ffi::c_char,
        size: *mut core::ffi::c_ulong,
    ) -> *mut u8;
}

/// Whether `symbol` lies in the machine code (`__TEXT,__text`) of the image
/// that defines it: it names a function rather than a variable.
fn is_function(symbol: NonNull<c_void>) -> bool {
    let mut info = core::mem::MaybeUninit::<libc::Dl_info>::uninit();
    // SAFETY: `dladdr` accepts any address and fills `info` when it returns
    // non-zero.
    let info = unsafe {
        if libc::dladdr(symbol.as_ptr(), info.as_mut_ptr()) == 0 {
            return false;
        }
        info.assume_init()
    };
    let mut size: core::ffi::c_ulong = 0;
    // SAFETY: `dli_fbase` is the Mach header of the loaded image containing
    // `symbol`; the names are NUL-terminated.
    let text = unsafe {
        getsectiondata(
            info.dli_fbase,
            c"__TEXT".as_ptr(),
            c"__text".as_ptr(),
            &raw mut size,
        )
    };
    let start = text as usize;
    !text.is_null() && (start..start + size as usize).contains(&(symbol.as_ptr() as usize))
}

#[cfg(test)]
mod tests {
    use super::{CF_OBJECTS, CG_RECT, Enc, Family, NS_RANGE, Pointee, Scalar, StructType};

    #[test]
    fn encodings() {
        assert_eq!(Enc::parse("@"), Enc::Object);
        assert_eq!(Enc::parse("@?"), Enc::Block);
        assert_eq!(Enc::parse("r*"), Enc::CString);
        assert_eq!(Enc::parse("*"), Enc::Buffer("*".into()));
        assert_eq!(Enc::parse("r^d"), Enc::Buffer("r^d".into()));
        assert_eq!(Enc::parse("^{CGColor=}"), Enc::CFObject(&CF_OBJECTS[0]));
        assert_eq!(Enc::parse("r^{CGPath=}"), Enc::CFObject(&CF_OBJECTS[3]));
        assert_eq!(Enc::parse("^{CGPath=}").encoding(), "^{CGPath=}");
        assert_eq!(Enc::parse("^^{CGImage=}"), Enc::Pointer);
        assert_eq!(Enc::parse("^{_NSZone=}"), Enc::Pointer);
        assert_eq!(Enc::parse("^v"), Enc::Pointer);
        assert_eq!(Enc::parse("^^@"), Enc::Pointer);
        assert_eq!(Enc::parse("o^@"), Enc::Out(Pointee::Object));
        assert_eq!(Enc::parse("N^@"), Enc::Out(Pointee::InOutObject));
        assert_eq!(Enc::Out(Pointee::InOutObject).encoding(), "N^@");
        assert_eq!(Enc::parse("^B"), Enc::Out(Pointee::Bool));
        assert_eq!(
            Enc::parse("^{CGRect={CGPoint=dd}{CGSize=dd}}"),
            Enc::Out(Pointee::Struct(&CG_RECT))
        );
        assert!(matches!(
            Enc::parse("r^{CGRect={CGPoint=dd}{CGSize=dd}}"),
            Enc::Buffer(_)
        ));
        assert_eq!(Enc::Out(Pointee::F64).encoding(), "^d");
        assert_eq!(
            Enc::parse("Q"),
            Enc::Int {
                bits: 64,
                signed: false
            }
        );
        assert_eq!(
            Enc::parse("{CGRect={CGPoint=dd}{CGSize=dd}}"),
            Enc::Struct(&CG_RECT)
        );
        assert_eq!(Enc::parse("{_NSRange=QQ}"), Enc::Struct(&NS_RANGE));
        assert_eq!(Enc::parse("r{_NSRange=QQ}"), Enc::Struct(&NS_RANGE));
        assert!(matches!(Enc::parse("(?=iq)"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{?=b8b4}"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{?=i^v}"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{?=[4d]}"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{CGColor}"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{?=}"), Enc::Other(_)));
        assert!(matches!(Enc::parse("{?=dd"), Enc::Other(_)));
        // Larger than a Frame.
        assert!(matches!(
            Enc::parse("{big=dddddddddddddddddd}"),
            Enc::Other(_)
        ));
    }

    /// Offsets and sizes as clang lays the same structs out.
    #[test]
    fn struct_layout() {
        let layout = |encoding: &str| -> (Vec<usize>, usize, &'static str) {
            match Enc::parse(encoding) {
                Enc::Struct(t) => (t.fields.iter().map(|f| f.offset).collect(), t.size, t.name),
                other => panic!("{encoding} parsed as {other:?}"),
            }
        };
        assert_eq!(
            layout("{CGAffineTransform=dddddd}"),
            (vec![0, 8, 16, 24, 32, 40], 48, "CGAffineTransform")
        );
        assert_eq!(layout("{CATransform3D=dddddddddddddddd}").1, 128);
        // CMTime: { int64_t value; int32_t timescale; uint32_t flags; int64_t epoch; }
        assert_eq!(layout("{?=qiIq}"), (vec![0, 8, 12, 16], 24, "?"));
        // MTLRegion: two anonymous structs of three NSUIntegers.
        assert_eq!(
            layout("{?={?=QQQ}{?=QQQ}}"),
            (vec![0, 8, 16, 24, 32, 40], 48, "?")
        );
        // Trailing padding of an inner struct, then a byte, then tail padding.
        assert_eq!(layout("{outer={inner=dc}c}"), (vec![0, 8, 16], 24, "outer"));
        assert_eq!(layout("{s=cs}"), (vec![0, 2], 4, "s"));
        assert_eq!(layout("{b=fB}"), (vec![0, 4], 8, "b"));
        let Enc::Struct(cm_time) = Enc::parse("{?=qiIq}") else {
            unreachable!()
        };
        assert_eq!(
            cm_time.fields[2].scalar,
            Scalar::Int {
                bits: 32,
                signed: false
            }
        );
        assert_eq!(cm_time.field_names(), None);
        assert_eq!(
            CG_RECT.field_names(),
            Some(&["x", "y", "width", "height"][..])
        );
        let Enc::Struct(insets) = Enc::parse("{NSDirectionalEdgeInsets=dddd}") else {
            unreachable!()
        };
        assert_eq!(
            insets.field_names(),
            Some(&["top", "leading", "bottom", "trailing"][..])
        );
        // Interned: the same encoding is the same type.
        assert!(core::ptr::eq::<StructType>(cm_time, {
            let Enc::Struct(again) = Enc::parse("{?=qiIq}") else {
                unreachable!()
            };
            again
        }));
    }

    /// `partition_point` needs the selectors sorted the way `str` orders.
    #[test]
    fn sdk_tables_are_sorted() {
        let table = super::sdk::VARIADIC;
        assert!(table.is_sorted() && table.windows(2).all(|w| w[0] != w[1]));
        let at = table.partition_point(|(s, _)| *s < "initWithObjects:");
        assert_eq!(table[at].0, "initWithObjects:");
        assert!(
            table[at..]
                .iter()
                .take_while(|(s, _)| *s == "initWithObjects:")
                .count()
                > 1
        );
        let table = super::sdk::ARRAY_PARAMS;
        assert!(table.is_sorted_by_key(|(s, _, _)| *s) && table.windows(2).all(|w| w[0] != w[1]));
        let at = table.partition_point(|(s, _, _)| *s < "getObjects:range:");
        assert_eq!(table[at], ("getObjects:range:", c"NSArray", 0));
        let table = super::sdk::BLOCK_PARAMS;
        assert!(table.is_sorted_by_key(|(s, c, i, _)| (*s, *c, *i)));
        let at = table.partition_point(|(s, ..)| *s < "enumerateObjectsUsingBlock:");
        assert_eq!(
            table[at],
            ("enumerateObjectsUsingBlock:", c"NSArray", 0, c"v@?@Q^B")
        );
        let table = super::sdk::PROTOCOLS;
        assert!(table.is_sorted_by_key(|p| p.name));
    }

    #[test]
    fn families() {
        assert_eq!(Family::of("alloc"), Family::Alloc);
        assert_eq!(Family::of("newValue"), Family::New);
        assert_eq!(Family::of("newsstand"), Family::None);
        assert_eq!(Family::of("_initWithFrame:"), Family::Init);
        assert_eq!(Family::of("initialize"), Family::None);
        assert_eq!(Family::of("copyright"), Family::None);
        assert_eq!(Family::of("mutableCopy"), Family::MutableCopy);
        assert_eq!(Family::of("copy:"), Family::Copy);
        assert_eq!(Family::of("createCGImage:fromRect:"), Family::Create);
        assert_eq!(
            Family::of("CGImageForProposedRect:context:hints:"),
            Family::None
        );
    }
}
