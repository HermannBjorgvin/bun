//! `ObjCObject` / `ObjCClass` / `ObjCSelector` and the `objc*` binding
//! functions: the JavaScript face of `bun_appkit::dynamic`, which sends any
//! selector to any object or class. `src/js/internal/objc.ts` wraps these in
//! the `objc` proxy layer (selector name mangling, `objc.classes`, handles).
//!
//! Everything here is per thread: the main thread and each Worker that loads
//! the module get their own handle table, hooks, script functions and
//! release queue, and are each an [`Owner`] the bridge hands stray blocks
//! and instances back to. [`retire`] lets go of a thread's half when it exits.

use core::cell::{Cell, RefCell};
use core::mem::ManuallyDrop;
use std::collections::HashMap;
use std::rc::Rc;

use bun_appkit::dynamic::{self, Enc, Plain, Receiver, Reply};
use bun_appkit::handoff::{self, Owner, Post};
use bun_appkit::script::{self, Call, ClassSpec, MethodSpec};
use bun_appkit::{DynClass, DynObject, DynValue, View, block};
use bun_jsc::ConcurrentTask::ConcurrentTask;
use bun_jsc::ManagedTask::ManagedTask;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{
    CallFrame, GlobalRef, JSBigInt, JSFunction, JSGlobalObject, JSUint8Array, JSValue, JsClass,
    JsResult, LoopKind, Posted, Strong, VmHandle, Weak,
};

use super::conv::{self, JsStr, Slot};

thread_local! {
    /// What the collector has finalized whose native half is still to be
    /// dropped; see [`drop_later`]. Never dropped as a whole.
    static RELEASED: RefCell<ManuallyDrop<Released>> = const {
        RefCell::new(ManuallyDrop::new(Released {
            objects: Vec::new(),
            views: Vec::new(),
        }))
    };
    /// What `internal/objc.ts` hands over once; see [`Hooks`]. Never dropped
    /// by the thread-local: it goes in [`retire`] or lives as long as the module.
    static HOOKS: RefCell<Option<ManuallyDrop<Hooks>>> = const { RefCell::new(None) };
    /// The live wrapper of each object or class by address, so one object is
    /// one JavaScript object for as long as the script can reach it. Nothing
    /// that allocates on the JavaScript heap may run while this is borrowed:
    /// a collection would finalize wrappers, which come back here. Emptied
    /// by [`retire`], never dropped by the thread-local.
    static HANDLES: RefCell<ManuallyDrop<HashMap<usize, Weak<()>>>> =
        RefCell::new(ManuallyDrop::new(HashMap::new()));
    /// Every live [`Roots`] on the thread, for [`retire`] to empty.
    static ROOTS: RefCell<Vec<std::rc::Weak<Roots>>> = const { RefCell::new(Vec::new()) };
}

/// Whether [`retire`] has run on this thread: its JavaScript side is going
/// or gone, so nothing here may touch the heap any more.
fn retired() -> bool {
    handoff::this_thread().is_some_and(Owner::retired)
}

/// The functions (or table) one block, script class or attached table keeps
/// alive, held so that [`retire`] can let them go while the heap is still
/// there; from then on whatever owned them answers nothing.
struct Roots(RefCell<Vec<Strong>>);

impl Roots {
    fn new(global: &JSGlobalObject, values: &[JSValue]) -> Rc<Roots> {
        let roots = Rc::new(Roots(RefCell::new(
            values.iter().map(|v| Strong::create(*v, global)).collect(),
        )));
        ROOTS.with_borrow_mut(|all| {
            // Forget the ones already dropped now and then, so the list
            // stays about as long as what is alive.
            if all.len().is_power_of_two() {
                all.retain(|r| r.strong_count() > 0);
            }
            all.push(Rc::downgrade(&roots));
        });
        roots
    }

    fn get(&self, index: usize) -> Option<JSValue> {
        self.0.borrow().get(index).map(Strong::get)
    }
}

/// The script side's half of the bridge, from `objcSetHooks`.
struct Hooks {
    /// The global object that loaded the module.
    global: GlobalRef,
    /// Applies a script-class method or block function to its receiver and
    /// arguments (turning the raw wrappers into the proxied handles scripts
    /// see).
    dispatch: Strong,
    /// An array a send pushes (argument index, value) pairs onto for what
    /// the method left in its out-parameters; the script side moves each
    /// into the `{ value }` object it passed and empties the array.
    outs: Strong,
}

fn hooks<R>(global: &JSGlobalObject, f: impl FnOnce(&Hooks) -> R) -> JsResult<R> {
    HOOKS.with_borrow(|hooks| match hooks {
        Some(hooks) => Ok(f(hooks)),
        None => Err(global.throw_type_error(format_args!("objcSetHooks() was never called"))),
    })
}

/// The wrapper already handed out for `address` while it is alive (and, for
/// an object, not released by the script), which counts as one more
/// acquisition of it when `acquired`; otherwise `make`'s, remembered.
fn canonical(
    global: &JSGlobalObject,
    address: usize,
    acquired: bool,
    make: impl FnOnce() -> JSValue,
) -> JSValue {
    let existing = HANDLES.with_borrow(|handles| handles.get(&address).and_then(Weak::get));
    if let Some(existing) = existing {
        let usable = match existing.as_class_ref::<ObjCObject>() {
            Some(o) if o.object.is_released() => false,
            Some(o) => {
                if acquired {
                    o.acquisitions.set(o.acquisitions.get().saturating_add(1));
                }
                true
            }
            None => true,
        };
        if usable {
            return existing;
        }
    }
    let value = make();
    let weak = Weak::create_passive(value, global);
    drop(HANDLES.with_borrow_mut(|handles| handles.insert(address, weak)));
    value
}

