import type { ReactNode } from "react";
import { Providers } from "@/components/wallet/Providers";
import { AppHeader } from "@/components/shell/AppHeader";
import { NetworkBanner } from "@/components/wallet/NetworkBanner";
import { DevnetBanner } from "@/components/shell/DevnetBanner";
import { BudgetBanner } from "@/components/shell/BudgetBanner";
import { LocalBoardBanner } from "@/components/shell/LocalBoardBanner";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { StorageNotice } from "@/components/shell/StorageNotice";
import { QuickGuide } from "@/components/shell/QuickGuide";
import { BOARD_LOCAL } from "@/lib/board";

/* The site's frame around every page but the public whitepaper (app/(site)/layout.tsx), and around the 404 for an address no route matches (app/global-not-found.tsx, through SiteFrameLazy.tsx). */
export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      {BOARD_LOCAL ? <LocalBoardBanner /> : <DevnetBanner />}
      {/* The day's chain read budget, when it runs short (server/budget.ts); nothing while it is fine. */}
      {!BOARD_LOCAL && <BudgetBanner />}
      <Providers>
        <AppHeader />
        {/* The board's chain is not the pinned devnet by design; its banner says so instead. */}
        {!BOARD_LOCAL && <NetworkBanner />}
        <main className="flex-1 w-full max-w-[1120px] mx-auto px-4 pb-10 md:px-8">{children}</main>
        <footer className="w-full max-w-[1120px] mx-auto px-4 md:px-8 pb-28 md:pb-10 pt-4 text-text-3">
          {/* The founder's items 4 and 9 (2026-10-16): the custody sentence and the live price note are gone from every page's foot; the custody wording stays on the How and Fees pages (siteCluster.ts), the settled minute's rate beside each settled figure. */}
          <SiteFooter />
        </footer>
        <StorageNotice />
        <QuickGuide />
      </Providers>
    </>
  );
}
