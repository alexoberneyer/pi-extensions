import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Exact read operations, not a verb-prefix heuristic or provider annotation.
// New tools fail closed until deliberately reviewed here.
export const microsoftTool = (name) => `mcp__claude_ai_Microsoft_365__${name}`;
const builtin = ["ToolSearch", "StructuredOutput"];
const draftTools = {
  mail: ["outlook_email_search"],
  teams: [
    "chat_message_search",
    "teams_list_chats",
    "teams_list_channels",
    "teams_list_channel_messages",
  ],
};
export const readTools = [
  ...builtin,
  ...[
    "get_me",
    "get_granted_scopes",
    "search_people",
    "outlook_email_search",
    "outlook_calendar_search",
    "chat_message_search",
    "read_resource",
    "teams_list_chats",
    "teams_list_teams",
    "teams_list_channels",
    "teams_list_channel_messages",
  ].map(microsoftTool),
  ...[
    "notion-get-self",
    "notion-get-tool-access",
    "notion-get-users",
    "notion-search",
    "notion-fetch",
    "notion-get-comments",
    "notion-query-data-sources",
    "notion-query-multiple-data-sources",
  ].map((name) => `mcp__claude_ai_Notion__${name}`),
  ...[
    "API-get-self",
    "API-get-user",
    "API-get-users",
    "API-post-search",
    "API-query-data-source",
    "API-retrieve-a-data-source",
    "API-retrieve-a-database",
    "API-retrieve-a-page",
    "API-retrieve-a-page-property",
    "API-retrieve-page-markdown",
    "API-retrieve-a-block",
    "API-get-block-children",
    "API-retrieve-a-comment",
  ].map((name) => `mcp__notion-api__${name}`),
];
export function toolsFor(mode) {
  if (mode === "triage") return readTools;
  if (mode !== "mail" && mode !== "teams") return [];
  return [
    ...builtin,
    ...["get_me", "read_resource", ...draftTools[mode]].map(microsoftTool),
  ];
}
export function permitted(name, input, mode = "triage") {
  return (
    toolsFor(mode).includes(name) &&
    !(
      name === "mcp__claude_ai_Notion__notion-fetch" &&
      input?.include_transcript !== undefined &&
      input.include_transcript !== false
    )
  );
}
export function decision(input, mode = "triage") {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: permitted(input?.tool_name, input?.tool_input, mode)
        ? "allow"
        : "deny",
      permissionDecisionReason:
        "Comms permits only reviewed reads for this operation and tool discovery. No raw transcripts, writes, shell, files, delegation or credential access.",
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const input = readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 2 * 1024 * 1024)
      throw new Error("Input too large");
    process.stdout.write(
      JSON.stringify(decision(JSON.parse(input), process.argv[2])),
    );
  } catch {
    // Hook exit 2 is blocking, unlike ordinary hook errors.
    process.stderr.write("Comms could not validate this tool call. Denied.\n");
    process.exitCode = 2;
  }
}
