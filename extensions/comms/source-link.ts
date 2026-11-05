import type { Source } from "./state.ts";

// Source links are untrusted data. Opening one is an explicit UI action only.
export function sourceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(
      "Source links must be HTTPS URLs without credentials or whitespace.",
    );
  return url.href;
}

function nativeTarget(source: Source, url: URL) {
  if (url.port) return;
  // Teams and Outlook stay browser-based until exact-item navigation works.
  if (
    (source === "notion" || source === "meetings") &&
    (["notion.so", "www.notion.so", "notion.com", "www.notion.com"].includes(
      url.hostname,
    ) ||
      url.hostname.endsWith(".notion.site")) &&
    /(?:^|\/|-)(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i.test(
      url.pathname,
    )
  )
    return {
      name: "Notion",
      bundleId: "notion.id",
      url: url.href.replace(/^https:/, "notion:"),
    };
}

export async function openSourceLink(
  source: Source,
  value: string,
  open: (args: string[]) => Promise<unknown>,
  browserOnly = false,
): Promise<string> {
  const url = new URL(sourceUrl(value));
  const target = browserOnly ? undefined : nativeTarget(source, url);
  if (target) {
    try {
      // Pin the intended Mac app rather than trusting a custom-scheme handler.
      await open(["-b", target.bundleId, target.url]);
      return `Sent original to ${target.name}. Queue unchanged.`;
    } catch {
      await open([url.href]);
      return `${target.name} could not launch the link. Opened original in your browser. Queue unchanged.`;
    }
  }
  await open([url.href]);
  return "Original opened in your browser. Queue unchanged.";
}
