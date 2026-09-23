import fs from "node:fs";

const OPEN = 1;

export const MAX_QUEUED_FRAME_BYTES = 1024 * 1024;
export const MAX_PTY_OUTPUT_FRAME_BYTES = 64 * 1024;

function payloadLength(payload) {
  return Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8");
}

export function splitPtyOutput(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_PTY_OUTPUT_FRAME_BYTES) {
    frames.push(bytes.subarray(offset, offset + MAX_PTY_OUTPUT_FRAME_BYTES));
  }
  return frames;
}

/**
 * Build a bounded, serial frame writer for one WebSocket connection.
 *
 * `ws` preserves call order. Its send callback marks the point where the final
 * bytes for one frame reach the socket. Waiting for that boundary keeps PTY
 * output and control frames from having writes in flight together. The byte
 * ceiling keeps a slow terminal client from retaining unlimited output.
 */
export function createFrameWriter(ws, connectionId, traceFrame) {
  const queue = [];
  let queuedBytes = 0;
  let sending = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
    queue.length = 0;
    queuedBytes = 0;
  };
  const terminate = () => {
    stop();
    try { ws.terminate(); } catch {}
  };
  ws.once("close", stop);
  ws.once("error", stop);

  const flush = () => {
    if (sending || stopped || queue.length === 0) return;
    if (ws.readyState !== OPEN) {
      stop();
      return;
    }

    const frame = queue.shift();
    queuedBytes -= frame.bytes;
    sending = true;
    traceFrame(ws, connectionId, frame.writer, frame.payload);
    try {
      ws.send(frame.payload, { compress: false }, (err) => {
        sending = false;
        if (err) {
          terminate();
          return;
        }
        if (frame.closeAfter) {
          stop();
          try { ws.close(); } catch {}
          return;
        }
        flush();
        try { frame.onFlushed?.(); } catch {}
      });
    } catch {
      sending = false;
      terminate();
    }
  };

  return (writer, payload, options = {}) => {
    if (stopped || ws.readyState !== OPEN) return false;
    const bytes = payloadLength(payload);
    if (queuedBytes + bytes > MAX_QUEUED_FRAME_BYTES) {
      terminate();
      return false;
    }
    queue.push({ writer, payload, ...options, bytes });
    queuedBytes += bytes;
    flush();
    return true;
  };
}

/**
 * Read a POSIX node-pty terminal's unread output before its read socket is
 * destroyed.
 *
 * node-pty waits a bounded time after the child exits for its read socket to
 * reach EIO, then destroys the socket and emits exit. Output still buffered in
 * the pty master at that point is discarded, so a starved process can deliver
 * exit ahead of the shell's last output. The master fd is non-blocking, so this
 * synchronous drain stops at EAGAIN or EIO. `maxBytes` bounds a background
 * process that keeps writing. Returns false when the terminal lacks the
 * internals this depends on, leaving node-pty's own behavior in place.
 */
export function drainPtyBeforeDestroy(term, onOutput, maxBytes = MAX_QUEUED_FRAME_BYTES) {
  const socket = term?._socket;
  const fd = term?._fd;
  if (!socket || typeof socket.destroy !== "function" || typeof fd !== "number") return false;
  const destroy = socket.destroy;
  socket.destroy = function (...args) {
    if (!socket.destroyed) {
      const buffer = Buffer.alloc(MAX_PTY_OUTPUT_FRAME_BYTES);
      let drained = 0;
      while (drained < maxBytes) {
        let n;
        try { n = fs.readSync(fd, buffer, 0, buffer.length, null); } catch { break; }
        if (n <= 0) break;
        drained += n;
        try { onOutput(Buffer.from(buffer.subarray(0, n))); } catch { break; }
      }
    }
    return destroy.apply(this, args);
  };
  return true;
}
