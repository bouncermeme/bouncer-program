import { PublicFooter, PublicHeader } from "@/components/shell/PublicShell";
import { RootHtml } from "../rootShell";

export { metadata, viewport } from "../rootShell";

/*
  The public whitepaper's root layout (round 3b's frame, tag 31c; its own root since tag 31d, app/rootShell.tsx): its
  header and footer around the page, and nothing of the site's frame. No wallet providers (their network check reads
  the chain through the gated API), no banner, no guide; this tree imports none of them, so neither their elements nor
  their code reach the page.
*/
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootHtml>
      <PublicHeader />
      <main className="flex-1 w-full max-w-[1120px] mx-auto px-4 pb-10 md:px-8">{children}</main>
      <footer className="w-full max-w-[1120px] mx-auto px-4 md:px-8 pb-10 pt-4 text-text-3">
        <PublicFooter />
      </footer>
    </RootHtml>
  );
}
