import { describe, expect, it, vi } from "vitest";
import type { ExecServerMessage } from "../src/proto/agent_pb.js";
import {
  emptyRequiredArgsError,
  normalizeMcpToolArgs,
  toolSchemaRequiresArgs,
} from "../src/stream/mcp-arg-normalize.js";
import { buildMcpToolDefinitions, encodeMcpArgsMap } from "../src/stream/request-build.js";
import { __testInternals as server } from "../src/stream/server-messages.js";

function tools(...names: string[]) {
  return buildMcpToolDefinitions(
    names.map((name) => ({
      type: "function",
      function: {
        name,
        description: name,
        parameters: {
          type: "object",
          required: name === "write" || name === "read" || name === "edit" ? ["path"] : [],
          properties:
            name === "write" || name === "read" || name === "edit"
              ? { path: { type: "string" } }
              : {},
        },
      },
    })),
  );
}

function exec(caseName: string, args: object = {}, id = 12): ExecServerMessage {
  return {
    id,
    execId: `exec-${id}`,
    message: { case: caseName, value: args },
  } as ExecServerMessage;
}

describe("normalizeMcpToolArgs", () => {
  it("maps Cursor write.contents onto Pi write.content", () => {
    expect(
      normalizeMcpToolArgs("write", {
        path: "/tmp/a.ts",
        contents: "hello",
      }),
    ).toEqual({ path: "/tmp/a.ts", content: "hello" });
  });

  it("leaves an explicit content field alone", () => {
    expect(
      normalizeMcpToolArgs("write", {
        path: "/tmp/a.ts",
        content: "keep",
        contents: "ignore",
      }),
    ).toEqual({ path: "/tmp/a.ts", content: "keep", contents: "ignore" });
  });

  it("normalizes remember/update_memory Cursor-shaped fields", () => {
    expect(
      normalizeMcpToolArgs("update_memory", {
        memoryId: 142,
        tags: ["oz", "phase3"],
        content: "note",
      }),
    ).toEqual({ id: 142, tags: "oz,phase3", content: "note" });
  });

  it("does not invent fields for empty argument objects", () => {
    expect(normalizeMcpToolArgs("edit", {})).toEqual({});
    expect(normalizeMcpToolArgs("write", {})).toEqual({});
  });

  it("detects schemas that require arguments", () => {
    expect(toolSchemaRequiresArgs('{"type":"object","required":["path"]}')).toBe(true);
    expect(toolSchemaRequiresArgs('{"type":"object","required":[]}')).toBe(false);
    expect(toolSchemaRequiresArgs(undefined)).toBe(false);
  });
});

describe("mcpArgs write contents alias", () => {
  it("hands Pi write.content when Cursor sent contents", () => {
    const onMcp = vi.fn();
    expect(
      server.handleExecMessageInner(
        exec("mcpArgs", {
          toolName: "mcp_pi_write",
          toolCallId: "w1",
          args: encodeMcpArgsMap({
            path: "/tmp/a.ts",
            contents: "body",
          }),
        }),
        tools("write"),
        () => {},
        onMcp,
      ),
    ).toBe(true);
    expect(onMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "write",
        decodedArgs: JSON.stringify({ path: "/tmp/a.ts", content: "body" }),
      }),
    );
  });

  it("rejects empty required args without handing them to Pi", () => {
    const onMcp = vi.fn();
    const send = vi.fn();
    expect(
      server.handleExecMessageInner(
        exec("mcpArgs", {
          toolName: "mcp_pi_read",
          toolCallId: "r-empty",
          args: encodeMcpArgsMap({}),
        }),
        tools("read"),
        send,
        onMcp,
      ),
    ).toBe(true);
    expect(onMcp).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    const frame = send.mock.calls[0]?.[0] as Uint8Array;
    expect(Buffer.from(frame).toString("utf8")).toContain("empty arguments");
    expect(emptyRequiredArgsError("read")).toContain("Retry once");
  });
});
