use core::cell::Cell;
use core::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
use std::sync::Arc;

use bun_core::MutableString;
use bun_event_loop::ConcurrentTask::ConcurrentTask;
use bun_event_loop::{ReusableConcurrentTask, Task, TaskHop, TaskTag, task_tag};
use bun_http::{HTTPClientResult, HTTPClientResultHandler, InFlight};
use bun_io::KeepAlive;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{GlobalRef, InFlightTicket, JsCell};
use bun_ptr::{RefPtr, ThisPtr};
use bun_s3_signing::error::S3Error;
use bun_threading::Guarded;

use crate::webcore::readable_stream::Strong as ReadableStreamStrong;
use crate::webcore::s3::client::s3_error_to_js;
use crate::webcore::s3::simple_request::RequestStorage;
use crate::webcore::s3::xml_response;

bun_core::declare_scope!(S3, hidden);

/// What the HTTP thread has buffered for the next progress report.
#[derive(Default)]
struct Progress {
    buffer: MutableString,
    /// The HTTP-level failure, if any; the `request_error` bit in
    /// [`DownloadShared::state`] mirrors `request_error.is_some()`.
    request_error: Option<bun_http::Error>,
}

/// The part of a streaming download shared with the HTTP thread: `bun_http`
/// holds it (as the request's result handler) until the terminal result; the
/// task and its sink's abort handle for their whole life.
pub(crate) struct DownloadShared {
    progress: Guarded<Progress>,
    state: AtomicU64,
    /// A progress hop is queued on the JS thread and has not run yet; set by
    /// the HTTP thread (compare-exchange, under `progress`' lock) and cleared
    /// by `on_response` under the same lock.
    has_schedule_callback: AtomicBool,
    /// The HTTP client's abort flag: set by a stream cancel or the VM's stop
    /// phase so the request fails promptly and comes back.
    signal_store: bun_http::signals::Store,
    /// The task's address for the JS-thread hops; set once, before the request
    /// is scheduled. The task keeps itself alive for them (`http_ref`).
    task: AtomicPtr<S3HttpDownloadStreamingTask>,
    /// The progress hop's queue node (at most one is queued at a time:
    /// `has_schedule_callback`).
    node: ReusableConcurrentTask,
    /// How the HTTP thread posts to the JS thread, and what makes the VM wait
    /// for it; handed back after the terminal result.
    ticket: InFlightTicket,
}

impl DownloadShared {
    pub(crate) fn get_state(&self) -> State {
        State(self.state.load(Ordering::Acquire))
    }

    pub(crate) fn set_state(&self, state: State) {
        self.state.store(state.0, Ordering::Relaxed);
    }

    fn post_progress(&self) {
        let task = Task::new(
            task_tag::S3HttpDownloadStreamingTask,
            self.task.load(Ordering::Acquire).cast::<()>(),
        );
        // `has_schedule_callback` was clear, so the previous hop has run and its
        // node was consumed; the heap node is only a fallback.
        let node = self
            .node
            .arm(task)
            .unwrap_or_else(|| ConcurrentTask::create(task));
        self.ticket.post(node);
    }

    /// HTTP thread, `progress` locked: fold `result`'s status into `state`.
    /// Returns whether reporting should wait until the body is fully buffered
    /// (an error or non-2xx status).
    fn update_state(
        &self,
        progress: &mut Progress,
        result: &HTTPClientResult,
        state: &mut State,
    ) -> bool {
        let is_done = !result.has_more;
        state.set_has_more(!is_done);

        progress.request_error = result.fail;
        state.set_request_error(if result.fail.is_some() { 1 } else { 0 });
        if state.status_code() == 0 {
            if let Some(m) = &result.metadata {
                state.set_status_code(m.response.status_code);
            }
        }
        let wait_until_done = match state.status_code() {
            200 | 204 | 206 => state.request_error() != 0,
            _ => true,
        };
        self.set_state(*state);
        wait_until_done
    }

    /// HTTP thread: buffer `result` and decide whether a progress hop should
    /// be posted for it.
    fn process_http_callback(&self, mut result: HTTPClientResult) -> bool {
        // Locked so the JS thread never observes the state mid-update.
        let mut progress = self.progress.lock();

        let mut state = self.get_state();
        // old state should have more otherwise it's an HTTP-client bug
        debug_assert!(state.has_more());
        let is_done = !result.has_more;
        let wait_until_done = self.update_state(&mut progress, &result, &mut state);
        let should_enqueue = !wait_until_done || is_done;
        bun_core::scoped_log!(
            S3,
            "state err: {} status_code: {} has_more: {} should_enqueue: {}",
            state.request_error(),
            state.status_code(),
            state.has_more(),
            should_enqueue
        );

        result.body_into(&mut progress.buffer.list);
        if should_enqueue {
            if progress.buffer.list.is_empty() && !is_done {
                return false;
            }
            if let Err(has_schedule_callback) = self.has_schedule_callback.compare_exchange(
                false,
                true,
                Ordering::Acquire,
                Ordering::Relaxed,
            ) {
                if has_schedule_callback {
                    return false;
                }
            }
            return true;
        }
        false
    }
}

