import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configPath } from "../../lib/config.mjs";

export function voicePreferencePath() {
  const selected = configPath();
  const file = join(dirname(selected), "voice-state.json");
  return resolve(file) === resolve(selected)
    ? join(dirname(selected), "voice-preferences.json")
    : file;
}

/** Pins the selected profile's path without reading or creating any files. */
export function createVoicePreferences(file = voicePreferencePath()) {
  const selected = configPath();
  function distinctFromConfig() {
    if (resolve(file) === resolve(selected))
      throw new Error("Voice preference path conflicts with configuration.");
    const stat = (path) => {
      try {
        return statSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
    const preference = stat(file);
    const configuration = stat(selected);
    if (
      preference &&
      configuration &&
      preference.dev === configuration.dev &&
      preference.ino === configuration.ino
    )
      throw new Error("Voice preference path conflicts with configuration.");
  }
  return {
    read() {
      try {
        distinctFromConfig();
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 2 ||
          value.version !== 1 ||
          typeof value.enabled !== "boolean"
        )
          throw new Error("Invalid Voice preference schema.");
        return value.enabled;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw new Error("Cannot read saved Voice preference.", {
          cause: error,
        });
      }
    },

    write(enabled) {
      let descriptor;
      let temporary;
      try {
        if (typeof enabled !== "boolean")
          throw new TypeError("Expected a boolean.");
        distinctFromConfig();
        const directory = dirname(file);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const candidate = join(directory, `.voice-state-${randomUUID()}.tmp`);
        descriptor = openSync(candidate, "wx", 0o600);
        temporary = candidate;
        writeFileSync(
          descriptor,
          `${JSON.stringify({ version: 1, enabled })}\n`,
          "utf8",
        );
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, file);
        temporary = undefined;
      } catch (error) {
        throw new Error("Cannot save Voice preference.", { cause: error });
      } finally {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {}
        }
        if (temporary !== undefined) {
          try {
            unlinkSync(temporary);
          } catch {}
        }
      }
    },
  };
}
