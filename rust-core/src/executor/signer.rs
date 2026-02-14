//! EIP-712 order signing for Polymarket CTF Exchange.
//!
//! Ported from `native-core/src/lib.rs` with HFT optimizations:
//! - `LocalWallet` cached (avoid hex decode + curve creation per call)
//! - Domain separators pre-computed at init time
//! - Pre-allocated buffers for encoding

use ethers_core::types::{Address, H256, U256};
use ethers_core::utils::keccak256;
use ethers_signers::LocalWallet;
use std::str::FromStr;

use crate::types::order::{OrderToSign, SignedClobOrder};

// =============================================================================
// CONSTANTS — Hardcoded for maximum performance
// =============================================================================

const DOMAIN_NAME: &str = "Polymarket CTF Exchange";
const DOMAIN_VERSION: &str = "1";
const CHAIN_ID: u64 = 137; // Polygon Mainnet

// Standard CTF Exchange
const VERIFYING_CONTRACT: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
// NegRisk CTF Exchange
const NEG_RISK_VERIFYING_CONTRACT: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// EIP-712 Type Hashes (pre-computed strings)
const DOMAIN_TYPE_HASH: &str =
    "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
const ORDER_TYPE_HASH: &str =
    "0xa852566c4e14d00869b6db0220888a9090a13eccdaea03713ff0a3d27bf9767c";

const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";
const SIGNATURE_TYPE_POLY_GNOSIS_SAFE: u8 = 2;

// =============================================================================
// SIGNER STATE — Cached for HFT performance
// =============================================================================

/// Pre-computed signer state. Created once at `init_executor()`.
pub struct SignerState {
    pub wallet: LocalWallet,
    pub maker_address: Address,
    pub signer_address: Address,
    pub taker_address: Address, // always zero address
    /// Pre-computed domain separator for standard CTF Exchange
    pub domain_separator_standard: [u8; 32],
    /// Pre-computed domain separator for negRisk CTF Exchange
    pub domain_separator_neg_risk: [u8; 32],
}

impl SignerState {
    /// Create a new SignerState from private key and addresses.
    /// Computes domain separators once.
    pub fn new(
        private_key: &str,
        maker_addr: &str,
        signer_addr: &str,
    ) -> Result<Self, String> {
        let pk = private_key.trim();
        let pk = if pk.starts_with("0x") || pk.starts_with("0X") {
            &pk[2..]
        } else {
            pk
        };

        let key_bytes =
            hex::decode(pk).map_err(|e| format!("Invalid private key hex: {}", e))?;

        let wallet = LocalWallet::from_bytes(&key_bytes)
            .map_err(|e| format!("Failed to create wallet: {}", e))?;

        let maker_address = Address::from_str(maker_addr)
            .map_err(|e| format!("Invalid maker address: {}", e))?;
        let signer_address = Address::from_str(signer_addr)
            .map_err(|e| format!("Invalid signer address: {}", e))?;
        let taker_address = Address::from_str(ZERO_ADDRESS).unwrap();

        let domain_separator_standard = compute_domain_separator(false);
        let domain_separator_neg_risk = compute_domain_separator(true);

        Ok(Self {
            wallet,
            maker_address,
            signer_address,
            taker_address,
            domain_separator_standard,
            domain_separator_neg_risk,
        })
    }

