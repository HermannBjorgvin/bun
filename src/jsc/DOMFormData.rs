use core::ffi::c_void;

use crate::{JSGlobalObject, JSValue, JsResult};
use bun_core::ZigString;

bun_opaque::opaque_ffi! {
    /// Opaque FFI handle to WebCore::DOMFormData (C++ side).
    pub struct DOMFormData;
}

unsafe extern "C" {
    safe fn WebCore__DOMFormData__create(arg0: &JSGlobalObject) -> JSValue;
    safe fn WebCore__DOMFormData__createFromURLQuery(
        arg0: &JSGlobalObject,
        arg1: &ZigString,
    ) -> JSValue;
    safe fn WebCore__DOMFormData__fromJS(js_value0: JSValue) -> *mut DOMFormData;
    safe fn WebCore__DOMFormData__append(
        arg0: &mut DOMFormData,
        arg1: &ZigString,
        arg2: &ZigString,
    );
    // safe: `DOMFormData`/`JSGlobalObject` are opaque `UnsafeCell`-backed ZST
    // handles; `&ZigString` is ABI-identical to non-null `*const ZigString` and
    // C++ only reads the named struct via `toStringCopy`. `arg3` is an opaque
    // `*Blob` C++ owns (never dereferenced as Rust data) — same round-trip
    // contract as `Zig__GlobalObject__resetModuleRegistryMap`'s `map` param.
    safe fn WebCore__DOMFormData__appendBlob(
        arg0: &mut DOMFormData,
        arg1: &JSGlobalObject,
        arg2: &ZigString,
        arg3: *mut c_void,
        arg4: &ZigString,
    );
    safe fn WebCore__DOMFormData__count(arg0: &mut DOMFormData) -> usize;
}

impl DOMFormData {
    pub fn create(global: &JSGlobalObject) -> JSValue {
        WebCore__DOMFormData__create(global)
    }

    /// C++ side declares a `THROW_SCOPE` and may throw `ERR_STRING_TOO_LONG`
    /// (returns encoded `JSValue::ZERO` on throw) — wrap in a validation scope
    /// so JSC's `validateExceptionChecks` sees the check before the next scope.
    #[track_caller]
    pub fn create_from_url_query(global: &JSGlobalObject, query: &ZigString) -> JsResult<JSValue> {
        crate::from_js_host_call(global, || {
            WebCore__DOMFormData__createFromURLQuery(global, query)
        })
    }

    pub fn from_js<'a>(value: JSValue) -> Option<&'a mut DOMFormData> {
        // Returned pointer is valid while `value` is kept alive on the stack
        // (conservative GC scan). Null → None. `DOMFormData` is an opaque ZST
        // handle, so `opaque_mut` is the centralised zero-byte deref proof.
        // The unbounded `'a` cannot be expressed more tightly: the cell is
        // GC-owned, so the caller must keep `value` stack-rooted for the
        // lifetime of the returned reference.
        let p = WebCore__DOMFormData__fromJS(value);
        (!p.is_null()).then(|| DOMFormData::opaque_mut(p))
    }

    pub fn append(&mut self, name_: &ZigString, value_: &ZigString) {
        WebCore__DOMFormData__append(self, name_, value_)
    }

    pub fn append_blob(
        &mut self,
        global: &JSGlobalObject,
        name_: &ZigString,
        blob: *mut c_void,
        filename_: &ZigString,
    ) {
        WebCore__DOMFormData__appendBlob(self, global, name_, blob, filename_);
    }

    pub fn count(&mut self) -> usize {
        WebCore__DOMFormData__count(self)
    }
}

/// One `FormData` entry as [`DOMFormData::for_each`] presents it. The
/// strings and the blob belong to the `DOMFormData` and are valid for the
/// callback only.
pub enum FormDataEntry<'a> {
    String(ZigString),
    File {
        blob: &'a crate::webcore_types::Blob,
        filename: ZigString,
    },
}

impl DOMFormData {
    /// Call `f(name, entry)` for every entry, in order. C++ walks its own
    /// list synchronously; nothing is retained past the call. `f` must not
    /// run JS (which could mutate the `FormData` mid-iteration).
    pub fn for_each<F: FnMut(ZigString, FormDataEntry<'_>)>(&mut self, mut f: F) {
        type Thunk = extern "C" fn(*mut c_void, *mut ZigString, *mut c_void, *mut ZigString, u8);
        unsafe extern "C" {
            // safe: `this` is the exclusive borrow; `ctx`/`cb` are only used
            // for the duration of the call.
            safe fn DOMFormData__forEach(this: &mut DOMFormData, ctx: *mut c_void, cb: Thunk);
        }
        extern "C" fn thunk<F: FnMut(ZigString, FormDataEntry<'_>)>(
            ctx: *mut c_void,
            name: *mut ZigString,
            value: *mut c_void,
            filename: *mut ZigString,
            is_blob: u8,
        ) {
            // SAFETY: `ctx` is the `&mut F` passed below, live for this
            // synchronous callback; `name` (and `filename` when non-null) point
            // at stack `ZigString`s in `DOMFormData__forEach`; `value` is a
            // `ZigString*` for string entries and the entry's `JSBlob::m_ctx`
            // (`Blob*`, alive with the entry) for file entries.
            unsafe {
                let f = &mut *ctx.cast::<F>();
                let entry = if is_blob == 0 {
                    FormDataEntry::String(*value.cast::<ZigString>())
                } else {
                    FormDataEntry::File {
                        blob: &*value.cast::<crate::webcore_types::Blob>(),
                        filename: if filename.is_null() {
                            ZigString::EMPTY
                        } else {
                            *filename
                        },
                    }
                };
                f(*name, entry);
            }
        }
        DOMFormData__forEach(self, (&raw mut f).cast::<c_void>(), thunk::<F>);
    }
}
