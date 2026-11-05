/*
  The token's name, symbol and image. Name and symbol are on chain in the
  Metaplex metadata account genesis writes (the program passes them through
  with the byte limits in BOUNDS); the image is the one the metadata URI's
  JSON names, fetched best effort and never required. Decimals are read from
  the mint itself rather than assumed.

  Since 2026-10-20 (S3, ownStore.ts) the URI is read only when it is the
  site's own metadata file, and from this site's store, and its image is
  kept only when it is the same store's picture: no request goes to a host
  a creator named, and no other origin's picture is shown.
*/
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_DECIMALS } from "@contract/constants";
import { shortAddr } from "../format";
import type { TokenMeta } from "../types";
import { readU32 } from "./borsh";
import { metadataPda } from "./pda";
import { ownMetadataPath, ownPicturePath, ownUrl } from "../ownStore";
import { checkDescription, creatorLinksOf, OFFICIAL_TICKER } from "../socialLinks";

/* Metaplex Metadata: key u8, update_authority 32, mint 32, then Data { name, symbol, uri: Borsh strings padded with zero bytes }. */
export function decodeMetadata(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  try {
    let o = 1 + 32 + 32;
    const str = () => {
      const len = readU32(data, o);
      o += 4;
      const s = new TextDecoder().decode(data.subarray(o, o + len)).replace(/\0+$/g, "").trim();
      o += len;
      return s;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/* SPL Mint: decimals at offset 44. */
const MINT_DECIMALS_OFFSET = 44;

/*
  The longest text the pages will print for each field. The program stores at
  most 32 bytes of name and 10 of symbol (BOUNDS), and Metaplex holds the same
  limits for a 0.18 launch, so on chain neither can be longer; the cut is here
  so that no page depends on that. The description comes from the creator's
  own JSON and has no limit of its own. Counted in characters, cut on a
  character boundary, marked with an ellipsis.
*/
const MAX_NAME_CHARS = 32;
const MAX_SYMBOL_CHARS = 10;
const MAX_DESCRIPTION_CHARS = 280;

export function clipText(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join("")}…`;
}

const cache = new Map<string, Promise<TokenMeta>>();

export function fetchTokenMeta(connection: Connection, mint: string, creator: string, fromLaunch: { name: string; symbol: string; uri: string } | null = null): Promise<TokenMeta> {
  const hit = cache.get(mint);
  if (hit) return hit;
  const p = (async (): Promise<TokenMeta> => {
    const mintKey = new PublicKey(mint);
    /* Since 0.19 the launch account carries its names and the mint is created with the pinned TOKEN_DECIMALS, so nothing is read from the RPC. Only a launch created under 0.18 needs its Metaplex account and mint. */
    const [metaInfo, mintInfo] = fromLaunch ? [null, null] : await connection.getMultipleAccountsInfo([metadataPda(mintKey), mintKey]);
    const decimals = mintInfo && mintInfo.data.length > MINT_DECIMALS_OFFSET ? mintInfo.data[MINT_DECIMALS_OFFSET] : TOKEN_DECIMALS;
    /* Since 0.19 the launch account carries the names from genesis and the metadata account exists only after the pool opens; both say the same then. */
    const md = fromLaunch ?? (metaInfo ? decodeMetadata(Uint8Array.from(metaInfo.data)) : null);
    const meta: TokenMeta = {
      mint,
      name: clipText(md?.name ?? "", MAX_NAME_CHARS) || shortAddr(mint, 4, 4),
      symbol: clipText(md?.symbol ?? "", MAX_SYMBOL_CHARS) || "TOKEN",
      decimals,
      description: "",
      creator: shortAddr(creator, 4, 4),
    };
    const metaPath = md?.uri ? ownMetadataPath(md.uri) : null;
    if (metaPath) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(ownUrl(metaPath), { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) {
          const json = (await res.json()) as { name?: unknown; symbol?: unknown; image?: string; description?: unknown; website?: unknown; twitter?: unknown; telegram?: unknown };
          const picture = typeof json.image === "string" ? ownPicturePath(json.image) : null;
          if (picture) meta.image = picture;
          /*
            Socials A (2026-10-31): the description and the links only from the launch's own file (its name and ticker
            the launch's), so no launch can borrow another's by naming its file; the picture as before. Both are checked
            again (socialLinks.ts), Bouncer's own links only on the ticker BOUNCER (only the creator wallet can create it).
          */
          const own = md !== null && typeof json.name === "string" && typeof json.symbol === "string" && json.name.trim() === md.name.trim() && json.symbol.trim().toUpperCase() === md.symbol.trim().toUpperCase();
          const d = own && typeof json.description === "string" ? checkDescription(json.description) : null;
          if (d && d.why === null && d.text) meta.description = clipText(d.text, MAX_DESCRIPTION_CHARS);
          const links = own && md ? creatorLinksOf(json, md.symbol.trim().toUpperCase() === OFFICIAL_TICKER) : undefined;
          if (links) meta.links = links;
        }
      } catch {
        /* no image, nothing else changes */
      }
    }
    return meta;
  })();
  cache.set(mint, p);
  p.catch(() => cache.delete(mint));
  return p;
}