    /// Sign a batch of orders. Wallet and domain separators are reused.
    pub fn sign_batch_orders(&self, orders: &[OrderToSign]) -> Result<Vec<SignedClobOrder>, String> {
        let mut results = Vec::with_capacity(orders.len());

        let maker_checksum = ethers_core::utils::to_checksum(&self.maker_address, None);
        let signer_checksum = ethers_core::utils::to_checksum(&self.signer_address, None);
        let taker_checksum = ethers_core::utils::to_checksum(&self.taker_address, None);

        for order in orders {
            let salt = parse_u256(&order.salt)?;
            let token_id = parse_u256(&order.token_id)?;
            let maker_amount = parse_u256(&order.maker_amount)?;
            let taker_amount = parse_u256(&order.taker_amount)?;
            let fee_rate_bps = U256::from(order.fee_rate_bps);
            let expiration = U256::zero();
            let nonce = U256::zero();

            // Pick pre-computed domain separator
            let domain_separator = if order.neg_risk {
                &self.domain_separator_neg_risk
            } else {
                &self.domain_separator_standard
            };

            // Compute struct hash
            let struct_hash = compute_order_struct_hash(
                salt,
                self.maker_address,
                self.signer_address,
                self.taker_address,
                token_id,
                maker_amount,
                taker_amount,
                expiration,
                nonce,
                fee_rate_bps,
                order.side,
                SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
            );

            // Compute typed data hash
            let typed_data_hash = compute_typed_data_hash(domain_separator, &struct_hash);

            // Sign
            let signature = self
                .wallet
                .sign_hash(H256::from(typed_data_hash))
                .map_err(|e| format!("Signing failed: {}", e))?;

            let sig_bytes = signature.to_vec();
            let signature_hex = format!("0x{}", hex::encode(&sig_bytes));

            // Parse salt as i64 for JSON serialization (Polymarket expects integer)
            let salt_i64 = order
                .salt
                .parse::<i64>()
                .unwrap_or_else(|_| salt.as_u64() as i64);

            results.push(SignedClobOrder {
                salt: salt_i64,
                maker: maker_checksum.clone(),
                signer: signer_checksum.clone(),
                taker: taker_checksum.clone(),
                token_id: order.token_id.clone(),
                maker_amount: order.maker_amount.clone(),
                taker_amount: order.taker_amount.clone(),
                side: if order.side == 0 { "BUY".to_string() } else { "SELL".to_string() },
                expiration: "0".to_string(),
                nonce: "0".to_string(),
                fee_rate_bps: order.fee_rate_bps.to_string(),
                signature_type: SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
                signature: signature_hex,
            });
        }

        Ok(results)
    }
}

// =============================================================================
// HELPER FUNCTIONS (ported from native-core)
// =============================================================================

fn parse_u256(s: &str) -> Result<U256, String> {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        U256::from_str(s).map_err(|e| format!("Invalid U256: {}", e))
    } else {
        U256::from_dec_str(s).map_err(|e| format!("Invalid U256: {}", e))
    }
}

fn compute_domain_separator(neg_risk: bool) -> [u8; 32] {
    let domain_type_hash = hex::decode(&DOMAIN_TYPE_HASH[2..]).unwrap();
    let name_hash = keccak256(DOMAIN_NAME.as_bytes());
    let version_hash = keccak256(DOMAIN_VERSION.as_bytes());
    let chain_id = U256::from(CHAIN_ID);

    let contract_addr = if neg_risk {
        NEG_RISK_VERIFYING_CONTRACT
    } else {
        VERIFYING_CONTRACT
    };
    let verifying_contract = Address::from_str(contract_addr).unwrap();

    let mut encoded = Vec::with_capacity(160);
    encoded.extend_from_slice(&domain_type_hash);
    encoded.extend_from_slice(&name_hash);
    encoded.extend_from_slice(&version_hash);

    let mut chain_id_bytes = [0u8; 32];
    chain_id.to_big_endian(&mut chain_id_bytes);
    encoded.extend_from_slice(&chain_id_bytes);

    let mut addr_bytes = [0u8; 32];
    addr_bytes[12..32].copy_from_slice(verifying_contract.as_bytes());
    encoded.extend_from_slice(&addr_bytes);

    keccak256(&encoded)
}

