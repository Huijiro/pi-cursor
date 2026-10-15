/**
 * Walk a Cursor conversation checkpoint and collect every blob id it still
 * addresses — including nested turn / user-message / selected-context ids.
 *
 * The local blob store used to trim oldest-first. That deletes ids the live
 * checkpoint still points at, and the next getBlob becomes a hard miss. Callers
 * use this set to evict unreferenced blobs first.
 */

import { fromBinary } from "@bufbuild/protobuf";

import {
  ConversationStateStructureSchema,
  ConversationSummaryArchiveSchema,
  ConversationTurnStructureSchema,
  SelectedContextSchema,
  UserMessageSchema,
  type SelectedContext,
  type SelectedImage,
} from "../proto/agent_pb.js";

function hexId(id: Uint8Array | undefined | null): string | undefined {
  if (!id || id.byteLength === 0) return undefined;
  return Buffer.from(id).toString("hex");
}

function enqueue(
  out: Set<string>,
  queue: string[],
  id: Uint8Array | undefined | null,
): void {
  const key = hexId(id);
  if (!key || out.has(key)) return;
  out.add(key);
  queue.push(key);
}

function enqueueImage(out: Set<string>, queue: string[], image: SelectedImage): void {
  const choice = image.dataOrBlobId;
  if (choice.case === "blobId") enqueue(out, queue, choice.value);
  else if (choice.case === "blobIdWithData") enqueue(out, queue, choice.value.blobId);
}

function enqueueSelectedContext(
  out: Set<string>,
  queue: string[],
  context: SelectedContext,
): void {
  for (const image of context.selectedImages) enqueueImage(out, queue, image);
  const invocation = context.invocationContext?.data;
  if (invocation?.case === "blobId") enqueue(out, queue, invocation.value);
}

function tryDecodeNested(
  data: Uint8Array,
  out: Set<string>,
  queue: string[],
): void {
  try {
    const turn = fromBinary(ConversationTurnStructureSchema, data);
    if (turn.turn.case === "agentConversationTurn") {
      enqueue(out, queue, turn.turn.value.userMessage);
      for (const step of turn.turn.value.steps) enqueue(out, queue, step);
      return;
    }
    if (turn.turn.case === "shellConversationTurn") {
      enqueue(out, queue, turn.turn.value.shellCommand);
      enqueue(out, queue, turn.turn.value.shellOutput);
      return;
    }
  } catch {
    // Not a turn blob.
  }

  try {
    const user = fromBinary(UserMessageSchema, data);
    enqueue(out, queue, user.selectedContextBlob);
    if (user.selectedContext) enqueueSelectedContext(out, queue, user.selectedContext);
    return;
  } catch {
    // Not a user-message blob.
  }

  try {
    const context = fromBinary(SelectedContextSchema, data);
    enqueueSelectedContext(out, queue, context);
    return;
  } catch {
    // Not a selected-context blob.
  }

  try {
    const archive = fromBinary(ConversationSummaryArchiveSchema, data);
    for (const id of archive.summarizedMessages) enqueue(out, queue, id);
    enqueue(out, queue, archive.summaryMessage);
  } catch {
    // Leaf blob (root prompt JSON, step payload, raw bytes, …).
  }
}

/**
 * Blob ids (hex, matching `blobStore` keys) reachable from `checkpoint`.
 * `store` is only needed to decode nested containers; missing nested blobs are
 * still recorded from the parent id list.
 */
export function collectReferencedBlobIds(
  checkpoint: Uint8Array | null | undefined,
  store: Map<string, Uint8Array> = new Map(),
): Set<string> {
  const out = new Set<string>();
  if (!checkpoint || checkpoint.byteLength === 0) return out;

  let state;
  try {
    state = fromBinary(ConversationStateStructureSchema, checkpoint);
  } catch {
    return out;
  }

  const queue: string[] = [];
  for (const id of state.rootPromptMessagesJson) enqueue(out, queue, id);
  for (const id of state.turns) enqueue(out, queue, id);
  for (const id of state.turnsOld) enqueue(out, queue, id);
  for (const id of state.todos) enqueue(out, queue, id);
  for (const id of state.summaryArchives) enqueue(out, queue, id);
  enqueue(out, queue, state.summary);
  enqueue(out, queue, state.plan);
  enqueue(out, queue, state.summaryArchive);
  for (const id of Object.values(state.fileStates)) enqueue(out, queue, id);
  for (const id of Object.values(state.subagentStateRefs)) enqueue(out, queue, id);
  for (const file of Object.values(state.fileStatesV2)) {
    enqueue(out, queue, file.content);
    enqueue(out, queue, file.initialContent);
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key) continue;
    const data = store.get(key);
    if (!data) continue;
    tryDecodeNested(data, out, queue);
  }

  return out;
}
