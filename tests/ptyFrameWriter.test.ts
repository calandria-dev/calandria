import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tmpDir } from "./helpers";
import {
  createFrameWriter,
  drainPtyBeforeDestroy,
  MAX_PTY_OUTPUT_FRAME_BYTES,
  MAX_QUEUED_FRAME_BYTES,
  splitPtyOutput,
} from "../lib/pty-frame-writer.mjs";

type SendCallback = (error?: Error) => void;

function socket() {
  const callbacks: SendCallback[] = [];
  const ws = {
    readyState: 1,
    send: vi.fn((_payload: Buffer | string, _options: { compress: boolean }, callback: SendCallback) => {
      callbacks.push(callback);
    }),
    close: vi.fn(),
    terminate: vi.fn(),
    once: vi.fn(),
  };
  return { ws, callbacks };
}

describe("PTY frame writer", () => {
  it("splits large PTY output into bounded binary frames", () => {
    const frames = splitPtyOutput(Buffer.alloc(MAX_PTY_OUTPUT_FRAME_BYTES * 2 + 1));

    expect(frames.map((frame) => frame.length)).toEqual([
      MAX_PTY_OUTPUT_FRAME_BYTES,
      MAX_PTY_OUTPUT_FRAME_BYTES,
      1,
    ]);
  });

  it("keeps one frame in flight and closes after the exit frame flushes", () => {
    const { ws, callbacks } = socket();
    const trace = vi.fn();
    const outputFlushed = vi.fn();
    const send = createFrameWriter(ws, 7, trace);

    expect(send("ready", "ready")).toBe(true);
    expect(send("pty_output", Buffer.from("output"), { onFlushed: outputFlushed })).toBe(true);
    expect(send("exit", "exit", { closeAfter: true })).toBe(true);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenLastCalledWith("ready", { compress: false }, expect.any(Function));
    callbacks.shift()?.();
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(outputFlushed).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(ws.send).toHaveBeenCalledTimes(3);
    expect(outputFlushed).toHaveBeenCalledOnce();
    expect(ws.close).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(ws.close).toHaveBeenCalledOnce();
    expect(trace.mock.calls.map((call) => call[2])).toEqual(["ready", "pty_output", "exit"]);
  });

  it("terminates a connection whose queued frames exceed the byte limit", () => {
    const { ws } = socket();
    const send = createFrameWriter(ws, 1, vi.fn());

    expect(send("active", Buffer.alloc(1))).toBe(true);
    expect(send("queued", Buffer.alloc(MAX_QUEUED_FRAME_BYTES))).toBe(true);
    expect(send("overflow", Buffer.alloc(1))).toBe(false);
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the connection when a frame write fails", () => {
    const { ws, callbacks } = socket();
    const send = createFrameWriter(ws, 1, vi.fn());

    expect(send("ready", "ready")).toBe(true);
    callbacks.shift()?.(new Error("write failed"));
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(send("late", "late")).toBe(false);
  });

  // A file stands in for the pty master: readSync drains it and stops at EOF
  // the way a master stops at EAGAIN or EIO.
  function terminalOver(contents: Buffer) {
    const file = path.join(tmpDir("pty-drain-"), "master");
    fs.writeFileSync(file, contents);
    const fd = fs.openSync(file, "r");
    const order: string[] = [];
    const destroy = vi.fn(() => { order.push("destroy"); });
    const term = { _fd: fd, _socket: { destroyed: false, destroy } };
    return { term, destroy, order, close: () => fs.closeSync(fd) };
  }

  it("delivers unread terminal output before the read socket is destroyed", () => {
    const { term, destroy, order, close } = terminalOver(Buffer.from("last line\r\n"));
    const output: Buffer[] = [];

    expect(drainPtyBeforeDestroy(term, (chunk: Buffer) => {
      output.push(chunk);
      order.push("output");
    })).toBe(true);
    term._socket.destroy();
    close();

    expect(Buffer.concat(output).toString()).toBe("last line\r\n");
    expect(order).toEqual(["output", "destroy"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("bounds the drain for a writer that never stops", () => {
    const { term, destroy, close } = terminalOver(Buffer.alloc(MAX_PTY_OUTPUT_FRAME_BYTES * 4));
    let drained = 0;

    drainPtyBeforeDestroy(term, (chunk: Buffer) => { drained += chunk.length; }, MAX_PTY_OUTPUT_FRAME_BYTES * 2);
    term._socket.destroy();
    close();

    expect(drained).toBe(MAX_PTY_OUTPUT_FRAME_BYTES * 2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("leaves a terminal without the expected internals alone", () => {
    expect(drainPtyBeforeDestroy({}, vi.fn())).toBe(false);
  });
});
