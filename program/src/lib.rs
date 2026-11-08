//! Tollgate settle program.
//!
//! One instruction: settle. It finds an Ed25519 signature check in the same
//! transaction, reads the payer's signed voucher out of it, and pays the
//! provider at most the signed amount from the payer's token account. The
//! payer approves this program's PDA as a token delegate when the session
//! opens, so the chain (not the server) decides how much the provider gets.
//!
//! Voucher bytes (Solana Foundation payment-channel layout, 50 bytes):
//!   0x56 0x01 | channel id (32) = payer's key | amount u64 LE | expires_at i64 LE


use pinocchio::{
    cpi::{Seed, Signer},
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_token::instructions::TransferChecked;

entrypoint!(process_instruction);

/// The provider this deployment pays. Settling to any other account is refused.
const PAYEE: [u8; 32] = decode_b58(b"HBKvsWpsZHdqrwstePVRiKttFjoW3AEaEYNvCezMaFtp");
const INSTRUCTIONS_SYSVAR: [u8; 32] = decode_b58(b"Sysvar1nstructions1111111111111111111111111");
const ED25519_PROGRAM: [u8; 32] = decode_b58(b"Ed25519SigVerify111111111111111111111111111");
const PDA_SEED: &[u8] = b"tollgate";

/// Errors this program returns (shown as custom program errors on the explorer).
#[repr(u32)]
enum TollgateError {
    /// Settle asks for more than the payer's signed voucher allows.
    AboveSignedVoucher = 1,
    /// No Ed25519 check of a voucher signed by this payer was found in the transaction.
    NoSignedVoucher = 2,
    /// The voucher is for a different payer, or the token account isn't the payer's.
    WrongPayer = 3,
    /// The receiving account doesn't belong to this deployment's provider.
    WrongProvider = 4,
    /// Malformed instruction data or accounts.
    BadInput = 5,
}

fn err(e: TollgateError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

pub fn process_instruction(_program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    // data: [0] = 1 (settle), [1..9] amount u64, [9] decimals, [10] pda bump
    if data.len() != 11 || data[0] != 1 {
        return Err(err(TollgateError::BadInput));
    }
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let decimals = data[9];
    let bump = data[10];

    let [payer_ata, mint, payee_ata, authority, owner, ix_sysvar, _token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if ix_sysvar.address().as_ref() != INSTRUCTIONS_SYSVAR {
        return Err(err(TollgateError::BadInput));
    }
    let owner_key: [u8; 32] = owner.address().as_ref().try_into().unwrap();

    // The payer's token account must belong to the voucher signer, and the
    // receiving account must belong to this deployment's provider.
    {
        let from = payer_ata.try_borrow()?;
        if from.len() < 64 || from[32..64] != owner_key {
            return Err(err(TollgateError::WrongPayer));
        }
        let to = payee_ata.try_borrow()?;
        if to.len() < 64 || to[32..64] != PAYEE {
            return Err(err(TollgateError::WrongProvider));
        }
    }

    // Find the largest amount the payer signed for, across Ed25519 checks in this transaction.
    let signed = {
        let sysvar = ix_sysvar.try_borrow()?;
        max_signed_amount(&sysvar, &owner_key).ok_or(err(TollgateError::NoSignedVoucher))?
    };
    if amount > signed {
        return Err(err(TollgateError::AboveSignedVoucher));
    }

    let bump_ref = [bump];
    let seeds = [Seed::from(PDA_SEED), Seed::from(&bump_ref)];
    let signer = Signer::from(&seeds);
    TransferChecked::new(payer_ata, mint, payee_ata, authority, amount, decimals).invoke_signed(&[signer])
}

/// Walks the instructions sysvar. For every Ed25519 program instruction whose
/// signature, key and message all live inside that same instruction (offset
/// index 0xFFFF), checks the key is the payer and the message is a voucher for
/// the payer's channel, and returns the largest signed amount.
fn max_signed_amount(sysvar: &[u8], owner: &[u8; 32]) -> Option<u64> {
    let n = u16_at(sysvar, 0)? as usize;
    let mut best: Option<u64> = None;
    for i in 0..n {
        let start = u16_at(sysvar, 2 + 2 * i)? as usize;
        let num_accounts = u16_at(sysvar, start)? as usize;
        let program_at = start + 2 + num_accounts * 33;
        let program = sysvar.get(program_at..program_at + 32)?;
        if program != ED25519_PROGRAM {
            continue;
        }
        let data_len = u16_at(sysvar, program_at + 32)? as usize;
        let data = sysvar.get(program_at + 34..program_at + 34 + data_len)?;
        let count = *data.first()? as usize;
        for s in 0..count {
            let h = 2 + s * 14;
            let sig_ix = u16_at(data, h + 2)?;
            let key_off = u16_at(data, h + 4)? as usize;
            let key_ix = u16_at(data, h + 6)?;
            let msg_off = u16_at(data, h + 8)? as usize;
            let msg_len = u16_at(data, h + 10)? as usize;
            let msg_ix = u16_at(data, h + 12)?;
            // Only trust data that the Ed25519 program verified inside this instruction.
            if sig_ix != u16::MAX || key_ix != u16::MAX || msg_ix != u16::MAX || msg_len != 50 {
                continue;
            }
            let key = data.get(key_off..key_off + 32)?;
            let msg = data.get(msg_off..msg_off + 50)?;
            if key != owner || msg[0] != 0x56 || msg[1] != 0x01 || &msg[2..34] != owner {
                continue;
            }
            let amt = u64::from_le_bytes(msg[34..42].try_into().ok()?);
            best = Some(best.map_or(amt, |b| if amt > b { amt } else { b }));
        }
    }
    best
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

/// Compile-time base58 decode of a 32-byte address.
const fn decode_b58(s: &[u8]) -> [u8; 32] {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < s.len() {
        let mut digit = 0usize;
        let mut found = false;
        while digit < 58 {
            if ALPHABET[digit] == s[i] { found = true; break; }
            digit += 1;
        }
        assert!(found);
        let mut carry = digit as u32;
        let mut j = 32;
        while j > 0 {
            j -= 1;
            carry += (out[j] as u32) * 58;
            out[j] = (carry & 0xff) as u8;
            carry >>= 8;
        }
        assert!(carry == 0);
        i += 1;
    }
    out
}
