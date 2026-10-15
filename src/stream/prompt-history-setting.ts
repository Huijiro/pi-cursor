/**
 * Prompt-history toggle: env wins, then pi-extension-settings, then default on.
 *
 * Storage format matches @juanibiapina/pi-extension-settings
 * (`settings-extensions.json` under the agent dir / `.pi/`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isPromptHistoryEnabled } from "./root-prompt.js";

export const PI_CURSOR_SETTINGS_EXTENSION_NAME = "pi-cursor";
export const PROMPT_HISTORY_SETTING_ID = "promptHistory";

type SettingsFile = Record<string, Record<string, string>>;

let testOverride: { value: string | undefined } | undefined;

function loadSettingsFile(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SettingsFile;
  } catch {
    return {};
  }
}

/** Read the stored promptHistory setting (local project file, then global). */
export function readPromptHistorySetting(
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): string | undefined {
  if (testOverride) return testOverride.value;
  const paths = [
    join(cwd, ".pi", "settings-extensions.json"),
    join(agentDir, "settings-extensions.json"),
  ];
  for (const path of paths) {
    const ext = loadSettingsFile(path)[PI_CURSOR_SETTINGS_EXTENSION_NAME];
    if (ext && PROMPT_HISTORY_SETTING_ID in ext) return ext[PROMPT_HISTORY_SETTING_ID];
  }
  return undefined;
}

/**
 * Effective prompt-history gate for request builds.
 * `PI_CURSOR_PROMPT_HISTORY` overrides the plugin setting when set.
 */
export function resolvePromptHistoryEnabled(): boolean {
  return isPromptHistoryEnabled(
    process.env.PI_CURSOR_PROMPT_HISTORY,
    readPromptHistorySetting(),
  );
}

/** Short diagnostic label for `/cursor.doctor`. */
export function promptHistoryDiagnostic(): string {
  const env = process.env.PI_CURSOR_PROMPT_HISTORY?.trim();
  const setting = readPromptHistorySetting();
  const enabled = resolvePromptHistoryEnabled();
  const source = env
    ? `env=${env}`
    : setting !== undefined
      ? `setting=${setting}`
      : "default";
  return `${enabled ? "on" : "off"} (${source})`;
}

/** Test helper: force the setting value, or pass `null` to clear the override. */
export function setPromptHistorySettingForTests(value: string | undefined | null): void {
  testOverride = value === null ? undefined : { value };
}
