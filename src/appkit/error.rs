use crate::Named;

pub type Result<T, E = Error> = core::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A framework or symbol could not be loaded; `.0` is the dlerror text or `symbol <name>`.
    #[error("AppKit could not be loaded: {0}")]
    Load(String),
    /// Called from a thread other than the process main thread.
    #[error(
        "bun:appkit works on the process's main thread only, not in a Worker: AppKit requires it, and the objc bridge keeps its objects, classes and callbacks with the main thread's JavaScript heap"
    )]
    WrongThread,
    /// `-[NSApplication setActivationPolicy:]` answered NO.
    #[error("the activation policy cannot be changed to \"{}\" now", .0.name())]
    ActivationPolicyRefused(crate::app::ActivationPolicy),
    /// Metal could not be loaded or there is no Metal device (`MTLCreateSystemDefaultDevice` gave nil).
    #[error("Metal is not available")]
    NoGpu,
    /// A range does not fit the buffer, texture, slice or render target it addresses.
    #[error("{what} out of bounds: offset {offset} + size {size} exceeds {len}")]
    OutOfBounds {
        what: &'static str,
        len: usize,
        offset: usize,
        size: usize,
    },
    /// A bind slot, attachment index or count is past a fixed Metal limit.
    #[error("{what} {index} is out of range (limit {limit})")]
    IndexOutOfRange {
        what: &'static str,
        index: usize,
        limit: usize,
    },
    /// A length, extent or count that Metal requires to be non-zero.
    #[error("{0} must be greater than zero")]
    ZeroSize(&'static str),
    /// The Metal compiler rejected the source; `message` is its log with line:column locations.
    #[error("shader compilation failed:\n{message}")]
    ShaderCompile { message: String },
    #[error("no shader function named {name:?}; the library has {available:?}")]
    NoSuchFunction {
        name: String,
        available: Vec<String>,
    },
    /// A pipeline could not be built, or does not match the pass it was set on.
    #[error("invalid pipeline: {message}")]
    Pipeline { message: String },
    /// Metal could not create an object or the command buffer finished with an error.
    #[error("GPU execution failed: {message}")]
    GpuExecution { message: String },
    /// `set…Bytes` copies at most 4096 bytes; use a buffer for more.
    #[error("{0} bytes is too large to set inline (limit 4096); use a buffer")]
    InlineBytesTooLarge(usize),
    #[error(
        "texture is not CPU-accessible (private storage or a drawable); render or blit into a readable texture instead"
    )]
    TextureNotReadable,
    #[error("buffer has private storage; the CPU cannot read or write it")]
    BufferNotAccessible,
    /// A frame method was called in the wrong phase (`actual`).
    #[error("frame is {actual}; expected it to be {expected}")]
    FrameState {
        expected: &'static str,
        actual: &'static str,
    },
    #[error("set a pipeline on the pass before drawing or dispatching")]
    NoPipeline,
    /// The view has no drawable to render into this frame.
    #[error("the view has no drawable to render into")]
    NoDrawable,
    /// An operation the object was not created to support; `.0` says which and why.
    #[error("{0}")]
    Unsupported(&'static str),
    /// The object is not in a state where this can be done now; `.0` says which and why.
    #[error("{0}")]
    InvalidState(&'static str),
    /// `objc_getClass` knows no class by this name.
    #[error("objc: no class named {0:?}")]
    NoClass(String),
    /// A class cannot be defined under this name: another class has it, or it contains NUL.
    #[error("objc: cannot define a class named {0:?}: the name is taken or not a valid identifier")]
    ClassName(String),
    /// `objc_getProtocol` knows no protocol by this name.
    #[error("objc: no protocol named {0:?} is registered by the loaded frameworks")]
    NoProtocol(String),
    /// `dlsym` finds no exported global by this name in any loaded image.
    #[error(
        "objc: no constant named {0:?} is exported by AppKit, Foundation or any other library loaded in the process"
    )]
    NoSymbol(String),
    /// The exported global by this name is a function, whose code reading it as a constant would copy.
    #[error("objc: {0} is a function, not a constant; call it through bun:ffi")]
    NotAConstant(String),
    /// The exported global read as `id` does not hold an Objective-C object.
    #[error(
        "objc: the constant {0} does not hold an Objective-C object; pass its C type, as in objc.constant({0:?}, {{ type: \"d\" }}) for a double or {{ type: \"{{CGRect=dddd}}\" }} for a struct"
    )]
    NotAnObject(String),
    /// A script class adopts `protocol` but neither defines nor inherits
    /// these methods it marks `@required`.
    #[error(
        "objc: class {class} adopts {protocol} but does not define {missing}, which the protocol requires"
    )]
    RequiredMethods {
        class: String,
        protocol: String,
        missing: String,
    },
    /// The receiver does not respond to `sel`; `class` names its class and
    /// `instance` picks `-` over `+`.
    #[error("{}[{class} {sel}]: unrecognized selector", if *.instance { '-' } else { '+' })]
    Unrecognized {
        class: String,
        sel: String,
        instance: bool,
    },
    /// `method` is the `-[Class selector]` form.
    #[error("{method}: expected {expected} argument(s), got {got}")]
    ArgCount {
        method: String,
        expected: usize,
        got: usize,
    },
    /// Argument `index` (from 0) cannot be passed as the type the method declares.
    #[error("{method}: argument {index} must be {expected}, got {got}")]
    ArgType {
        method: String,
        index: usize,
        expected: String,
        got: String,
    },
    /// What a script method returned cannot be encoded as the type the method declares.
    #[error("{method}: must return {expected}, got {got}")]
    ReturnType {
        method: String,
        expected: String,
        got: String,
    },
    /// The method's signature uses something the dynamic bridge cannot marshal yet.
    #[error("{method}: {what}")]
    UnsupportedSignature { method: String, what: String },
    /// A block type encoding that does not parse or has no invoke shim; `what` says which.
    #[error("objc: block type encoding {types:?} {what}")]
    BlockSignature { types: String, what: String },
    /// `.0` (`block v@?@`, `-[Class selector]`) was called on another thread,
    /// where the script function behind it cannot run.
    #[error(
        "objc: {0} was called on another thread; its JavaScript function only runs on the main thread, so the caller received 0 / NO / nil"
    )]
    CalledOffMainThread(String),
    /// An `init…` message took ownership of this object; only the object it returned is usable.
    #[error("this object was consumed by init; use the object init returned")]
    Consumed,
    /// The handle is an `alloc()` result that has not been sent an `init…` yet.
    #[error("this object came from alloc(); call an init… method on it first")]
    NotInitialized,
    #[error("ObjCObject has been released")]
    ObjectReleased,
    /// An Objective-C exception raised inside a bridged send. `name` and
    /// `reason` are the `NSException`'s (the class name and `-description`
    /// for anything else thrown), `user_info` its `userInfo` printed, and
    /// `object` what was thrown, unless that was `nil`.
    #[error("{name}: {reason}")]
    Exception {
        name: String,
        reason: String,
        user_info: Option<String>,
        object: Option<crate::DynObject>,
    },
}
