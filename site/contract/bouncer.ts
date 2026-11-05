/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bouncer.json`.
 */
export type Bouncer = {
  "address": "DK5RcZiHhp5uV99PgwTmBsZWwFJS4G9HrDAsEbPRPu9r",
  "metadata": {
    "name": "bouncer",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Bouncer: sealed bid uniform price launch auction, decrypted on chain with drand timelock"
  },
  "instructions": [
    {
      "name": "abort",
      "discriminator": [
        73,
        205,
        102,
        177,
        241,
        200,
        145,
        80
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "docs": [
            "The settlement record, or the program id in its place. Unread since 0.22 (the deadline",
            "no longer counts from `settled_ts`); kept so the account list does not change."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "acceptAdmin",
      "docs": [
        "0.24: the proposed admin takes the role by signing."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "acceptLpOwner",
      "docs": [
        "0.24: the proposed fee destination takes effect by signing, so revenue can never be pointed at",
        "an address nobody controls."
      ],
      "discriminator": [
        20,
        128,
        105,
        214,
        71,
        36,
        192,
        197
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newLpOwner",
          "docs": [
            "handler checks both, and refuses `NotProposedLpOwner` otherwise."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "acceptTreasury",
      "docs": [
        "v0.30: the proposed treasury takes effect by signing, as the fee destination does (0.24): the platform's half of",
        "the raise fee can never be pointed at an address nobody controls. A Squads vault signs through a vault transaction."
      ],
      "discriminator": [
        196,
        145,
        81,
        139,
        177,
        13,
        197,
        43
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newTreasury",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "adminEmergencyUpdatePause",
      "docs": [
        "The emergency update pause (0.18, restored under the founder's name). While on,",
        "`create_launch` refuses `EmergencyUpdatePaused`; no other instruction reads",
        "the flag, so a launch already running goes on exactly as before: bids,",
        "close, beacon, reveal, settle, pool, locks, deliveries, refunds, claims,",
        "abort and finalize all work. Its one purpose is a program update: creation",
        "stops so no launch is created under a layout the next build could strand,",
        "the update lands, creation resumes. Disclosed on the page from",
        "`Config.emergency_update_pause` and `emergency_update_pause_ts`, never hidden."
      ],
      "discriminator": [
        206,
        25,
        234,
        104,
        67,
        29,
        249,
        31
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "on",
          "type": "bool"
        }
      ]
    },
    {
      "name": "adminOpenTrading",
      "docs": [
        "v0.30 (the founder: the stall escape is the Squad's break-glass only, no timer): opens trading with bids still",
        "outstanding. The config admin (the Squad after the freeze) signs; nothing else differs from `open_trading`.",
        "Every undelivered bid stays pushable afterwards. The event and `SettlementRecord.opened_forced` record it."
      ],
      "discriminator": [
        224,
        45,
        70,
        149,
        69,
        20,
        175,
        152
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true
        },
        {
          "name": "pool"
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "adminSetBuyback",
      "docs": [
        "v0.30 (the founder, 2026-10-27, the buy-and-burn folded into the core): the ops Squad sets the buy-and-burn's terms",
        "after the BOUNCER genesis (the mint and its canonical pool), the crankers allowed to run it, the cap, the",
        "interval and the price limit. Zeros for the mint and the pool keep `buy_and_burn` refused `BuybackPoolNotSet`",
        "while the burn vault accumulates; a non-zero pool needs a non-zero mint, cap and price limit (`InvalidConfig`).",
        "The clock (`last_buy_ts`) is not an argument and is not reset here."
      ],
      "discriminator": [
        239,
        27,
        224,
        54,
        198,
        131,
        241,
        7
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "buybackArgs"
            }
          }
        }
      ]
    },
    {
      "name": "adminUpdateConfig",
      "discriminator": [
        224,
        243,
        100,
        135,
        120,
        165,
        43,
        244
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "configArgs"
            }
          }
        }
      ]
    },
    {
      "name": "adminWaiveAttestation",
      "docs": [
        "0.29: the admin waives the bid attestation on one running launch (Squad B's per-launch waiver, for a service",
        "outage or a launch that should not gate its bidders). Launch-wide and one direction only: nothing sets the",
        "flag back, new launches follow `Config.attest_bids`, it lands only while the bidding window is open (`Open`",
        "and before `close_ts`; `LaunchNotOpen` otherwise), once (`AttestationAlreadyWaived` after, or on a launch",
        "that never required it), and the time is recorded on the launch (`attest_waived_ts`) beside the event."
      ],
      "discriminator": [
        190,
        235,
        57,
        226,
        148,
        135,
        119,
        143
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "launch",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "burnUnsold",
      "docs": [
        "Burn what is left in the token vault, sweep the lamport dust to the",
        "caller, Finalized. Requires every bid delivered or refunded, and both",
        "LP positions locked."
      ],
      "discriminator": [
        129,
        115,
        92,
        111,
        174,
        198,
        99,
        3
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "settlement",
          "docs": [
            "Present once the launch settled; absent for a failed or aborted launch that never settled."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "Required once the pool exists; the program id in its place for a launch that failed or was",
            "aborted, which never had a mint (0.19)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenVault",
          "docs": [
            "Required once the pool exists; the program id in its place otherwise (0.19)."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "creator",
          "docs": [
            "any account type, since the creator signed genesis and may be a program's PDA."
          ],
          "writable": true
        },
        {
          "name": "poolTokens",
          "docs": [
            "The pool creator PDA's token pass through, holding the opening's leftover reserve atoms (0.21).",
            "Required when `SettlementRecord.dust_tokens_burned` is above 0; the program id in its place otherwise."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "poolCreator",
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "buyAndBurn",
      "docs": [
        "v0.30 (the founder, 2026-10-27, the buy-and-burn folded into the core): a cranker on the config's list swaps the burn",
        "vault's wrapped SOL (at most the cap) for BOUNCER on the canonical pool and burns every atom bought in the same",
        "transaction. Refused `BuybackPoolNotSet` until the Squad set the mint and the pool (the vault accumulates",
        "meanwhile), `NotABurnCranker` for any other signer, `BuybackTooSoon` within the interval of the last buy,",
        "`NothingToBuy` on an empty vault. The price limit: the swap's minimum output is `lamports * 2^64 / max_price`",
        "atoms, or the caller's `min_out` when that is higher; cp-amm refuses the swap (and so the whole instruction,",
        "nothing moves) when the pool's state, a sandwich included, would pay fewer. The caller pays the signature fee",
        "and, the first time, the burn vault's BOUNCER token account."
      ],
      "discriminator": [
        94,
        253,
        83,
        243,
        168,
        14,
        216,
        207
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "cranker",
          "docs": [
            "One of `Config.burn_crankers`; pays the signature fee and, once, the burn vault's BOUNCER token account."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "burnVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "burnVaultWsol",
          "writable": true
        },
        {
          "name": "burnVaultTokens",
          "writable": true
        },
        {
          "name": "bouncerMint",
          "writable": true
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenBVault",
          "writable": true
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "eventAuthority",
          "address": "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "close",
      "discriminator": [
        98,
        165,
        201,
        177,
        108,
        65,
        206,
        96
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "collectParked",
      "docs": [
        "v0.32: the bidder collects its parked payout to destinations it names: the tokens to any token account of the",
        "mint (the token program checks the mint), the lamports and the bid account's own lamports to `destination`.",
        "Only the bidder signs; any launch state (the bid is parked). The bid account is closed."
      ],
      "discriminator": [
        165,
        49,
        228,
        2,
        37,
        237,
        134,
        234
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenVault",
          "docs": [
            "Required when the bid parked tokens; the program id in its place otherwise."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenDestination",
          "docs": [
            "when the bid parked tokens."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "bidder",
          "signer": true
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "collectPlatformFees",
      "docs": [
        "Collect the platform position's trading fees (0.19). Permissionless and",
        "keyless: the only authority in the path is the launch's pool creator",
        "PDA, which owns the platform's position NFT, and it signs through this",
        "program. The payer is any fee payer (a cron's hot key does); it signs",
        "nothing that moves value and pays only for the LP owner's wrapped SOL",
        "account the first time. Fees are paid to `Launch.lp_owner`, the",
        "destination copied from the config at genesis (0.24; until 0.23 the",
        "live `Config.lp_owner`, so one accepted change moved every launch's",
        "accrued fees), as wrapped SOL in its associated token account; the",
        "launch token side (zero under OnlyB) lands in the PDA's own token",
        "account. A change of destination reaches only launches created after",
        "it. Claiming nothing is not an error."
      ],
      "discriminator": [
        191,
        153,
        219,
        164,
        5,
        65,
        153,
        48
      ],
      "accounts": [
        {
          "name": "launch",
          "docs": [
            "and version checked by `launch_fee_view` in the handler, which reads its state, mint and fee destination."
          ]
        },
        {
          "name": "settlement",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "poolCreator",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "lpOwner",
          "docs": [
            "`Config.lp_owner` until 0.23), checked in the handler through the layout table. The config is not in",
            "this instruction's accounts: nothing written after genesis can move this launch's fees."
          ]
        },
        {
          "name": "lpOwnerWsol",
          "writable": true
        },
        {
          "name": "poolTokens",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "platformNftMint"
        },
        {
          "name": "platformPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "platformNftAccount",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  110,
                  102,
                  116,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "pool"
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenBVault",
          "writable": true
        },
        {
          "name": "tokenMint",
          "docs": [
            "The launch token's mint, checked against the launch in the handler (the layout table)."
          ]
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "payer",
          "docs": [
            "Any fee payer; pays the LP owner's wrapped SOL account once. Not an authority over anything."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "eventAuthority",
          "address": "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "commit",
      "discriminator": [
        223,
        140,
        142,
        165,
        229,
        208,
        156,
        74
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "bidder",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "config",
          "docs": [
            "0.29: read for the attestor keys only, and only when the launch requires an attestation; the charge and the",
            "flag are the launch's own copies."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "deposit",
          "type": "u64"
        },
        {
          "name": "sealed",
          "type": {
            "array": [
              "u8",
              128
            ]
          }
        },
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "flags",
          "type": "u8"
        },
        {
          "name": "maxProcessingCharge",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createLaunch",
      "docs": [
        "v0.31 (the founder, 2026-10-28): `close_ts` is the absolute window end the creator chose; the window is",
        "`close_ts` less the landing clock, accepted from `MIN_WINDOW_AT_LANDING_SECS` (240, the approval grace",
        "under the 300 the client may choose; `CloseTooSoon` under it) to `MAX_WINDOW_SECS`. The reveal round is",
        "then a pure function of `close_ts` and the config's margin, so a slow wallet approval shortens the window",
        "and moves nothing else (`window_secs` as an argument until v0.30 timed the window from the landing, and an",
        "approval slower than the client's aim past the earliest round was refused `RevealRoundOutOfRange`).",
        "`reveal_round` is the quicknet round bids are sealed to; the creator supplies it because its hashed",
        "identity is verified from the creator's hints, which are specific to one round. It must be at or after",
        "the first round past `close_ts` + `Config.reveal_margin_secs` and within `REVEAL_ROUND_SLACK` rounds of it.",
        "`round_point` must be that round's hashed identity on G1; the program",
        "derives the identity from `reveal_round` itself (h2c.rs) and refuses",
        "any other point (`InvalidRoundPoint`). `round_hints` are the four",
        "field elements of that derivation the program verifies instead of",
        "computing (two square roots, two inverses; `h2c::hints_for` on the",
        "host, `idl/round-point.ts` for clients); wrong hints are refused with",
        "the same error and cannot change the derived point.",
        "",
        "0.19: the mint is not created here. `token_mint` is the address the mint will have,",
        "the PDA `[\"mint\", creator, mint_salt LE]`, and nothing exists there until `create_pool`.",
        "Name, symbol and URI are checked against Metaplex's limits and kept in the launch;",
        "`create_pool` writes them into the metadata. No token vault, metadata account or",
        "supply exists during bidding, and a launch that fails or is aborted never has any."
      ],
      "discriminator": [
        239,
        223,
        255,
        134,
        39,
        121,
        127,
        62
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenMint",
          "docs": [
            "Nothing is created here; `create_pool` creates the mint. Until 0.18 a fresh keypair signed and",
            "the mint was created at genesis."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "mintSalt"
              }
            ]
          }
        },
        {
          "name": "launch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  97,
                  117,
                  110,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "histogram",
          "docs": [
            "created by the handler at `Histogram::INIT_LEN` (a typed init would read the full struct from the short",
            "account) and grown to `Histogram::LEN` by `grow_histogram` in the same transaction; must not exist yet."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "mintSalt",
          "type": "u64"
        },
        {
          "name": "closeTs",
          "type": "i64"
        },
        {
          "name": "revealRound",
          "type": "u64"
        },
        {
          "name": "roundPoint",
          "type": {
            "array": [
              "u8",
              48
            ]
          }
        },
        {
          "name": "roundHints",
          "type": {
            "array": [
              "u8",
              192
            ]
          }
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        },
        {
          "name": "expected",
          "type": {
            "defined": {
              "name": "launchTerms"
            }
          }
        }
      ]
    },
    {
      "name": "createPool",
      "docs": [
        "Open the launch's Meteora DAMM v2 pool (0.19) on the one config v19",
        "accepts, `meteora::CONFIG`, and lock all of its liquidity forever in the",
        "platform's position. Permissionless.",
        "",
        "The config is checked before anything moves (public, 1 percent flat, no",
        "dynamic fee, OnlyB, static, timestamp activation, full range). The",
        "opening price is computed here from the auction's proceeds,",
        "`float_value` lamports against the reserve half of the supply, with the",
        "largest liquidity whose rounded up deposit fits both; the pool is read",
        "back afterwards and must hold exactly that price, range, liquidity, fee",
        "mode, mints and creator.",
        "",
        "Meteora's payer and pool creator is the launch's `pool_creator` PDA (a",
        "dataless system account this program signs for): it pays the rents",
        "Meteora charges from lamports the payer lends it here, it owns the two",
        "pass through token accounts Meteora pulls from, and it owns the",
        "platform's position NFT for good. What the lent lamports did not cover",
        "goes back to the payer at the end.",
        "",
        "Rounding: Meteora rounds the deposit up, so the liquidity chosen leaves",
        "a few atoms of one or both sides behind. Leftover reserve atoms are",
        "burned (the mint authority is gone, so nobody could ever be owed them",
        "and the supply shrinks by exactly that). Leftover proceeds lamports go",
        "to the payer with the wrapped SOL account's rent, the same path stray",
        "wrapped SOL has taken since 0.17. Both amounts are recorded and emitted.",
        "",
        "The launch token (0.19, the pool squatting fix): the mint, the token vault and the",
        "metadata are created here, not at genesis. Anchor's `init` creates the mint at",
        "`[\"mint\", creator, mint_salt]` (a stranger's lamports at that address are kept, not",
        "refused) and the token vault; this instruction then mints the whole supply into the",
        "vault, writes the Metaplex metadata from the name, symbol and URI kept at genesis,",
        "revokes the mint authority, and opens the pool, all in one instruction. Before it the",
        "mint does not exist, so Meteora refuses a pool for it; after it the pool's address is",
        "taken by this launch's own pool. `creator` and `mint_salt` repeat `Launch.creator`",
        "and `Launch.mint_salt` for the seeds; any other value derives another address and is",
        "refused `WrongLaunch`. The payer pays the mint, vault and metadata rents and Metaplex's",
        "fee, reimbursed by the bond like the rest."
      ],
      "discriminator": [
        233,
        146,
        209,
        142,
        207,
        104,
        64,
        188
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "own two CPIs (2026-10-21, `create_pda`: a stranger's lamports at the address are moved out and kept by the",
            "payer, never refused); must be `Launch.token_mint`. The metadata and the revocation follow in `finish_mint`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "mintSalt"
              }
            ]
          }
        },
        {
          "name": "tokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "poolCreator",
          "docs": [
            "Meteora's pool creator and payer for this launch, and owner of the platform's",
            "position NFT: a dataless system account at `[\"pool_creator\", launch]` this",
            "program signs for. Lent the rents by the payer here and emptied back to it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "payerWsol",
          "docs": [
            "and closed to the payer here."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  119,
                  115,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "payerTokens",
          "docs": [
            "Left open and empty as the platform position's launch token claim destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Pays the pass through accounts and lends Meteora's rents, never from proceeds; the unspent part comes back."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "platformNftMint",
          "writable": true
        },
        {
          "name": "platformNftAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  110,
                  102,
                  116,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "platformPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenBVault",
          "writable": true
        },
        {
          "name": "meteoraConfig",
          "address": "HQ6vW45Kug23h2A4LkyUqB4UFfGx4LqY1uZLLfQemEjU"
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "eventAuthority",
          "address": "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "creatorWallet",
          "docs": [
            "plain lamport credit, so any account shape receives it (a Squads vault PDA that does not exist yet included)."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "must be `Launch.treasury` (0.28 to 0.29: the fee destination `lp_owner`, which now receives trading fees only).",
            "The same slot, so the account count is unchanged. The config is not in this instruction's accounts. A launch",
            "created before 0.30 recorded no treasury (zeros): its slot takes `Launch.lp_owner`, the destination its genesis",
            "terms named (the check is in the handler, where both fields are read)."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "creator",
          "type": "pubkey"
        },
        {
          "name": "mintSalt",
          "type": "u64"
        }
      ]
    },
    {
      "name": "deliver",
      "docs": [
        "Push a winner its tokens and refund. Anyone may run it, and the caller pays",
        "for the bidder's token account if it is missing. How the caller is paid is",
        "the launch's own term, fixed at genesis (`Launch.delivery_terms`):",
        "- a launch created by 0.26 or later: the caller is repaid the rent it just",
        "paid into that token account, plus `Launch.delivery_reward`, out of this",
        "bid's own account, and the rest of the bid account goes to the bidder with",
        "the refund (`close = bidder`). No tokens are taken.",
        "- a launch created before 0.26: as it always was. The caller is paid",
        "`Launch.delivery_fee_bps` of the tokens and the whole bid account goes to",
        "the bidder."
      ],
      "discriminator": [
        250,
        131,
        222,
        57,
        211,
        229,
        209,
        147
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "tokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "bid",
          "docs": [
            "`bidder`, delivered and closed to the bidder, who gets everything the account still holds when the instruction",
            "ends (its rent less what `deliver` repaid the caller); or an already closed account, a harmless no-op. Only this",
            "program moves this account's lamports: it signs for nothing and is passed to no CPI."
          ],
          "writable": true
        },
        {
          "name": "bidder",
          "writable": true
        },
        {
          "name": "bidderToken",
          "writable": true
        },
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "callerToken",
          "docs": [
            "(launches created before 0.26). Not read on a launch with bid rent terms."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "finishMint",
      "docs": [
        "2026-10-21 (Astra's trace headroom finding): the launch token's Metaplex metadata, written from the name,",
        "symbol and URI kept at genesis, and the revocation of its mint authority, both out of `create_pool`, which",
        "ran at the runtime's 64 trace entries exactly with the keeper's price instruction in front. Permissionless,",
        "exactly once per launch, in PoolLive or Finalized (the tenth candidate, Astra's N4: nothing requires it, and",
        "finalization never closes it; the metadata is never a prerequisite of any money step). Until it lands the mint",
        "authority is the vault PDA, which only this program signs for: the supply is fixed from `create_pool` on either",
        "way. Funding (Astra's N3): while the prepay is open (`bond_state` 0, the normal order) the payer's spend (the",
        "metadata's rent and Metaplex's fee) plus the step allowance are repaid from it, as every step's are; once the",
        "prepay was returned (a lock or a cash release landed first) the payer is paid from `Launch.metadata_reserve`,",
        "which that return held back, capped by it, and the rest of the reserve goes to the creator."
      ],
      "discriminator": [
        211,
        63,
        16,
        57,
        107,
        222,
        66,
        63
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "Repays the payer from the operating prepay; the mint authority until this instruction, signs by its seeds."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true
        },
        {
          "name": "metadata",
          "docs": [
            "0.29 candidate; at genesis until 0.18)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "const",
                "value": [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70
              ]
            }
          }
        },
        {
          "name": "tokenMetadataProgram",
          "address": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        },
        {
          "name": "payer",
          "docs": [
            "Pays the metadata's rent and Metaplex's fee, repaid from the prepay with the step allowance."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "creator",
          "docs": [
            "metadata reserve after the payer, when the prepay was returned before this step."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "growHistogram",
      "docs": [
        "0.29: the second instruction of a launch's creation, in the same transaction as `create_launch`: the",
        "histogram is grown from `Histogram::INIT_LEN` to `Histogram::LEN` (one cross-program create allocates at most",
        "10,240 bytes and one realloc adds at most 10,240), the creator pays the rent of the added bytes, and the launch",
        "records the account's lamports as the launch cost (`Launch.histogram_rent`, never refunded: the account is",
        "the auction's permanent receipt). The launch is Initializing until this lands and Open after it: `commit`",
        "refuses every bid before (`HistogramNotReady`); a second call is refused (`HistogramAlreadyGrown`); only the",
        "launch's creator may send it, and only while the bidding window is still open (`LaunchNotOpen` once",
        "`close_ts` has passed, or on a launch aborted at the deadline): nothing regrows or resets an activated launch,",
        "and nothing activates one whose window is already over (docs/DIRECT-CALL-SAFETY-0.29.md, item 6)."
      ],
      "discriminator": [
        200,
        181,
        102,
        0,
        119,
        202,
        245,
        209
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "histogram",
          "docs": [
            "so the handler checks the header by hand and grows the account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initConfig",
      "docs": [
        "0.24: permissionless, and the caller chooses nothing. The admin is this program's upgrade",
        "authority, read from its ProgramData (the loader's own PDA of the program id; see `InitConfig`),",
        "never an argument, so a watcher who runs this first only pays our rent, and the upgrade key never",
        "has to sign. No values and no fee destination are set: the admin sets them with",
        "`admin_update_config`, the destination accepts by signing (`accept_lp_owner`), and creation stays",
        "paused until the admin lifts the pause, which it refuses while either is missing."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Anyone (0.24): pays the rent and chooses nothing."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "programData",
          "docs": [
            "This program's ProgramData (0.24). The address is the upgradeable loader's PDA of `crate::ID`,",
            "the only address the loader accepts for this program's data at deploy, so no other program's",
            "ProgramData can be passed; `Account` checks the loader owns it and that it is in the ProgramData",
            "state. No `Program` account is taken: the id is the compile-time `crate::ID`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  182,
                  237,
                  179,
                  72,
                  129,
                  33,
                  225,
                  81,
                  54,
                  44,
                  153,
                  89,
                  53,
                  14,
                  210,
                  222,
                  113,
                  193,
                  101,
                  106,
                  235,
                  26,
                  191,
                  201,
                  140,
                  152,
                  141,
                  85,
                  11,
                  5,
                  19,
                  1
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                2,
                168,
                246,
                145,
                78,
                136,
                161,
                176,
                226,
                16,
                21,
                62,
                247,
                99,
                174,
                43,
                0,
                194,
                185,
                61,
                22,
                193,
                36,
                210,
                192,
                83,
                122,
                16,
                4,
                128,
                0,
                0
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "initPlatformVaults",
      "docs": [
        "v0.30 (the fold-in): anyone creates the fee vault (a program-owned account, so the program may move the lamports",
        "a closed wrapped SOL account leaves in it) and the burn vault's wrapped SOL account, once; the payer pays their",
        "rent. The burn vault itself is an address, never an account: it signs its token accounts by its seeds."
      ],
      "discriminator": [
        102,
        153,
        64,
        65,
        8,
        151,
        71,
        169
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "burnVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "burnVaultWsol",
          "writable": true
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "lockLiquidity",
      "docs": [
        "The creator's side of the pool's permanently locked liquidity (0.19).",
        "`create_pool` locked all of it in the platform's position; this moves",
        "`Launch.creator_lp_bps` of it (every bucket, permanent liquidity and any",
        "pending fees alike) into a second position with Meteora's",
        "`split_position2`, then hands that position's NFT to the launch creator,",
        "who claims its fees from Meteora directly with their own key: no Bouncer",
        "instruction and no permission of ours is in that path. Both positions",
        "stay permanently locked; a split cannot unlock anything.",
        "",
        "Permissionless; the payer pays the new position's rents and the",
        "creator's NFT token account. Runs once, and `burn_unsold` refuses to",
        "finalize until it has."
      ],
      "discriminator": [
        179,
        201,
        236,
        158,
        212,
        98,
        70,
        182
      ],
      "accounts": [
        {
          "name": "launch",
          "docs": [
            "Writable since 0.22: the operating prepay's running total is recorded on it."
          ],
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "0.22: repays the pool payer and this signer from the operating prepay."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "poolCreator",
          "docs": [
            "Writable since 0.20: its unused rent loan leaves here for `pool_payer`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Pays the creator position's rents and the creator's NFT token account."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "creator",
          "docs": [
            "Writable since 0.23: receives the unused operating prepay."
          ],
          "writable": true
        },
        {
          "name": "creatorNftMint",
          "writable": true
        },
        {
          "name": "creatorNftPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  110,
                  102,
                  116,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creatorNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "creatorPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "creatorNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "creatorNftAta",
          "writable": true
        },
        {
          "name": "platformNftMint"
        },
        {
          "name": "platformPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "platformNftAccount",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  110,
                  102,
                  116,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "platformNftMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                9,
                45,
                33,
                53,
                101,
                122,
                21,
                156,
                43,
                135,
                212,
                182,
                106,
                112,
                219,
                142,
                151,
                82,
                56,
                159,
                247,
                106,
                175,
                32,
                108,
                237,
                6,
                58,
                56,
                249,
                90,
                237
              ]
            }
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "eventAuthority",
          "address": "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "poolPayer",
          "writable": true
        },
        {
          "name": "payerWsol",
          "docs": [
            "The wrapped SOL pass through `create_pool` wrapped the proceeds through (`[\"pool_wsol\", launch]`, owned by the",
            "pool creator PDA): closed here to `pool_payer` since the ninth 0.29 candidate (2026-10-21), its rent, the",
            "opening's leftover lamports and any stray wrapped SOL, a loan that payer made like the PDA's rent loan.",
            "0.29 tenth candidate: optional, the program id in its place once `release_pool_cash` closed it (refused",
            "`TokenAccountsRequired` without it otherwise)."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  119,
                  115,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "openTrading",
      "docs": [
        "v0.30 (the founder, 2026-10-27, gate X): trading opens only once every bid of the launch is delivered or refunded",
        "(`distributed_count == bid_count`, the guard finalize already uses). Permissionless and without allowance: the",
        "keeper sends it in the transaction of its last push batch, and anyone else may. Thaws the pool's launch token",
        "vault, which `create_pool` froze, and revokes the mint's freeze authority for good, so no account of this mint",
        "can ever be frozen again. Refused on a launch whose pool predates 0.30 (`TradingGateNone`) and twice",
        "(`TradingAlreadyOpen`)."
      ],
      "discriminator": [
        248,
        79,
        225,
        158,
        86,
        244,
        239,
        139
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true
        },
        {
          "name": "pool"
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "parkBid",
      "docs": [
        "v0.32 (the founder, 2026-10-28; review/2026-10-28c-PROGRAM-CHANGES.md): park a payout that cannot land, so one bid",
        "never holds up its launch. Permissionless. Allowed on an open bid of a PoolLive, Failed or Aborted launch when",
        "(1) a winner's associated token account is unusable (`bidder_token_unusable`: an owner moved by SetAuthority, a",
        "frozen or foreign account), (2) a winner's bid account cannot repay the delivery's rent (`delivery_rent_short`:",
        "a rent rise, an emptied wallet), or (4) `PARK_AFTER_SECS` have passed since the pool was created (since the close",
        "for a failed or aborted launch), whatever the reason the payout has not landed. Nothing leaves the program: a",
        "winner's tokens stay in the launch's token vault (recorded as delivered, so `burn_unsold` leaves them), the",
        "lamports owed stay in the vault (`Launch.parked_lamports`, which `burn_unsold` leaves), both recorded on the bid,",
        "which stays open as the bidder's ticket in state Parked. The bid counts as distributed, so `open_trading` and",
        "`burn_unsold` proceed. The caller of a winner's park is paid the launch's delivery reward out of the bidder's own",
        "money, as a push's is: what the bid's account holds above its rent, then the parked lamports (never below zero;",
        "a full fill with an account at its rent pays none). No CPI. A closed or already parked bid is a no-op."
      ],
      "discriminator": [
        19,
        22,
        231,
        191,
        3,
        216,
        140,
        192
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "Pays a winner's park its reward out of the parked lamports."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "settlement",
          "docs": [
            "Required whenever the launch has a record (as in `refund`); the program id in its place otherwise."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "bidder"
        },
        {
          "name": "bidderToken",
          "docs": [
            "a loser's: not read (any account)."
          ]
        },
        {
          "name": "caller",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "postBeacon",
      "discriminator": [
        165,
        83,
        227,
        9,
        94,
        219,
        211,
        86
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "signature",
          "type": {
            "array": [
              "u8",
              48
            ]
          }
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "docs": [
        "0.24: the admin proposes a successor, who takes the role only by signing `accept_admin`, so an",
        "address nobody controls can never become the admin. Proposing the default key cancels."
      ],
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "proposed",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "pushParked",
      "docs": [
        "v0.32: anyone pushes a parked payout to the bidder's own associated token account (created if missing, its rent",
        "repaid to the caller out of the bid's own account as `deliver` does, no reward) and wallet, once they can take",
        "it. A closed bid is a no-op; a bid that is not parked is refused."
      ],
      "discriminator": [
        151,
        173,
        176,
        149,
        83,
        11,
        14,
        227
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "optional": true
        },
        {
          "name": "tokenVault",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "bidder",
          "writable": true
        },
        {
          "name": "bidderToken",
          "docs": [
            "address); required when the bid parked tokens."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "refund",
      "docs": [
        "Refund an invalid bid, a loser, or any bid of a failed or aborted launch."
      ],
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "settlement",
          "docs": [
            "Required whenever the launch has a record (`Launch.settled` 1: Settled, PoolLive, Finalized, or",
            "Aborted after settling; 0.17), refused `SettlementRequired` without it; the program id in its",
            "place for a Failed launch or one aborted before settling."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "bid",
          "docs": [
            "closed account, a harmless no-op. Pushed refunds are free."
          ],
          "writable": true
        },
        {
          "name": "bidder",
          "writable": true
        },
        {
          "name": "caller",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "releasePoolCash",
      "docs": [
        "0.29 twelfth candidate (Astra's F2, built in the tenth, deferred in the eleventh, approved by the founder",
        "2026-10-21): the cash steps of `lock_liquidity` without Meteora's split,",
        "for a launch whose creator split cannot land (cp-amm changed, the creator's position refused, anything): the",
        "wrapped SOL pass through closed to the pool payer, the pool creator PDA's unused rent loan returned to it,",
        "the part Meteora kept repaid to it from the prepay, and the unused prepay returned to the creator (less",
        "`burn_unsold`'s allowance and the metadata reserve). Permissionless, once, `POOL_CASH_RELEASE_SECS` after",
        "settlement, while the creator side is not locked. `lock_liquidity` afterwards does the split and the NFT only,",
        "with the program id in its pass through slot; its payer is then not repaid (the prepay is gone). The creator's",
        "unsplit share stays in the platform position, where `collect_platform_fees` cannot touch it (`SplitNotDone`),",
        "and `burn_unsold` still waits for the split: this moves cash only."
      ],
      "discriminator": [
        243,
        236,
        231,
        236,
        120,
        126,
        56,
        222
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "poolCreator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "poolPayer",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true
        },
        {
          "name": "payerWsol",
          "docs": [
            "`create_pool`'s wrapped SOL pass through, owned by the pool creator PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  119,
                  115,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "reveal",
      "docs": [
        "Decrypt every Bid account passed in remaining accounts. Anyone may send it; no bidder signs.",
        "",
        "0.22: each bid moved out of Sealed (to Revealed or to Invalid) pays its processing charge to",
        "`processor`, once, in this instruction. A bid already processed is skipped and pays nothing",
        "(until 0.21 it failed the whole batch with `AlreadyRevealed`), so two processors racing lose",
        "only the overlap. Invalid means the ciphertext fails a deterministic check against the posted",
        "beacon (`bls::open_bid`); a syscall error, running out of compute or a wrong account is a",
        "transaction error and marks nothing. Refused at or after the recovery deadline."
      ],
      "discriminator": [
        9,
        35,
        59,
        190,
        167,
        249,
        76,
        115
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "0.22: pays the processing charges."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "processor",
          "docs": [
            "0.22: whoever sends it; receives the processing charge of every bid it moves out of Sealed."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "histogram",
          "docs": [
            "0.29: the histogram every opened bid is added to."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "settle",
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
      ],
      "accounts": [
        {
          "name": "launch",
          "writable": true
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "creatorBid",
          "docs": [
            "The creator's own Bid, required when `Launch.creator_has_bid == 1`; pass the program id otherwise."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "0.22: repays the signer from the operating prepay."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        },
        {
          "name": "histogram",
          "docs": [
            "0.29: the histogram, read here (never written again, never closed)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "launch"
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "bid",
      "discriminator": [
        143,
        246,
        48,
        245,
        42,
        145,
        180,
        88
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "histogram",
      "discriminator": [
        174,
        142,
        148,
        67,
        110,
        6,
        49,
        148
      ]
    },
    {
      "name": "launch",
      "discriminator": [
        144,
        51,
        51,
        163,
        206,
        85,
        213,
        38
      ]
    },
    {
      "name": "platformVault",
      "discriminator": [
        223,
        22,
        224,
        48,
        29,
        125,
        8,
        80
      ]
    },
    {
      "name": "settlementRecord",
      "discriminator": [
        172,
        159,
        67,
        74,
        96,
        85,
        37,
        205
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "aborted",
      "discriminator": [
        174,
        37,
        127,
        34,
        59,
        60,
        173,
        65
      ]
    },
    {
      "name": "adminChanged",
      "discriminator": [
        232,
        34,
        31,
        226,
        62,
        18,
        19,
        114
      ]
    },
    {
      "name": "adminProposalCancelled",
      "discriminator": [
        158,
        7,
        69,
        243,
        15,
        126,
        0,
        184
      ]
    },
    {
      "name": "adminProposed",
      "discriminator": [
        129,
        249,
        226,
        227,
        199,
        82,
        110,
        243
      ]
    },
    {
      "name": "alreadyDistributed",
      "discriminator": [
        46,
        44,
        199,
        184,
        10,
        54,
        163,
        209
      ]
    },
    {
      "name": "attestationWaived",
      "discriminator": [
        41,
        253,
        77,
        107,
        57,
        157,
        235,
        40
      ]
    },
    {
      "name": "beaconPosted",
      "discriminator": [
        220,
        150,
        94,
        152,
        87,
        150,
        37,
        219
      ]
    },
    {
      "name": "bidCommitted",
      "discriminator": [
        81,
        13,
        193,
        139,
        0,
        168,
        82,
        55
      ]
    },
    {
      "name": "bidInvalid",
      "discriminator": [
        92,
        66,
        144,
        143,
        233,
        7,
        23,
        19
      ]
    },
    {
      "name": "bidParked",
      "discriminator": [
        23,
        146,
        62,
        20,
        81,
        108,
        216,
        199
      ]
    },
    {
      "name": "bidRevealed",
      "discriminator": [
        227,
        144,
        125,
        229,
        28,
        109,
        18,
        209
      ]
    },
    {
      "name": "boughtAndBurned",
      "discriminator": [
        13,
        130,
        211,
        97,
        12,
        157,
        239,
        61
      ]
    },
    {
      "name": "buybackConfigured",
      "discriminator": [
        62,
        1,
        209,
        193,
        18,
        177,
        45,
        118
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "delivered",
      "discriminator": [
        148,
        178,
        60,
        250,
        87,
        49,
        149,
        65
      ]
    },
    {
      "name": "deliveryRepaid",
      "discriminator": [
        248,
        223,
        75,
        152,
        226,
        190,
        86,
        45
      ]
    },
    {
      "name": "emergencyUpdatePauseSet",
      "discriminator": [
        50,
        164,
        72,
        187,
        10,
        110,
        241,
        78
      ]
    },
    {
      "name": "finalized",
      "discriminator": [
        4,
        77,
        242,
        80,
        20,
        152,
        247,
        252
      ]
    },
    {
      "name": "histogramGrown",
      "discriminator": [
        89,
        115,
        184,
        65,
        178,
        28,
        53,
        166
      ]
    },
    {
      "name": "launchClosed",
      "discriminator": [
        18,
        101,
        70,
        162,
        2,
        120,
        163,
        0
      ]
    },
    {
      "name": "launchCreated",
      "discriminator": [
        59,
        38,
        190,
        230,
        33,
        34,
        89,
        20
      ]
    },
    {
      "name": "launchFailed",
      "discriminator": [
        237,
        176,
        20,
        83,
        102,
        56,
        66,
        116
      ]
    },
    {
      "name": "liquidityLocked",
      "discriminator": [
        150,
        201,
        204,
        183,
        217,
        13,
        119,
        185
      ]
    },
    {
      "name": "lpOwnerChanged",
      "discriminator": [
        201,
        155,
        105,
        244,
        240,
        226,
        236,
        252
      ]
    },
    {
      "name": "mintFinished",
      "discriminator": [
        102,
        94,
        20,
        0,
        177,
        180,
        5,
        35
      ]
    },
    {
      "name": "parkedCollected",
      "discriminator": [
        171,
        160,
        95,
        149,
        61,
        3,
        0,
        138
      ]
    },
    {
      "name": "parkedPushed",
      "discriminator": [
        144,
        210,
        238,
        153,
        250,
        176,
        188,
        2
      ]
    },
    {
      "name": "platformFeesCollected",
      "discriminator": [
        109,
        143,
        129,
        146,
        174,
        164,
        57,
        226
      ]
    },
    {
      "name": "platformFeesSplit",
      "discriminator": [
        138,
        119,
        192,
        49,
        99,
        174,
        75,
        49
      ]
    },
    {
      "name": "platformVaultsInitialized",
      "discriminator": [
        42,
        199,
        81,
        90,
        6,
        207,
        36,
        191
      ]
    },
    {
      "name": "poolCashReleased",
      "discriminator": [
        240,
        17,
        10,
        204,
        249,
        38,
        96,
        65
      ]
    },
    {
      "name": "poolCreated",
      "discriminator": [
        202,
        44,
        41,
        88,
        104,
        220,
        157,
        82
      ]
    },
    {
      "name": "prepayReturned",
      "discriminator": [
        45,
        39,
        159,
        30,
        187,
        146,
        198,
        99
      ]
    },
    {
      "name": "refunded",
      "discriminator": [
        35,
        103,
        149,
        246,
        196,
        123,
        221,
        99
      ]
    },
    {
      "name": "settled",
      "discriminator": [
        232,
        210,
        40,
        17,
        142,
        124,
        145,
        238
      ]
    },
    {
      "name": "tradingForcedOpen",
      "discriminator": [
        37,
        198,
        105,
        24,
        61,
        242,
        176,
        52
      ]
    },
    {
      "name": "tradingOpened",
      "discriminator": [
        48,
        149,
        100,
        42,
        246,
        90,
        132,
        153
      ]
    },
    {
      "name": "treasuryChanged",
      "discriminator": [
        252,
        2,
        55,
        56,
        106,
        205,
        227,
        47
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "emergencyUpdatePaused",
      "msg": "the emergency update pause is on: no new launch can be created until the program update lands; launches already running are unaffected"
    },
    {
      "code": 6001,
      "name": "floorValueOutOfRange",
      "msg": "floor value outside the allowed range"
    },
    {
      "code": 6002,
      "name": "invalidConfig",
      "msg": "config parameters are inconsistent (cap below floor, cap above the grid top, bad minimum bid)"
    },
    {
      "code": 6003,
      "name": "invalidWindow",
      "msg": "window length must be between 300 and 3600 seconds"
    },
    {
      "code": 6004,
      "name": "invalidRoundPoint",
      "msg": "round point is not a valid G1 point"
    },
    {
      "code": 6005,
      "name": "launchNotOpen",
      "msg": "launch is not open"
    },
    {
      "code": 6006,
      "name": "notOpenYet",
      "msg": "bidding has not opened yet"
    },
    {
      "code": 6007,
      "name": "belowMinimum",
      "msg": "deposit is below the minimum bid"
    },
    {
      "code": 6008,
      "name": "exceedsRaiseCap",
      "msg": "retired 2026-09-24: deposits past the raise cap are accepted; the cap bounds proceeds at settle"
    },
    {
      "code": 6009,
      "name": "alreadyBid",
      "msg": "this wallet already has a bid on this launch"
    },
    {
      "code": 6010,
      "name": "notCloseable",
      "msg": "launch is not closeable yet"
    },
    {
      "code": 6011,
      "name": "windowStillOpen",
      "msg": "window is still open"
    },
    {
      "code": 6012,
      "name": "alreadyPosted",
      "msg": "beacon signature already posted"
    },
    {
      "code": 6013,
      "name": "signatureInvalid",
      "msg": "beacon signature does not verify for this launch's round"
    },
    {
      "code": 6014,
      "name": "launchFailed",
      "msg": "launch failed: deposits did not cover the floor"
    },
    {
      "code": 6015,
      "name": "beaconNotPosted",
      "msg": "beacon signature not posted yet"
    },
    {
      "code": 6016,
      "name": "alreadyRevealed",
      "msg": "bid already revealed"
    },
    {
      "code": 6017,
      "name": "bidsNotAllRevealed",
      "msg": "not every bid has been revealed or marked invalid"
    },
    {
      "code": 6018,
      "name": "launchNotClosed",
      "msg": "launch is not closed"
    },
    {
      "code": 6019,
      "name": "notSettled",
      "msg": "launch is not settled"
    },
    {
      "code": 6020,
      "name": "notPoolLive",
      "msg": "pool is not live"
    },
    {
      "code": 6021,
      "name": "notRefundable",
      "msg": "bid is not refundable in this state"
    },
    {
      "code": 6022,
      "name": "alreadyDone",
      "msg": "bid already delivered or refunded"
    },
    {
      "code": 6023,
      "name": "notAWinner",
      "msg": "bid is not a winner"
    },
    {
      "code": 6024,
      "name": "isAWinner",
      "msg": "bid is a winner; use deliver"
    },
    {
      "code": 6025,
      "name": "claimOnly",
      "msg": "bidder asked to claim; push delivery refused"
    },
    {
      "code": 6026,
      "name": "notAllDistributed",
      "msg": "not every bid has been delivered or refunded"
    },
    {
      "code": 6027,
      "name": "tooEarlyToAbort",
      "msg": "too early to abort"
    },
    {
      "code": 6028,
      "name": "poolAlreadyLive",
      "msg": "pool is already live; abort refused"
    },
    {
      "code": 6029,
      "name": "overflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6030,
      "name": "wrongLaunch",
      "msg": "bid account does not belong to this launch"
    },
    {
      "code": 6031,
      "name": "curveSyscallFailed",
      "msg": "a BLS12-381 syscall failed"
    },
    {
      "code": 6032,
      "name": "metadataTooLong",
      "msg": "name, symbol or uri too long"
    },
    {
      "code": 6033,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6034,
      "name": "poolConfigDisabled",
      "msg": "retired 0.19 (Raydium): the pool config refused new pools"
    },
    {
      "code": 6035,
      "name": "poolAmountsMismatch",
      "msg": "pool creation did not take the amounts computed from the proceeds and the reserve"
    },
    {
      "code": 6036,
      "name": "lpNotReceived",
      "msg": "retired 0.19 (Raydium): no LP tokens were received from the pool"
    },
    {
      "code": 6037,
      "name": "revealRoundOutOfRange",
      "msg": "reveal round is before the window end plus margin, or more than 20 rounds after it"
    },
    {
      "code": 6038,
      "name": "notAbortable",
      "msg": "launch is already aborted or failed"
    },
    {
      "code": 6039,
      "name": "creatorBidMissing",
      "msg": "the creator placed a bid; settle needs the creator Bid account"
    },
    {
      "code": 6040,
      "name": "wrongPool",
      "msg": "the pool is not the one recorded at pool creation"
    },
    {
      "code": 6041,
      "name": "wrongLockOwner",
      "msg": "retired 0.19 (Raydium): the lock NFT owner did not match its side"
    },
    {
      "code": 6042,
      "name": "lpAlreadyLocked",
      "msg": "that side of the LP is already locked"
    },
    {
      "code": 6043,
      "name": "lpNotLocked",
      "msg": "both LP positions must be locked before the launch can finalize"
    },
    {
      "code": 6044,
      "name": "invalidLockSide",
      "msg": "retired 0.19 (Raydium): lock side must be 0 or 1"
    },
    {
      "code": 6045,
      "name": "settlementRequired",
      "msg": "the settlement record must be passed once the launch has one: to abort a settled launch, and since 0.17 to refund or claim any of its bids"
    },
    {
      "code": 6046,
      "name": "nothingToSweep",
      "msg": "retired 0.19 (Raydium): no creator fee had accrued to the pool"
    },
    {
      "code": 6047,
      "name": "wrongPoolCreator",
      "msg": "the pool or position is not the one this launch created (its creator or NFT owner is not the launch pool creator PDA)"
    },
    {
      "code": 6048,
      "name": "wrongFeeOwner",
      "msg": "platform fees are paid to the config LP owner WSOL associated token account only"
    },
    {
      "code": 6049,
      "name": "wrongAmmConfig",
      "msg": "retired 0.19 (Raydium): create_pool accepted AmmConfig index 0 only"
    },
    {
      "code": 6050,
      "name": "wrongCreator",
      "msg": "burn_unsold must be given the launch's creator, who receives the crank bond back"
    },
    {
      "code": 6051,
      "name": "wrongMeteoraConfig",
      "msg": "create_pool accepts Meteora config AeLtDKgw only, and only while it is public, 1 percent flat with no dynamic fee, OnlyB, static, timestamp activated and full range"
    },
    {
      "code": 6052,
      "name": "openingPriceOutOfRange",
      "msg": "the proceeds and the reserve give an opening price outside Meteora bounds"
    },
    {
      "code": 6053,
      "name": "poolReadbackMismatch",
      "msg": "the pool Meteora created does not read back as asked: mints, vaults, range, price, liquidity, fee mode or creator"
    },
    {
      "code": 6054,
      "name": "positionReadbackMismatch",
      "msg": "a Meteora position does not read back as expected after the lock or split"
    },
    {
      "code": 6055,
      "name": "platformNotLocked",
      "msg": "the platform position must be locked (create_pool) before the creator side"
    },
    {
      "code": 6056,
      "name": "tokenAccountsRequired",
      "msg": "the token mint and token vault must be passed once the pool exists; they do not exist before create_pool (0.19)"
    },
    {
      "code": 6057,
      "name": "wrongPoolPayer",
      "msg": "lock_liquidity must be given the create_pool payer recorded in the settlement, who gets the unused rent loan back (0.20)"
    },
    {
      "code": 6058,
      "name": "platformPositionDelegated",
      "msg": "the platform position must never be delegated: its NFT account has an SPL delegate or the position has delegate permissions (0.20)"
    },
    {
      "code": 6059,
      "name": "splitNotDone",
      "msg": "the creator's split has not run: lock_liquidity records it, and the platform's fees cannot be collected before it (0.21)"
    },
    {
      "code": 6060,
      "name": "recoveryDeadlinePassed",
      "msg": "the launch's recovery deadline (scheduled close plus the recovery delay) has passed: it can no longer progress, and every deposit is recoverable (0.22)"
    },
    {
      "code": 6061,
      "name": "scheduleTooTight",
      "msg": "the reveal round leaves less than MIN_PROCESSING_SECS between its publication and the recovery deadline (0.22)"
    },
    {
      "code": 6062,
      "name": "noUpgradeAuthority",
      "msg": "the program has no upgrade authority: init_config derives the admin from it and cannot run on an immutable program (0.24)"
    },
    {
      "code": 6063,
      "name": "notProposedLpOwner",
      "msg": "accept_lp_owner must be signed by the proposed fee destination, and one must have been proposed (0.24)"
    },
    {
      "code": 6064,
      "name": "notProposedAdmin",
      "msg": "accept_admin must be signed by the proposed admin, and an admin must have been proposed (0.24)"
    },
    {
      "code": 6065,
      "name": "configIncomplete",
      "msg": "the config is not complete: its values and an accepted fee destination must be set before creation can start (0.24)"
    },
    {
      "code": 6066,
      "name": "termsChanged",
      "msg": "the terms stated in create_launch are not the config's: the config changed after the creator signed; read it again and sign again (0.25)"
    },
    {
      "code": 6067,
      "name": "processingChargeAboveMaximum",
      "msg": "the processing charge is above the maximum the bidder stated in commit (0.25)"
    },
    {
      "code": 6068,
      "name": "tokenFeeRetired",
      "msg": "the delivery fee must be 0: a pushed delivery is repaid from the bid account's rent and takes no tokens; set the config's delivery_fee_bps to 0 (0.26)"
    },
    {
      "code": 6069,
      "name": "bidRentTooSmall",
      "msg": "the bid account's rent does not cover the token account rent the caller paid and leave the bidder's wallet rent exempt; nothing was taken, and the bidder can claim (0.26)"
    },
    {
      "code": 6070,
      "name": "raiseFeeTooHigh",
      "msg": "the raise fee is above its bound: at most MAX_RAISE_FEE_BPS of the cleared raise, and the creator's share at most 10,000 of the fee (0.28)"
    },
    {
      "code": 6071,
      "name": "histogramNotReady",
      "msg": "the launch's histogram is not at its full size yet: grow_histogram must land before any bid (0.29)"
    },
    {
      "code": 6072,
      "name": "histogramAlreadyGrown",
      "msg": "the launch's histogram is already at its full size (0.29: grow_histogram lands once)"
    },
    {
      "code": 6073,
      "name": "attestorUnknown",
      "msg": "the attestation is signed by a key that is not one of the config's attestors (0.29)"
    },
    {
      "code": 6074,
      "name": "attestationMismatch",
      "msg": "the attestation's message is not this program, this launch and this bidder under the bid attestation tag (0.29)"
    },
    {
      "code": 6075,
      "name": "attestationExpired",
      "msg": "the attestation has expired (0.29)"
    },
    {
      "code": 6076,
      "name": "attestationTooLong",
      "msg": "the attestation's expiry is further ahead than ATTEST_MAX_LIFE_SECS allows (0.29)"
    },
    {
      "code": 6077,
      "name": "attestationMissing",
      "msg": "this launch requires a bid attestation: the instruction before commit must be the Ed25519 program verifying one signature, key, signature and 125-byte message in its own data (0.29)"
    },
    {
      "code": 6078,
      "name": "launchLayoutUnknown",
      "msg": "the launch account is not this build's layout: a launch created under 0.28 or earlier is stranded by the 0.29 layout change (INTERFACE.md, the layout rule)"
    },
    {
      "code": 6079,
      "name": "attestationAlreadyWaived",
      "msg": "the attestation is already waived on this launch, or was never required (0.29: the waiver is one way and lands once)"
    },
    {
      "code": 6080,
      "name": "mintAlreadyFinished",
      "msg": "finish_mint already landed on this launch: the mint authority is revoked (2026-10-21)"
    },
    {
      "code": 6081,
      "name": "cashAlreadyReleased",
      "msg": "release_pool_cash already ran on this launch (0.29 twelfth candidate)"
    },
    {
      "code": 6082,
      "name": "releaseTooEarly",
      "msg": "release_pool_cash waits POOL_CASH_RELEASE_SECS after settlement for the creator's split (0.29 twelfth candidate)"
    },
    {
      "code": 6083,
      "name": "claimRemoved",
      "msg": "self-claim is removed (v0.30): the claim flag (bit 0) is refused; every winner is pushed"
    },
    {
      "code": 6084,
      "name": "tradingGateNone",
      "msg": "this launch's pool has no trading gate: it was created under 0.29 or earlier, or it does not exist yet (v0.30)"
    },
    {
      "code": 6085,
      "name": "tradingNotOpenable",
      "msg": "trading cannot open yet: a bid is still undelivered or unrefunded (v0.30)"
    },
    {
      "code": 6086,
      "name": "tradingAlreadyOpen",
      "msg": "trading is already open on this launch (v0.30)"
    },
    {
      "code": 6087,
      "name": "tradingNotOpen",
      "msg": "trading has not opened on this launch: open_trading must land before finalize (v0.30)"
    },
    {
      "code": 6088,
      "name": "vaultNotFrozen",
      "msg": "the pool's launch token vault is not frozen (v0.30)"
    },
    {
      "code": 6089,
      "name": "notProposedTreasury",
      "msg": "the signer is not the proposed treasury (v0.30)"
    },
    {
      "code": 6090,
      "name": "wrongTreasury",
      "msg": "the treasury account is not the one this launch recorded at genesis (v0.30)"
    },
    {
      "code": 6091,
      "name": "revealMarginOutOfRange",
      "msg": "the reveal margin is outside its hard bounds, 60 to 300 seconds (v0.30)"
    },
    {
      "code": 6092,
      "name": "termsPinned",
      "msg": "the creator LP share and the raise fee are program constants since v0.30 (2,188 bps of the LP; 100 bps of the raise, 5,000 bps of it to the creator)"
    },
    {
      "code": 6093,
      "name": "operatingValueOutOfRange",
      "msg": "the delivery reward or the metadata reserve is outside its bounds (v0.30)"
    },
    {
      "code": 6094,
      "name": "notABid",
      "msg": "the bid account is neither an open bid of this launch for this bidder nor a closed one (v0.30)"
    },
    {
      "code": 6095,
      "name": "buybackPoolNotSet",
      "msg": "the buy-and-burn's BOUNCER mint and pool are not set yet; the burn vault accumulates (v0.30)"
    },
    {
      "code": 6096,
      "name": "notABurnCranker",
      "msg": "the signer is not one of the burn crankers the config lists (v0.30)"
    },
    {
      "code": 6097,
      "name": "buybackTooSoon",
      "msg": "too soon after the last buy-and-burn: Config.buy_min_interval_secs has not passed (v0.30)"
    },
    {
      "code": 6098,
      "name": "nothingToBuy",
      "msg": "the burn vault holds nothing to buy with (v0.30)"
    },
    {
      "code": 6099,
      "name": "buybackLimitUnset",
      "msg": "the buy-and-burn's cap or price limit is unset, or the limit leaves no minimum output (v0.30)"
    },
    {
      "code": 6100,
      "name": "wrongBurnVault",
      "msg": "the account is not the burn vault, or not its token account for this mint (v0.30)"
    },
    {
      "code": 6101,
      "name": "splitAccountsMissing",
      "msg": "a fee-vault launch's collect needs the config, the burn vault's wrapped SOL account and the treasury as remaining accounts, writable (v0.30)"
    },
    {
      "code": 6102,
      "name": "wrongBuybackPool",
      "msg": "the pool is not the configured BOUNCER pool with the mint as token A and wrapped SOL as token B (v0.30)"
    },
    {
      "code": 6103,
      "name": "closeTooSoon",
      "msg": "the close is under 240 s away at landing: rebuild with a later close (v0.31)"
    },
    {
      "code": 6104,
      "name": "notParkable",
      "msg": "this payout can still land: a bid is parked only when its token account is unusable, its account cannot repay the delivery, or 600 s after the pool, or after the close of a failed or aborted launch (v0.32)"
    },
    {
      "code": 6105,
      "name": "notParked",
      "msg": "the bid is not parked (v0.32)"
    },
    {
      "code": 6106,
      "name": "wrongBidderToken",
      "msg": "the account is not the bidder's associated token account for this launch's mint (v0.32)"
    }
  ],
  "types": [
    {
      "name": "aborted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "adminChanged",
      "docs": [
        "0.24: the proposed admin accepted; it is now the admin."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "adminProposalCancelled",
      "docs": [
        "0.24: the admin withdrew a pending proposal."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "cancelled",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "adminProposed",
      "docs": [
        "0.24: the admin proposed a successor. Nothing changes until the proposed key signs `accept_admin`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "proposed",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "alreadyDistributed",
      "docs": [
        "v0.30: a `deliver` or `refund` found its bid account already closed (another push, or the bidder's own, landed",
        "first) and did nothing. The transaction lands; the other items of a batch are unaffected."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "attestationWaived",
      "docs": [
        "0.29: the admin waived the bid attestation on one launch (`Launch.attest_required` 1 to 0, one direction only)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "beaconPosted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "revealRound",
            "type": "u64"
          },
          {
            "name": "postedTs",
            "docs": [
              "v0.30 (the founder, 2026-10-27): the lag sample, record only. `posted_ts` is the chain clock at this instruction;",
              "`lag_secs` is the round's scheduled publish time less it (positive: the chain's clock was at least that far",
              "behind the world's, since the verified signature proves the key existed); `margin_secs` the launch's margin;",
              "`breach` whether the sample reached the margin (the chain was behind by a whole margin or more: the key may",
              "have been public while the book was open). Nothing is refused on it."
            ],
            "type": "i64"
          },
          {
            "name": "lagSecs",
            "type": "i64"
          },
          {
            "name": "marginSecs",
            "type": "u32"
          },
          {
            "name": "breach",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "bid",
      "docs": [
        "One sealed bid. PDA [\"bid\", launch, bidder], 260 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "flags",
            "docs": [
              "bit 0: retired in v0.30 (self-claim is removed; `commit` refuses it, `ClaimRemoved`), the claim-only flag of",
              "0.18 to 0.29. bit 1: this is the launch creator's bid (set by the program)."
            ],
            "type": "u8"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "deposit",
            "type": "u64"
          },
          {
            "name": "placedTs",
            "type": "i64"
          },
          {
            "name": "sealed",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tick",
            "type": "u16"
          },
          {
            "name": "pad2",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "processingCharge",
            "docs": [
              "0.22: the processing charge paid at commit on top of the deposit, held in the vault and paid to",
              "whoever moves this bid out of Sealed (reveal), or returned with the deposit if it never is. 0 for",
              "a bid committed before 0.22."
            ],
            "type": "u64"
          },
          {
            "name": "parkedTokens",
            "docs": [
              "v0.32: what a parked bid is owed (`bid_state::PARKED`): the fill's tokens, held in the launch's token vault, and",
              "the lamports, held in the vault. Zero on every other bid."
            ],
            "type": "u64"
          },
          {
            "name": "parkedLamports",
            "type": "u64"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for fields appended by later versions (0.18, 56 since 0.22, 40 since 0.32); zeros."
            ],
            "type": {
              "array": [
                "u8",
                40
              ]
            }
          }
        ]
      }
    },
    {
      "name": "bidCommitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "bool"
          },
          {
            "name": "deposit",
            "type": "u64"
          },
          {
            "name": "totalDeposits",
            "type": "u64"
          },
          {
            "name": "bidCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "bidInvalid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "deposit",
            "type": "u64"
          },
          {
            "name": "invalidCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "bidParked",
      "docs": [
        "v0.32: a payout that could not land was parked (`park_bid`). `reason`: 1 the bidder's token account is unusable,",
        "2 the bid's account cannot repay the delivery's rent, 4 the catch-all (`PARK_AFTER_SECS`). `tokens` stay in the",
        "launch's token vault and `lamports` in the vault until the bidder collects or anyone pushes them; `reward` is what",
        "the caller was paid out of the bid's own account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "reward",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "tick",
            "type": "u16"
          },
          {
            "name": "deposit",
            "type": "u64"
          },
          {
            "name": "revealedCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "boughtAndBurned",
      "docs": [
        "v0.30: one `buy_and_burn`: `lamports` of wrapped SOL swapped on the canonical pool, `atoms` of BOUNCER burned",
        "(everything the burn vault's token account held after the swap), under the minimum output and the price limit."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "cranker",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "atoms",
            "type": "u64"
          },
          {
            "name": "minOut",
            "type": "u64"
          },
          {
            "name": "maxPriceX64",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "buybackArgs",
      "docs": [
        "v0.30 (the founder, 2026-10-27): the buy-and-burn's terms, set by `admin_set_buyback` (the ops Squad) after the BOUNCER",
        "genesis; its own instruction, so `ConfigArgs` and every update sent before it keep their shape. The pool is the",
        "canonical BOUNCER pool on cp-amm (this program's own: token A the mint, token B wrapped SOL); the crankers are the",
        "keys allowed to call `buy_and_burn` (keeper 1, keeper 2, the founder's Phantom; a zero slot is unused); the cap bounds one",
        "buy in lamports; the interval is the least seconds between two; the price limit is the most lamports per atom a buy",
        "may pay, Q64.64 (`buy_and_burn` demands at least `lamports * 2^64 / price` atoms out; the caller may only raise it)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bouncerMint",
            "type": "pubkey"
          },
          {
            "name": "bouncerPool",
            "type": "pubkey"
          },
          {
            "name": "burnCrankers",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "buyCapLamports",
            "type": "u64"
          },
          {
            "name": "buyMinIntervalSecs",
            "type": "u64"
          },
          {
            "name": "buyMaxPriceX64",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "buybackConfigured",
      "docs": [
        "v0.30: the buy-and-burn's terms as `admin_set_buyback` wrote them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "bouncerMint",
            "type": "pubkey"
          },
          {
            "name": "bouncerPool",
            "type": "pubkey"
          },
          {
            "name": "burnCrankers",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "buyCapLamports",
            "type": "u64"
          },
          {
            "name": "buyMinIntervalSecs",
            "type": "u64"
          },
          {
            "name": "buyMaxPriceX64",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Platform configuration. PDA [\"config\"], 632 bytes (0.18)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "emergencyUpdatePause",
            "docs": [
              "The emergency update pause (0.18, restored under the founder's name): 1 while the",
              "admin has paused the creation of new launches for a program update. Read by",
              "`create_launch` only; nothing on a running launch looks at it. Disclosed on",
              "the page. `creation_paused` until 0.15, a pad in 0.16 and 0.17."
            ],
            "type": "u8"
          },
          {
            "name": "pad1",
            "docs": [
              "Alignment, always 0 (until 0.14 the reserved `cap_closes_book_default`)."
            ],
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "lpOwner",
            "type": "pubkey"
          },
          {
            "name": "floorValue",
            "docs": [
              "Lamports the whole float is worth at tick 0, and the least a launch can raise. No ceiling exists."
            ],
            "type": "u64"
          },
          {
            "name": "minBid",
            "type": "u64"
          },
          {
            "name": "abortAfterSecs",
            "type": "u64"
          },
          {
            "name": "deliveryFeeBps",
            "docs": [
              "Basis points of a pushed delivery's tokens paid to the pusher. Claiming is free. 0.26: must",
              "be 0 (a pushed delivery is repaid from the bid account's rent instead); a config written",
              "before 0.26 may hold 50 until it is updated, and no launch is created while it does."
            ],
            "type": "u16"
          },
          {
            "name": "creatorLpBps",
            "docs": [
              "Basis points of the pool's LP locked for the creator; the rest for the protocol."
            ],
            "type": "u16"
          },
          {
            "name": "crankBond",
            "docs": [
              "Lamports the creator posts at genesis as the crank bond (0.16): the measured cost of `create_pool`, copied into the launch."
            ],
            "type": "u64"
          },
          {
            "name": "emergencyUpdatePauseTs",
            "docs": [
              "Unix time the emergency update pause was last switched on; 0 while off (0.18)."
            ],
            "type": "i64"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "The admin proposed by `propose_admin`, who becomes the admin by signing `accept_admin` (0.24).",
              "The default key while nothing is proposed. Carved from the start of the reserved tail."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingLpOwner",
            "docs": [
              "The fee destination proposed by `admin_update_config`, which becomes `lp_owner` only when it signs",
              "`accept_lp_owner` (0.24). The default key while nothing is proposed."
            ],
            "type": "pubkey"
          },
          {
            "name": "raiseFeeBps",
            "docs": [
              "0.28: basis points of the cleared raise taken as the raise fee when a launch opens its pool (the founder,",
              "2026-10-08: 1 percent of successful auction proceeds, in SOL). Copied into every launch at genesis and",
              "signed in the creator's terms; at most `MAX_RAISE_FEE_BPS`. Carved from the reserved tail, so a config",
              "written before 0.28 reads 0 here and no launch created under it pays a fee."
            ],
            "type": "u16"
          },
          {
            "name": "raiseFeeCreatorShareBps",
            "docs": [
              "0.28: the creator's share of that fee, basis points of the fee (6,000: 60 percent to the creator, the",
              "rest to the launch's `lp_owner`); at most 10,000."
            ],
            "type": "u16"
          },
          {
            "name": "attestors",
            "docs": [
              "0.29: the keys whose Ed25519 attestation a bid may carry when `attest_bids` is 1 (the attestation services'",
              "keys, held in Turnkey); a zero slot is unused. Carved from the reserved tail, so a config written before 0.29",
              "reads three zero slots here."
            ],
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "attestBids",
            "docs": [
              "0.29: 1 when every launch created from now on requires a Bouncer attestation on each bid; copied to",
              "`Launch.attest_required` at genesis and read nowhere else."
            ],
            "type": "u8"
          },
          {
            "name": "padAttest",
            "docs": [
              "0.29: alignment; zeros."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "processingCharge",
            "docs": [
              "0.29: the processing charge each bid pays at commit, lamports (10,000 in production), at most",
              "`MAX_PROCESSING_CHARGE`; copied to `Launch.processing_charge` at genesis and read there by `commit`."
            ],
            "type": "u64"
          },
          {
            "name": "revealMarginSecs",
            "docs": [
              "v0.30 (the founder, 2026-10-27): the reveal margin, seconds, Squad-adjustable within hard bounds (`REVEAL_MARGIN_MIN_SECS`",
              "60 to `REVEAL_MARGIN_MAX_SECS` 300; starts at 120, the constant every build before 0.30 used). Copied to",
              "`Launch.reveal_margin_secs` at genesis, where it fixes the drand round the bids are sealed to. A config written",
              "before 0.30 reads 0 here, which an update refuses, so the first 0.30 update sets it. Carved from the tail at 300."
            ],
            "type": "u32"
          },
          {
            "name": "padMargin",
            "docs": [
              "v0.30: alignment; zeros."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "deliveryReward",
            "docs": [
              "v0.30: lamports a pushed delivery pays its caller on top of the token account rent (`Launch.delivery_reward` at",
              "genesis; the constant `DELIVERY_REWARD_LAMPORTS` until 0.29); at most `MAX_DELIVERY_REWARD_LAMPORTS`."
            ],
            "type": "u64"
          },
          {
            "name": "metadataReserve",
            "docs": [
              "v0.30: lamports of the creator's prepay held back for `finish_mint` when the prepay is returned before the metadata",
              "is written (`Launch.metadata_reserve_lamports` at genesis; the constant `METADATA_RESERVE_LAMPORTS` until 0.29);",
              "within `MIN_METADATA_RESERVE_LAMPORTS` and `MAX_METADATA_RESERVE_LAMPORTS`."
            ],
            "type": "u64"
          },
          {
            "name": "treasury",
            "docs": [
              "v0.30: where the platform's half of the raise fee is paid by `create_pool`, copied to `Launch.treasury` at genesis",
              "as `lp_owner` is; `lp_owner` (the buyback router) then receives trading fees only. Takes effect only when the",
              "proposed key signs `accept_treasury` (a Squads vault signs through a vault transaction). The default key until",
              "then, and creation is refused `ConfigIncomplete` while it is."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingTreasury",
            "docs": [
              "v0.30: the treasury proposed by `admin_update_config`, the default key while nothing is proposed."
            ],
            "type": "pubkey"
          },
          {
            "name": "bouncerMint",
            "docs": [
              "v0.30 (the founder, 2026-10-27, the buy-and-burn folded into the core): the BOUNCER mint and its canonical cp-amm pool",
              "(this program's own: token A the mint, token B wrapped SOL), set by `admin_set_buyback` after genesis; zeros",
              "until then, and `buy_and_burn` refuses `BuybackPoolNotSet` while the burn vault accumulates. Carved at 388."
            ],
            "type": "pubkey"
          },
          {
            "name": "bouncerPool",
            "type": "pubkey"
          },
          {
            "name": "burnCrankers",
            "docs": [
              "v0.30: the keys allowed to call `buy_and_burn` (keeper 1, keeper 2, the founder's Phantom); a zero slot is unused."
            ],
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "buyCapLamports",
            "docs": [
              "v0.30: the most lamports one `buy_and_burn` swaps; the least seconds between two; the most lamports per atom a",
              "buy may pay, Q64.64 (the swap's minimum output is `lamports * 2^64 / price`; the caller may only raise it)."
            ],
            "type": "u64"
          },
          {
            "name": "buyMinIntervalSecs",
            "type": "u64"
          },
          {
            "name": "buyMaxPriceX64",
            "type": "u128"
          },
          {
            "name": "lastBuyTs",
            "docs": [
              "v0.30: unix time of the last landed `buy_and_burn`; 0 before the first. Written by `buy_and_burn` only."
            ],
            "type": "i64"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for fields appended by later versions (0.18); zeros. See the append only rule in INTERFACE.md.",
              "0.24 took 64 of the 512 bytes, 0.28 took 4, 0.29 took 112, 0.30 took 88 and then 200 (the fold-in)."
            ],
            "type": {
              "array": [
                "u8",
                44
              ]
            }
          }
        ]
      }
    },
    {
      "name": "configArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lpOwner",
            "type": "pubkey"
          },
          {
            "name": "floorValue",
            "type": "u64"
          },
          {
            "name": "minBid",
            "type": "u64"
          },
          {
            "name": "abortAfterSecs",
            "type": "u64"
          },
          {
            "name": "deliveryFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorLpBps",
            "type": "u16"
          },
          {
            "name": "crankBond",
            "docs": [
              "The crank bond, lamports (0.16): the measured cost of `create_pool`, at most 1 SOL."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeeBps",
            "docs": [
              "0.28: the raise fee, basis points of the cleared raise (at most `MAX_RAISE_FEE_BPS`), and the creator's",
              "share of it in basis points of the fee (at most 10,000). Appended, so a 0.27 argument is a prefix of this one."
            ],
            "type": "u16"
          },
          {
            "name": "raiseFeeCreatorShareBps",
            "type": "u16"
          },
          {
            "name": "attestors",
            "docs": [
              "0.29: the attestor keys (a zero slot is unused), whether new launches require a bid attestation (0 or 1),",
              "and the processing charge each bid pays (at most `MAX_PROCESSING_CHARGE`). Appended, the same way."
            ],
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "attestBids",
            "type": "u8"
          },
          {
            "name": "processingCharge",
            "type": "u64"
          },
          {
            "name": "revealMarginSecs",
            "docs": [
              "v0.30: the reveal margin (60 to 300 s), the delivery reward, the metadata reserve and the treasury (proposed, as",
              "`lp_owner` is: it takes effect when it signs `accept_treasury`; naming the current one cancels a proposal).",
              "Appended, the same way."
            ],
            "type": "u32"
          },
          {
            "name": "deliveryReward",
            "type": "u64"
          },
          {
            "name": "metadataReserve",
            "type": "u64"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "docs": [
        "0.24: `init_config` ran. `admin` is the program's upgrade authority, read from its ProgramData;",
        "`payer` paid the rent and chose nothing. Creation starts paused, with no values and no fee destination."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "docs": [
        "0.24: `admin_update_config` ran, with every value before and after. `new.lp_owner` is the fee",
        "destination in force (unchanged by an update); a different requested destination is `pending_lp_owner`,",
        "which takes effect only when it signs `accept_lp_owner` (the default key: none pending)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "old",
            "type": {
              "defined": {
                "name": "configArgs"
              }
            }
          },
          {
            "name": "new",
            "type": {
              "defined": {
                "name": "configArgs"
              }
            }
          },
          {
            "name": "pendingLpOwner",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "pendingTreasury",
            "docs": [
              "v0.30: the treasury proposed by this update (the default key when none)."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "delivered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "cost",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          },
          {
            "name": "feeTokens",
            "docs": [
              "Tokens out of `tokens` that went to the pusher as the delivery fee. 0 on a claim."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "deliveryRepaid",
      "docs": [
        "0.26: a pushed delivery on a launch with bid rent terms repaid its caller out of the delivered",
        "bid's own account. `rent` is what the caller had just paid into the bidder's token account: its",
        "whole rent when the account did not exist, less when someone had already sent it lamports, zero",
        "when it existed. `reward` is `Launch.delivery_reward`, or less when the bidder's wallet needed the",
        "difference to stay rent exempt. The rest of the bid account went to the bidder. Emitted after that",
        "delivery's `Delivered`; never on a claim, and never on a launch created before 0.26."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "rent",
            "type": "u64"
          },
          {
            "name": "reward",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "emergencyUpdatePauseSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "on",
            "docs": [
              "1 switched on, 0 switched off (0.18)."
            ],
            "type": "bool"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "finalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "burnedTokens",
            "type": "u64"
          },
          {
            "name": "largestFillTokens",
            "type": "u64"
          },
          {
            "name": "dustLamports",
            "type": "u64"
          },
          {
            "name": "crankBondReturned",
            "docs": [
              "The crank bond returned to the creator, lamports: the bond after a failure or an abort, 0 after a clear (0.16)."
            ],
            "type": "u64"
          },
          {
            "name": "dustTokensBurned",
            "docs": [
              "The opening's leftover reserve atoms burned here (0.21; burned by `create_pool` until 0.20)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "histogram",
      "docs": [
        "0.29: the launch's histogram. PDA [\"hist\", launch], 19,272 bytes, zero copy (`reveal` touches one slot per bid).",
        "Created by `create_launch` at `INIT_LEN` and grown to `LEN` by `grow_histogram` in the same transaction, both",
        "paid by the creator (`Launch.histogram_rent`, a launch cost, never refunded); `reveal` adds each opened bid's",
        "deposit in lamports to `counts[tick]`; `settle` reads it to clear the launch. Nothing writes it after the reveals",
        "and nothing closes it, ever: it is the auction's permanent on-chain receipt (the founder, 2026-10-20). Every step after",
        "`settle` works from the `SettlementRecord`."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tickCount",
            "docs": [
              "`TICK_COUNT` as written at genesis (2,407)."
            ],
            "type": "u16"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "counts",
            "docs": [
              "Revealed deposits per tick, in lamports. A sum of deposits is under 2^63 (the chain's supply), so no slot can",
              "overflow; `reveal` adds with a checked add regardless."
            ],
            "type": {
              "array": [
                "u64",
                2407
              ]
            }
          }
        ]
      }
    },
    {
      "name": "histogramGrown",
      "docs": [
        "0.29: the launch's histogram was grown to its full size by `grow_histogram` (the second instruction of the create",
        "flow); `histogram_rent` is the account's lamports now, the launch cost the creator paid for the auction's permanent",
        "receipt (`Launch.histogram_rent`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "histogramRent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "launch",
      "docs": [
        "One launch. PDA [\"launch\", token_mint], 1,376 bytes since 0.29 (9,568 until 0.28, when the 8 KB histogram",
        "lived inside it; it is now the `Histogram` account below, the permanent receipt). Zero copy."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "state",
            "docs": [
              "0 Open, 1 Closed, 2 Settled, 3 PoolLive, 4 Finalized, 5 Aborted, 6 Failed, 7 Initializing (0.29: created,",
              "the histogram not yet grown; `grow_histogram` takes it to Open, nothing else moves it but `abort` at the deadline)"
            ],
            "type": "u8"
          },
          {
            "name": "settled",
            "docs": [
              "1 once `settle` wrote the settlement record (the launch cleared); never",
              "cleared, so a launch aborted after settling keeps it. `refund` and `claim`",
              "require the record whenever this is 1 (0.17). A pad until 0.16."
            ],
            "type": "u8"
          },
          {
            "name": "beaconPosted",
            "type": "u8"
          },
          {
            "name": "creatorHasBid",
            "docs": [
              "1 once the creator has placed a bid in this launch (set by `commit`, never cleared).",
              "`settle` then requires the creator's Bid account so the record can label the fill."
            ],
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "tokenVault",
            "type": "pubkey"
          },
          {
            "name": "float",
            "type": "u64"
          },
          {
            "name": "floorValue",
            "type": "u64"
          },
          {
            "name": "minBid",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "windowSecs",
            "type": "i64"
          },
          {
            "name": "closeTs",
            "type": "i64"
          },
          {
            "name": "revealRound",
            "type": "u64"
          },
          {
            "name": "roundPoint",
            "type": {
              "array": [
                "u8",
                48
              ]
            }
          },
          {
            "name": "beaconSignature",
            "type": {
              "array": [
                "u8",
                48
              ]
            }
          },
          {
            "name": "totalDeposits",
            "type": "u64"
          },
          {
            "name": "bidCount",
            "type": "u32"
          },
          {
            "name": "revealedCount",
            "type": "u32"
          },
          {
            "name": "invalidCount",
            "type": "u32"
          },
          {
            "name": "distributedCount",
            "docs": [
              "Bids closed by deliver, refund or claim, in any state."
            ],
            "type": "u32"
          },
          {
            "name": "largestDeposit",
            "type": "u64"
          },
          {
            "name": "lpOwner",
            "docs": [
              "Copied from the config at genesis; nothing in the config reaches a running launch. Where this",
              "launch's platform fees are paid by `collect_platform_fees` (0.24; written but unread from 0.19",
              "to 0.23, when collection followed the live config)."
            ],
            "type": "pubkey"
          },
          {
            "name": "abortAfterSecs",
            "type": "u64"
          },
          {
            "name": "deliveryFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorLpBps",
            "type": "u16"
          },
          {
            "name": "bondState",
            "docs": [
              "Operating prepay state: 0 held in the vault, 1 paid whole to a `create_pool` payer (0.16 to 0.21",
              "only; a launch created under 0.22 never reaches it), 2 remainder returned to the creator (at finalize,",
              "or at lock since 0.23 and then finalized), 3 (0.23) remainder returned to the creator at `lock_liquidity`,",
              "the finalize allowance still held for `burn_unsold`'s caller."
            ],
            "type": "u8"
          },
          {
            "name": "pad2",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "crankBond",
            "docs": [
              "The operating prepay the creator posted at genesis (the crank bond until 0.21), lamports. Since",
              "0.22 each operating step repays its signer from it (`ops_paid`) and finalize returns the rest to",
              "the creator in every outcome."
            ],
            "type": "u64"
          },
          {
            "name": "mintSalt",
            "docs": [
              "0.19, carved from the 0.18 reserve (the pool squatting fix, the founder 2026-09-27): the",
              "mint is the PDA [\"mint\", creator, mint_salt LE] and does not exist until `create_pool`",
              "creates it, so the salt is kept here for that instruction's seeds."
            ],
            "type": "u64"
          },
          {
            "name": "nameLen",
            "docs": [
              "Lengths of the three metadata strings below, in bytes (0.19)."
            ],
            "type": "u8"
          },
          {
            "name": "symbolLen",
            "type": "u8"
          },
          {
            "name": "uriLen",
            "type": "u8"
          },
          {
            "name": "pad3",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "name",
            "docs": [
              "Metaplex name, symbol and URI given at genesis and written into the mint's metadata by",
              "`create_pool` (0.19); zero padded. Until 0.18 the metadata account was created at genesis."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                10
              ]
            }
          },
          {
            "name": "uri",
            "type": {
              "array": [
                "u8",
                200
              ]
            }
          },
          {
            "name": "padOps",
            "docs": [
              "0.22: alignment for `ops_paid`; zeros."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "opsPaid",
            "docs": [
              "0.22: lamports of `crank_bond` already paid to the signers of operating steps (settle,",
              "create_pool, lock_liquidity, burn_unsold). Never more than `crank_bond`."
            ],
            "type": "u64"
          },
          {
            "name": "deliveryTerms",
            "docs": [
              "0.26, carved from the reserve: how the caller of `deliver` is paid (`delivery_terms`), fixed at",
              "genesis. Zero in every launch created before 0.26, whose reserve was zeros."
            ],
            "type": "u8"
          },
          {
            "name": "padTerms",
            "docs": [
              "0.26: alignment for `delivery_reward`; zeros."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "deliveryReward",
            "docs": [
              "0.26: lamports a pushed delivery pays its caller out of the delivered bid's own account, on top",
              "of the token account rent the caller advanced (`DELIVERY_REWARD_LAMPORTS` at genesis). Read only",
              "when `delivery_terms` is `BID_RENT`; zero in every launch created before 0.26."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeeBps",
            "docs": [
              "0.28, carved from the reserve: the raise fee terms copied from the config at genesis and read by `settle`,",
              "never the config. Basis points of the cleared raise taken when the pool opens, and the creator's share of",
              "that fee in basis points of the fee. Zeros in every launch created before 0.28, whose reserve was zeros."
            ],
            "type": "u16"
          },
          {
            "name": "raiseFeeCreatorShareBps",
            "type": "u16"
          },
          {
            "name": "padFee",
            "docs": [
              "0.28: alignment; zeros."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "attestRequired",
            "docs": [
              "0.29, carved from the reserve: 1 when every bid must carry a Bouncer attestation (`Config.attest_bids` at",
              "genesis); `admin_waive_attestation` sets it to 0 (while the window is open, once) and nothing sets it back.",
              "Read by `commit` only."
            ],
            "type": "u8"
          },
          {
            "name": "padAttest",
            "docs": [
              "0.29: alignment; zeros."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "processingCharge",
            "docs": [
              "0.29: the processing charge each bid pays at commit, lamports (`Config.processing_charge` at genesis). Read by",
              "`commit`; each bid records what it paid, so the reveal reward and refunds use the bid's own figure."
            ],
            "type": "u64"
          },
          {
            "name": "histogramRent",
            "docs": [
              "0.29: the lamports the creator paid for the launch's `Histogram` account (its rent at `Histogram::LEN`, written",
              "by `grow_histogram`; the genesis size's rent until then). A launch cost, never refunded: the account is the",
              "auction's permanent receipt. For display."
            ],
            "type": "u64"
          },
          {
            "name": "attestWaivedTs",
            "docs": [
              "0.29: when `admin_waive_attestation` cleared `attest_required` (unix seconds), 0 while never waived. The",
              "waiver is launch-wide and one way, lands only while the bidding window is open, and is recorded here as well",
              "as in the `AttestationWaived` event."
            ],
            "type": "i64"
          },
          {
            "name": "histogramGrown",
            "docs": [
              "0.29: 1 once `grow_histogram` took the histogram to its full size; `commit` refuses every bid before that",
              "(`HistogramNotReady`). Set in the same transaction as `create_launch` by the site's create flow."
            ],
            "type": "u8"
          },
          {
            "name": "padHist",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "metadataReserve",
            "docs": [
              "0.29 tenth candidate (Astra's N3, 2026-10-21): lamports of the operating prepay held in the vault for",
              "`finish_mint` when the prepay was returned to the creator (`lock_liquidity` or `release_pool_cash`) before the",
              "metadata was written: `METADATA_RESERVE_LAMPORTS` at most, less when the prepay had less left. `finish_mint`",
              "pays its payer from it (the measured spend plus the step allowance, capped by it) and the rest to the creator,",
              "then zeroes it. `burn_unsold` neither pays it out nor sweeps it. 0 while the prepay is still open",
              "(`bond_state` 0) or once the metadata is written."
            ],
            "type": "u64"
          },
          {
            "name": "mintFinished",
            "docs": [
              "0.29 tenth candidate (Astra's N4): 1 once `finish_mint` landed (PoolLive or Finalized). The money steps read",
              "this, not the mint: the prepay's return holds the reserve above while it is 0."
            ],
            "type": "u8"
          },
          {
            "name": "padMint",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "tradingState",
            "docs": [
              "v0.30 (the founder, 2026-10-27, gate X): 0 no gate (the pool was created under 0.29 or earlier, or does not exist yet),",
              "1 frozen (`create_pool` froze the pool's launch token vault the instant Meteora made it; no swap can land),",
              "2 open (`open_trading` thawed it once every bid was delivered or refunded, or `admin_open_trading` did). Read",
              "by the two opens and by `burn_unsold`, which refuses to finalize a frozen pool."
            ],
            "type": "u8"
          },
          {
            "name": "padTrading",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "treasury",
            "docs": [
              "v0.30: where this launch's platform raise fee part goes (`Config.treasury` at genesis), read by `create_pool`",
              "and nothing else; `lp_owner` keeps the trading fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "revealMarginSecs",
            "docs": [
              "v0.30: the reveal margin the launch's round was sealed with (`Config.reveal_margin_secs` at genesis). Record."
            ],
            "type": "u32"
          },
          {
            "name": "padMargin",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "beaconPostedTs",
            "docs": [
              "v0.30: the chain clock when `post_beacon` landed, and the lag sample: the round's scheduled publish time (wall",
              "clock) less that chain clock. Positive means the chain's clock was behind the world's by at least that much when",
              "the key was posted (the signature proves the key existed). Record only; no instruction reads either."
            ],
            "type": "i64"
          },
          {
            "name": "beaconLagSecs",
            "type": "i64"
          },
          {
            "name": "metadataReserveLamports",
            "docs": [
              "v0.30: the metadata reserve term (`Config.metadata_reserve` at genesis), read by the prepay's return."
            ],
            "type": "u64"
          },
          {
            "name": "poolCreatedTs",
            "docs": [
              "v0.32: when `create_pool` landed (the chain clock), the start of `park_bid`'s catch-all; 0 on a pool created",
              "before 0.32, where the record's `settled_ts` stands in."
            ],
            "type": "i64"
          },
          {
            "name": "parkedCount",
            "docs": [
              "v0.32: bids parked and not yet collected or pushed, and the lamports the vault holds for them (excluded from",
              "`burn_unsold`'s dust sweep)."
            ],
            "type": "u32"
          },
          {
            "name": "padPark",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "parkedLamports",
            "type": "u64"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for fields appended by later versions (0.18, 752 since 0.22, 736 since 0.26, 728 since 0.28, 688",
              "in the first nine 0.29 candidates, 672 since the tenth, 600 since 0.30, 576 since 0.32); zeros."
            ],
            "type": {
              "array": [
                "u8",
                576
              ]
            }
          }
        ]
      }
    },
    {
      "name": "launchClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "closeTs",
            "type": "i64"
          },
          {
            "name": "reason",
            "docs": [
              "0 WindowElapsed, 1 CapReached"
            ],
            "type": "u8"
          },
          {
            "name": "totalDeposits",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "launchCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "float",
            "type": "u64"
          },
          {
            "name": "floorValue",
            "type": "u64"
          },
          {
            "name": "minBid",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "windowSecs",
            "type": "i64"
          },
          {
            "name": "revealRound",
            "type": "u64"
          },
          {
            "name": "crankBond",
            "docs": [
              "The crank bond the creator posted, lamports (0.16)."
            ],
            "type": "u64"
          },
          {
            "name": "mintSalt",
            "docs": [
              "0.19: the mint's PDA salt and the metadata `create_pool` will write. The mint and its",
              "metadata account do not exist until then; this event and the launch account carry them."
            ],
            "type": "u64"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "abortAfterSecs",
            "docs": [
              "0.25: the three terms the event lacked. With `floor_value`, `min_bid` and `crank_bond` above",
              "they are the six the creator signed in `create_launch` (`LaunchTerms`): the event records",
              "what was agreed, not only what happened."
            ],
            "type": "u64"
          },
          {
            "name": "deliveryFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorLpBps",
            "type": "u16"
          },
          {
            "name": "raiseFeeBps",
            "docs": [
              "0.28: the raise fee terms, the seventh and eighth the creator signed: basis points of the cleared raise",
              "taken when the pool opens, and the creator's share of that fee in basis points of the fee."
            ],
            "type": "u16"
          },
          {
            "name": "raiseFeeCreatorShareBps",
            "type": "u16"
          },
          {
            "name": "attestRequired",
            "docs": [
              "0.29: 1 when every bid on this launch must carry a Bouncer attestation (`Config.attest_bids` at genesis;",
              "`admin_waive_attestation` can clear it later), the processing charge each bid pays (`Config.processing_charge`",
              "at genesis), and the lamports the creator paid for the histogram account, returned when it closes."
            ],
            "type": "u8"
          },
          {
            "name": "processingCharge",
            "type": "u64"
          },
          {
            "name": "histogramRent",
            "type": "u64"
          },
          {
            "name": "treasury",
            "docs": [
              "v0.30: the treasury the launch recorded, the reveal margin its round was sealed with, and the two operating",
              "values copied from the config at genesis."
            ],
            "type": "pubkey"
          },
          {
            "name": "revealMarginSecs",
            "type": "u32"
          },
          {
            "name": "deliveryReward",
            "type": "u64"
          },
          {
            "name": "metadataReserveLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "launchFailed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "stage",
            "docs": [
              "0 at close, 1 at settle"
            ],
            "type": "u8"
          },
          {
            "name": "totalDeposits",
            "type": "u64"
          },
          {
            "name": "revealedDeposits",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "launchTerms",
      "docs": [
        "0.25: the terms a creator agrees to, stated in `create_launch`'s own data: the six values a",
        "launch copies from the config, in the config's own order (`Config` bytes 76..112 are this",
        "struct, serialised). `create_launch` refuses `TermsChanged` unless every one equals the config",
        "at execution, and then writes the launch and takes the prepay from these, never from the config,",
        "so an `admin_update_config` that lands between the creator's signature and the instruction",
        "cannot change what the creator gets or pays. Exact equality, not bounds: which direction is",
        "better for the creator is not defined for the floor, the minimum or the delay, so a difference",
        "means read again and sign again. `lp_owner` is not a term: it is where the platform's own fees",
        "go, and no creator money rides on it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "floorValue",
            "type": "u64"
          },
          {
            "name": "minBid",
            "type": "u64"
          },
          {
            "name": "abortAfterSecs",
            "type": "u64"
          },
          {
            "name": "deliveryFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorLpBps",
            "type": "u16"
          },
          {
            "name": "crankBond",
            "docs": [
              "The operating prepay debited from the creator in `create_launch`."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeeBps",
            "docs": [
              "0.28: the seventh and eighth terms, `Config` bytes 184..188: the raise fee and the creator's share of it."
            ],
            "type": "u16"
          },
          {
            "name": "raiseFeeCreatorShareBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "liquidityLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "which",
            "docs": [
              "0 the creator's position, 1 the platform's."
            ],
            "type": "u8"
          },
          {
            "name": "nftOwner",
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "docs": [
              "The position NFT's mint; the default key when the side's share was zero and nothing was locked."
            ],
            "type": "pubkey"
          },
          {
            "name": "liquidity",
            "docs": [
              "Meteora liquidity permanently locked in this position (0.19; LP tokens until 0.18)."
            ],
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "lpOwnerChanged",
      "docs": [
        "0.24: the proposed fee destination accepted by signing; it is now `lp_owner`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldLpOwner",
            "type": "pubkey"
          },
          {
            "name": "newLpOwner",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mintFinished",
      "docs": [
        "2026-10-21: `finish_mint` wrote the launch token's metadata and revoked its mint authority (out of",
        "`create_pool` since the eighth 0.29 candidate), and repaid its payer `repaid` lamports from the prepay."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "metadata",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "repaid",
            "docs": [
              "From the prepay while it is open, else from `Launch.metadata_reserve` (0.29 tenth candidate), capped by it."
            ],
            "type": "u64"
          },
          {
            "name": "reserveReturned",
            "docs": [
              "0.29 tenth candidate (Astra's N3): what was left of the reserve after the payer, paid to the creator. Trailing."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "parkedCollected",
      "docs": [
        "v0.32: the bidder collected a parked payout to destinations it named (`collect_parked`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "tokenDestination",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "parkedPushed",
      "docs": [
        "v0.32: a parked payout pushed to the bidder's own token account and wallet (`push_parked`); `rent` is the token",
        "account rent the caller fronted and was repaid out of the bid's own account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "rent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "platformFeesCollected",
      "docs": [
        "The platform position's fees, claimed from Meteora by the launch's pool",
        "creator PDA and paid to the config's LP owner (0.19). `lamports` arrive as",
        "wrapped SOL in the LP owner's associated token account; `token_atoms` is",
        "the launch token side, zero under OnlyB, kept in the PDA's token account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "lpOwner",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "tokenAtoms",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "platformFeesSplit",
      "docs": [
        "v0.30 (the founder, 2026-10-27, the buy-and-burn folded into the core): what `collect_platform_fees` did with the fee",
        "vault's wrapped SOL account after the claim: `held` (the claim and anything already there) split into the",
        "treasury's native SOL (`treasury_lamports`) and the burn vault's wrapped SOL (`burn_lamports`), exact."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "claimed",
            "type": "u64"
          },
          {
            "name": "held",
            "type": "u64"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "treasuryLamports",
            "type": "u64"
          },
          {
            "name": "burnLamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "platformVault",
      "docs": [
        "v0.30 (the fold-in): the fee vault, PDA `[\"fee_vault\"]`, 9 bytes, one per deployment: a program-owned account so",
        "the lamports a closed wrapped SOL account leaves in it can be moved on by the program (`collect_platform_fees`).",
        "It holds nothing between instructions but its own rent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "platformVaultsInitialized",
      "docs": [
        "v0.30: the fee vault and the burn vault's wrapped SOL account created (`init_platform_vaults`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "feeVault",
            "type": "pubkey"
          },
          {
            "name": "burnVault",
            "type": "pubkey"
          },
          {
            "name": "burnVaultWsol",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "poolCashReleased",
      "docs": [
        "0.29 twelfth candidate (Astra's F2): `release_pool_cash` closed the wrapped SOL pass through and returned the pool",
        "creator PDA's loan to the pool payer (`wsol_closed`, `loan_returned`, and `loan_repaid` from the prepay for the part",
        "Meteora kept), ahead of the creator's split; the prepay's return, when it happened here, is its own",
        "`PrepayReturned`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "poolPayer",
            "type": "pubkey"
          },
          {
            "name": "wsolClosed",
            "type": "u64"
          },
          {
            "name": "loanReturned",
            "type": "u64"
          },
          {
            "name": "loanRepaid",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "floatValue",
            "type": "u64"
          },
          {
            "name": "crankBond",
            "docs": [
              "The crank bond paid from the vault to the payer, lamports (0.16)."
            ],
            "type": "u64"
          },
          {
            "name": "cranker",
            "docs": [
              "Who landed the instruction and received the bond (0.16)."
            ],
            "type": "pubkey"
          },
          {
            "name": "poolSolAtOpen",
            "docs": [
              "The pool's SOL side at open, lamports (0.18): from 0.19 Meteora's rounded",
              "deposit plus any SOL strangers sent to the vault's address before the pool opened."
            ],
            "type": "u64"
          },
          {
            "name": "liquidity",
            "docs": [
              "Meteora pool liquidity at open, all of it permanently locked in the platform position (0.19)."
            ],
            "type": "u128"
          },
          {
            "name": "sqrtPrice",
            "docs": [
              "Opening price, Q64.64 square root of lamports per token atom, read back from the pool (0.19)."
            ],
            "type": "u128"
          },
          {
            "name": "dustTokensBurned",
            "docs": [
              "Reserve atoms the rounded deposit could not take, burned (0.19)."
            ],
            "type": "u64"
          },
          {
            "name": "dustLamports",
            "docs": [
              "Proceeds lamports the rounded deposit could not take, paid to the cranker (0.19)."
            ],
            "type": "u64"
          },
          {
            "name": "platformNftMint",
            "docs": [
              "The platform position's NFT mint, owned by the launch's pool creator PDA (0.19)."
            ],
            "type": "pubkey"
          },
          {
            "name": "raiseFeeCreatorPaid",
            "docs": [
              "0.28: the raise fee paid here, lamports, to the creator's wallet and to `Launch.lp_owner`; a part its",
              "destination could not hold rent exempt stayed in the proceeds and is 0 here. `pool_sol_in` is what went",
              "into the wrapped SOL pass through for the pool: `float_value` less the two parts paid."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeePlatformPaid",
            "type": "u64"
          },
          {
            "name": "poolSolIn",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "prepayReturned",
      "docs": [
        "0.23: `lock_liquidity`, the last operating step of a cleared launch, returned the unused operating",
        "prepay to the creator. `held` stays in the vault for `burn_unsold`'s caller."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "held",
            "docs": [
              "What stays in the vault: `burn_unsold`'s allowance, plus (0.29 tenth candidate) `metadata_reserve`."
            ],
            "type": "u64"
          },
          {
            "name": "metadataReserve",
            "docs": [
              "0.29 tenth candidate (Astra's N3): the part of `held` kept for `finish_mint`, 0 when the metadata was",
              "already written. Trailing."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "refunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "clearingTick",
            "type": "u16"
          },
          {
            "name": "marginalTick",
            "type": "u16"
          },
          {
            "name": "floatValue",
            "type": "u64"
          },
          {
            "name": "winningDeposits",
            "type": "u64"
          },
          {
            "name": "aboveDeposits",
            "type": "u64"
          },
          {
            "name": "atDeposits",
            "type": "u64"
          },
          {
            "name": "revealedBids",
            "type": "u32"
          },
          {
            "name": "invalidBids",
            "type": "u32"
          },
          {
            "name": "creatorDeposit",
            "type": "u64"
          },
          {
            "name": "creatorTokens",
            "type": "u64"
          },
          {
            "name": "creatorCost",
            "type": "u64"
          },
          {
            "name": "creatorBidState",
            "type": "u8"
          },
          {
            "name": "raiseFeeCreator",
            "docs": [
              "0.28: the raise fee agreed here from the launch's own terms, lamports: the creator's part and the",
              "platform's. Paid by `create_pool`, so nothing of it moves if the launch never opens its pool."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeePlatform",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settlementRecord",
      "docs": [
        "Settlement record. PDA [\"settlement\", launch], 264 bytes. Only exists for",
        "a launch that cleared."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "docs": [
              "Reserved, zero (byte 10 was `capped` until 0.14, when the cap was removed)."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "clearingTick",
            "type": "u16"
          },
          {
            "name": "marginalTick",
            "docs": [
              "At least clearing_tick. Bids above it fill in full, bids at it are rationed, bids below it get nothing."
            ],
            "type": "u16"
          },
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "floatValue",
            "type": "u64"
          },
          {
            "name": "winningDeposits",
            "type": "u64"
          },
          {
            "name": "revealedBids",
            "type": "u32"
          },
          {
            "name": "invalidBids",
            "type": "u32"
          },
          {
            "name": "settledTs",
            "type": "i64"
          },
          {
            "name": "tokensDelivered",
            "type": "u64"
          },
          {
            "name": "distributedBids",
            "type": "u32"
          },
          {
            "name": "pad3",
            "type": "u32"
          },
          {
            "name": "largestFillTokens",
            "type": "u64"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "burnedTokens",
            "type": "u64"
          },
          {
            "name": "aboveDeposits",
            "type": "u64"
          },
          {
            "name": "atDeposits",
            "type": "u64"
          },
          {
            "name": "creatorDeposit",
            "docs": [
              "The launch creator's own bid, labelled here so nobody has to infer it. Zero when the creator did not bid."
            ],
            "type": "u64"
          },
          {
            "name": "creatorTokens",
            "docs": [
              "Token atoms the creator's bid receives under the fill rule."
            ],
            "type": "u64"
          },
          {
            "name": "creatorCost",
            "docs": [
              "Lamports the creator's bid pays (deposit minus refund)."
            ],
            "type": "u64"
          },
          {
            "name": "creatorTick",
            "docs": [
              "The creator's revealed tick. Valid when creator_bid_state is 1."
            ],
            "type": "u16"
          },
          {
            "name": "creatorBidState",
            "docs": [
              "0 no creator bid, 1 revealed, 2 invalid ciphertext (refunded in full)."
            ],
            "type": "u8"
          },
          {
            "name": "lpLockState",
            "docs": [
              "bit 0: the creator's LP position is locked; bit 1: the protocol's. 3 is both, required to finalize."
            ],
            "type": "u8"
          },
          {
            "name": "pad4",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "lpTotal",
            "docs": [
              "Raydium only (until 0.18): LP tokens the pool minted. Always 0 from 0.19; see `pool_liquidity`."
            ],
            "type": "u64"
          },
          {
            "name": "creatorLockNft",
            "docs": [
              "Mint of the creator's Meteora position NFT (0.19; default key until locked, or when the creator's share was zero)."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolLockNft",
            "docs": [
              "Mint of the platform's Meteora position NFT (0.19), owned by the launch's pool creator PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "poolSolAtOpen",
            "docs": [
              "The pool's SOL side when it opened, lamports (0.18): from 0.19 what Meteora's SOL vault held after",
              "the deposit, the rounded deposit plus any SOL strangers sent to the vault's address before it existed."
            ],
            "type": "u64"
          },
          {
            "name": "poolLiquidity",
            "docs": [
              "The pool's liquidity at open (0.19), all of it permanently locked; split between the two positions at lock time."
            ],
            "type": "u128"
          },
          {
            "name": "openingSqrtPrice",
            "docs": [
              "The price the pool opened at (0.19): Q64.64 square root of lamports per token atom."
            ],
            "type": "u128"
          },
          {
            "name": "dustTokensBurned",
            "docs": [
              "Reserve atoms Meteora's rounded deposit could not take, burned at pool creation (0.19)."
            ],
            "type": "u64"
          },
          {
            "name": "dustLamports",
            "docs": [
              "Proceeds lamports Meteora's rounded deposit could not take, paid to the `create_pool` payer (0.19)."
            ],
            "type": "u64"
          },
          {
            "name": "poolPayer",
            "docs": [
              "The `create_pool` signer (0.20). `lock_liquidity` returns the pool creator PDA's unused rent loan here."
            ],
            "type": "pubkey"
          },
          {
            "name": "poolLoan",
            "docs": [
              "The rent loan `create_pool` made to the pool creator PDA, lamports (0.23): the amount transferred,",
              "recorded in the same instruction. `lock_liquidity` repays the part Meteora kept from this record,",
              "never from a recomputation (a Rent change between the two steps mispriced it under 0.22)."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeeCreator",
            "docs": [
              "0.28: the raise fee agreed at `settle` from the launch's own terms, lamports: the creator's part",
              "(floor of the fee times the creator's share) and the platform's (the rest of the fee, which is the floor",
              "of `float_value` times `Launch.raise_fee_bps`). Nothing is paid here; `create_pool` pays."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeePlatform",
            "type": "u64"
          },
          {
            "name": "raiseFeeCreatorPaid",
            "docs": [
              "0.28: what `create_pool` paid of each part. Equal to the agreed part, or 0 when the destination could not",
              "hold it rent exempt (then it stayed in the proceeds). 0 until the pool opens."
            ],
            "type": "u64"
          },
          {
            "name": "raiseFeePlatformPaid",
            "type": "u64"
          },
          {
            "name": "poolSolIn",
            "docs": [
              "0.28: the proceeds `create_pool` put into the wrapped SOL pass through for the pool: `float_value` less the",
              "two parts paid. The pool's SOL side at open is this less `dust_lamports` plus any stray SOL (`pool_sol_at_open`)."
            ],
            "type": "u64"
          },
          {
            "name": "cashReleased",
            "docs": [
              "0.29 twelfth candidate (Astra's F2): 1 once `release_pool_cash` closed the wrapped SOL pass through and returned",
              "the pool creator PDA's loan to the pool payer and the unused prepay to the creator, ahead of the creator's",
              "split. `lock_liquidity` then skips those steps (its pass through slot takes the program id)."
            ],
            "type": "u8"
          },
          {
            "name": "padCash",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "openedTs",
            "docs": [
              "v0.30: the chain clock when trading opened (`open_trading` or `admin_open_trading`); 0 while the pool is frozen."
            ],
            "type": "i64"
          },
          {
            "name": "openedForced",
            "docs": [
              "v0.30: 1 when the open was the Squad's break-glass (`admin_open_trading`, bids still outstanding), 0 for the",
              "gated open."
            ],
            "type": "u8"
          },
          {
            "name": "padOpen",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for fields appended by later versions (0.18); zeros. 0.19 took 48 of the 512 bytes, 0.20 took 32, 0.23 took 8, 0.28 took 40, the twelfth 0.29 candidate 8, 0.30 took 16."
            ],
            "type": {
              "array": [
                "u8",
                360
              ]
            }
          }
        ]
      }
    },
    {
      "name": "tradingForcedOpen",
      "docs": [
        "v0.30: the Squad's break-glass opened trading with bids still outstanding (`undelivered` of them)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "openedTs",
            "type": "i64"
          },
          {
            "name": "undelivered",
            "type": "u32"
          },
          {
            "name": "admin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "tradingOpened",
      "docs": [
        "v0.30 (gate X): trading opened on the launch's pool: every bid delivered or refunded, the vault thawed, the mint's",
        "freeze authority revoked for good."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "openedTs",
            "type": "i64"
          },
          {
            "name": "distributedCount",
            "type": "u32"
          },
          {
            "name": "bidCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "treasuryChanged",
      "docs": [
        "v0.30: the proposed treasury accepted; the platform's raise fee part of every launch created from now on goes there."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldTreasury",
            "type": "pubkey"
          },
          {
            "name": "newTreasury",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "Vault. PDA [\"vault\", launch], 41 bytes. Holds the deposits as lamports on",
        "top of its rent and is the authority of the token vault."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "launch",
            "type": "pubkey"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for fields appended by later versions (0.18); zeros."
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    }
  ]
};
