import { expect, test } from "bun:test";
import { bunEnv, bunExe, normalizeBunSnapshot } from "harness";

// Once `S3Client.write(key, new Response(stream))` returns, the only thing
// that refers to the stream is the native multipart upload. A GC while the
// upload is parked on part backpressure must not collect the stream pump:
// the write must still settle instead of hanging or crashing.
function fixture(source: string) {
  return `
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.searchParams.has("uploads")) {
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
            { headers: { "content-type": "application/xml" } },
          );
        }
        if (req.method === "PUT") {
          await req.arrayBuffer();
          // The client waits for this part to finish before it reads more of
          // the stream. Nothing in JS refers to the stream at this point.
          Bun.gc(true);
          return new Response("", { headers: { ETag: '"etag"' } });
        }
        await req.text();
        return new Response(
          '<CompleteMultipartUploadResult><ETag>"etag-1"</ETag></CompleteMultipartUploadResult>',
          { headers: { "content-type": "application/xml" } },
        );
      },
    });
    const client = new Bun.S3Client({
      endpoint: "http://127.0.0.1:" + server.port,
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "us-east-1",
    });
    const partSize = 5 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const chunkCount = 2 * (partSize / chunk.byteLength) + 1;
    ${source}
    const results = await Promise.all(
      [1, 2].map(queueSize =>
        client
          .write("key-" + queueSize, new Response(makeStream()), { partSize, queueSize, retry: 0 })
          .then(() => "ok", e => "error:" + e.message),
      ),
    );
    console.log(results.join(" "));
    server.stop(true);
  `;
}

const env = {
  ...bunEnv,
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
};

test.concurrent("S3 multipart upload from an unreferenced ReadableStream survives GC during backpressure", async () => {
  // Everything is enqueued up front, so the pump parks with an unwritten batch tail.
  const source = `
    function makeStream() {
      return new ReadableStream({
        start(controller) {
          for (let i = 0; i < chunkCount; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
    }
  `;
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", fixture(source)],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout: normalizeBunSnapshot(stdout), stderr: normalizeBunSnapshot(stderr), exitCode })
    .toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "ok ok",
    }
  `);
});

test.concurrent("S3 multipart upload rejects with a stream error raised after GC during backpressure", async () => {
  // Pulled one chunk at a time; the source fails once the first part is in flight.
  const source = `
    function makeStream() {
      let sent = 0;
      return new ReadableStream({
        pull(controller) {
          if (sent > partSize / chunk.byteLength) {
            controller.error(new Error("stream failed"));
            return;
          }
          controller.enqueue(chunk);
          sent++;
        },
      });
    }
  `;
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", fixture(source)],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout: normalizeBunSnapshot(stdout), stderr: normalizeBunSnapshot(stderr), exitCode })
    .toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "error:stream failed error:stream failed",
    }
  `);
});