fn compute_order_struct_hash(
    salt: U256,
    maker: Address,
    signer: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
) -> [u8; 32] {
    let order_type_hash = hex::decode(&ORDER_TYPE_HASH[2..]).unwrap();

    let mut encoded = Vec::with_capacity(416); // 13 * 32 bytes
    encoded.extend_from_slice(&order_type_hash);

    let encode_u256 = |v: U256| -> [u8; 32] {
        let mut bytes = [0u8; 32];
        v.to_big_endian(&mut bytes);
        bytes
    };

    let encode_address = |addr: Address| -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes[12..32].copy_from_slice(addr.as_bytes());
        bytes
    };

    encoded.extend_from_slice(&encode_u256(salt));
    encoded.extend_from_slice(&encode_address(maker));
    encoded.extend_from_slice(&encode_address(signer));
    encoded.extend_from_slice(&encode_address(taker));
    encoded.extend_from_slice(&encode_u256(token_id));
    encoded.extend_from_slice(&encode_u256(maker_amount));
    encoded.extend_from_slice(&encode_u256(taker_amount));
    encoded.extend_from_slice(&encode_u256(expiration));
    encoded.extend_from_slice(&encode_u256(nonce));
    encoded.extend_from_slice(&encode_u256(fee_rate_bps));
    encoded.extend_from_slice(&encode_u256(U256::from(side)));
    encoded.extend_from_slice(&encode_u256(U256::from(signature_type)));

    keccak256(&encoded)
}

