// The one catch frame around Objective-C in bun: `-[NSInvocation
// invokeWithTarget:]` under try, so an exception raised inside the method
// comes back to Bun.AppKit's bridge (src/appkit/objc/dynamic.rs) as a value
// instead of ending the process. Plain C++ so that bun links no Objective-C
// runtime and carries no Objective-C image info: the bridge loads the runtime
// itself and hands this frame the entry points it needs. An Objective-C
// exception is a C++ exception whose type_info sits inside the thrown buffer
// right after the `id` (objc4's `struct objc_exception`), which is how the
// object is recovered here and in ZigGlobalObject.cpp's terminate handler.

#include <cxxabi.h>
#include <typeinfo>

using Send = void (*)(void* receiver, void* selector, void* argument);
using Retain = void* (*)(void* object);

/// Sends [invocation invokeWithTarget:target] through `msgSend`. On an
/// Objective-C exception, stores what was thrown (usually an NSException) in
/// *exception with a +1 reference from `retain` that the caller releases, and
/// returns false. Anything else thrown keeps unwinding.
extern "C" bool Bun__NSInvocation__tryInvoke(Send msgSend, Retain retain, void* invocation, void* invokeWithTarget, void* target, void** exception)
{
    // Release builds strip __TEXT,__unwind_info, and ld64.lld drops a
    // frame's DWARF FDE whenever it can encode the frame compactly, which
    // would leave this catch frame nowhere. Compact unwind cannot describe
    // CFI it does not model, so these two no-op directives make the compiler
    // mark the frame DWARF-only on every architecture: the FDE stays in
    // __eh_frame and libunwind finds it there.
    __asm__ volatile(".cfi_remember_state\n\t.cfi_restore_state");
    try {
        msgSend(invocation, invokeWithTarget, target);
        return true;
    } catch (...) {
        const std::type_info* type = abi::__cxa_current_exception_type();
        void* thrown = abi::__cxa_current_primary_exception();
        bool objc = type && thrown && reinterpret_cast<const char*>(type) == static_cast<const char*>(thrown) + sizeof(void*);
        void* object = objc ? *static_cast<void**>(thrown) : nullptr;
        if (thrown)
            abi::__cxa_decrement_exception_refcount(thrown);
        if (!objc)
            throw;
        *exception = object ? retain(object) : nullptr;
        return false;
    }
}
