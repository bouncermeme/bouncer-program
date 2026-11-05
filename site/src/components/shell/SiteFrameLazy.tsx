"use client";

import dynamic from "next/dynamic";

/*
  The site's frame for app/global-not-found.tsx (tag 31d). Next loads that page's code on every page, the public
  whitepaper's included, so the frame comes through a dynamic import: drawn on the server into the 404 as before, its
  code (the wallet providers, the header) fetched only when the 404 is drawn (the 31c pre-check's G1).
*/
export const SiteFrameLazy = dynamic(() => import("./SiteFrame").then((m) => m.SiteFrame));