impl HTTPClientResultHandler for DownloadShared {
    fn on_result(&self, result: HTTPClientResult<'_>) {
        let is_done = !result.has_more;
        if self.process_http_callback(result) {
            self.post_progress();
        }
        if is_done {
            self.ticket.hand_back();
        }
    }

    /// The exiting main thread parked the HTTP thread, which will not call
    /// back; hand the download back as failed/finished so its VM's wait ends
    /// and the JS thread releases it.
    fn release_at_shutdown(&self) {
        let should_enqueue = {
            let mut progress = self.progress.lock();
            let mut state = self.get_state();
            state.set_has_more(false);
            progress.request_error = Some(bun_http::Error::Aborted);
            state.set_request_error(1);
            self.set_state(state);
            self.has_schedule_callback
                .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_ok()
        };
        if should_enqueue {
            self.post_progress();
        }
        self.ticket.hand_back();
    }
}

/// A streaming S3 download (`s3file.stream()` / `readable`). Lives on the JS
/// thread; the HTTP thread only sees [`DownloadShared`].
#[derive(bun_ptr::CellRefCounted)]
pub struct S3HttpDownloadStreamingTask {
    ref_count: Cell<u32>,
    /// The ref the progress hops (and the teardown registry) reach this task
    /// through; released by the hop that sees `has_more == false`.
    http_ref: Cell<Option<RefPtr<S3HttpDownloadStreamingTask>>>,
    shared: Arc<DownloadShared>,
    /// The request out on (or back from) the HTTP thread; taken back on drop.
    request: InFlight<RequestStorage>,
    /// Where the body goes.
    sink: bun_ptr::OwnedThis<S3DownloadStreamWrapper>,
    poll_ref: KeepAlive,
}

/// `task_tag::S3HttpDownloadStreamingTask`: the HTTP thread has body bytes
/// (or the end of the download) for the JS thread.
pub struct ProgressHop;
impl TaskHop for ProgressHop {
    type Target = S3HttpDownloadStreamingTask;
    const TAG: TaskTag = task_tag::S3HttpDownloadStreamingTask;
    fn run(this: ThisPtr<S3HttpDownloadStreamingTask>) -> bun_jsc::JsResult<()> {
        S3HttpDownloadStreamingTask::on_response(this);
        Ok(())
    }
    /// As `S3HttpSimpleTask`: the completion is what releases the sink; run it.
    fn release_unrun(this: ThisPtr<S3HttpDownloadStreamingTask>) {
        S3HttpDownloadStreamingTask::on_response(this);
    }
}

impl S3HttpDownloadStreamingTask {
    fn report_progress(&self, state: State, mut progress: Progress) {
        let has_more = state.has_more();
        let failed = match state.status_code() {
            200 | 204 | 206 => state.request_error() != 0,
            _ => true,
        };
        bun_core::scoped_log!(
            S3,
            "reportProgres failed: {} has_more: {} len: {}",
            failed,
            has_more,
            progress.buffer.list.len()
        );

        if failed {
            if has_more {
                return;
            }
            let empty = MutableString::default();
            let mut code: &[u8] = b"UnknownError";
            let mut message: &[u8] = b"an unexpected error has occurred";
            let parsed;
            if let Some(req_err) = progress.request_error {
                code = req_err.name().as_bytes();
            } else {
                let bytes = progress.buffer.list.as_slice();
                if !bytes.is_empty() {
                    message = bytes;
                }
                parsed = xml_response::parse_error(bytes);
                if let Some(error) = &parsed {
                    code = error.code.as_deref().unwrap_or(code);
                    message = error.message.as_deref().unwrap_or(message);
                }
            }
            self.sink
                .on_chunk(&empty, false, Some(S3Error { code, message }));
            return;
        }

        // dont report empty chunks if we have more data to read
        if !has_more || !progress.buffer.list.is_empty() {
            let chunk = core::mem::take(&mut progress.buffer);
            self.sink.on_chunk(&chunk, has_more, None);
        }
    }