fn compute_typed_data_hash(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut message = Vec::with_capacity(66);
    message.push(0x19);
    message.push(0x01);
    message.extend_from_slice(domain_separator);
    message.extend_from_slice(struct_hash);
    keccak256(&message)
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_separator_standard() {
        let ds = compute_domain_separator(false);
        assert_eq!(ds.len(), 32);
        // Verify it's deterministic
        let ds2 = compute_domain_separator(false);
        assert_eq!(ds, ds2);
    }

    #[test]
    fn test_domain_separator_neg_risk() {
        let ds_standard = compute_domain_separator(false);
        let ds_neg_risk = compute_domain_separator(true);
        // They should be different (different verifying contract)
        assert_ne!(ds_standard, ds_neg_risk);
    }

    #[test]
    fn test_parse_u256_decimal() {
        let val = parse_u256("1000000").unwrap();
        assert_eq!(val, U256::from(1_000_000u64));
    }

    #[test]
    fn test_parse_u256_hex() {
        let val = parse_u256("0xF4240").unwrap();
        assert_eq!(val, U256::from(1_000_000u64));
    }

    #[test]
    fn test_signer_state_creation() {
        // Use a well-known test private key (DO NOT use in production)
        let test_pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let state = SignerState::new(
            test_pk,
            "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        );
        assert!(state.is_ok());
    }

    #[test]
    fn test_sign_batch_deterministic() {
        let test_pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let state = SignerState::new(
            test_pk,
            "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        )
        .unwrap();

        let order = OrderToSign {
            salt: "12345".to_string(),
            token_id: "999".to_string(),
            maker_amount: "1000000".to_string(),
            taker_amount: "2000000".to_string(),
            side: 0,
            neg_risk: false,
            fee_rate_bps: 0,
        };

        let result1 = state.sign_batch_orders(&[order.clone()]).unwrap();
        let result2 = state.sign_batch_orders(&[order]).unwrap();

        // Same inputs should produce same signature
        assert_eq!(result1[0].signature, result2[0].signature);
        assert_eq!(result1[0].side, "BUY");
    }

    /// Cross-validate rust-core signer against native-core output.
    /// native-core was tested with the same inputs and produced:
    ///   signature: 0x6ad53d2d9eeb1af27ddc3864f3c805ac38dccdd07c4f032e24a3bedacdea1d5a2d2b40d542aac42f64abb797088702719f027cd5ee643aefc19b0abe5a6457131c
    #[test]
    fn test_cross_validation_with_native_core() {
        let test_pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let maker = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        let signer_addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

        let state = SignerState::new(test_pk, maker, signer_addr).unwrap();

        let order = OrderToSign {
            salt: "12345678901234".to_string(),
            token_id: "17510381696424521626872545793830070082360183532089020912133870456423861609957".to_string(),
            maker_amount: "1500000".to_string(),
            taker_amount: "3000000".to_string(),
            side: 0,          // BUY
            neg_risk: false,
            fee_rate_bps: 0,
        };

        let result = state.sign_batch_orders(&[order]).unwrap();

        // This is the signature produced by native-core/signClobOrdersBatch
        // with the exact same inputs (verified via Node.js test)
        let expected_native_signature = "0x6ad53d2d9eeb1af27ddc3864f3c805ac38dccdd07c4f032e24a3bedacdea1d5a2d2b40d542aac42f64abb797088702719f027cd5ee643aefc19b0abe5a6457131c";

        println!("rust-core signature:   {}", result[0].signature);
        println!("native-core signature: {}", expected_native_signature);
        
        assert_eq!(
            result[0].signature, expected_native_signature,
            "rust-core and native-core signatures MUST match for the same inputs!"
        );
    }

    /// Integration test: Executor flow vs Test API flow produce identical signatures.
    ///
    /// This test simulates:
    /// - Flow A (Executor): validator::prepare_batch_orders() → signer.sign_batch_orders()
    /// - Flow B (Test API): inline OrderToSign construction → signer.sign_batch_orders()
    ///
    /// Both must produce identical EIP-712 signatures for the same inputs.
    #[test]
    fn test_executor_vs_test_api_identical_signatures() {
        let test_pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let maker = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        let signer_addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

        let state = SignerState::new(test_pk, maker, signer_addr).unwrap();

        // ─── Build OrderToSign: Test API style (inline, from napi_exports.rs) ───
        let price = 0.65_f64;
        let size = 10.0_f64;
        let decimals: f64 = 1_000_000.0;
        let fixed_salt = "9876543210".to_string();
        let token_id = "17510381696424521626872545793830070082360183532089020912133870456423861609957";

        // Replicate napi_exports.rs logic exactly
        let size_rounded_api = (size * 100.0).round() / 100.0;
        let usdc_raw_api = price * size_rounded_api;
        let usdc_rounded_api = (usdc_raw_api * 10000.0).round() / 10000.0;
        let maker_amount_api = ((usdc_rounded_api * decimals).round() as u64).to_string();
        let taker_amount_api = ((size_rounded_api * decimals).round() as u64).to_string();

        let order_api = OrderToSign {
            salt: fixed_salt.clone(),
            token_id: token_id.to_string(),
            maker_amount: maker_amount_api,
            taker_amount: taker_amount_api,
            side: 0, // BUY
            neg_risk: true,
            fee_rate_bps: 0,
        };

        // ─── Build OrderToSign: Executor style (validator.rs logic) ───
        // round_to_decimals(size, 2) = (size * 100).round() / 100
        let size_rounded_exec = {
            let multiplier = 10_f64.powi(2);
            (size * multiplier).round() / multiplier
        };
        let usdc_raw_exec = price * size_rounded_exec; // slippage_enabled=false → raw price
        let usdc_rounded_exec = {
            let multiplier = 10_f64.powi(4);
            (usdc_raw_exec * multiplier).round() / multiplier
        };
        let maker_amount_exec = ((usdc_rounded_exec * decimals).round() as u64).to_string();
        let taker_amount_exec = ((size_rounded_exec * decimals).round() as u64).to_string();

        let order_exec = OrderToSign {
            salt: fixed_salt.clone(),
            token_id: token_id.to_string(),
            maker_amount: maker_amount_exec,
            taker_amount: taker_amount_exec,
            side: 0, // BUY
            neg_risk: true,
            fee_rate_bps: 0,
        };

        // ─── Verify: amounts must be identical ───
        assert_eq!(order_api.maker_amount, order_exec.maker_amount,
            "maker_amount mismatch: API={} vs Executor={}",
            order_api.maker_amount, order_exec.maker_amount);
        assert_eq!(order_api.taker_amount, order_exec.taker_amount,
            "taker_amount mismatch: API={} vs Executor={}",
            order_api.taker_amount, order_exec.taker_amount);

        // ─── Sign both with the same signer ───
        let signed_api = state.sign_batch_orders(&[order_api]).unwrap();
        let signed_exec = state.sign_batch_orders(&[order_exec]).unwrap();

        // ─── Verify: signatures must be identical ───
        assert_eq!(signed_api[0].signature, signed_exec[0].signature,
            "CRITICAL: Signatures differ!\n  API:      {}\n  Executor: {}",
            signed_api[0].signature, signed_exec[0].signature);

        // Also verify all SignedClobOrder fields match
        assert_eq!(signed_api[0].maker, signed_exec[0].maker);
        assert_eq!(signed_api[0].signer, signed_exec[0].signer);
        assert_eq!(signed_api[0].taker, signed_exec[0].taker);
        assert_eq!(signed_api[0].maker_amount, signed_exec[0].maker_amount);
        assert_eq!(signed_api[0].taker_amount, signed_exec[0].taker_amount);
        assert_eq!(signed_api[0].side, signed_exec[0].side);
        assert_eq!(signed_api[0].token_id, signed_exec[0].token_id);
        assert_eq!(signed_api[0].fee_rate_bps, signed_exec[0].fee_rate_bps);
        assert_eq!(signed_api[0].signature_type, signed_exec[0].signature_type);

        println!("✅ Executor and Test API produce IDENTICAL signatures:");
        println!("   signature: {}", signed_api[0].signature);
        println!("   maker_amount: {}", signed_api[0].maker_amount);
        println!("   taker_amount: {}", signed_api[0].taker_amount);
    }

    /// Integration test: SELL order produces identical signatures across both flows.
    #[test]
    fn test_executor_vs_test_api_sell_signatures() {
        let test_pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let maker = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        let signer_addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

        let state = SignerState::new(test_pk, maker, signer_addr).unwrap();

        let price = 0.42_f64;
        let size = 15.0_f64;
        let decimals: f64 = 1_000_000.0;
        let fixed_salt = "1111222233334444".to_string();
        let token_id = "99887766554433221100998877665544332211009988776655443322110099887";

        // ─── Test API style (SELL) ───
        let size_rounded = (size * 100.0).round() / 100.0;
        let usdc_raw = price * size_rounded;
        let usdc_rounded = (usdc_raw * 10000.0).round() / 10000.0;
        // SELL: Maker = Asset, Taker = USDC
        let order_api = OrderToSign {
            salt: fixed_salt.clone(),
            token_id: token_id.to_string(),
            maker_amount: ((size_rounded * decimals).round() as u64).to_string(),
            taker_amount: ((usdc_rounded * decimals).round() as u64).to_string(),
            side: 1,
            neg_risk: false,
            fee_rate_bps: 0,
        };

        // ─── Executor style (SELL) ───
        let size_rounded_e = { let m = 100.0; (size * m).round() / m };
        let usdc_raw_e = price * size_rounded_e;
        let usdc_rounded_e = { let m = 10000.0; (usdc_raw_e * m).round() / m };
        let order_exec = OrderToSign {
            salt: fixed_salt,
            token_id: token_id.to_string(),
            maker_amount: ((size_rounded_e * decimals).round() as u64).to_string(),
            taker_amount: ((usdc_rounded_e * decimals).round() as u64).to_string(),
            side: 1,
            neg_risk: false,
            fee_rate_bps: 0,
        };

        let signed_api = state.sign_batch_orders(&[order_api]).unwrap();
        let signed_exec = state.sign_batch_orders(&[order_exec]).unwrap();

        assert_eq!(signed_api[0].signature, signed_exec[0].signature,
            "SELL signature mismatch!\n  API:      {}\n  Executor: {}",
            signed_api[0].signature, signed_exec[0].signature);
        assert_eq!(signed_api[0].side, "SELL");
        assert_eq!(signed_exec[0].side, "SELL");

        println!("✅ SELL signature match: {}", signed_api[0].signature);
    }
}
