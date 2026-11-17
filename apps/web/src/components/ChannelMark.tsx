// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@/lib/cn";

/** The channels a mark can show. A step type or network maps to one of these with `channelOf`. */
export type Channel = "email" | "post" | "linkedin" | "x" | "newsletter" | "seo" | "manual";

const LABEL: Record<Channel, string> = { email: "Email", post: "Social posts", linkedin: "LinkedIn", x: "X", newsletter: "Newsletter", seo: "SEO", manual: "Manual" };
const FILL: Record<Channel, string> = {
  email: "bg-channel-email",
  post: "bg-channel-post",
  linkedin: "bg-channel-post",
  x: "bg-foreground",
  newsletter: "bg-channel-newsletter",
  seo: "bg-channel-seo",
  manual: "bg-muted-foreground",
};

/** A Campaign step type ("email", "seo_brief"), a network ("linkedin") or a section ("newsletter") as a Channel. */
export function channelOf(kind: string): Channel {
  if (kind === "email" || kind === "outreach") return "email";
  if (kind === "seo_brief" || kind === "seo") return "seo";
  if (kind === "newsletter" || kind === "linkedin" || kind === "x" || kind === "manual") return kind;
  return "post";
}

function Glyph({ channel }: { channel: Channel }) {
  if (channel === "linkedin") return <span className="text-xs leading-none font-bold">in</span>;
  if (channel === "x") return <span className="text-xs leading-none font-bold">X</span>;
  const path: Record<Exclude<Channel, "linkedin" | "x">, string> = {
    email: "M2.5 4.5h11v8h-11zM2.5 4.5 8 9l5.5-4.5",
    post: "M3 3.5h10v7H7l-3 2.5v-2.5H3z",
    newsletter: "M3.5 2.5h9v11h-9zM5.5 6h5M5.5 8.5h5M5.5 11h3",
    seo: "M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l3.5 3.5",
    manual: "M3 13l2.5-.5 7-7-2-2-7 7zM9.5 4.5l2 2",
  };
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
      <path d={path[channel]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A channel as a small coloured tile with a white glyph. Its name is the label, so colour is never the only signal. */
export function ChannelMark({ channel, className }: { channel: Channel; className?: string }) {
  return (
    <span role="img" aria-label={LABEL[channel]} title={LABEL[channel]} className={cn("inline-grid size-6 shrink-0 place-items-center rounded-sm text-primary-foreground", FILL[channel], className)}>
      <Glyph channel={channel} />
    </span>
  );
}

/** Several channels side by side, once each. */
export function ChannelMarks({ kinds }: { kinds: string[] }) {
  const channels = [...new Set(kinds.map(channelOf))];
  if (!channels.length) return null;
  return (
    <span className="inline-flex gap-1">
      {channels.map((c) => (
        <ChannelMark key={c} channel={c} />
      ))}
    </span>
  );
}