    /// A progress hop (JS thread): deliver what the HTTP thread buffered, and
    /// release the task once the download is over.
    pub(crate) fn on_response(this: ThisPtr<Self>) {
        // `on_chunk` re-enters JS, which may run the final hop under us.
        let _alive = this.ref_guard();
        let (state, progress) = {
            let mut progress = this.shared.progress.lock();
            // the state is atomic let's load it once
            let state = this.shared.get_state();
            // there is no reason to set has_schedule_callback to true if we dont have more data to read
            if state.has_more() {
                this.shared
                    .has_schedule_callback
                    .store(false, Ordering::Relaxed);
            }
            // A failure is only reported once the body is complete, so leave
            // it buffered until then.
            let failed = match state.status_code() {
                200 | 204 | 206 => state.request_error() != 0,
                _ => true,
            };
            let taken = if failed && state.has_more() {
                Progress::default()
            } else {
                Progress {
                    buffer: core::mem::take(&mut progress.buffer),
                    request_error: progress.request_error,
                }
            };
            (state, taken)
        };
        let http_ref = (!state.has_more()).then(|| {
            crate::jsc_hooks::ActiveHandle::S3Download(this.into()).unregister();
            this.http_ref
                .take()
                .expect("S3 download is handed back once")
        });
        this.report_progress(state, progress);
        if let Some(http_ref) = http_ref {
            http_ref.deref();
        }
    }

    /// VM teardown's stop phase (JS thread): abort the transport so the HTTP
    /// thread fails the request promptly and hands it back.
    pub(crate) fn stop_for_vm_teardown(&self) {
        self.shared
            .signal_store
            .aborted
            .store(true, Ordering::Relaxed);
        bun_http::http_thread().schedule_shutdown_by_id(self.request.async_http_id());
    }

    /// Put the request on the HTTP thread with response-body streaming on;
    /// `sink` gets the body on this (the JS) thread.
    pub(crate) fn start(
        storage: RequestStorage,
        sink: bun_ptr::OwnedThis<S3DownloadStreamWrapper>,
    ) {
        let shared = Arc::new(DownloadShared {
            progress: Guarded::default(),
            state: AtomicU64::new(State::default().0),
            has_schedule_callback: AtomicBool::new(false),
            signal_store: Default::default(),
            task: AtomicPtr::new(core::ptr::null_mut()),
            node: ReusableConcurrentTask::default(),
            ticket: VirtualMachine::get().ticket().in_flight(),
        });
        let mut request = storage.request(
            bun_http::Method::GET,
            Arc::clone(&shared),
            shared.signal_store.to(),
        );
        request.with_http_mut(|http| http.enable_response_body_streaming());
        bun_http::http_thread::init(&Default::default());
        let mut batch = bun_threading::thread_pool::Batch::default();
        let request = request.start(&mut batch);
        sink.abort.set(Some(DownloadAbort {
            shared: Arc::clone(&shared),
            async_http_id: request.async_http_id(),
        }));
        let mut poll_ref = KeepAlive::init();
        poll_ref.ref_(bun_io::js_vm_ctx());
        let task = RefPtr::new(S3HttpDownloadStreamingTask {
            ref_count: Cell::new(1),
            http_ref: Cell::new(None),
            shared,
            request,
            sink,
            poll_ref,
        });
        let this = task.this_ptr();
        this.shared.task.store(this.as_ptr(), Ordering::Release);
        // Out on the HTTP thread until its final hop: the VM aborts it at
        // teardown (registry) and waits for it (the ticket).
        crate::jsc_hooks::ActiveHandle::S3Download(this.into()).register();
        this.http_ref.set(Some(task));
        bun_http::HTTPThread::schedule(batch);
    }
}

impl Drop for S3HttpDownloadStreamingTask {
    fn drop(&mut self) {
        self.poll_ref.unref(bun_io::js_vm_ctx());
        // `request` drops next: the HTTP thread handed it back before the
        // final hop was posted, so this frees it. `sink` clears the stream's
        // producer handle as it drops.
    }
}

/// How a cancelled stream aborts the download it is fed by.
pub(crate) struct DownloadAbort {
    shared: Arc<DownloadShared>,
    async_http_id: u32,
}

/// The JS side of a streaming download: feeds each chunk to the
/// `ReadableStream`'s `ByteStream` source. Owned by the task; the source holds
/// a back-reference to it (`SourceHandle::S3DownloadBody`) that `Drop` clears.
pub struct S3DownloadStreamWrapper {
    pub readable_stream_ref: JsCell<ReadableStreamStrong>,
    pub path: Box<[u8]>,
    pub global: GlobalRef,
    /// Set once the request is in flight; taken by `on_stream_cancelled`.
    abort: JsCell<Option<DownloadAbort>>,
}

impl S3DownloadStreamWrapper {
    pub(crate) fn new(
        readable_stream_ref: ReadableStreamStrong,
        path: &[u8],
        global: GlobalRef,
    ) -> bun_ptr::OwnedThis<Self> {
        bun_ptr::OwnedThis::new(Self {
            readable_stream_ref: JsCell::new(readable_stream_ref),
            path: Box::<[u8]>::from(path),
            global,
            abort: JsCell::new(None),
        })
    }