/// Drops `address`'s entry once the wrapper it names has been collected (a
/// newer wrapper for the same address keeps it).
fn forget(address: usize) {
    HANDLES.with_borrow_mut(|handles| {
        if handles
            .get(&address)
            .is_some_and(|weak| weak.get().is_none())
        {
            handles.remove(&address);
        }
    });
}

/// How `bun_appkit` reaches this thread from another: a task on its event
/// loop that frees handed-back values or reports a call made elsewhere.
struct VmHome(VmHandle);

impl handoff::Home for VmHome {
    fn post(&self, post: Post) -> bool {
        fn posted(post: *mut Post) -> JsResult<()> {
            // SAFETY: what the enclosing function boxed for this one task.
            match *unsafe { bun_core::heap::take(post) } {
                Post::FreeDeferred => handoff::free_deferred(),
                Post::WrongThread(_) if retired() => {}
                Post::WrongThread(what) => {
                    let global = VirtualMachine::get().global();
                    let err = conv::throw(global, bun_appkit::Error::CalledOnOtherThread(what));
                    let _ = bun_jsc::task::report_error_or_terminate(global, err);
                }
            }
            Ok(())
        }
        let task = ConcurrentTask::create(ManagedTask::new_owned(
            bun_core::heap::into_raw(Box::new(post)),
            posted,
        ));
        match self.0.post(LoopKind::Regular, task) {
            Posted::Queued => true,
            Posted::Refused(task) => {
                // SAFETY: refused, so still ours; this frees the boxed `Post` too.
                unsafe { ConcurrentTask::release_refused(task) };
                false
            }
        }
    }
}

/// This thread's JavaScript side is shutting down (a Worker ending, or the
/// process): free what other threads handed back while the heap is still
/// here, then let go of every function, table, hook and wrapper the bridge
/// holds on it and tell `bun_appkit` the thread is gone, so a block or
/// script method reached later (here during teardown, or on another thread)
/// runs nothing. Objective-C objects the collector frees from now on are
/// released on the spot.
extern "C" fn retire(_: *mut core::ffi::c_void) {
    let Some(owner) = handoff::this_thread() else {
        return;
    };
    if owner.retired() {
        return;
    }
    handoff::free_deferred();
    owner.retire();
    release_finalized();
    let roots = ROOTS.with_borrow_mut(core::mem::take);
    for roots in roots.iter().filter_map(std::rc::Weak::upgrade) {
        roots.0.borrow_mut().clear();
    }
    drop(roots);
    if let Some(hooks) = HOOKS.with_borrow_mut(Option::take) {
        drop(ManuallyDrop::into_inner(hooks));
    }
    drop(HANDLES.with_borrow_mut(|handles| core::mem::take(&mut **handles)));
}

/// Applies `function` to `receiver` (or `undefined`) and `args` through the
/// dispatch function. `None` when it threw, which the event loop reported.
fn dispatch(
    global: &JSGlobalObject,
    function: JSValue,
    receiver: JSValue,
    args: JSValue,
) -> JsResult<Option<JSValue>> {
    let dispatch = hooks(global, |hooks| hooks.dispatch.get())?;
    let result = global.bun_vm().event_loop_mut().run_callback_with_result(
        dispatch,
        global,
        JSValue::UNDEFINED,
        &[function, receiver, args],
    );
    Ok((!result.is_empty()).then_some(result))
}

/// `returned` converted for a `ret`-typed return slot of `method`; a misfit
/// is the script's error, reported like a throw from the function itself,
/// and reads as `None` just as a throw does.
fn returned(
    global: &JSGlobalObject,
    method: &str,
    ret: &Enc,
    returned: JsResult<Option<JSValue>>,
) -> Option<DynValue> {
    let converted = returned.and_then(|returned| match returned {
        // Whatever a void function returns is dropped, as JavaScript does.
        Some(_) if *ret == Enc::Void => Ok(Some(DynValue::Void)),
        Some(value) => conv::dyn_value(global, method, Slot::Return, ret, value).map(Some),
        None => Ok(None),
    });
    match converted {
        Ok(value) => value,
        Err(err) => {
            let _ = bun_jsc::task::report_error_or_terminate(global, err);
            None
        }
    }
}

