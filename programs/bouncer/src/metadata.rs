//! Metaplex Token Metadata `CreateMetadataAccountV3`, hand encoded so the
//! program does not depend on an alpha release of the mpl crate. Layout from
//! the Metaplex program: discriminator 33, then borsh `DataV2`, `is_mutable`,
//! and `collection_details: Option<..>`.

use crate::errors::BouncerError;
use anchor_lang::prelude::*;
use solana_instruction::{AccountMeta, Instruction};

/// Token Metadata program id (same on every cluster).
pub const METADATA_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

pub const MAX_NAME: usize = 32;
pub const MAX_SYMBOL: usize = 10;
pub const MAX_URI: usize = 200;

fn put_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// Build the instruction. Accounts, in the program's order: metadata (writable),
/// mint, mint authority (signer), payer (signer, writable), update authority,
/// system program, rent sysvar.
pub fn create_metadata_v3_instruction(
    metadata: Pubkey,
    mint: Pubkey,
    mint_authority: Pubkey,
    payer: Pubkey,
    update_authority: Pubkey,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Result<Instruction> {
    require!(
        name.len() <= MAX_NAME && symbol.len() <= MAX_SYMBOL && uri.len() <= MAX_URI,
        BouncerError::MetadataTooLong
    );
    let mut data = Vec::with_capacity(64 + name.len() + symbol.len() + uri.len());
    data.push(33u8);
    put_string(&mut data, name);
    put_string(&mut data, symbol);
    put_string(&mut data, uri);
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.push(0); // creators: None
    data.push(0); // collection: None
    data.push(0); // uses: None
    data.push(0); // is_mutable: false
    data.push(0); // collection_details: None
    Ok(Instruction {
        program_id: METADATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(metadata, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(mint_authority, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(update_authority, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(anchor_lang::prelude::rent::ID, false),
        ],
        data,
    })
}