    pub(crate) fn on_chunk(
        &self,
        chunk: &MutableString,
        has_more: bool,
        request_err: Option<S3Error<'_>>,
    ) {
        let Some(readable) = self.readable_stream_ref.get().get() else {
            return;
        };
        // BACKREF: see `Source::bytes()` — payload live while the readable
        // stream is rooted. R-2: `&` — `on_data` re-enters JS.
        let Some(bytes) = readable.ptr.bytes() else {
            return;
        };
        if let Some(err) = request_err {
            bytes.on_data(crate::webcore::streams::StreamResult::Err(
                crate::webcore::streams::StreamError::JSValue(bun_jsc::strong::Optional::create(
                    s3_error_to_js(&err, &self.global, Some(&self.path)),
                    &self.global,
                )),
            ));
            return;
        }
        if has_more {
            bytes.on_data(crate::webcore::streams::StreamResult::Temporary(
                // chunk.list is borrowed for the duration of on_data.
                bun_ptr::RawSlice::new(chunk.list.as_slice()),
            ));
            return;
        }

        bytes.on_data(crate::webcore::streams::StreamResult::TemporaryAndDone(
            // chunk.list is borrowed for the duration of on_data.
            bun_ptr::RawSlice::new(chunk.list.as_slice()),
        ));
    }

    pub(crate) fn on_stream_cancelled(&self) {
        // Release the Strong ref so the ReadableStream can be GC'd.
        // The download may still be in progress, but `on_chunk` will
        // see readable_stream_ref.get() return null and skip data delivery.
        // When the download finishes (has_more == false), the task drops this
        // wrapper with itself.
        self.readable_stream_ref.with_mut(|r| r.deinit());
        // Abort the in-flight HTTP request so the HTTP thread delivers a final
        // callback with `has_more == false`, which frees the task and this wrapper.
        // Without this, a server that never sends the terminal chunk would leak both.
        if let Some(abort) = self.abort.replace(None) {
            abort
                .shared
                .signal_store
                .aborted
                .store(true, Ordering::Relaxed);
            // Wake the HTTP thread so it observes the abort even when the
            // socket is idle; otherwise the final `has_more == false`
            // callback never fires and both the task and wrapper leak.
            bun_http::http_thread().schedule_shutdown_by_id(abort.async_http_id);
        }
    }
}

impl Drop for S3DownloadStreamWrapper {
    fn drop(&mut self) {
        // Clear the ByteStream's producer handle before `readable_stream_ref`
        // drops so the stream never calls back into a freed wrapper.
        if let Some(readable) = self.readable_stream_ref.get().get() {
            if let Some(bytes) = readable.ptr.bytes() {
                bytes
                    .parent_const()
                    .producer
                    .set(crate::webcore::streams::SourceHandle::None);
            }
        }
    }
}

/// Manual bitfield over a transparent u64. Layout (LSB-first):
///   bits  0..32 : status_code (u32)
///   bits 32..48 : request_error (u16)
///   bit  48     : has_more (bool)
///   bits 49..64 : _reserved (u15)
#[repr(transparent)]
#[derive(Copy, Clone)]
pub struct State(pub(crate) u64);

impl State {
    const STATUS_CODE_SHIFT: u32 = 0;
    const REQUEST_ERROR_SHIFT: u32 = 32;
    const HAS_MORE_SHIFT: u32 = 48;

    #[inline]
    const fn status_code(self) -> u32 {
        (self.0 >> Self::STATUS_CODE_SHIFT) as u32
    }
    #[inline]
    fn set_status_code(&mut self, v: u32) {
        self.0 = (self.0 & !0xFFFF_FFFF) | (v as u64);
    }
    #[inline]
    const fn request_error(self) -> u16 {
        (self.0 >> Self::REQUEST_ERROR_SHIFT) as u16
    }
    #[inline]
    fn set_request_error(&mut self, v: u16) {
        self.0 = (self.0 & !(0xFFFF << Self::REQUEST_ERROR_SHIFT))
            | ((v as u64) << Self::REQUEST_ERROR_SHIFT);
    }
    #[inline]
    const fn has_more(self) -> bool {
        (self.0 >> Self::HAS_MORE_SHIFT) & 1 != 0
    }
    #[inline]
    fn set_has_more(&mut self, v: bool) {
        self.0 = (self.0 & !(1 << Self::HAS_MORE_SHIFT)) | ((v as u64) << Self::HAS_MORE_SHIFT);
    }
}

impl Default for State {
    fn default() -> Self {
        // status_code = 0, request_error = 0, has_more = true, _reserved = 0
        State(1u64 << State::HAS_MORE_SHIFT)
    }
}
