import Link from "next/link";

/* The 404's content (launch candidate, 2026-10-22): the site's dark tones, where Next's default rendered light and unstyled under the header. app/(site)/not-found.tsx and app/global-not-found.tsx draw it in the site's frame. */
export function NotFoundBody() {
  return (
    <div className="pt-12 md:pt-20 max-w-[46rem] text-base" data-not-found>
      <p className="display text-brand-text text-[1.25rem]">404</p>
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight mt-1 text-text">This page does not exist.</h1>
      <p className="text-text-2 text-[1.125rem] mt-2 leading-snug">The link may be wrong, or the launch address mistyped.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/" className="btn btn-primary min-h-11 px-5">
          Launches
        </Link>
        <Link href="/how" className="btn btn-secondary min-h-11 px-5">
          How it works
        </Link>
      </div>
    </div>
  );
}
