//! The `AppKitApp` singleton and its per-thread state: whether AppKit is up,
//! and the keep-alive that holds the process open while windows are.

use core::cell::{Cell, RefCell};
use std::rc::Rc;

use bun_appkit::app::LoopHooks;
use bun_appkit::{ActivationPolicy, App, AppSink};
use bun_core::Timespec;
use bun_io::KeepAlive;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult};

use super::conv::{self, JsStr};
use super::slots::JsSlots;

use crate::generated_classes::js_AppKitApp as js;

struct State {
    keep_alive: RefCell<KeepAlive>,
    windows: Cell<usize>,
    /// `app.keepAlive`: hold the process even with no window open.
    keep_flag: Cell<bool>,
    /// A quit passed every veto; the process exits at the next loop turn.
    quit_requested: Cell<bool>,
}

thread_local! {
    static STATE: State = State {
        keep_alive: RefCell::new(KeepAlive::init()),
        windows: Cell::new(0),
        keep_flag: Cell::new(false),
        quit_requested: Cell::new(false),
    };
}

/// Holds the process open, and App Nap off, exactly while a window is open,
/// `app.keepAlive` is set, or an accepted quit is waiting for the next loop
/// turn to exit.
fn sync_keep_alive(state: &State) {
    let wanted = state.windows.get() > 0 || state.keep_flag.get() || state.quit_requested.get();
    let mut keep_alive = state.keep_alive.borrow_mut();
    if wanted {
        keep_alive.ref_(bun_io::js_vm_ctx());
    } else {
        keep_alive.unref(bun_io::js_vm_ctx());
    }
    if let Some(app) = App::get() {
        app.set_responsive(wanted);
    }
}

/// `bun:appkit` reports how many of its windows are open.
fn set_windows(count: usize) {
    STATE.with(|state| {
        state.windows.set(count);
        sync_keep_alive(state);
    });
}

fn set_keep_flag(on: bool) {
    STATE.with(|state| {
        state.keep_flag.set(on);
        sync_keep_alive(state);
    });
}

/// The running application, or a JavaScript error if `bun:appkit` has not
/// started it on this thread yet.
pub(super) fn started(global: &JSGlobalObject) -> JsResult<&'static App> {
    App::get().ok_or_else(|| {
        global.throw(format_args!(
            "the AppKit application has not been started on this thread"
        ))
    })
}

/// [`LoopHooks::next_due`]: zero while tasks or immediates are queued,
/// otherwise the time to the earliest armed timer (either heap) or QUIC
/// tick. Peeks only; runs nothing.
fn next_due() -> Option<Timespec> {
    let vm = VirtualMachine::get();
    let event_loop = vm.event_loop_mut();
    let has_pending = !event_loop.immediate_tasks.is_empty()
        || !event_loop.next_immediate_tasks.is_empty()
        || event_loop.has_pending_tasks();
    let quic_next_tick_us = {
        let ild = &vm.uws_loop_mut().internal_loop_data;
        (!ild.quic_head.is_null()).then_some(ild.quic_next_tick_us)
    };
    crate::jsc_hooks::timer_all_mut().peek_next_due(has_pending, quic_next_tick_us)
}

/// [`LoopHooks::outermost`]: no JavaScript frame is on the stack (so no
/// native code JavaScript called into can be holding an autorelease pool
/// across this park), and the loop is not inside `EventLoop::enter`.
fn outermost() -> bool {
    let vm = VirtualMachine::get();
    !vm.jsc_vm().is_entered() && vm.event_loop_mut().entered_event_loop_count == 0
}

/// [`LoopHooks::exit_if_requested`]: a quit that got past `beforequit` and
/// every `shouldClose` ends the process here, at the top of a loop turn, so no
/// AppKit frame is on the stack while exit handlers and finalizers run.
fn exit_if_requested() {
    if STATE.with(|state| state.quit_requested.get()) {
        exit_now();
    }
}

/// `process.exit(process.exitCode)`.
fn exit_now() {
    let global = VirtualMachine::get().global();
    let code = global.bun_vm().as_mut().exit_handler.exit_code;
    crate::node::process::exit(global, code);
}

struct Events {
    slots: Rc<JsSlots>,
}

impl AppSink for Events {
    fn before_quit(&self) -> bool {
        self.slots.allows(js::on_before_quit_get_cached, &[])
    }

    fn close_all(&self) -> bool {
        self.slots.allows(js::on_close_all_get_cached, &[])
    }

    fn quit(&self) {
        STATE.with(|state| {
            state.quit_requested.set(true);
            sync_keep_alive(state);
        });
        VirtualMachine::get().event_loop_mut().wakeup();
    }

    fn exit_now(&self) {
        exit_now();
    }

    fn reopened(&self, has_visible_windows: bool) {
        self.slots.call(
            js::on_reopen_get_cached,
            &[JSValue::js_boolean(has_visible_windows)],
        );
    }
}

/// `app` in `bun:appkit`: NSApplication lifecycle and Dock badge.
#[bun_jsc::JsClass(no_constructor)]
pub struct AppKitApp {
    slots: Rc<JsSlots>,
}

impl AppKitApp {
    /// Creates the singleton and its JavaScript wrapper.
    pub(super) fn create(global: &JSGlobalObject) -> JSValue {
        let slots = Rc::new(JsSlots::empty(global));
        let app = AppKitApp {
            slots: Rc::clone(&slots),
        };
        let value = bun_jsc::JsClass::to_js(app, global);
        slots.bind(value, global);
        value
    }

