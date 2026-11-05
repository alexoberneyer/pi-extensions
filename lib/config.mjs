import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const defaults = {
  identity: {
    name: "the authenticated user",
    timeZone: "UTC",
  },
  remote: {
    host: null,
    project: "~",
    sharedDirectory: "shared-dev",
  },
  fast: { defaultTier: "off" },
  approval: { protectedCommands: [], readCommands: [] },
  comms: {
    notesDirectory: null,
    triageInstructions: null,
    messageInstructions: null,
    meetingInstructions: null,
    reminderList: "Next",
    remarkableSource: null,
    notebookName: "Scratchpad",
  },
  workstation: {
    memory: false,
    memoryDirectory: null,
    styleFile: null,
    skillPaths: [],
    promptPaths: [],
    qmdHook: null,
    usageLog: null,
  },
};

/** Only user configuration is discovered. Never read configuration from cwd. */
export function configPath() {
  if (process.env.PI_EXTENSIONS_CONFIG)
    return expandPath(process.env.PI_EXTENSIONS_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(base)) throw new Error("XDG_CONFIG_HOME must be absolute.");
  return join(base, "pi-extensions", "config.json");
}

export function expandPath(value, base = homedir()) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Expected a nonempty path without control characters.");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(base, value);
}

export function packagePath(...parts) {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", ...parts);
}

/** A malformed configuration is an error, never a fallback to weaker policy. */
export function readConfig(path) {
  const explicit =
    path !== undefined || Boolean(process.env.PI_EXTENSIONS_CONFIG);
  path ??= configPath();
  let input;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && !explicit) return structuredClone(defaults);
    throw new Error(`Cannot read Pi extensions configuration at ${path}.`, {
      cause: error,
    });
  }
  const output = structuredClone(defaults);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Pi extensions configuration must be an object.");
  for (const [section, values] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, section))
      throw new Error(`Unknown configuration section: ${section}.`);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error(`Expected an object for ${section}.`);
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(defaults[section], key))
        throw new Error(`Unknown configuration setting: ${section}.${key}.`);
      const expected = defaults[section][key];
      const valid = Array.isArray(expected)
        ? Array.isArray(value) &&
          value.every(
            (item) =>
              typeof item === "string" &&
              item.length > 0 &&
              !/[\x00-\x1f\x7f]/.test(item),
          )
        : expected === null
          ? value === null ||
            (typeof value === "string" &&
              value.length > 0 &&
              !/[\x00-\x1f\x7f]/.test(value))
          : typeof value === typeof expected &&
            (typeof value !== "string" ||
              (value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)));
      if (!valid)
        throw new Error(`Invalid configuration setting: ${section}.${key}.`);
      output[section][key] = value;
    }
  }
  if (!["off", "priority"].includes(output.fast.defaultTier))
    throw new Error(
      "fast.defaultTier must be off or priority. Ultrafast is explicit-only.",
    );
  if (
    output.remote.host &&
    !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(output.remote.host)
  )
    throw new Error(
      "remote.host must be an SSH alias or user@host, without options.",
    );
  if (
    output.approval.protectedCommands.some(
      (name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    )
  )
    throw new Error(
      "approval.protectedCommands must contain executable names, not paths or shell commands.",
    );
  if (
    output.approval.readCommands.some(
      (name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    )
  )
    throw new Error(
      "approval.readCommands must contain reviewed operation names, not paths or shell commands.",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: output.identity.timeZone });
  } catch {
    throw new Error("identity.timeZone must be an IANA timezone.");
  }
  for (const [section, keys] of [
    [
      "comms",
      [
        "notesDirectory",
        "triageInstructions",
        "messageInstructions",
        "meetingInstructions",
        "remarkableSource",
      ],
    ],
    ["workstation", ["memoryDirectory", "styleFile", "qmdHook", "usageLog"]],
  ]) {
    for (const key of keys) {
      if (output[section][key] !== null)
        output[section][key] = expandPath(output[section][key], dirname(path));
    }
  }
  for (const key of ["skillPaths", "promptPaths"])
    output.workstation[key] = output.workstation[key].map((value) =>
      expandPath(value, dirname(path)),
    );
  return output;
}