/// How a block or script-class method reaches its function: `args`
/// converted the way results are (an out-parameter as a `{ value }` cell),
/// the function applied to `receiver`, its result converted for `ret`, and
/// the cells read back for `params`' out-parameters.
fn call_js(
    global: &JSGlobalObject,
    function: JSValue,
    receiver: JSValue,
    method: &str,
    args: Vec<DynValue>,
    params: &[Enc],
    ret: &Enc,
) -> Reply {
    // Each converted argument is in the array, and so reachable, as soon as
    // it exists; the cells are read back out of the array after the call.
    let args =
        JSValue::create_array_from_iter(global, args.into_iter().zip(params), |(arg, enc)| {
            let value = conv::lent_to_js(global, arg)?;
            Ok(match enc {
                Enc::Out(_) => {
                    let cell = JSValue::create_empty_object(global, 1);
                    cell.put(global, b"value", value);
                    cell
                }
                _ => value,
            })
        });
    let args = match args {
        Ok(args) => args,
        Err(err) => {
            return Reply {
                value: returned(global, method, ret, Err(err)),
                outs: Vec::new(),
            };
        }
    };
    let value = returned(
        global,
        method,
        ret,
        dispatch(global, function, receiver, args),
    );
    let read_outs = || -> JsResult<Vec<(usize, DynValue)>> {
        let mut read = Vec::new();
        for (index, enc) in params.iter().enumerate() {
            let Enc::Out(pointee) = enc else {
                continue;
            };
            let cell = args.get_index(global, index as u32)?;
            if let Some(value) = cell.get(global, "value")? {
                let slot = Slot::Arg(index);
                read.push((
                    index,
                    conv::dyn_value(global, method, slot, &pointee.enc(), value)?,
                ));
            }
        }
        Ok(read)
    };
    let outs = read_outs().unwrap_or_else(|err| {
        // A `value` that does not convert (or a getter that throws) counts
        // as the function throwing.
        let _ = bun_jsc::task::report_error_or_terminate(global, err);
        Vec::new()
    });
    args.ensure_still_alive();
    Reply { value, outs }
}

fn selector_arg(global: &JSGlobalObject, value: JSValue, what: &str) -> JsResult<conv::Utf8> {
    Ok(JsStr::new(global, value, format_args!("{what} selector"))?.to_utf8())
}

/// The native half of a wrapper the collector has finalized. Dropping it
/// gives an Objective-C reference back (an object's last release runs its
/// `dealloc`; a view lets go of its delegate), which can send messages
/// that script-defined methods answer, and JavaScript cannot run inside a
/// collection. So finalizers queue it here and it is dropped on the next
/// event loop turn, or at the top of the next send, instead.
pub(super) enum Finalized {
    Object(DynObject),
    View(View),
}

#[derive(Default)]
struct Released {
    objects: Vec<DynObject>,
    views: Vec<View>,
}

impl Released {
    fn is_empty(&self) -> bool {
        self.objects.is_empty() && self.views.is_empty()
    }
}

/// Queues `item` to be dropped outside the collection; see [`Finalized`].
/// Once the thread has [`retire`]d there is no later, and no script method
/// a `dealloc` could reach runs any more, so it is dropped here.
pub(super) fn drop_later(item: Finalized) {
    if retired() {
        dynamic::drop_pooled(item);
        return;
    }
    let first = RELEASED.with_borrow_mut(|queue| {
        let first = queue.is_empty();
        match item {
            Finalized::Object(object) => queue.objects.push(object),
            Finalized::View(view) => queue.views.push(view),
        }
        first
    });
    if first {
        fn release(_: *mut u8) -> JsResult<()> {
            release_finalized();
            Ok(())
        }
        static TAG: u8 = 0;
        VirtualMachine::get()
            .event_loop_mut()
            .enqueue_task(ManagedTask::new(
                core::ptr::from_ref(&TAG).cast_mut(),
                release,
            ));
    }
}

/// Drops what the collector has finalized since this last ran; see
/// [`Finalized`].
fn release_finalized() {
    let released = RELEASED.with_borrow_mut(|queue| core::mem::take(&mut **queue));
    if !released.is_empty() {
        dynamic::drop_pooled(released);
    }
}

/// Looks the method up, converts `args` by its signature, sends, and converts
/// the result back.
fn send(
    global: &JSGlobalObject,
    receiver: Receiver<'_>,
    frame: &CallFrame,
    what: &str,
) -> JsResult<JSValue> {
    // Here rather than only on the next event-loop turn, so a loop of sends
    // that never yields cannot pile up what the collector already let go.
    release_finalized();
    let args = frame.arguments();
    let sel = selector_arg(global, frame.argument(0), what)?;
    let args = args.get(1..).unwrap_or_default();
    let sig = conv::check(global, dynamic::signature(receiver, &sel))?;
    send_as(global, receiver, &sig, args)
}

/// Converts `args` by `sig`, sends (or calls the block), and converts the
/// result back.
fn send_as(
    global: &JSGlobalObject,
    receiver: Receiver<'_>,
    sig: &dynamic::Signature,
    args: &[JSValue],
) -> JsResult<JSValue> {
    // Out-parameters at the end may be left off: each is passed as NULL.
    let complete = args.len() == sig.args.len()
        || (args.len() < sig.args.len()
            && sig.args[args.len()..]
                .iter()
                .all(|enc| matches!(enc, Enc::Out(_))));
    if !complete {
        return Err(conv::throw(
            global,
            bun_appkit::Error::ArgCount {
                method: sig.method().to_owned(),
                expected: sig.args.len(),
                got: args.len(),
            },
        ));
    }
    let mut values = Vec::with_capacity(sig.args.len());
    for (index, enc) in sig.args.iter().enumerate() {
        values.push(match args.get(index) {
            Some(value) => conv::dyn_arg(global, sig, index, enc, *value)?,
            None => DynValue::Nil,
        });
    }
    let result = conv::check(global, dynamic::invoke(receiver, sig, &mut values))?;
    let result = conv::dyn_to_js(global, result)?;
    if values.iter().any(|v| matches!(v, DynValue::Out(Some(_)))) {
        let outs = hooks(global, |hooks| hooks.outs.get())?;
        for (index, value) in values.into_iter().enumerate() {
            if let DynValue::Out(Some(out)) = value {
                outs.push(global, JSValue::js_number(index as f64))?;
                outs.push(global, conv::dyn_to_js(global, *out)?)?;
            }
        }
    }
    Ok(result)
}