    /// Brings AppKit up with `policy` (default `"regular"`) and routes its events to this
    /// object's slots. A second call only re-routes the events (the module
    /// loaded again under a replaced global object finds AppKit already up).
    pub fn start(&self, global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
        let arg = frame.argument(0);
        let policy = if arg.is_undefined_or_null() {
            ActivationPolicy::Regular
        } else {
            conv::activation_policy(global, arg)?
        };
        let app = match App::get() {
            Some(app) => app,
            None => {
                let loop_ = global.bun_vm().uws_loop_mut();
                let hooks = LoopHooks {
                    next_due,
                    outermost,
                    exit_if_requested,
                };
                conv::check(global, App::start(loop_, hooks, policy))?
            }
        };
        app.set_sink(Box::new(Events {
            slots: Rc::clone(&self.slots),
        }));
        STATE.with(sync_keep_alive);
        Ok(JSValue::UNDEFINED)
    }

    /// Before the application has started there is nothing to ask, so this
    /// is `process.exit()` with the current `process.exitCode`.
    pub fn quit(&self, _global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        match App::get() {
            Some(app) => {
                app.request_quit();
            }
            None => exit_now(),
        }
        Ok(JSValue::UNDEFINED)
    }

    /// Hooks for `bun:internal-for-testing`; `op` picks one.
    pub fn testing(&self, global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
        let op = JsStr::new(global, frame.argument(0), format_args!("op"))?.to_utf8();
        match op.as_str() {
            // Every compiled Objective-C binding checked against the loaded
            // frameworks; one string per mismatch.
            "verifyBindings" => {
                let problems = conv::check(global, bun_appkit::verify_bindings())?;
                let array = JSValue::create_empty_array(global, problems.len())?;
                for (i, p) in problems.iter().enumerate() {
                    let s = bun_jsc::StringJsc::to_js(
                        &bun_core::String::clone_utf8(p.as_bytes()),
                        global,
                    )?;
                    array.put_index(global, i as u32, s)?;
                }
                Ok(array)
            }
            // Runs `callback` after `ms` from inside AppKit's wait rather than
            // from Bun's timer heap, like a display timer or an Apple Event.
            "runInsideWait" => {
                let app = started(global)?;
                let ms = conv::number(global, frame.argument(1), format_args!("ms"))?;
                let callback = frame.argument(2);
                if !callback.is_callable() {
                    return Err(
                        global.throw_invalid_arguments(format_args!("callback must be a function"))
                    );
                }
                let callback = bun_jsc::Strong::create(callback, global);
                app.run_after(
                    ms / 1000.0,
                    Box::new(move || {
                        let global = VirtualMachine::get().global();
                        let _ = global.bun_vm().event_loop_mut().run_callback_with_result(
                            callback.get(),
                            global,
                            JSValue::UNDEFINED,
                            &[],
                        );
                    }),
                );
                Ok(JSValue::UNDEFINED)
            }
            // `-[NSApplication terminate:]`, the path the Quit menu item, the
            // Dock and a logout take.
            "terminate" => {
                started(global)?.terminate();
                Ok(JSValue::UNDEFINED)
            }
            other => {
                Err(global.throw_invalid_arguments(format_args!("unknown testing op \"{other}\"")))
            }
        }
    }

    pub fn activate(&self, global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        started(global)?.activate();
        Ok(JSValue::UNDEFINED)
    }

    pub fn hide(&self, _global: &JSGlobalObject, _frame: &CallFrame) -> JsResult<JSValue> {
        if let Some(app) = App::get() {
            app.hide();
        }
        Ok(JSValue::UNDEFINED)
    }

    pub fn set(&self, global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
        let key = JsStr::new(global, frame.argument(0), format_args!("key"))?.to_utf8();
        let value = frame.argument(1);
        match key.as_str() {
            "keepAlive" => {
                set_keep_flag(conv::boolean(global, value, format_args!("app.keepAlive"))?)
            }
            "windows" => {
                let count = conv::number(global, value, format_args!("app.windows"))?;
                set_windows(count.max(0.0) as usize);
            }
            "activationPolicy" => {
                let policy = conv::activation_policy(global, value)?;
                conv::check(global, started(global)?.set_activation_policy(policy))?;
            }
            "badge" => {
                let app = started(global)?;
                let text = if value.is_number() {
                    Some(JsStr::coerce(global, value)?)
                } else {
                    conv::optional_string(global, value, format_args!("app.badge"))?
                };
                app.set_badge(&text.map(|t| t.to_utf8()).unwrap_or_default());
            }
            other => {
                return Err(
                    global.throw_invalid_arguments(format_args!("app has no property \"{other}\""))
                );
            }
        }
        Ok(JSValue::UNDEFINED)
    }

    pub fn get_is_dark(&self, _global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::js_boolean(App::get().is_some_and(App::is_dark)))
    }

    /// Answers without starting the application.
    pub fn get_has_display(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::js_boolean(conv::check(
            global,
            App::query_display(),
        )?))
    }

    /// Event slots start empty; JavaScript assigns them and the cached
    /// value is what gets read back.
    pub fn get_on_before_quit(&self, _global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::UNDEFINED)
    }

    pub fn get_on_close_all(&self, _global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::UNDEFINED)
    }

    pub fn get_on_reopen(&self, _global: &JSGlobalObject) -> JsResult<JSValue> {
        Ok(JSValue::UNDEFINED)
    }
}

impl Drop for AppKitApp {
    fn drop(&mut self) {
        self.slots.finalize();
    }
}
