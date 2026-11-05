"use client";

import Link from "next/link";
import { YOUR_LAUNCHES_ANCHOR } from "@/lib/bouncer/boardSort";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PauseBanner } from "@/components/launch/PauseBanner";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { BotCheck } from "@/components/bid/BotCheck";
import { SignInStep, useCreatorSession } from "@/components/create/SignInStep";
import { useAccount } from "@/components/wallet/AccountProvider";
import { Reading } from "@/components/create/FeesAndTerms";
import { MeteoraSplitInfo } from "@/components/ui/MeteoraSplitInfo";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { getClient } from "@/lib/bouncer/client";
import { fmtDuration, fmtSol, fmtTime } from "@/lib/bouncer/format";
import { useConfigLive, useNow, useSetupCost } from "@/lib/bouncer/hooks";
import { bpsPct, burnSplitText, fmtVolumePct, GENESIS_OTHER_LAMPORTS, tradingFeeSplit, utf8Length } from "@/lib/bouncer/product";
import { V030 } from "@/lib/bouncer/v030";
import { CREATE_FEE, termChanges, termsFromKey, termsKey, termsOf, type TermChange } from "@/lib/bouncer/terms";
import { uploadToken, UploadRefused } from "@/lib/bouncer/tokenUpload";
import { checkSocials, DESCRIPTION_MAX_CHARS, OFFICIAL_TICKER, type LinkKind, type SocialField, type SocialValues } from "@/lib/bouncer/socialLinks";
import { AttestRefused } from "@/lib/bouncer/attest";
import type { LaunchTerms } from "@/lib/bouncer/types";
import { WINDOW_DEFAULT_SECS, WINDOW_MAX_SECS, WINDOW_MIN_SECS } from "@/lib/bouncer/view";
import { BOUNDS, ERROR_CODE } from "@contract/constants";
import { reviewHref } from "@/lib/review";
import { goToLaunch } from "@/lib/bouncer/goToLaunch";
import { ImageCrop, type Picked } from "@/components/create/ImageCrop";
import { PICK_MAX_BYTES } from "@/lib/bouncer/imageCrop";
import { GIF_REFUSED, HEAD_BYTES, refusedKind, SVG_REFUSED } from "@/lib/bouncer/imagePolicy";
import { hashedListsFrom, reservedIn, reservedTermOf, tickerCharsetOk, walletHash } from "@/lib/bouncer/creationPolicy";

/* Genesis mode and the reserved-name owners as this build knows them: a flag and wallet hashes (next.config.helpers.ts), the server's lists in the form the browser may hold. */
const LISTS = hashedListsFrom(process.env.NEXT_PUBLIC_GENESIS_MODE, process.env.NEXT_PUBLIC_GENESIS_CREATOR_HASHES, process.env.NEXT_PUBLIC_RESERVED_OWNER_HASHES);

/*
  The creator form. Four fields: name, ticker, image, window, every one
  required (the founder's item 7, 2026-10-16: the picture is stored through the
  site's own /api/token and written into the token's metadata). The
  paragraph under the heading, and the lines that repeated it, went in the
  copy pass of 2026-10-02 (the founder, "way too much text"); the heading itself
  became "Start an auction." on 2026-10-16 (item 6). Every other launchpad hands a creator a
  page of tokenomics and blames them for the outcome. Here the floor, the
  minimum bid, the valve, the fee, the LP split and the bond are the Config
  account's, read from the chain and copied onto the launch at genesis; the
  float is half the supply. Those are stated beside the form as guarantees,
  not asked for as inputs. Nothing on this page is a number the site made up:
  what the config does not carry (the rents, Metaplex's fee) is left to the
  wallet's own total at signing rather than guessed here.
*/
/* the founder's item 8 (2026-10-16): three presets beside the slider, 10, 30 and 60 minutes (the proposal; the founder to confirm). */
const WINDOW_CHIPS = [10, 30, 60];
/* The picture's smallest side; the crop step (components/create/ImageCrop.tsx) makes any picture the square the upload route takes (server/imageFile.ts). */
const IMAGE_MIN_SIDE = 64;
/* 24h (the founder, 2026-10-25): no GIFs for now (lib/bouncer/imagePolicy.ts). */
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