/// One retained Objective-C object. `internal/objc.ts` wraps it in a Proxy that
/// turns property access into bound `msgSend` calls.
#[bun_jsc::JsClass]
pub struct ObjCObject {
    object: DynObject,
    /// How many times the bridge has handed this object to the script as a
    /// result (a send's, `objc.ns()`, an out-parameter) and not had it given
    /// back with `release()`. One retain backs them all; it goes with the
    /// last of them, or when the wrapper is collected.
    acquisitions: Cell<u32>,
}

impl ObjCObject {
    pub fn constructor(_global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<Box<ObjCObject>> {
        Err(_global.throw_illegal_constructor())
    }

    /// The object's one wrapper (a class object's is an [`ObjCClass`]),
    /// counting one more acquisition of it.
    pub(super) fn wrap(global: &JSGlobalObject, object: DynObject) -> JSValue {
        ObjCObject::wrap_as(global, object, true)
    }

    /// The object's one wrapper for the duration of a callback (its receiver
    /// or an argument): the caller's reference, not an acquisition.
    pub(super) fn lend(global: &JSGlobalObject, object: DynObject) -> JSValue {
        ObjCObject::wrap_as(global, object, false)
    }

    fn wrap_as(global: &JSGlobalObject, object: DynObject, acquired: bool) -> JSValue {
        if let Some(class) = object.as_class() {
            return ObjCClass::wrap(global, class);
        }
        let address = object.address();
        let make = || {
            JsClass::to_js(
                ObjCObject {
                    object,
                    acquisitions: Cell::new(1),
                },
                global,
            )
        };
        match address {
            // An `alloc` awaiting its `init…` stands for no object yet.
            0 => make(),
            _ => canonical(global, address, acquired, make),
        }
    }

    pub(super) fn object(&self) -> &DynObject {
        &self.object
    }

    /// See [`Finalized`]: the reference goes back later, not from here.
    pub fn finalize(self: Box<Self>) {
        if self.object.address() != 0 {
            forget(self.object.address());
        }
        if !self.object.is_released() {
            drop_later(Finalized::Object(self.object));
        }
    }

    /// `msgSend(selector, ...args)`.
    pub fn msg_send(&self, global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
        send(
            global,
            Receiver::Object(&self.object),
            frame,
            "ObjCObject.msgSend()",
        )
    }

    pub fn get_class_name(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        let name = conv::check(global, self.object.class_name())?;
        conv::str_to_js(global, &name)
    }

    pub fn get_address(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        JSValue::from_uint64_no_truncate(global, self.object.address() as u64)
    }

    /// Gives one acquisition back; with the last one goes the reference,
    /// and every later send throws. Idempotent after that.
    pub fn release(&self, _global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        let left = self.acquisitions.get().saturating_sub(1);
        self.acquisitions.set(left);
        if left == 0 {
            self.object.release();
        }
        Ok(JSValue::UNDEFINED)
    }

    pub fn get_released(&self, _global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::js_boolean(self.object.is_released()))
    }

    /// `-description`.
    pub fn to_string(&self, global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        let text = conv::check(global, self.object.description())?;
        conv::utf16_to_js(global, &text)
    }
}

/// One Objective-C class.
#[bun_jsc::JsClass]
pub struct ObjCClass {
    class: DynClass,
}

