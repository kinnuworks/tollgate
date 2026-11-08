//! Tollgate settle program.
//!
//! One instruction: settle. It finds an Ed25519 signature check in the same
//! transaction, reads the payer's signed voucher out of it, and pays the
//! provider at most the signed amount from the payer's token account. The
//! payer approves this program's PDA as a token delegate when the session
//! opens, so the chain (not the server) decides how much the provider gets.
//! Any provider can sell through it: the delegate PDA is derived from the
//! provider's wallet, so a payer's approval only ever pays the provider it chose.
//! The payer must also sign the settle transaction, so a voucher cannot be
//! replayed by the server or anyone else who has seen it.
//!
//! Voucher bytes (Solana Foundation payment-channel layout, 50 bytes):
//!   0x56 0x01 | channel id (32) = payer's key | amount u64 LE | expires_at i64 LE


use pinocchio::{
    cpi::{Seed, Signer},
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio::sysvars::{clock::Clock, Sysvar};
use pinocchio_token::instructions::TransferChecked;

entrypoint!(process_instruction);

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
    /// The payer did not sign this settle, so nobody else can replay a voucher.
    PayerMustSign = 6,
    /// Every voucher the payer signed in this transaction has expired.
    VoucherExpired = 7,
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

    // accounts: payer token account, mint, provider token account, the provider's Tollgate PDA (the
    // payer's approved delegate), payer (signer), instructions sysvar, token program, provider wallet.
    let [payer_ata, mint, payee_ata, authority, owner, ix_sysvar, _token_program, provider, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if ix_sysvar.address().as_ref() != INSTRUCTIONS_SYSVAR {
        return Err(err(TollgateError::BadInput));
    }
    let owner_key: [u8; 32] = owner.address().as_ref().try_into().unwrap();
    // Each payout needs the payer's own signature on this transaction, so a
    // voucher can't be settled again by whoever holds it.
    if !owner.is_signer() {
        return Err(err(TollgateError::PayerMustSign));
    }

    // The payer's token account must belong to the voucher signer, and the
    // receiving account must belong to this deployment's provider.
    {
        let from = payer_ata.try_borrow()?;
        if from.len() < 64 || from[32..64] != owner_key {
            return Err(err(TollgateError::WrongPayer));
        }
        let to = payee_ata.try_borrow()?;
        if to.len() < 64 || to[32..64] != *provider.address().as_ref() {
            return Err(err(TollgateError::WrongProvider));
        }
    }

    // Find the largest amount the payer signed for, across Ed25519 checks in this transaction.
    let signed = {
        let sysvar = ix_sysvar.try_borrow()?;
        let now = Clock::get()?.unix_timestamp;
        match max_signed_amount(&sysvar, &owner_key, now) {
            Signed::Found(a) => a,
            Signed::AllExpired => return Err(err(TollgateError::VoucherExpired)),
            Signed::None => return Err(err(TollgateError::NoSignedVoucher)),
        }
    };
    if amount > signed {
        return Err(err(TollgateError::AboveSignedVoucher));
    }

    let bump_ref = [bump];
    // Each provider has its own delegate PDA, so an approval for one provider can never pay another.
    let seeds = [Seed::from(PDA_SEED), Seed::from(provider.address().as_ref()), Seed::from(&bump_ref)];
    let signer = Signer::from(&seeds);
    TransferChecked::new(payer_ata, mint, payee_ata, authority, amount, decimals).invoke_signed(&[signer])
}

/// Walks the instructions sysvar. For every Ed25519 program instruction whose
/// signature, key and message all live inside that same instruction (offset
/// index 0xFFFF), checks the key is the payer and the message is a voucher for
/// the payer's channel, and returns the largest signed amount.
#[derive(Debug, PartialEq)]
pub enum Signed { Found(u64), AllExpired, None }

pub fn max_signed_amount(sysvar: &[u8], owner: &[u8; 32], now: i64) -> Signed {
    let mut expired = false;
    match scan(sysvar, owner, now, &mut expired) {
        Some(a) => Signed::Found(a),
        None if expired => Signed::AllExpired,
        None => Signed::None,
    }
}

fn scan(sysvar: &[u8], owner: &[u8; 32], now: i64, expired: &mut bool) -> Option<u64> {
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
            let expires_at = i64::from_le_bytes(msg[42..50].try_into().ok()?);
            if expires_at < now {
                *expired = true;
                continue;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an instructions-sysvar buffer holding one Ed25519 instruction with the given voucher.
    fn sysvar_with(owner: &[u8; 32], channel: &[u8; 32], amount: u64, expires_at: i64, inline: bool) -> [u8; 512] {
        let mut msg = [0u8; 50];
        msg[0] = 0x56; msg[1] = 0x01; msg[2..34].copy_from_slice(channel);
        msg[34..42].copy_from_slice(&amount.to_le_bytes()); msg[42..50].copy_from_slice(&expires_at.to_le_bytes());
        let mut data = [0u8; 162];
        data[0] = 1;
        let idx: u16 = if inline { u16::MAX } else { 0 };
        let put = |d: &mut [u8; 162], at: usize, v: u16| d[at..at + 2].copy_from_slice(&v.to_le_bytes());
        put(&mut data, 2, 48); put(&mut data, 4, idx); put(&mut data, 6, 16); put(&mut data, 8, idx);
        put(&mut data, 10, 112); put(&mut data, 12, 50); put(&mut data, 14, idx);
        data[16..48].copy_from_slice(owner); data[112..162].copy_from_slice(&msg);
        let mut b = [0u8; 512];
        b[0..2].copy_from_slice(&1u16.to_le_bytes());
        let start = 4u16; b[2..4].copy_from_slice(&start.to_le_bytes());
        let s = start as usize;
        b[s..s + 2].copy_from_slice(&0u16.to_le_bytes()); // no accounts
        b[s + 2..s + 34].copy_from_slice(&ED25519_PROGRAM);
        b[s + 34..s + 36].copy_from_slice(&(data.len() as u16).to_le_bytes());
        b[s + 36..s + 36 + data.len()].copy_from_slice(&data);
        b
    }

    const OWNER: [u8; 32] = [7u8; 32];

    #[test]
    fn reads_the_signed_amount() {
        assert_eq!(max_signed_amount(&sysvar_with(&OWNER, &OWNER, 700, 2_000, true), &OWNER, 1_000), Signed::Found(700));
    }
    #[test]
    fn ignores_a_voucher_from_another_signer() {
        assert_eq!(max_signed_amount(&sysvar_with(&[9u8; 32], &OWNER, 700, 2_000, true), &OWNER, 1_000), Signed::None);
    }
    #[test]
    fn ignores_a_voucher_for_another_channel() {
        assert_eq!(max_signed_amount(&sysvar_with(&OWNER, &[9u8; 32], 700, 2_000, true), &OWNER, 1_000), Signed::None);
    }
    #[test]
    fn ignores_data_pointing_outside_the_ed25519_instruction() {
        assert_eq!(max_signed_amount(&sysvar_with(&OWNER, &OWNER, 700, 2_000, false), &OWNER, 1_000), Signed::None);
    }
    #[test]
    fn reports_an_expired_voucher() {
        assert_eq!(max_signed_amount(&sysvar_with(&OWNER, &OWNER, 700, 999, true), &OWNER, 1_000), Signed::AllExpired);
    }
    #[test]
    fn decodes_the_provider_address() {
        assert_eq!(decode_b58(b"11111111111111111111111111111111"), [0u8; 32]);
    }
}
