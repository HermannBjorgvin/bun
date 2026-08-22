//! Handing the main thread what reaches this crate on another one: values a
//! script owns that were let go there (a block, or an instance carrying
//! script data, released for the last time by a background queue), which
//! may only be dropped on the main thread; and word that a script function
//! was called where it cannot run. How the main thread is reached is up to
//! whoever embeds the crate ([`post_with`]); until then values queue up and
//! reports go nowhere.

use core::ptr::null_mut;
use core::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;

use super::is_main_thread;

/// What the main thread is asked to do.
pub enum Post {
    /// Call [`free_deferred`].
    FreeDeferred,
    /// Report that this (`block v@?@`, `-[Class selector]`) was called on
    /// another thread, where the script function behind it cannot run, so
    /// its caller was given zero.
    WrongThread(String),
}

static POST: OnceLock<fn(Post)> = OnceLock::new();

/// How a [`Post`] made on any thread reaches the main thread from now on.
/// Takes effect (answering `true`) once, and only from the main thread.
pub fn post_with(post: fn(Post)) -> bool {
    is_main_thread() && POST.set(post).is_ok()
}

fn post(what: Post) {
    if let Some(post) = POST.get() {
        post(what);
    }
}

pub(super) fn wrong_thread(what: String) {
    post(Post::WrongThread(what));
}

/// One value waiting to be dropped on the main thread.
struct Deferred {
    next: *mut Deferred,
    value: *mut (),
    free: unsafe fn(*mut ()),
}

/// Pushed from any thread; taken whole by the main thread.
static DEFERRED: AtomicPtr<Deferred> = AtomicPtr::new(null_mut());

/// Frees `value` on the main thread: right away if this is it, otherwise
/// once the main thread answers the [`Post::FreeDeferred`] this sends.
///
/// # Safety
/// `value` came from `bun_core::heap::into_raw` and nothing else frees it.
pub(super) unsafe fn free_on_main_thread<T>(value: *mut T) {
    /// # Safety
    /// As the enclosing function, for a `T`.
    unsafe fn free<T>(value: *mut ()) {
        // SAFETY: per contract.
        drop(unsafe { bun_core::heap::take(value.cast::<T>()) });
    }
    if is_main_thread() {
        // SAFETY: per contract.
        return unsafe { free::<T>(value.cast()) };
    }
    let node = bun_core::heap::into_raw(Box::new(Deferred {
        next: null_mut(),
        value: value.cast(),
        free: free::<T>,
    }));
    let mut head = DEFERRED.load(Ordering::Relaxed);
    loop {
        // SAFETY: just allocated; only this thread sees it until the exchange.
        unsafe { (*node).next = head };
        match DEFERRED.compare_exchange_weak(head, node, Ordering::Release, Ordering::Relaxed) {
            Ok(_) => break,
            Err(current) => head = current,
        }
    }
    post(Post::FreeDeferred);
}

/// Frees what other threads have handed over. Main thread only.
pub fn free_deferred() {
    if !is_main_thread() {
        return;
    }
    let mut node = DEFERRED.swap(null_mut(), Ordering::Acquire);
    while !node.is_null() {
        // SAFETY: a node `free_on_main_thread` published, off the list now so
        // nothing else reaches it; its `free` matches its `value`.
        unsafe {
            let deferred = bun_core::heap::take(node);
            (deferred.free)(deferred.value);
            node = deferred.next;
        }
    }
}
