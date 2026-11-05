import type { CreatorLinks as Links, LinkKind } from "@/lib/bouncer/socialLinks";

/*
  Creator Links (socials A, approved 2026-10-31: Option A, the note "Creator Links"): one line, the program lane's spec
  section 4. From the token's own metadata file, which the site reads from its own store only (ownStore.ts) and shows
  only when the file is the launch's own (its name and ticker); checked again before they show (socialLinks.ts
  creatorLinksOf). Each opens in a new tab with no referrer.
  Option A: the words Website, X and Telegram.
*/
const ORDER: readonly LinkKind[] = ["website", "x", "telegram"];
const NAMES: Record<LinkKind, string> = { website: "Website", x: "X", telegram: "Telegram" };

export function CreatorLinks({ links, className = "" }: { links?: Links; className?: string }) {
  const shown = ORDER.filter((k) => links?.[k]);
  if (!links || shown.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 max-w-[62ch] ${className}`} data-creator-links>
      <span className="text-text-3" data-creator-links-note>
        Creator Links
      </span>
      {/* One group, so a narrow line breaks after the note and keeps the links on one row. */}
      <span className="flex flex-wrap items-center gap-x-4 min-w-0">
        {shown.map((k) => {
          const href = links[k] as string;
          return (
            <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="link-accent inline-flex items-center justify-center min-h-11 min-w-11 [overflow-wrap:anywhere]" title={href} data-creator-link={k}>
              {NAMES[k]}
            </a>
          );
        })}
      </span>
    </div>
  );
}
