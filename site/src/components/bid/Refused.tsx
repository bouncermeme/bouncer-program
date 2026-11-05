/*
  Why a typed amount was not read (amountInput.ts). The first sentence says
  what happened, in the warning colour; the rest explains, in ordinary text.
  A whole paragraph in the warning colour reads as an alarm, and this is
  only a field that needs retyping.
*/
export function Refused({ why }: { why: string }) {
  const cut = why.indexOf(". ");
  const head = cut < 0 ? why : why.slice(0, cut + 1);
  const rest = cut < 0 ? "" : why.slice(cut + 1);
  return (
    <>
      <span className="text-bad font-medium">{head}</span>
      {rest && <span className="text-text-2">{rest}</span>}
    </>
  );
}
