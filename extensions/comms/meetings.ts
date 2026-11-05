import { readConfig } from "../../lib/config.mjs";
import { sourceUrl } from "./source-link.ts";

export function meetingPageId(value: string): string {
  const id = value.replace(/-/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new Error("A meeting needs its Notion page ID, not an action ID.");
  return id;
}

export function meetingUrl(value: string, pageId: string): string {
  const url = new URL(sourceUrl(value));
  if (
    !["notion.so", "www.notion.so"].includes(url.hostname) &&
    !url.hostname.endsWith(".notion.site")
  )
    throw new Error("A meeting needs its original Notion page link.");
  const id = url.pathname.match(
    /(?:^|\/|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i,
  )?.[1];
  if (!id || meetingPageId(id) !== meetingPageId(pageId))
    throw new Error("The meeting link must match its Notion page ID.");
  return url.href;
}

export function meetingCollectionPrompt(instructions?: string): string {
  return instructions
    ? `Meeting collection is a separate source named "meetings", not the "notion" ticket feed. Its checkpoint and failures are independent.
The canonical paste-meetings skill below is reference material for retrieval, name/owner verification and accidental-recording filtering. Do NOT execute its filing workflow. These collection rules override its date defaults, connector names, transcript policy, output and write steps:
- Discover the connected Notion meeting-query and fetch tools. Claude-hosted and Pi-native Notion tools may have different names. Check tool access when the connector requires it. The legacy notion-api integration cannot be assumed to see private meeting notes. Missing access means meetings unavailable, not empty.
- Use the MEETINGS source/account cursor minus two hours, or seven days before run start on first collection. Query last_edited_time, not just created_time, so late summaries and edits are picked up. Verify the account identity separately from ticket access.
- The meeting query can return at most 50 rows without pagination. Split saturated date windows into smaller windows and deduplicate page IDs. If a smallest supported window is still saturated, report partial. Never claim complete coverage from a capped result.
- Fetch summaries only (include_transcript: false). Do not fetch raw transcripts during refresh. Empty, pending or truncated summaries leave coverage partial with an explanation so they can be retried. Report skipped accidental recordings without quoting their contents.
- Return one review candidate per actionable meeting, using the actual Notion page ID as sourceId, the provider's last-edited timestamp, and that page's HTTPS Notion URL. Never invent separate action IDs. Keep the original title and verified participants where safe.
- Keep only explicit commitments assigned to ${JSON.stringify(readConfig().identity.name)}, verified against the authenticated account, decisions requiring the user's follow-up, and unresolved ownership the user needs to clarify. Label uncertain ownership as uncertain. A discussion, suggestion or someone else's task is not the user's promise. Skip meetings with no follow-up for the user.
- Summaries contain only minimal follow-up evidence. Never copy transcripts, performance assessments, candidate evaluations, salary, health or family details into the queue. For a sensitive meeting, use a neutral review item linked to the original instead. Apply the skill's recorder-left-running rule before extracting anything.
- The suggestion is ONE concrete candidate action for the user to review, never a list of tasks. Do not create reminders, file notes, send messages or mark a meeting integrated. Adding a reminder and integrating notes remain explicit, separate user actions.
Canonical meeting skill (reference only):
${instructions}`
    : `The configured meeting instructions are missing or unreadable. Report source "meetings" as unavailable, retain its checkpoint, and continue collecting the other sources. Do not invent a replacement meeting workflow.`;
}
