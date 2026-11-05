import { SiteFrame } from "@/components/shell/SiteFrame";
import { RootHtml } from "../rootShell";

export { metadata, viewport } from "../rootShell";

/* The site's root layout (tag 31d): every page but the public whitepaper (app/(public)), in the site's frame (components/shell/SiteFrame.tsx), and its 404 (app/(site)/not-found.tsx; app/global-not-found.tsx for an address no route matches). app/rootShell.tsx says why there are two roots. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <RootHtml>
      <SiteFrame>{children}</SiteFrame>
    </RootHtml>
  );
}
