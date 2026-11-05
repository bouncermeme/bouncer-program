# Bouncer

The source behind [bouncer.meme](https://bouncer.meme): sealed-bid token launches on Solana.

- `programs/bouncer/` and `crates/auction-core/`: the on-chain program.
- `idl/bouncer.json`: the program's interface (IDL), v0.32.
- `site/`: the web app's source (Next.js).

## The program

- Program id (mainnet-beta): `DK5RcZiHhp5uV99PgwTmBsZWwFJS4G9HrDAsEbPRPu9r`
- Version 0.32. The deployed program is 1,133,112 bytes, sha256 `39e266f45038bfeb03bb222844511fee402dd1a077bb9b368fd0871eb7f41c12`.

### Build

Built with [solana-verify](https://github.com/Ellipsis-Labs/solana-verifiable-build) 0.5.2 in the pinned image:

```
solana-verify build --library-name bouncer --arch v3 \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
```

The result, `target/deploy/bouncer.so`, has the sha256 above.

### Check the deployed program against this source

```
solana-verify verify-from-repo -u https://api.mainnet-beta.solana.com \
  --program-id DK5RcZiHhp5uV99PgwTmBsZWwFJS4G9HrDAsEbPRPu9r \
  https://github.com/bouncermeme/bouncer-program --commit-hash <this commit> \
  --library-name bouncer --arch v3 \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
```

Answer `n` when it asks to upload.

## The site

`site/` is the app source as deployed, without internal notes, test and deploy scripts, or deployment settings.
Keys and endpoints are not included: the app reads them from its environment. The cloud account number in the
attestation signer's role pin is replaced by `000000000000`.
The reviewer packet (`site/src/content/reviewPacket.ts`, `reviewIndex.ts`) is internal and is published empty.
