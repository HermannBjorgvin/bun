//! Objective-C classes defined at run time so AppKit has something to call:
//! the application delegate and an `MTKViewDelegate`. Delegate instances
//! carry one `owner` ivar pointing at a reference-counted Rust trait object;
//! the `extern "C"` IMPs below do nothing but forward.

use std::sync::OnceLock;

use super::{Bool, ClassBuilder, Delegate, DelegateClass, Obj, Sel, This, sel};
use crate::geometry::Size;
use crate::objc::foundation::NSObject;

/// What the application delegate reports. All methods run on the main thread
/// inside AppKit event dispatch.
pub(crate) trait AppEvents {
    /// `applicationShouldTerminate:`: true lets AppKit terminate (it then
    /// sends `applicationWillTerminate:` and exits), false cancels.
    fn terminate_requested(&self) -> bool;
    /// `applicationWillTerminate:`: the last callout before AppKit's `exit`.
    fn will_terminate(&self);
    fn did_finish_launching(&self);
    /// `applicationShouldHandleReopen:hasVisibleWindows:` — the Dock icon was clicked while running.
    fn reopened(&self, has_visible_windows: bool);
}

/// `MTKViewDelegate`. Both run on the main thread: from the view's display
/// timer inside AppKit event dispatch, or synchronously from `-[MTKView draw]`.
pub(crate) trait MetalViewEvents {
    /// `drawInMTKView:`.
    fn draw(&self);
    /// `mtkView:drawableSizeWillChange:`, in pixels.
    fn drawable_size_will_change(&self, size: Size);
}

// SAFETY (every `.method(...)` below): each IMP's signature transcribes the
// named protocol's (or overridden superclass's) declaration of that selector,
// which debug builds assert.

fn app_class() -> &'static DelegateClass<dyn AppEvents> {
    static CLASS: OnceLock<DelegateClass<dyn AppEvents>> = OnceLock::new();
    // SAFETY: see above.
    CLASS.get_or_init(|| unsafe {
        ClassBuilder::<NSObject>::new(c"BunAppKitAppDelegate")
            .owned::<dyn AppEvents>()
            .protocol(c"NSApplicationDelegate")
            .method(
                sel!("applicationShouldTerminate:"),
                app_should_terminate as extern "C" fn(App, Sel, Obj) -> usize,
            )
            .method(
                sel!("applicationWillTerminate:"),
                app_will_terminate as extern "C" fn(App, Sel, Obj),
            )
            .method(
                sel!("applicationShouldTerminateAfterLastWindowClosed:"),
                app_no as extern "C" fn(App, Sel, Obj) -> Bool,
            )
            .method(
                sel!("applicationDidFinishLaunching:"),
                app_did_finish_launching as extern "C" fn(App, Sel, Obj),
            )
            .method(
                sel!("applicationShouldHandleReopen:hasVisibleWindows:"),
                app_reopen as extern "C" fn(App, Sel, Obj, Bool) -> Bool,
            )
            .method(
                sel!("applicationSupportsSecureRestorableState:"),
                app_yes as extern "C" fn(App, Sel, Obj) -> Bool,
            )
            .register()
    })
}

fn metal_view_class() -> &'static DelegateClass<dyn MetalViewEvents> {
    static CLASS: OnceLock<DelegateClass<dyn MetalViewEvents>> = OnceLock::new();
    // SAFETY: see above; `MTKViewDelegate` (MTKView.h) declares
    // `drawInMTKView:(MTKView *)` and `mtkView:(MTKView *) drawableSizeWillChange:(CGSize)`.
    CLASS.get_or_init(|| unsafe {
        ClassBuilder::<NSObject>::new(c"BunAppKitMetalDelegate")
            .owned::<dyn MetalViewEvents>()
            .protocol(c"MTKViewDelegate")
            .method(
                sel!("drawInMTKView:"),
                mtk_draw as extern "C" fn(Mtk, Sel, Obj),
            )
            .method(
                sel!("mtkView:drawableSizeWillChange:"),
                mtk_drawable_size_will_change as extern "C" fn(Mtk, Sel, Obj, Size),
            )
            .register()
    })
}

/// Registers every class this file defines, so the check of each IMP
/// against its protocol or superclass declaration runs now.
pub(super) fn register_all() {
    app_class();
    metal_view_class();
}

impl Delegate<dyn AppEvents> {
    pub(crate) fn app(handler: Box<dyn AppEvents>) -> Self {
        Delegate::new(app_class(), handler)
    }
}

impl Delegate<dyn MetalViewEvents> {
    pub(crate) fn metal_view(handler: Box<dyn MetalViewEvents>) -> Self {
        Delegate::new(metal_view_class(), handler)
    }
}

type App = This<dyn AppEvents>;
type Mtk = This<dyn MetalViewEvents>;

// SAFETY (app/mtk): each `*_class()` above is the only
// `DelegateClass` for its handler, so a `This<H>` can only have come from an
// IMP registered on it. AppKit calls on the main thread; `dispatch` handles a
// cleared owner.

fn app<R>(this: App, f: impl FnOnce(&(dyn AppEvents + 'static)) -> R) -> Option<R> {
    // SAFETY: see above.
    unsafe { app_class().dispatch(this, f) }
}
fn mtk<R>(this: Mtk, f: impl FnOnce(&(dyn MetalViewEvents + 'static)) -> R) -> Option<R> {
    // SAFETY: see above.
    unsafe { metal_view_class().dispatch(this, f) }
}

extern "C" fn app_should_terminate(this: App, _: Sel, _sender: Obj) -> usize {
    // NSTerminateNow / NSTerminateCancel
    usize::from(app(this, |h| h.terminate_requested()).unwrap_or(false))
}
extern "C" fn app_will_terminate(this: App, _: Sel, _note: Obj) {
    let _ = app(this, |h| h.will_terminate());
}
extern "C" fn app_no(_: App, _: Sel, _: Obj) -> Bool {
    Bool::NO
}
extern "C" fn app_yes(_: App, _: Sel, _: Obj) -> Bool {
    Bool::YES
}
extern "C" fn app_did_finish_launching(this: App, _: Sel, _note: Obj) {
    let _ = app(this, |h| h.did_finish_launching());
}
extern "C" fn app_reopen(this: App, _: Sel, _sender: Obj, visible: Bool) -> Bool {
    let _ = app(this, |h| h.reopened(visible.get()));
    Bool::YES
}
extern "C" fn mtk_draw(this: Mtk, _: Sel, _view: Obj) {
    let _ = mtk(this, |h| h.draw());
}
extern "C" fn mtk_drawable_size_will_change(this: Mtk, _: Sel, _view: Obj, size: Size) {
    let _ = mtk(this, |h| h.drawable_size_will_change(size));
}
