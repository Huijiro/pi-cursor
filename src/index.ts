/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Native Pi streamSimple provider translating Pi context → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSystemCredentialPolicy, systemCredentialsAllowed } from "./auth/consent.js";
import {
  setLastClientVersion,
  setLastTokenSource,
  setSystemCredentialsPolicy,
} from "./diagnostics/index.js";
import { getCursorClientVersion } from "./stream/config.js";
import { CredentialSource, ProviderConstant } from "./types/enums.js";
import type { ProcessedModel } from "./models/processing.js";
import {
  debugExtensionLog,
  getExtensionDebugLogFilePath,
  isExtensionDebugEnabled,
  registerExtensionDebugHooks,
  registerSessionLifecycleCleanup,
} from "./extension/debug-hooks.js";
import { getStartupCursorAccessToken, isTokenNearExpiry } from "./extension/auth.js";
import { createProviderManager, loadStartupCatalog } from "./extension/provider.js";
import { registerCursorCommands } from "./extension/commands.js";
import {
  PI_CURSOR_SETTINGS_EXTENSION_NAME,
  PROMPT_HISTORY_SETTING_ID,
} from "./stream/prompt-history-setting.js";

// ── Re-exports for public API, tests, and external scripts ──

export {
  extractToolResultImagePayloads,
  type CursorToolResultImagePayload,
} from "./extension/debug-hooks.js";

export {
  applyNoReasoningEffort,
  applyRawCursorModelId,
  buildEffortMap,
  buildNoReasoningEffortLookup,
  buildRawModelLookup,
  modelConfig,
  parseModelId,
  processModels,
  supportsReasoningModelId,
  type CursorEffortMap,
  type CursorModelRouting,
  type ProcessedModel,
} from "./models/processing.js";

export {
  augmentCursorModels,
  FALLBACK_MODELS,
  modelsFromParameterizedMetadata,
} from "./models/parameterized.js";

export { registerSessionLifecycleCleanup } from "./extension/debug-hooks.js";

/** API id used by Cursor models and the native streamSimple implementation. */
export const CURSOR_NATIVE_API = ProviderConstant.NativeApi;

// ── Extension entry point ──

export default async function (pi: ExtensionAPI): Promise<void> {
  let currentToken = "";
  let currentTokenSource: CredentialSource = CredentialSource.None;
  let lastRegisteredModels: ProcessedModel[] = [];

  setSystemCredentialsPolicy(resolveSystemCredentialPolicy());
  setLastClientVersion(getCursorClientVersion());

  // Proactive token pre-refresh: background-refresh when the token is within 5 minutes
  // of expiry so a fresh token is ready before the stream starts (not mid-retry).
  const TOKEN_PREREFRESH_SKEW_MS = 5 * 60 * 1000;
  let preRefreshInFlight = false;

  const scheduleProactiveTokenRefresh = (): void => {
    if (preRefreshInFlight || !currentToken || currentTokenSource === CredentialSource.Env) return;
    if (!isTokenNearExpiry(currentToken, TOKEN_PREREFRESH_SKEW_MS)) return;
    preRefreshInFlight = true;
    void getStartupCursorAccessToken({ forceRefresh: true })
      .then((resolved) => {
        if (resolved) {
          currentToken = resolved.accessToken;
          currentTokenSource = resolved.source;
          setLastTokenSource(resolved.source);
          debugExtensionLog("token.proactive_refresh", { source: resolved.source });
        }
      })
      .catch((err) => {
        debugExtensionLog("token.proactive_refresh_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        preRefreshInFlight = false;
      });
  };

  const getAccessToken = async (options?: { forceRefresh?: boolean }): Promise<string> => {
    // Kick off a non-blocking pre-refresh if we're close to expiry but not yet expired.
    scheduleProactiveTokenRefresh();

    const needsRefresh =
      options?.forceRefresh ||
      !currentToken ||
      (currentTokenSource !== CredentialSource.Env && isTokenNearExpiry(currentToken));

    if (needsRefresh) {
      const resolved = await getStartupCursorAccessToken({
        forceRefresh: options?.forceRefresh || isTokenNearExpiry(currentToken || "x"),
      });
      if (resolved) {
        currentToken = resolved.accessToken;
        currentTokenSource = resolved.source;
        setLastTokenSource(resolved.source);
      } else if (options?.forceRefresh) {
        // Keep previous token only if force refresh failed and we still have one.
        setLastTokenSource(currentTokenSource || CredentialSource.None);
      }
    }

    if (!currentToken) {
      const consentHint = systemCredentialsAllowed()
        ? ""
        : " System credential reuse is disabled (PI_CURSOR_SYSTEM_CREDENTIALS=0).";
      throw new Error(
        `Not logged in to Cursor. Run /login cursor or log in via Cursor CLI.${consentHint}`,
      );
    }
    setLastTokenSource(currentTokenSource);
    return currentToken;
  };

  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    mode: "native-streamSimple",
    debugLogFile: isExtensionDebugEnabled() ? getExtensionDebugLogFilePath() : undefined,
  });

  const providerManager = createProviderManager(pi, {
    getAccessToken,
    setCurrentToken: (token, source) => {
      currentToken = token;
      currentTokenSource = source;
      setLastTokenSource(source);
    },
    onRegisteredModelsUpdated: (models) => {
      lastRegisteredModels = models;
    },
  });

  // Activation must not block on the network. Register the last-known-good
  // catalog (or the bundled fallback) synchronously; pi calls refreshModels in
  // the background and updates an open /model selector with the live list.
  const startupCatalog = loadStartupCatalog();
  providerManager.registerModels(startupCatalog.rawModels, startupCatalog.parameterizedModels);

  registerCursorCommands(pi, {
    getAccessToken,
    getLastRegisteredModels: () => lastRegisteredModels,
    getCurrentTokenSource: () => currentTokenSource,
  });

  // Shown in /extension-settings when @juanibiapina/pi-extension-settings is loaded first.
  pi.events.emit("pi-extension-settings:register", {
    name: PI_CURSOR_SETTINGS_EXTENSION_NAME,
    settings: [
      {
        id: PROMPT_HISTORY_SETTING_ID,
        label: "Prompt History",
        description:
          "Replay Pi's system prompt and completed turns into Cursor root_prompt_messages_json on every turn. Off is much faster on long tool-heavy chats; rebuilt/resumed sessions may lose history. PI_CURSOR_PROMPT_HISTORY overrides when set.",
        defaultValue: "on",
        values: ["on", "off"],
      },
    ],
  });
}