impl ObjCClass {
    pub fn constructor(_global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<Box<ObjCClass>> {
        Err(_global.throw_illegal_constructor())
    }

    /// The class's one wrapper.
    pub(super) fn wrap(global: &JSGlobalObject, class: DynClass) -> JSValue {
        canonical(global, class.address(), false, || {
            JsClass::to_js(ObjCClass { class }, global)
        })
    }

    pub(super) fn class(&self) -> DynClass {
        self.class
    }

    /// `msgSend(selector, ...args)`, sent to the class object.
    pub fn msg_send(&self, global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
        send(
            global,
            Receiver::Class(&self.class),
            frame,
            "ObjCClass.msgSend()",
        )
    }

    pub fn get_name(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        conv::str_to_js(global, &self.class.name())
    }

    pub fn get_address(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        JSValue::from_uint64_no_truncate(global, self.class.address() as u64)
    }

    pub fn to_string(&self, global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        conv::str_to_js(global, &self.class.name())
    }
}

/// `new ObjCSelector(name)` (`objc.sel(name)`): a selector name marked as
/// one, so it fits a `SEL` argument and nothing else.
#[bun_jsc::JsClass]
pub struct ObjCSelector {
    name: String,
}

impl ObjCSelector {
    pub fn constructor(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<Box<ObjCSelector>> {
        let name = selector_arg(global, frame.argument(0), "objc.sel(name):")?.into_string();
        if name.is_empty() {
            return Err(global.throw_type_error(format_args!(
                "objc.sel(name): name must be a non-empty string"
            )));
        }
        Ok(Box::new(ObjCSelector { name }))
    }

    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub fn get_name(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        conv::str_to_js(global, &self.name)
    }

    pub fn to_string(&self, global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        conv::str_to_js(global, &self.name)
    }
}

/// `objcLookupClass(name)`: the class, or a TypeError naming it.
#[bun_jsc::host_fn]
fn objc_lookup_class(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let name = JsStr::new(global, frame.argument(0), format_args!("class name"))?.to_utf8();
    let class = conv::check(global, dynamic::lookup_class(&name))?;
    Ok(ObjCClass::wrap(global, class))
}

/// `objcJs(value)`: Foundation value objects as plain JavaScript data; any
/// other value (wrapped or not) comes back as it was.
#[bun_jsc::host_fn]
fn objc_js(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let value = frame.argument(0);
    let Some(wrapper) = conv::objc_object(value) else {
        return Ok(value);
    };
    match conv::check(global, wrapper.object.to_plain())? {
        Plain::Other(_) => Ok(value),
        plain => plain_to_js(global, plain),
    }
}

fn plain_to_js(global: &JSGlobalObject, plain: Plain) -> JsResult<JSValue> {
    match plain {
        Plain::Null => Ok(JSValue::NULL),
        Plain::String(text) => conv::utf16_to_js(global, &text),
        Plain::Number(n) => Ok(JSValue::js_number(n)),
        Plain::Integer(n) => conv::i64_to_js(global, n),
        Plain::Unsigned(n) => conv::u64_to_js(global, n),
        Plain::Boolean(b) => Ok(JSValue::js_boolean(b)),
        Plain::Data(bytes) => JSUint8Array::from_bytes(global, bytes.into_boxed_slice()),
        Plain::Date(milliseconds) => Ok(JSValue::from_date_number(global, milliseconds)),
        Plain::Array(items) => JSValue::create_array_from_iter(global, items.into_iter(), |item| {
            plain_to_js(global, item)
        }),
        Plain::Dictionary(entries) => {
            let object = JSValue::create_empty_object(global, entries.len());
            for (key, value) in entries {
                let value = plain_to_js(global, value)?;
                object.put_may_be_index(global, &bun_core::String::clone_utf16(&key), value)?;
            }
            Ok(object)
        }
        Plain::Other(object) => Ok(ObjCObject::wrap(global, object)),
    }
}

/// `objcNs(value)`: the Foundation object for a JavaScript value (`null` for `null`).
#[bun_jsc::host_fn]
fn objc_ns(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    match conv::ns_value(global, frame.argument(0), format_args!("objc.ns()"))? {
        Some(object) => Ok(ObjCObject::wrap(global, object)),
        None => Ok(JSValue::NULL),
    }
}

/// `objcAcquire(handle)`: the same handle, counted as handed out once more
/// (what a result that produces the object does).
#[bun_jsc::host_fn]
fn objc_acquire(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let Some(handle) = conv::objc_object(frame.argument(0)) else {
        return Err(global.throw_type_error(format_args!("objcAcquire: not an ObjCObject")));
    };
    let object = conv::check(global, handle.object().try_clone())?;
    Ok(ObjCObject::wrap(global, object))
}

/// `objcLookupProtocol(name)`: the `Protocol` object as a handle, or a TypeError naming it.
#[bun_jsc::host_fn]
fn objc_lookup_protocol(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let name = JsStr::new(global, frame.argument(0), format_args!("protocol name"))?.to_utf8();
    let protocol = conv::check(global, dynamic::lookup_protocol(&name))?;
    Ok(ObjCObject::wrap(global, protocol))
}

// ─────────────────────────── script-defined classes ───────────────────────────

/// The functions behind one script-defined class, in definition order.
/// Never dropped: the class is registered for the life of the process.
struct JsMethods {
    global: GlobalRef,
    functions: Rc<Roots>,
}

const NO_REPLY: Reply = Reply {
    value: None,
    outs: Vec::new(),
};

impl script::Methods for JsMethods {
    fn call(&self, call: Call<'_>) -> Reply {
        let global = &*self.global;
        let Some(function) = self.functions.get(call.index) else {
            return NO_REPLY;
        };
        let receiver = ObjCObject::lend(global, call.receiver);
        call_js(
            global,
            function,
            receiver,
            call.method,
            call.args,
            call.params,
            call.ret,
        )
    }