export function CreateLaunchView() {
  /* The starting market cap in dollars at the live price; it moves with SOL until a launch settles. */
  const router = useRouter();
  const account = useAccount();
  const now = useNow(30_000);
  /* 0.25: the config as last read, as first read by this page, and a way to read it again at once. */
  const { config, first, failed: configFailed, refresh } = useConfigLive();
  /* 24g: the launch this page created, once it confirms; `stuck` when the page has still not moved FALLBACK_MS later (goToLaunch.ts). */
  const [created, setCreated] = useState<{ href: string; stuck: boolean } | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  /* The picture being cropped (null: none), and the side of the square made from the last one (null: sent as it is). */
  const [picked, setPicked] = useState<Picked | null>(null);
  const [cropped, setCropped] = useState<{ name: string; w: number; h: number } | null>(null);
  const [lastPicked, setLastPicked] = useState<Picked | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /*
    24g (Astra 24f R7-M1, the founder: Create disabled while a crop is pending): the picture shown and the picture sent are
    one selection. While a new file is being read or cropped the form is not ready, so Create cannot send the picture
    accepted before it; each file chosen gets a number, and a read that a newer choice overtook is dropped.
  */
  const [reading, setReading] = useState(false);
  const selection = useRef(0);
  /* 24h (the founder, 2026-10-25): every refusal of the picture is said under the picture's field, the page's and the upload route's alike. */
  const [imageError, setImageError] = useState<string | null>(null);
  const [windowMin, setWindowMin] = useState(WINDOW_DEFAULT_SECS / 60);
  const tx = useTx(account.address);
  /* The picture on its way to the store, before the transaction (tokenUpload.ts). */
  const [uploading, setUploading] = useState(false);
  const busy = tx.busy || uploading;
  /* Image file and upload problems only; a transaction's outcome lives in tx. */
  const [error, setError] = useState<string | null>(null);
  /* Socials A (approved 2026-10-31, Option A): the optional description and links, and a refusal of one by the upload route, said under its own box. */
  const [socials, setSocials] = useState<SocialValues>({ description: "", website: "", x: "", telegram: "" });
  const [socialRefused, setSocialRefused] = useState<{ field: SocialField; text: string } | null>(null);

  const paused = config?.emergencyUpdatePause ?? false;
  /*
    0.25: the six terms stated on this page (the prepay, the liquidity split,
    the floor, the minimum bid, the delivery fee, the deadline) are the ones
    create_launch carries, and the program refuses TermsChanged (6066) if the
    config is different when the transaction arrives. The terms the creator
    has seen are the first ones this page read, or the last ones they said
    they had read. When the config moves away from those the page says what
    changed and creation waits until they have read it, so the terms sent
    are never ones that appeared under the cursor.
  */
  const liveTerms = config ? termsOf(config) : null;
  const [readTerms, setReadTerms] = useState<LaunchTerms | null>(null);
  const seenTerms = readTerms ?? (first ? termsOf(first) : null);
  const changes = seenTerms && liveTerms ? termChanges(seenTerms, liveTerms) : [];
  const termsRefused = tx.failure?.detail.code === ERROR_CODE.TermsChanged;
  /* The program limits bytes, not characters (MetadataTooLong 6032, checklist C-33). */
  const cleanName = name.trim();
  const nameBytes = utf8Length(cleanName);
  const nameOk = nameBytes >= 1 && nameBytes <= BOUNDS.maxName;
  const cleanSymbol = symbol.trim().toUpperCase();
  /* The ticker's alphabet is creationPolicy.ts tickerCharsetOk, the attestation service's (A to Z, 0 to 9, 1 to 10). Copy fix C3 (2026-10-31): one character allowed, as the route takes. */
  const symbolOk = cleanSymbol.length >= 1 && tickerCharsetOk(cleanSymbol) && utf8Length(cleanSymbol) <= BOUNDS.maxSymbol;
  const windowSecs = windowMin * 60;
  /*
    The launch candidate (creationPolicy.ts, the check the attestation service
    runs): a reserved ticker or name, and genesis mode's invite list, said here
    before anything is uploaded or signed. The wallet is compared by its hash.
  */
  const [walletKey, setWalletKey] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!account.address) setWalletKey(null);
    else void walletHash(account.address).then((h) => live && setWalletKey(h), () => live && setWalletKey(null));
    return () => {
      live = false;
    };
  }, [account.address]);
  /* With a valid ticker this is the service's own reservedIn; before the ticker is valid the name is still checked (the ticker's alphabet has its own note). */
  const nameTerm = symbolOk ? null : reservedTermOf(cleanName);
  const reserved = symbolOk ? reservedIn(cleanName, cleanSymbol) : nameTerm ? { field: "name" as const, term: nameTerm, rule: "reserved-term" as const } : null;
  const reservedBlocked = reserved !== null && reserved.rule === "reserved-term" && !(walletKey !== null && LISTS.owners.has(walletKey));
  const inviteOnly = LISTS.genesisOn && !(walletKey !== null && LISTS.genesis.has(walletKey));
  /*
    22e3, the copycat block (23c: copycat v2, server/ticker.ts and server/reservations.ts): whether another launch or a
    launch being created holds this ticker, asked of /api/ticker once the ticker is valid and a wallet is connected.
    The creation permit decides; this lets the form say so before anything is signed. A failed check says nothing
    here: the permit then refuses with its own line.
  */
  const tickerAsk = symbolOk && !reservedBlocked && account.address ? `${cleanSymbol}|${account.address}` : null;
  const [tickerAnswer, setTickerAnswer] = useState<{ ask: string; hold: string | null } | null>(null);
  useEffect(() => {
    if (!tickerAsk) return;
    let live = true;
    const [s, w] = tickerAsk.split("|");
    const t = setTimeout(() => {
      fetch(`/api/ticker?s=${encodeURIComponent(s)}&w=${encodeURIComponent(w)}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ hold: string | null }>) : null))
        .then((j) => live && j && setTickerAnswer({ ask: tickerAsk, hold: typeof j.hold === "string" ? j.hold : null }), () => undefined);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tickerAsk]);
  const tickerHold = tickerAnswer && tickerAnswer.ask === tickerAsk ? tickerAnswer.hold : null;
  const tickerLine = tickerHold === "live" ? "That ticker is taken by a live launch." : tickerHold === "trading" ? "That ticker is taken by a token that's trading." : tickerHold === "paying" ? "That ticker is taken by a launch paying out." : tickerHold === "pending" ? "That ticker is taken by a launch being created." : null;
  /* The ticker BOUNCER from the creator wallet (a reserved owner) may carry Bouncer's own links; no other launch may. */
  const officialToken = symbolOk && cleanSymbol === OFFICIAL_TICKER && !reservedBlocked;
  const social = checkSocials(socials, officialToken);
  const socialsOk = social.ok && socialRefused === null;
  const ready = nameOk && symbolOk && !reservedBlocked && tickerLine === null && image !== null && picked === null && !reading && windowSecs >= WINDOW_MIN_SECS && windowSecs <= WINDOW_MAX_SECS;
  /* 0.29, the seventh candidate: every creation needs the bot check's token for its creation permit (no waiver). */
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  /* 23c: the creator sign-in (SignInStep.tsx): a permit reserves the ticker, so the wallet proves itself once a day first. */
  const session = useCreatorSession(account.address);
  /* 24c (M3): a create refused for the session (it ran out on this open page): the sign-in step comes back with its line, in place of the failure note. */
  const sessionRefused = tx.failure?.detail.cause instanceof AttestRefused && tx.failure.detail.cause.reason === "session";
  const { expire } = session;
  const { reset: resetTx } = tx;
  useEffect(() => {
    if (!sessionRefused) return;
    expire();
    resetTx();
  }, [sessionRefused, expire, resetTx]);
  const canSubmit = ready && socialsOk && config !== null && !paused && !inviteOnly && !busy && !account.signProblem && changes.length === 0 && botToken !== null && session.signedIn === true;
  const closesAt = now ? Math.floor(now / 1000) + windowSecs : null;

  /*
    What genesis costs, from a simulation against this RPC: the bond, the
    rents and Metaplex's fee, as the runtime charges them (on the local
    validator the simulated figure matched the creator's debit to the
    lamport, STATUS-frontend.md step 3). The figure does not depend on the
    name, the ticker or the window, so it is simulated once per wallet and
    set of terms, with placeholders. 0.25: the simulation states the terms
    on the page, as the real transaction will.

    the founder's item 17 (2026-10-16): the wallet's balance is read first, and
    again every 30 seconds. A wallet that cannot pay is told so in the page's
    words, with its balance, and nothing is simulated for it; the simulation
    runs again whenever the balance changes (on 2026-10-16 the page simulated
    once against a wallet funded three minutes later and kept the refusal,
    with the RPC's error name, "AccountNotFound", on the page). Any other
    failure is one fixed sentence.
  */
  const [held, setHeld] = useState<{ address: string; lamports: bigint } | null>(null);
  useEffect(() => {
    const address = account.address;
    if (!address) return;
    let live = true;
    getClient()
      .getBalanceLamports(address)
      .then((lamports) => live && setHeld({ address, lamports }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account.address, now]);
  const balance = held && held.address === account.address ? held.lamports : null;
  /*
    0.29: the launch cost, stated before anything else about money (the
    histogram, the launch account and the vault: rent kept on chain for good,
    never refunded; product.ts, setupCost); in SOL since 24g, a line of the
    cost block like the others.
  */
  const setup = useSetupCost();
  /* What createLaunch itself requires before any prompt: the prepay, the launch cost and an allowance for the token's accounts and the fees (chainClient.requireBalance). */
  const needAtLeast = config && setup ? config.crankBond + setup.total + GENESIS_OTHER_LAMPORTS : null;
  const cannotPay = balance !== null && needAtLeast !== null && balance < needAtLeast;
  const [estimate, setEstimate] = useState<{ key: string; cost: bigint | null; failed: boolean } | null>(null);
  const liveKey = liveTerms ? termsKey(liveTerms) : null;
  const estimateKey = account.address && liveKey && !paused && balance !== null && !cannotPay ? `${account.address}|${liveKey}|${balance.toString()}` : null;
  useEffect(() => {
    const address = account.address;
    if (!estimateKey || !address || !liveKey) return;
    let live = true;
    getClient()
      .estimateCreateCost({ name: "Doorman", symbol: "DOOR", image: null, windowSecs: WINDOW_DEFAULT_SECS, terms: termsFromKey(liveKey) }, address)
      .then((cost) => live && setEstimate({ key: estimateKey, cost, failed: false }))
      .catch(() => live && setEstimate({ key: estimateKey, cost: null, failed: true }));
    return () => {
      live = false;
    };
  }, [estimateKey, account.address, liveKey]);
  const est = estimate && estimate.key === estimateKey ? estimate : null;
  const split = config ? tradingFeeSplit(config.creatorLpBps) : null;

  async function onImage(file: File | null) {
    if (!file || busy) return;
    const mine = ++selection.current;
    const current = () => selection.current === mine;
    setReading(false);
    setImageError(null);
    /* 24h: the kinds refused by the page and the upload route alike, by type and name, then by the file's first bytes (a GIF or SVG renamed). */
    const byName = refusedKind(new Uint8Array(0), file.name, file.type);
    if (byName) {
      setImageError(byName === "gif" ? GIF_REFUSED : SVG_REFUSED);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setImageError("That file is not an image");
      return;
    }
    /* 2026-10-25 (the founder approved the crop mock): any picture up to 20 MB; the crop step makes it the square the upload route takes. */
    if (file.size > PICK_MAX_BYTES) {
      setImageError("Keep the image under 20 MB");
      return;
    }
    setReading(true);
    const unread = () => {
      if (!current()) return;
      setReading(false);
      setImageError("That file could not be read as an image");
    };
    let head: Uint8Array;
    try {
      head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    } catch {
      return unread();
    }
    if (!current()) return;
    const byBytes = refusedKind(head);
    if (byBytes) {
      setReading(false);
      setImageError(byBytes === "gif" ? GIF_REFUSED : SVG_REFUSED);
      return;
    }
    const reader = new FileReader();
    reader.onerror = unread;
    reader.onload = () => {
      if (!current()) return;
      const url = typeof reader.result === "string" ? reader.result : null;
      if (!url) return unread();
      const probe = new Image();
      probe.onload = () => {
        if (!current()) return;
        setReading(false);
        const w = probe.naturalWidth;
        const h = probe.naturalHeight;
        if (!(w > 0 && h > 0) || Math.min(w, h) < IMAGE_MIN_SIDE) {
          setImageError("Use an image at least 64 pixels a side");
          return;
        }
        setPicked({ url, name: file.name, type: file.type, bytes: file.size, w, h });
      };
      probe.onerror = unread;
      probe.src = url;
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    const signer = account.signer;
    /* 24g (R7-M1): never while a newer picture is being read or cropped; the picture sent is the one shown. */
    if (!signer || !canSubmit || !seenTerms || !image || picked !== null || reading) return;
    setError(null);
    /*
      0.25: the terms sent are the held ones, the first this page read or the
      last the creator said they had read. Never the latest read. A re-read
      can change what the page shows, and then it blocks this button until
      the creator acknowledges the change; it cannot change what is sent.
      Passing a fresh read here would compare the config with itself and the
      program's check would always pass.
    */
    const terms = seenTerms;
    /* The picture and the metadata file first, to the site's own store (tokenUpload.ts); the URI it answers is what create_launch carries. A refusal is the site's own sentence, shown under the button; nothing was sent. */
    let uri: string;
    setUploading(true);
    try {
      uri = (await uploadToken({ name: cleanName, symbol: cleanSymbol, image, ...social.clean })).uri;
    } catch (e) {
      /* 24h: a refusal of the picture itself goes under its field; the rest (the store, the day's uploads, the name) stays by the button. */
      if (e instanceof UploadRefused && e.field === "image") setImageError(e.message);
      else if (e instanceof UploadRefused && e.field !== null && e.field !== "image") setSocialRefused({ field: e.field, text: e.message });
      else setError(e instanceof UploadRefused ? e.message : "The picture could not be stored just now. Try again in a minute.");
      return;
    } finally {
      setUploading(false);
    }
    const r = await tx.run((onStage) => getClient().createLaunch({ name: cleanName, symbol: cleanSymbol, image, uri, windowSecs, terms, botToken }, signer, { onStage }));
    /* A token verifies once: the widget is asked for a fresh one whatever happened. */
    setBotToken(null);
    setBotReset((n) => n + 1);
    if (r) {
      const href = reviewHref(`/launch/${r.id}`);
      setCreated({ href, stuck: false });
      goToLaunch({ push: (h) => router.push(h), path: () => window.location.pathname, assign: (h) => window.location.assign(h), later: setTimeout }, href, window.location.pathname, () => setCreated({ href, stuck: true }));
    }
    /* Whatever refused it, read the config again now: if the terms moved, the page says so, with what changed. */
    else refresh();
  }

  return (
    <div className="pt-5 md:pt-8 md:grid md:grid-cols-12 md:gap-8">
      <div className="md:col-span-7 lg:col-span-6">
        <div className="reveal" style={{ "--i": 0 } as React.CSSProperties}>
          <p className="text-text-3">Create</p>
          <h1 className="display-xl text-[2rem] md:text-[2.5rem] mt-2">Start an auction.</h1>
        </div>

        {/* C-07: the emergency update pause, disclosed wherever a launch can be created. */}
        {config && paused && (
          <div className="mt-6">
            <PauseBanner config={{ ...config, emergencyUpdatePause: true }} />
          </div>
        )}

        {/* The whole form: one panel, four fields. */}
        <section className="panel p-4 md:p-6 mt-6 reveal" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-[1fr_10rem]">
            <div>
              <label htmlFor="name" className="font-semibold text-[1.125rem]">
                <Num n={1} /> Name
              </label>
              {/* Astra's frontend review of 2026-10-21, F6: each field names its own error line for screen readers, and says when it is invalid. */}
              <input
                id="name"
                className="field mt-2 text-[1.25rem] py-3"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Night Owl"
                autoComplete="off"
                aria-invalid={nameBytes > BOUNDS.maxName}
                aria-describedby={nameBytes > 24 ? "name-note" : undefined}
              />
              {nameBytes > BOUNDS.maxName ? (
                <p id="name-note" className="text-bad mt-2 num">
                  {nameBytes} bytes; the program allows {BOUNDS.maxName}. Bytes, not letters: accents and symbols count more than one.
                </p>
              ) : (
                nameBytes > 24 && (
                  <p id="name-note" className="text-text-3 mt-2 num">
                    {nameBytes} of {BOUNDS.maxName} bytes
                  </p>
                )
              )}
            </div>
            <div>
              <label htmlFor="ticker" className="font-semibold text-[1.125rem]">
                <Num n={2} /> Ticker
              </label>
              <input
                id="ticker"
                className="field mt-2 text-[1.25rem] py-3 uppercase"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, BOUNDS.maxSymbol))}
                placeholder="OWL"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={symbol.length > 0 && !symbolOk}
                aria-describedby={symbol.length > 0 && !symbolOk ? "ticker-note" : undefined}
              />
            </div>
          </div>
          {symbol.length > 0 && !symbolOk && (
            <p id="ticker-note" className="text-bad mt-2" role="alert">
              1 to {BOUNDS.maxSymbol} characters, A to Z or 0 to 9 only.
            </p>
          )}
          {reservedBlocked && (
            <p className="text-bad mt-2" role="alert" data-create-reserved={reserved.field}>
              {reserved.field === "symbol" ? "This ticker" : "This name"} is reserved. Pick another.
            </p>
          )}
          {tickerLine && (
            <p className="text-bad mt-2" role="alert" data-create-taken>
              {tickerLine}
            </p>
          )}
          {inviteOnly && (
            <p className="text-text-2 mt-4 rounded-[8px] px-4 py-3" style={{ background: "var(--note-soft)" }} role="note" data-create-invite-only>
              Creating launches is invite-only for now. Anyone can bid. Creation opens to everyone soon.
            </p>
          )}

          <div className="mt-6">
            <p className="font-semibold text-[1.125rem]">
              <Num n={3} /> Image
            </p>
            <label className="mt-2 flex items-center gap-4 inset p-3 cursor-pointer hover:border-line-2 transition">
              <span
                className="shrink-0 w-16 h-16 rounded-[12px] bg-panel-3 flex items-center justify-center text-text-3 overflow-hidden"
                style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
              >
                {(picked?.url ?? image) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={picked?.url ?? image ?? undefined} alt="" className="w-full h-full object-cover" />
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="3" />
                    <circle cx="9" cy="10" r="2" />
                    <path d="M21 16l-5-5-8 8" />
                  </svg>
                )}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{picked ? picked.name : (imageName ?? "Choose an image")}</span>
                <span className="block text-text-3">
                  {picked ? (
                    <>
                      {picked.w} × {picked.h}. Crop it to a square.
                    </>
                  ) : cropped ? (
                    <>
                      Cropped to {cropped.w} × {cropped.h}.{" "}
                      <button
                        type="button"
                        className="underline"
                        onClick={(e) => {
                          e.preventDefault();
                          if (lastPicked) setPicked(lastPicked);
                        }}
                      >
                        Crop again
                      </button>
                    </>
                  ) : (
                    "A PNG, JPEG or WebP, under 20 MB. You'll crop it to a square."
                  )}
                </span>
              </span>
              <input
                ref={fileInput}
                type="file"
                accept={IMAGE_TYPES}
                className="sr-only"
                onChange={(e) => {
                  void onImage(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
            {imageError && (
              <p className="text-bad mt-2" role="alert" data-image-error>
                {imageError}
              </p>
            )}
            {picked && (
              <ImageCrop
                picked={picked}
                onCancel={() => {
                  setPicked(null);
                  fileInput.current?.click();
                }}
                onUse={(url, side) => {
                  setImageError(null);
                  setImage(url);
                  setImageName(picked.name);
                  setCropped({ name: picked.name, w: side ?? picked.w, h: side ?? picked.h });
                  setLastPicked(picked);
                  setPicked(null);
                }}
              />
            )}
          </div>

          <SocialFields
            values={socials}
            onChange={(v) => {
              setSocials(v);
              /* The route judged all four together, so an edit to any box clears its refusal (one under a box that was right, or empty, would otherwise hold the button). */
              setSocialRefused(null);
            }}
            checked={social}
            refused={socialRefused}
          />

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-semibold text-[1.125rem]">
                <Num n={4} /> Window
              </p>
              <p className="figure text-[1.75rem]">{fmtDuration(windowSecs)}</p>
            </div>
            <p className="text-text-2">
              Fixed once set.
            </p>
            <input
              type="range"
              className="cap-range mt-3"
              min={WINDOW_MIN_SECS / 60}
              max={WINDOW_MAX_SECS / 60}
              step={1}
              value={windowMin}
              onChange={(e) => setWindowMin(Number(e.target.value))}
              style={{ "--p": (windowMin - WINDOW_MIN_SECS / 60) / ((WINDOW_MAX_SECS - WINDOW_MIN_SECS) / 60) } as React.CSSProperties}
              aria-label={`Window length in minutes, ${WINDOW_MIN_SECS / 60} to ${WINDOW_MAX_SECS / 60}`}
            />
            <div className="flex justify-between text-text-3 num -mt-1 mb-2">
              <span>{WINDOW_MIN_SECS / 60} min</span>
              <span>{WINDOW_MAX_SECS / 60} min</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-1">
              {WINDOW_CHIPS.map((m) => (
                <button key={m} type="button" className="chip num shrink-0" data-on={windowMin === m} onClick={() => setWindowMin(m)}>
                  {m} min
                </button>
              ))}
            </div>
            {closesAt && <p className="text-text-3 mt-2 num">Closes at {fmtTime(closesAt)} if created now.</p>}
          </div>
        </section>

        {/* sign */}
        <section className="panel p-4 md:p-5 mt-4 reveal" style={{ "--i": 2 } as React.CSSProperties}>
          {account.address ? (
            <>
              {/*
                24g (the founder's pick A, 2026-10-25, review/2026-10-25-founder-issues/fees-copy-mock): four lines and a total.
                The launch cost (rent, kept on chain), the operating prepay (what the steps do not spend returns), the two
                network fees (the bot check's signature is charged like the creator's), and the total this page computed
                for the transaction. Until there is a total, the line in its place says why, in the page's words.
                24i (the founder, 2026-10-25): a figure not read yet shows "…" (the page's placeholder), not "Reading".
              */}
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2" data-launch-cost={setup ? setup.total.toString() : ""}>
                <CostLine label="Launch cost" note="Kept on chain, not refunded" value={setup ? fmtSol(setup.total) : "…"} />
                <CostLine label="Operating prepay" note="Unused part returned" value={config ? fmtSol(config.crankBond) : "…"} />
                <CostLine label="Network fee" value={fmtSol(CREATE_FEE)} />
                {est?.cost != null && !cannotPay && !paused && <CostLine label="Total now" value={fmtSol(est.cost)} strong />}
              </dl>
              {/* the founder's item 17: the total, or why there is none yet, in the page's words. Never an error name. */}
              <p className="text-text-2 leading-snug mt-2 empty:hidden" data-create-cost={cannotPay ? "cannot-pay" : est?.cost != null ? "computed" : est?.failed ? "failed" : "pending"}>
                {config === null ? (
                  <>{configFailed ? "The program's config was not read just now; trying again." : "Reading the program's config."}</>
                ) : paused ? null : balance === null ? (
                  <>Reading your wallet.</>
                ) : cannotPay ? (
                  <>
                    This wallet holds <span className="num text-text">{fmtSol(balance)}</span>. Creating needs about <span className="num text-text">{fmtSol(needAtLeast ?? 0n)}</span>; add SOL and the total appears here.
                  </>
                ) : est?.cost != null ? null : est?.failed ? (
                  <>The total could not be read just now. Your wallet shows the exact total before you sign.</>
                ) : (
                  <>Reading the total.</>
                )}
              </p>
              <Link href="/fees" className="link-accent inline-flex items-center min-h-11">Fees and terms</Link>
              {session.signedIn === false && account.signer && <SignInStep busy={session.busy} tryAgain={session.tryAgain} problem={session.problem} onSignIn={() => account.signer && session.signIn(account.signer)} />}
              {/* 0.29, the seventh candidate: the bot check before every new launch. No waiver: while it is down, new launches wait. */}
              <div className="mt-4" data-bot-check>
                <BotCheck onToken={setBotToken} resetKey={botReset} action="create" />
              </div>
              <button type="button" className="btn btn-primary w-full text-[1.125rem] mt-4" disabled={!canSubmit || created !== null} onClick={submit}>
                {created ? "Launch created" : uploading ? "Storing the picture" : busy && tx.stage ? stageLabel(tx.stage, now) : paused ? "Launch creation is paused" : config === null ? (configFailed ? "Config not read just now; trying again" : "Reading the program's config") : changes.length > 0 ? "Read what changed, below" : !ready ? "Fill in the four fields" : !socialsOk ? "Fix the description or links" : session.signedIn !== true ? "Sign in first" : botToken === null ? "Running the bot check" : `Create ${cleanSymbol} for ${fmtDuration(windowSecs)}`}
              </button>
              {created?.stuck && (
                <p className="mt-3 text-text-2 leading-snug" role="status" data-launch-live>
                  Your launch is live.{" "}
                  <a href={created.href} className="link-accent">
                    Open it
                  </a>
                </p>
              )}
              <StageLine stage={tx.stage} />
              {account.signProblem && <p className="mt-3 text-text-2 leading-snug">{account.signProblem}</p>}
              {termsRefused || changes.length > 0 ? (
                <TermsNote
                  refused={termsRefused}
                  landed={tx.failure?.kind === "landedFailed"}
                  changes={changes}
                  onRead={() => {
                    setReadTerms(liveTerms);
                    tx.reset();
                  }}
                  onRetry={submit}
                />
              ) : (
                <FailureNote failure={tx.failure} onRetry={submit} />
              )}
            </>
          ) : (
            <>
              <p className="font-semibold text-[1.125rem] mb-3">Connect to launch</p>
              <ConnectButton size="full" tone="primary" />
            </>
          )}
          {error && <p className="mt-3 text-bad">{error}</p>}
        </section>
      </div>

      <aside className="md:col-span-5 lg:col-span-5 lg:col-start-8 mt-8 md:mt-0 md:pt-12">
        <div className="panel-2 p-4 md:p-5 md:sticky md:top-24">
          <dl className="flex flex-col gap-5">
            {/* the founder's item 10 (2026-10-16): the two fees a creator earns from, never merged. The launch fee from the config the creator signs (Config 184, 186); the trading fee shares from the pool's fixed 1% and Meteora's 20% (product.ts, tradingFeeSplit). */}
            {(!config || config.raiseFeeBps > 0) && (
              <div data-raise-fee-terms>
                <dt className="text-text-3">You earn</dt>
                <dd className="figure text-[1.75rem] mt-1">{config ? bpsPct((config.raiseFeeBps * config.raiseFeeCreatorShareBps) / 10_000) : <Reading failed={configFailed} />}</dd>
                {config && (
                  <dd className="text-text-2 leading-snug mt-1">
                    of the raise, in SOL, when the pool is created.
                  </dd>
                )}
              </div>
            )}
            <div data-trading-fee-terms>
              <dt className="text-text-3">Trading fees</dt>
              <dd className="figure text-[1.75rem] mt-1">{split ? fmtVolumePct(split.creatorPct) : <Reading failed={configFailed} />}</dd>
              {config && split && (
                <dd className="text-text-2 leading-snug mt-1">
                  of all trading volume, for as long as it trades. Collect any time with <Link href={`/#${YOUR_LAUNCHES_ANCHOR}`} className="link">Collect fees</Link>. <MeteoraSplitInfo />
                </dd>
              )}
            </div>
          </dl>
          {config && split && (
            <p className="text-text-3 leading-snug mt-4" data-bouncer-share>
              {/* C-3 (SHIPS WITH v0.30, the burn). */}
              Bouncer gets {bpsPct((config.raiseFeeBps * (10_000 - config.raiseFeeCreatorShareBps)) / 10_000)} of the raise and {fmtVolumePct(split.bouncerPct)} of volume{V030 ? `: ${burnSplitText(split.bouncerPct)}` : ""}.
            </p>
          )}
          <p className="hairline mt-5 pt-4">
            <Link href="/fees" className="link-accent">
              Fees and terms
            </Link>
          </p>
        </div>
      </aside>
    </div>
  );
}

/*
  TermsChanged (6066), written for the person it happens to: a creator can
  hit it through no fault of their own, when the platform's terms for new
  launches are updated between the page showing them and the transaction
  arriving. Money first, then what changed, then what to do. No error name
  and no number. The same note, with another first line, when the terms
  move while the page is open and nothing has been sent.
*/
function TermsNote({ refused, landed, changes, onRead, onRetry }: { refused: boolean; landed: boolean; changes: TermChange[]; onRead: () => void; onRetry: () => void }) {
  return (
    <div className="inset p-4 mt-3" role="alert">
      <p className="font-semibold text-text">{refused ? "The launch terms changed while you were signing." : "The launch terms changed while this page was open."}</p>
      <p className="text-text-2 mt-1 leading-snug">
        {refused ? (landed ? "No launch was created. The network fee was paid; nothing else left your wallet." : "Nothing was sent and nothing left your wallet.") : "Nothing was sent."}{" "}
        {refused ? "A launch is only ever created under the terms its creator was shown, so yours was refused rather than created under different ones." : "A launch is only ever created under the terms its creator was shown."}
      </p>
      {changes.length > 0 ? (
        <>
          <p className="text-text-2 mt-3">This page now shows the current terms. What changed:</p>
          <ul className="mt-2 flex flex-col gap-2">
            {changes.map((c) => (
              <li key={c.label} className="leading-snug">
                <span className="text-text">{c.label}</span>
                <span className="text-text-2">
                  : was <span className="num">{c.was}</span>, now <span className="num text-text">{c.now}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-text-2 mt-3 leading-snug">If you still agree, create again and your wallet will ask you to sign the new terms.</p>
          <button type="button" className="btn btn-secondary w-full mt-3" onClick={onRead}>
            I have read the new terms
          </button>
        </>
      ) : (
        <>
          <p className="text-text-2 mt-3 leading-snug">Reading the current terms. If they show no difference here, they have already changed back; try again.</p>
          <button type="button" className="btn btn-secondary w-full mt-3" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

/*
  Socials A (approved 2026-10-31, Option A; SOCIALS-A-SPEC.md section 2, review/2026-10-30-socials-mock): four
  optional boxes between the picture and the window, written into the token's metadata file with the name, the ticker and the picture, so fixed once the
  launch exists. Not numbered: items 1 to 4 are the ones every launch needs. A link's sentence shows once its box is
  left, and the link then reads as it will be stored (@name as https://x.com/name, no share query); the description's
  shows at once, beside its count.
*/
const LINK_FIELDS: readonly { field: LinkKind; label: string; placeholder: string; url: boolean }[] = [
  { field: "website", label: "Website", placeholder: "https://", url: true },
  { field: "x", label: "X", placeholder: "@handle or x.com link", url: false },
  { field: "telegram", label: "Telegram", placeholder: "@group or t.me link", url: false },
];

function SocialFields({ values, onChange, checked, refused }: { values: SocialValues; onChange: (v: SocialValues, field: SocialField) => void; checked: ReturnType<typeof checkSocials>; refused: { field: SocialField; text: string } | null }) {
  const [left, setLeft] = useState<Partial<Record<SocialField, boolean>>>({});
  const line = (f: SocialField): string | null => (refused?.field === f ? refused.text : f === "description" || left[f] ? checked.errors[f] : null);
  const set = (f: SocialField, v: string) => onChange({ ...values, [f]: v }, f);
  const leave = (f: LinkKind) => {
    setLeft((l) => ({ ...l, [f]: true }));
    const c = checked.clean[f];
    if (c && c !== values[f]) set(f, c);
  };
  const descLine = line("description");
  const chars = checked.descriptionChars;
  return (
    <div className="mt-6" data-socials>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-semibold text-[1.125rem]">Description and links</p>
        <p className="text-text-3">Optional</p>
      </div>
      <label htmlFor="description" className="block font-medium mt-3">
        Description
      </label>
      <textarea
        id="description"
        className="field mt-1.5 resize-none leading-snug"
        rows={4}
        value={values.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="What is this token?"
        aria-invalid={descLine !== null}
        aria-describedby={descLine ? "description-note description-count socials-note" : "description-count socials-note"}
        data-social-field="description"
      />
      <div className="mt-2 flex items-start justify-between gap-3">
        {descLine ? (
          <p id="description-note" className="text-bad" role="alert">
            {descLine}
          </p>
        ) : (
          <span />
        )}
        <p id="description-count" className={`num shrink-0 ${chars > DESCRIPTION_MAX_CHARS ? "text-bad" : "text-text-3"}`}>
          {chars}/{DESCRIPTION_MAX_CHARS}
        </p>
      </div>
      {LINK_FIELDS.map(({ field, label, placeholder, url }) => {
        const msg = line(field);
        return (
          <div key={field} className="mt-3">
            <label htmlFor={`link-${field}`} className="block font-medium">
              {label}
            </label>
            <input
              id={`link-${field}`}
              type={url ? "url" : "text"}
              inputMode={url ? "url" : "text"}
              className="field mt-1.5"
              value={values[field]}
              onChange={(e) => set(field, e.target.value)}
              onBlur={() => leave(field)}
              placeholder={placeholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={msg !== null}
              aria-describedby={msg ? `link-${field}-note socials-note` : "socials-note"}
              data-social-field={field}
            />
            {msg && (
              <p id={`link-${field}-note`} className="text-bad mt-2" role="alert">
                {msg}
              </p>
            )}
          </div>
        );
      })}
      <p id="socials-note" className="text-text-2 mt-3">These go into the token&apos;s file for good. They cannot be changed after you create.</p>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-panel-3 text-text-2 num text-[1rem] align-[-2px] mr-1.5" aria-hidden="true">
      {n}
    </span>
  );
}

/* 24g: one line of the create page's cost block, as in the mock: the label, its note under it, the figure right. */
function CostLine({ label, note, value, strong = false }: { label: string; note?: string; value: string; strong?: boolean }) {
  const edge = strong ? "font-semibold pt-2 border-t border-line" : "";
  return (
    <>
      <dt className={edge}>
        {label}
        {note && <span className="block text-text-3 text-[0.875rem] leading-snug">{note}</span>}
      </dt>
      <dd className={`num text-right ${edge}`}>{value}</dd>
    </>
  );
}
