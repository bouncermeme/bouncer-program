"use client";

import { Info } from "./Info";

/*
  The "i" beside the creator's locked liquidity: the split's dependence on
  Meteora (the founder, 2026-10-22, from the v1 reviews; 872f9c4). One source for
  every page that says the liquidity is locked. "creator" is the create
  page's words, to the creator; "reader" is the same in the third person,
  as the How page has carried it since 872f9c4.
*/
export const METEORA_SPLIT_TEXT = {
  creator: "Your liquidity split runs through Meteora's program. If Meteora ever blocks that step, your share stays locked in the pool until the split can run.",
  reader: "The creator's liquidity split runs through Meteora's program. If Meteora ever blocks that step, the creator's share stays locked in the pool until the split can run.",
} as const;
export const METEORA_SPLIT_LABEL = { creator: "About your liquidity split", reader: "About the creator's liquidity split" } as const;

export function MeteoraSplitInfo({ voice = "creator" }: { voice?: keyof typeof METEORA_SPLIT_TEXT }) {
  return <Info text={METEORA_SPLIT_TEXT[voice]} label={METEORA_SPLIT_LABEL[voice]} />;
}