    fn report(&self, err: bun_appkit::Error) {
        let global = &*self.global;
        let _ = bun_jsc::task::report_error_or_terminate(global, conv::throw(global, err));
    }
}

/// What `objc.target()` attaches to one instance of [`TARGETS`]: an object
/// whose function-valued properties, named by selector, are the instance's
/// methods. Dropped when the instance deallocates.
struct JsInstance {
    table: Rc<Roots>,
}

/// The methods of `objc.target()`'s one class, whose every instance carries
/// a [`JsInstance`] some thread attached and is called only there.
struct Targets;

/// That class, defined by whichever thread makes a target first.
static TARGETS: std::sync::Mutex<Option<DynClass>> = std::sync::Mutex::new(None);

impl script::Methods for Targets {
    fn call(&self, call: Call<'_>) -> Reply {
        let global = VirtualMachine::get().global();
        let function = match call
            .instance
            .and_then(|data| data.downcast_ref::<JsInstance>())
            .and_then(|instance| instance.table.get(0))
        {
            Some(table) => table
                .get(global, call.selector)
                .map(|f| f.filter(|f| f.is_callable())),
            None => Ok(None),
        };
        let function = match function {
            Ok(Some(function)) => function,
            Ok(None) => return NO_REPLY,
            Err(err) => {
                return Reply {
                    value: returned(global, call.method, call.ret, Err(err)),
                    outs: Vec::new(),
                };
            }
        };
        let receiver = ObjCObject::lend(global, call.receiver);
        call_js(
            global,
            function,
            receiver,
            call.method,
            call.args,
            call.params,
            call.ret,
        )
    }

    fn report(&self, err: bun_appkit::Error) {
        let global = VirtualMachine::get().global();
        let _ = bun_jsc::task::report_error_or_terminate(global, conv::throw(global, err));
    }
}

/// The function behind one block. Dropped when the block's last reference
/// is released.
pub(super) struct JsBlock {
    global: GlobalRef,
    function: Rc<Roots>,
}

impl JsBlock {
    /// A heap block of type `types` that calls `function`, as a handle's object.
    pub(super) fn make(
        global: &JSGlobalObject,
        function: JSValue,
        types: &str,
    ) -> bun_appkit::Result<bun_appkit::DynObject> {
        let handler = Box::new(JsBlock {
            global: GlobalRef::new(global),
            function: Roots::new(global, &[function]),
        });
        block::make(types, handler)
    }
}

impl block::BlockFn for JsBlock {
    fn call(&self, call: block::Call<'_>) -> Reply {
        let Some(function) = self.function.get(0) else {
            return NO_REPLY;
        };
        call_js(
            &self.global,
            function,
            JSValue::UNDEFINED,
            call.method,
            call.args,
            call.params,
            call.ret,
        )
    }

