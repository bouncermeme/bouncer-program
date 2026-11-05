/*
  /llms.txt (llmstxt.org; build lane 2, 2026-10-31, Dispatch's yes): the sitemap's pages as a list a language model can
  read, every word from the pages' own metadata (lib/seo.ts PAGE_META) and nothing new. The title line is the brand;
  the summary under it is LLMS_SUMMARY, the header line build lane 2 drafted (review/2026-10-31-build-lane2/STATUS.md
  section 3), approved as drafted on 2026-10-31. scripts/gen-llms.ts writes public/llms.txt from this; scripts/check-seo.tsx
  holds the file equal to it. The coming-soon gate covers the file like every page (src/proxy.ts).
*/
import { BRAND } from "@/lib/brand";
import { PAGE_META, SITE_PAGES } from "@/lib/seo";

export const LLMS_SUMMARY = "Solana token launches by sealed-bid auction: every winner pays the same clearing price, and what does not fill is refunded.";

export function llmsText(origin: string): string {
  const home = PAGE_META["/"];
  const pages = SITE_PAGES.filter((p) => p !== "/").map((p) => `- [${PAGE_META[p].title}](${origin}${p}): ${PAGE_META[p].description}`);
  return [`# ${BRAND.name}`, "", `> ${LLMS_SUMMARY}`, "", "## Pages", "", `- [${home.title}](${origin}): ${home.description}`, ...pages, ""].join("\n");
}
