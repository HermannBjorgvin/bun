//! The native side of `Bun.AppKit`: the Objective-C bridge ([`dynamic`],
//! [`script`], [`block`]) that `bun:appkit` builds its windows, menus and
//! views with, the `NSApplication` lifecycle ([`app`]), the Metal view and
//! [`gpu`], and the run-loop integration underneath them.
//!
//! This crate talks to AppKit through the Objective-C runtime, which it
//! `dlopen`s on first use so that nothing is linked into `bun` at startup.
//! It never names a JavaScript type: `bun_runtime` converts JS values into
//! the calls defined here and receives events back through the sink traits.
//!
//! Everything runs on the main thread, which is both the JavaScript thread
//! and the AppKit main thread; [`run_loop`] is what lets the two event loops
//! share it. Raw Objective-C and CoreFoundation calls live only in [`objc`]
//! and [`run_loop`]; `unsafe_code` is forbidden in every other module, and
//! every way `objc` offers to name a raw pointer, wrap an arbitrary object in
//! a typed wrapper, register a method implementation or allocate a protocol
//! type is an `unsafe fn` or private to it.
#![cfg(target_os = "macos")]
#![deny(unsafe_code)]

#[forbid(unsafe_code)]
mod named;
pub use named::Named;
pub(crate) use named::named_enum;

#[forbid(unsafe_code)]
pub mod app;
#[forbid(unsafe_code)]
pub mod error;
#[forbid(unsafe_code)]
pub mod geometry;
#[forbid(unsafe_code)]
pub mod gpu;
#[allow(unsafe_code)]
pub(crate) mod objc;
#[allow(unsafe_code)]
pub(crate) mod run_loop;
#[forbid(unsafe_code)]
pub mod view;

pub use app::{ActivationPolicy, App, AppSink};
pub use error::{Error, Result};
pub use gpu::{Gpu, Storage};
pub use objc::NsStr;
/// Blocks whose body is a script function: `objc.block` in `bun:appkit`.
pub use objc::block;
/// Run-time (selector-by-name) messaging: `objc.classes`, `msgSend` and
/// `.native` in `bun:appkit`.
pub use objc::dynamic;
/// What other threads hand the main thread, and how it is reached.
pub use objc::handoff;
/// Classes whose methods are script functions: `objc.defineClass` and
/// `objc.target` in `bun:appkit`.
pub use objc::script;
pub use objc::{DynClass, DynObject, DynValue};
pub use view::{MetalSurface, PIXEL_FORMAT, View, ViewSink};

/// Loads AppKit and Metal and checks every Objective-C binding compiled into
/// this build against the frameworks on this machine: the class or protocol
/// exists, it declares the selector, and its type encoding matches the Rust
/// signature; and every method of the classes this crate registers matches
/// its protocol or superclass declaration. Returns one line per mismatch;
/// empty means they agree.
pub fn verify_bindings() -> Result<Vec<String>> {
    objc::verify_bindings()
}