    fn report(&self, err: bun_appkit::Error) {
        let global = &*self.global;
        let _ = bun_jsc::task::report_error_or_terminate(global, conv::throw(global, err));
    }
}

fn string_list(global: &JSGlobalObject, value: JSValue, what: &str) -> JsResult<Vec<String>> {
    let mut out = Vec::new();
    if value.is_undefined_or_null() {
        return Ok(out);
    }
    let mut iter = value.array_iterator(global)?;
    while let Some(item) = iter.next()? {
        out.push(
            JsStr::new(global, item, format_args!("{what}"))?
                .to_utf8()
                .into_string(),
        );
    }
    Ok(out)
}

/// `objcSetHooks(dispatch, outs)`, once, from `internal/objc.ts`: see [`Hooks`].
#[bun_jsc::host_fn]
fn objc_set_hooks(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let (dispatch, outs) = (frame.argument(0), frame.argument(1));
    if !dispatch.is_callable() || !outs.is_array() {
        return Err(global.throw_type_error(format_args!(
            "objcSetHooks: expected a function and an array"
        )));
    }
    // The hooks, the handle table and the script classes are this thread's,
    // and their values belong to the global that loaded the module. When the
    // thread's own global has been replaced (bun test --isolate) the module
    // loads again under the new one and takes them over: the old global is
    // done, its wrappers are forgotten (each object gets a fresh one on next
    // sight) and its hooks dropped. Any other second global on the thread (a
    // ShadowRealm) would mix its objects into a live module's, so it is
    // refused before it can change anything.
    let other = HOOKS.with_borrow(|slot| {
        slot.as_ref()
            .is_some_and(|hooks| !core::ptr::eq::<JSGlobalObject>(&*hooks.global, global))
    });
    if other && !core::ptr::eq::<JSGlobalObject>(VirtualMachine::get().global(), global) {
        return Err(conv::throw(
            global,
            bun_appkit::Error::InvalidState(
                "bun:appkit is loaded by this thread's main global object; another global object on the same thread (a ShadowRealm) cannot use it",
            ),
        ));
    }
    let old = HOOKS.with_borrow_mut(|slot| {
        slot.replace(ManuallyDrop::new(Hooks {
            global: GlobalRef::new(global),
            dispatch: Strong::create(dispatch, global),
            outs: Strong::create(outs, global),
        }))
    });
    if let Some(old) = old {
        drop(ManuallyDrop::into_inner(old));
        if other {
            drop(HANDLES.with_borrow_mut(|handles| core::mem::take(&mut **handles)));
        }
    }
    Ok(JSValue::UNDEFINED)
}

/// A defined method's constant result as `bun:appkit` lets it through: a
/// boolean, a number, a bigint or null.
fn constant_body(global: &JSGlobalObject, value: JSValue, selector: &str) -> JsResult<DynValue> {
    Ok(if value.is_undefined_or_null() {
        DynValue::Nil
    } else if value.is_boolean() {
        DynValue::Bool(value.as_boolean())
    } else if value.is_number() {
        let n = value.as_number();
        if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
            DynValue::I64(n as i64)
        } else {
            DynValue::F64(n)
        }
    } else if let Some(big) = JSBigInt::from_js(value)
        && value.is_big_int_in_int64_range(i64::MIN, i64::MAX)
    {
        DynValue::I64(big.to_int64())
    } else if value.is_big_int() && value.is_big_int_in_uint64_range(0, u64::MAX) {
        DynValue::U64(value.to_uint64_no_truncate())
    } else {
        return Err(global.throw_type_error(format_args!(
            "objc.defineClass(): method {selector} must be a function or a constant (a boolean, a number or null)"
        )));
    })
}

const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

/// `objcDefineClass(name, superclass, protocols, selectors, types, bodies)`:
/// registers the class and returns it. `bun:appkit` has already shaped the
/// arguments; `types[i]` is `undefined` where the encoding is to be looked
/// up, and `bodies[i]` is the method's function or its constant result.
#[bun_jsc::host_fn]
fn objc_define_class(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let name = match frame.argument(0) {
        n if n.is_undefined_or_null() => String::new(),
        n => JsStr::new(global, n, format_args!("objc.defineClass(): name"))?
            .to_utf8()
            .into_string(),
    };
    let superclass = frame.argument(1);
    let superclass = conv::objc_class(superclass)
        .map(ObjCClass::class)
        .or_else(|| conv::objc_object(superclass).and_then(|o| o.object.as_class()));
    let Some(superclass) = superclass else {
        return Err(global.throw_type_error(format_args!(
            "objc.defineClass(): superclass must be a class name or a class handle"
        )));
    };
    let protocols = string_list(global, frame.argument(2), "objc.defineClass(): protocols")?;
    let selectors = string_list(
        global,
        frame.argument(3),
        "objc.defineClass(): method names",
    )?;
    let (types, functions) = (frame.argument(4), frame.argument(5));
    if !types.is_array() || !functions.is_array() {
        return Err(global.throw_type_error(format_args!("objcDefineClass: bad arguments")));
    }
    let mut methods = Vec::with_capacity(selectors.len());
    let mut bodies = Vec::with_capacity(selectors.len());
    for (i, selector) in selectors.into_iter().enumerate() {
        let types = match types.get_index(global, i as u32)? {
            t if t.is_undefined_or_null() => None,
            t => Some(
                JsStr::new(
                    global,
                    t,
                    format_args!("objc.defineClass(): types of {selector}"),
                )?
                .to_utf8()
                .into_string(),
            ),
        };
        let body = functions.get_index(global, i as u32)?;
        let constant = if body.is_callable() {
            bodies.push(body);
            None
        } else {
            Some(constant_body(global, body, &selector)?)
        };
        methods.push(MethodSpec {
            selector,
            types,
            constant,
        });
    }
    let spec = ClassSpec {
        name,
        superclass,
        protocols,
        methods,
        instance_owned: false,
    };
    let handler = Box::new(JsMethods {
        global: GlobalRef::new(global),
        functions: Roots::new(global, &bodies),
    });
    let class = conv::check(global, script::define_class(&spec, handler))?;
    Ok(ObjCClass::wrap(global, class))
}

/// `objcBlock(fn, types)`: a block of that type encoding whose body is `fn`.
#[bun_jsc::host_fn]
fn objc_block(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let (function, types) = (frame.argument(0), frame.argument(1));
    if !function.is_callable() {
        return Err(
            global.throw_type_error(format_args!("objc.block(fn, types): fn must be a function"))
        );
    }
    let types = JsStr::new(global, types, format_args!("objc.block(fn, types): types"))?.to_utf8();
    let block = conv::check(global, JsBlock::make(global, function, &types))?;
    Ok(ObjCObject::wrap(global, block))
}

/// `objcTargetClass()`: the one class every thread's `objc.target()` makes
/// instances of, defined now if no thread has yet. Its `action:` runs, on
/// the thread that attached it, the function in the table [`objc_attach`]
/// gave the instance.
#[bun_jsc::host_fn]
fn objc_target_class(global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
    let mut slot = TARGETS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let class = match *slot {
        Some(class) => class,
        None => {
            let spec = ClassSpec {
                name: String::new(),
                superclass: conv::check(global, dynamic::lookup_class("NSObject"))?,
                protocols: Vec::new(),
                methods: vec![MethodSpec {
                    selector: "action:".into(),
                    types: Some("v@:@".into()),
                    constant: None,
                }],
                instance_owned: true,
            };
            let class = conv::check(global, script::define_class(&spec, Box::new(Targets)))?;
            *slot.insert(class)
        }
    };
    drop(slot);
    Ok(ObjCClass::wrap(global, class))
}

/// `objcAttach(handle, table)`: the functions of one [`TARGETS`] instance,
/// by selector, kept alive by the instance from now until it deallocates
/// and run on this thread.
#[bun_jsc::host_fn]
fn objc_attach(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let (Some(wrapper), table) = (conv::objc_object(frame.argument(0)), frame.argument(1)) else {
        return Err(global.throw_type_error(format_args!("objcAttach: expected an ObjCObject")));
    };
    if !table.is_object() {
        return Err(
            global.throw_type_error(format_args!("objcAttach: expected an object of functions"))
        );
    }
    let data = Box::new(JsInstance {
        table: Roots::new(global, &[table]),
    });
    conv::check(global, script::attach(wrapper.object(), data))?;
    Ok(JSValue::UNDEFINED)
}

/// The receiver a wrapper (or its proxy) stands for; a TypeError for anything else.
fn with_receiver<R>(
    global: &JSGlobalObject,
    value: JSValue,
    what: &str,
    f: impl FnOnce(Receiver<'_>) -> bun_appkit::Result<R>,
) -> JsResult<R> {
    if let Some(o) = conv::objc_object(value) {
        return conv::check(global, f(Receiver::Object(&o.object)));
    }
    if let Some(c) = conv::objc_class(value) {
        return conv::check(global, f(Receiver::Class(&c.class)));
    }
    Err(global.throw_type_error(format_args!("{what}: expected an ObjCObject or ObjCClass")))
}

/// `objcResponds(handle, selector)`: `respondsToSelector:` without sending
/// anything to a proxy or an unsent `alloc`.
#[bun_jsc::host_fn]
fn objc_responds(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let sel = selector_arg(global, frame.argument(1), "objcResponds():")?;
    let responds = with_receiver(global, frame.argument(0), "objcResponds()", |r| {
        r.responds_to(&sel)
    })?;
    Ok(JSValue::js_boolean(responds))
}

/// `objcMethodNames(handle)`: the selectors the receiver's classes implement, for `ownKeys`.
#[bun_jsc::host_fn]
fn objc_method_names(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let names = with_receiver(global, frame.argument(0), "objcMethodNames()", |r| {
        r.method_names()
    })?;
    JSValue::create_array_from_iter(global, names.into_iter(), |name| {
        conv::str_to_js(global, &name)
    })
}

/// `objcIsBlock(handle)`: whether the object is a block.
#[bun_jsc::host_fn]
fn objc_is_block(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let is = match conv::objc_object(frame.argument(0)) {
        Some(o) => conv::check(global, Receiver::Object(&o.object).is_block())?,
        None => false,
    };
    Ok(JSValue::js_boolean(is))
}

/// `objcInvokeBlock(handle, ...args)`: calls the block with `args`, typed
/// by the signature it was compiled with.
#[bun_jsc::host_fn]
fn objc_invoke_block(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let Some(block) = conv::objc_object(frame.argument(0)) else {
        return Err(
            global.throw_type_error(format_args!("objcInvokeBlock: expected an ObjCObject"))
        );
    };
    release_finalized();
    let sig = conv::check(global, dynamic::block_signature(&block.object))?;
    let args = frame.arguments();
    send_as(
        global,
        Receiver::Object(&block.object),
        &sig,
        args.get(1..).unwrap_or_default(),
    )
}

/// `objcConstant(name, types)`: the exported global `name` read as `types`.
#[bun_jsc::host_fn]
fn objc_constant(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let name = JsStr::new(
        global,
        frame.argument(0),
        format_args!("objc.constant(): name"),
    )?;
    let types = JsStr::new(
        global,
        frame.argument(1),
        format_args!("objc.constant(): type"),
    )?;
    let value = conv::check(global, dynamic::constant(&name.to_utf8(), &types.to_utf8()))?;
    conv::dyn_to_js(global, value)
}

/// Adds the classes and functions above to the `createObjcBinding` object;
/// from here on Objective-C exceptions inside sends are errors, this thread
/// is one `bun_appkit` hands its blocks and instances back to, and its half
/// of the bridge is let go when the thread exits ([`retire`]).
pub(super) fn install(global: &JSGlobalObject, binding: JSValue) {
    dynamic::catch_exceptions_with(dynamic::Bun__NSInvocation__tryInvoke);
    let vm = global.bun_vm();
    if handoff::install(Box::new(VmHome(vm.handle()))) {
        vm.as_mut()
            .rare_data()
            .push_cleanup_hook(global, core::ptr::null_mut(), retire);
    }
    binding.put(global, b"ObjCObject", ObjCObject::get_constructor(global));
    binding.put(global, b"ObjCClass", ObjCClass::get_constructor(global));
    binding.put(
        global,
        b"ObjCSelector",
        ObjCSelector::get_constructor(global),
    );
    let functions: [(&str, bun_jsc::JSHostFn, u32); 15] = [
        ("objcLookupClass", __jsc_host_objc_lookup_class, 1),
        ("objcLookupProtocol", __jsc_host_objc_lookup_protocol, 1),
        ("objcJs", __jsc_host_objc_js, 1),
        ("objcNs", __jsc_host_objc_ns, 1),
        ("objcAcquire", __jsc_host_objc_acquire, 1),
        ("objcResponds", __jsc_host_objc_responds, 2),
        ("objcMethodNames", __jsc_host_objc_method_names, 1),
        ("objcConstant", __jsc_host_objc_constant, 2),
        ("objcIsBlock", __jsc_host_objc_is_block, 1),
        ("objcInvokeBlock", __jsc_host_objc_invoke_block, 1),
        ("objcSetHooks", __jsc_host_objc_set_hooks, 2),
        ("objcDefineClass", __jsc_host_objc_define_class, 6),
        ("objcTargetClass", __jsc_host_objc_target_class, 0),
        ("objcAttach", __jsc_host_objc_attach, 2),
        ("objcBlock", __jsc_host_objc_block, 2),
    ];
    for (name, host_fn, arity) in functions {
        binding.put(
            global,
            name,
            JSFunction::create(global, name, host_fn, arity, Default::default()),
        );
    }
}
