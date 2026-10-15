import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  AgentConversationTurnStructureSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  UserMessageSchema,
} from "../src/proto/agent_pb.js";
import { collectReferencedBlobIds } from "../src/stream/blob-refs.js";
import { mergeBlobStore, trimBlobStore } from "../src/stream/session-state.js";
import type { StoredConversation } from "../src/stream/types.js";

function hex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

function storedConversation(partial: Partial<StoredConversation> = {}): StoredConversation {
  return {
    conversationId: "conv-1",
    checkpoint: null,
    sessionScoped: false,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    ...partial,
  };
}

describe("collectReferencedBlobIds", () => {
  it("walks root prompts, turns, and nested user/selected-context blob ids", () => {
    const imageBlob = new Uint8Array([9, 9, 9]);
    const imageId = new Uint8Array(32).fill(1);
    const selectedContext = create(SelectedContextSchema, {
      selectedImages: [
        create(SelectedImageSchema, {
          uuid: "img",
          mimeType: "image/png",
          dataOrBlobId: { case: "blobId", value: imageId },
        }),
      ],
    });
    const selectedContextBytes = toBinary(SelectedContextSchema, selectedContext);
    const selectedContextId = new Uint8Array(32).fill(2);

    const userMessage = create(UserMessageSchema, {
      text: "hi",
      messageId: "m1",
      selectedContextBlob: selectedContextId,
    });
    const userMessageBytes = toBinary(UserMessageSchema, userMessage);
    const userMessageId = new Uint8Array(32).fill(3);

    const stepId = new Uint8Array(32).fill(4);
    const turn = create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, {
          userMessage: userMessageId,
          steps: [stepId],
          requestId: "r1",
        }),
      },
    });
    const turnBytes = toBinary(ConversationTurnStructureSchema, turn);
    const turnId = new Uint8Array(32).fill(5);
    const rootId = new Uint8Array(32).fill(6);

    const checkpoint = toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [rootId],
        turns: [turnId],
      }),
    );

    const store = new Map<string, Uint8Array>([
      [hex(turnId), turnBytes],
      [hex(userMessageId), userMessageBytes],
      [hex(selectedContextId), selectedContextBytes],
      [hex(imageId), imageBlob],
      [hex(stepId), new Uint8Array([7])],
      [hex(rootId), new TextEncoder().encode('{"role":"user"}')],
      ["orphan", new Uint8Array([0])],
    ]);

    const refs = collectReferencedBlobIds(checkpoint, store);
    expect(refs.has(hex(rootId))).toBe(true);
    expect(refs.has(hex(turnId))).toBe(true);
    expect(refs.has(hex(userMessageId))).toBe(true);
    expect(refs.has(hex(stepId))).toBe(true);
    expect(refs.has(hex(selectedContextId))).toBe(true);
    expect(refs.has(hex(imageId))).toBe(true);
    expect(refs.has("orphan")).toBe(false);
  });

  it("returns an empty set for null/undecodable checkpoints", () => {
    expect(collectReferencedBlobIds(null).size).toBe(0);
    expect(collectReferencedBlobIds(new Uint8Array([0xff, 0xff])).size).toBe(0);
  });
});

describe("referenced-first trim", () => {
  it("evicts unprotected orphans before protected ids", () => {
    const store = new Map<string, Uint8Array>([
      ["old-orphan", new Uint8Array(20).fill(1)],
      ["protected", new Uint8Array(20).fill(2)],
      ["new-orphan", new Uint8Array(20).fill(3)],
    ]);
    const trimmed = trimBlobStore(store, 45, 10, new Set(["protected"]));
    expect(trimmed.removed).toBeGreaterThan(0);
    expect(trimmed.removedProtected).toBe(0);
    expect(store.has("protected")).toBe(true);
    expect(store.has("old-orphan")).toBe(false);
  });

  it("keeps a checkpoint when merge only drops unreferenced blobs", () => {
    const rootId = new Uint8Array(32).fill(8);
    const rootHex = hex(rootId);
    const checkpoint = toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [rootId],
        turns: [],
      }),
    );
    const rootBytes = new TextEncoder().encode("rules");
    const stored = storedConversation({
      checkpoint,
      checkpointSource: "upstream",
      checkpointTurnCount: 1,
      blobStore: new Map([
        [rootHex, rootBytes],
        ["orphan-1", new Uint8Array(8).fill(1)],
        ["orphan-2", new Uint8Array(8).fill(2)],
      ]),
    });

    // Incoming set is only the referenced root. Orphans already in stored.blobStore are
    // unreferenced and may be dropped by a later trim; merge itself should not clear the
    // checkpoint when nothing protected was forced out.
    const { evicted } = mergeBlobStore(
      stored,
      new Map([[rootHex, rootBytes]]),
      { protectCheckpoint: checkpoint },
    );
    expect(evicted).toBe(0);
    expect(stored.checkpoint).toEqual(checkpoint);
    expect(stored.blobStore.has(rootHex)).toBe(true);

    const protect = collectReferencedBlobIds(checkpoint, stored.blobStore);
    const trimmed = trimBlobStore(stored.blobStore, 20, 10, protect);
    expect(trimmed.removedProtected).toBe(0);
    expect(stored.blobStore.has(rootHex)).toBe(true);
    expect(stored.blobStore.has("orphan-1")).toBe(false);
  });

  it("reports protected eviction when the budget cannot hold referenced blobs", () => {
    const store = new Map<string, Uint8Array>([
      ["a", new Uint8Array(30).fill(1)],
      ["b", new Uint8Array(30).fill(2)],
    ]);
    const trimmed = trimBlobStore(store, 40, 10, new Set(["a", "b"]));
    expect(trimmed.removedProtected).toBeGreaterThan(0);
    expect(store.size).toBe(1);
  });
});
