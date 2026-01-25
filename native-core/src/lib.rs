use ethers_core::types::{Address, H256, U256};
use ethers_core::utils::keccak256;
use ethers_signers::{LocalWallet, Signer};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::str::FromStr;

// =============================================================================
// CONSTANTS - Hardcoded for maximum performance (no runtime overhead)
// =============================================================================

/// Polymarket CTF Exchange Domain Constants
const DOMAIN_NAME: &str = "Polymarket CTF Exchange";
const DOMAIN_VERSION: &str = "1";
const CHAIN_ID: u64 = 137; // Polygon Mainnet

// Standard CTF Exchange
const VERIFYING_CONTRACT: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
// NegRisk CTF Exchange (for negRisk markets)
const NEG_RISK_VERIFYING_CONTRACT: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// EIP-712 Type Hashes (pre-computed for performance)
// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
const DOMAIN_TYPE_HASH: &str = "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";

// keccak256("Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)")
const ORDER_TYPE_HASH: &str = "0xa852566c4e14d00869b6db0220888a9090a13eccdaea03713ff0a3d27bf9767c";

// =============================================================================
// INPUT/OUTPUT STRUCTS
// =============================================================================

/// Input options for signing a CLOB order
#[napi(object)]
#[derive(Clone)]
pub struct SignOpts {
    /// Private key in hex format (with or without 0x prefix)
    pub private_key: String,
    /// Random salt for the order
    pub salt: String,
    /// Maker address (proxy wallet)
    pub maker: String,
    /// Signer address (EOA)
    pub signer: String,
    /// Taker address (usually 0x0)
    pub taker: String,
    /// Token ID (position token)
    pub token_id: String,
    /// Maker amount in USDC units (string to handle large numbers)
    pub maker_amount: String,
    /// Taker amount in token units (string to handle large numbers)
    pub taker_amount: String,
    /// Expiration timestamp (0 for no expiration)
    pub expiration: String,
    /// Order nonce
    pub nonce: String,
    /// Fee rate in basis points
    pub fee_rate_bps: String,
    /// Side: 0 = Buy, 1 = Sell
    pub side: u8,
    /// Signature type: 2 = POLY_GNOSIS_SAFE
    pub signature_type: u8,
    /// Whether this is a negRisk market (uses different exchange contract)
    pub neg_risk: Option<bool>,
}

/// Signed order output
#[napi(object)]
pub struct SignedOrder {
    /// Salt
    pub salt: String,
    /// Maker address
    pub maker: String,
    /// Signer address
    pub signer: String,
    /// Taker address
    pub taker: String,
    /// Token ID
    pub token_id: String,
    /// Maker amount
    pub maker_amount: String,
    /// Taker amount
    pub taker_amount: String,
    /// Expiration
    pub expiration: String,
    /// Nonce
    pub nonce: String,
    /// Fee rate bps
    pub fee_rate_bps: String,
    /// Side
    pub side: u8,
    /// Signature type
    pub signature_type: u8,
    /// EIP-712 signature (hex encoded with 0x prefix)
    pub signature: String,
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/// Parse hex string to U256
fn parse_u256(s: &str) -> Result<U256> {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        U256::from_str(s).map_err(|e| Error::new(Status::InvalidArg, format!("Invalid U256: {}", e)))
    } else {
        U256::from_dec_str(s).map_err(|e| Error::new(Status::InvalidArg, format!("Invalid U256: {}", e)))
    }
}

/// Parse hex string to Address
fn parse_address(s: &str) -> Result<Address> {
    Address::from_str(s.trim())
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid address: {}", e)))
}

/// Compute the EIP-712 domain separator
fn compute_domain_separator(neg_risk: bool) -> [u8; 32] {
    let domain_type_hash = hex::decode(&DOMAIN_TYPE_HASH[2..]).unwrap();
    let name_hash = keccak256(DOMAIN_NAME.as_bytes());
    let version_hash = keccak256(DOMAIN_VERSION.as_bytes());
    let chain_id = U256::from(CHAIN_ID);
    
    // Use correct verifying contract based on negRisk flag
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

/// Compute the struct hash for an Order
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

    // Helper to encode U256
    let encode_u256 = |v: U256| -> [u8; 32] {
        let mut bytes = [0u8; 32];
        v.to_big_endian(&mut bytes);
        bytes
    };

    // Helper to encode Address (left-padded to 32 bytes)
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

/// Compute the EIP-712 typed data hash
fn compute_typed_data_hash(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut message = Vec::with_capacity(66);
    message.push(0x19);
    message.push(0x01);
    message.extend_from_slice(domain_separator);
    message.extend_from_slice(struct_hash);
    keccak256(&message)
}

// =============================================================================
// MAIN SIGNING FUNCTION
// =============================================================================

/// Sign a CLOB order using EIP-712
/// 
/// This function takes order parameters and a private key, computes the EIP-712
/// typed data hash, signs it, and returns the complete signed order.
#[napi]
pub fn sign_clob_order(opts: SignOpts) -> Result<SignedOrder> {
    // Parse private key
    let private_key = opts.private_key.trim();
    let private_key = if private_key.starts_with("0x") || private_key.starts_with("0X") {
        &private_key[2..]
    } else {
        private_key
    };
    
    let key_bytes = hex::decode(private_key)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid private key: {}", e)))?;
    
    let wallet = LocalWallet::from_bytes(&key_bytes)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Failed to create wallet: {}", e)))?;

    // Parse order fields
    let salt = parse_u256(&opts.salt)?;
    let maker = parse_address(&opts.maker)?;
    let signer = parse_address(&opts.signer)?;
    let taker = parse_address(&opts.taker)?;
    let token_id = parse_u256(&opts.token_id)?;
    let maker_amount = parse_u256(&opts.maker_amount)?;
    let taker_amount = parse_u256(&opts.taker_amount)?;
    let expiration = parse_u256(&opts.expiration)?;
    let nonce = parse_u256(&opts.nonce)?;
    let fee_rate_bps = parse_u256(&opts.fee_rate_bps)?;

    // Compute domain separator (use negRisk exchange if flag is set)
    let neg_risk = opts.neg_risk.unwrap_or(false);
    let domain_separator = compute_domain_separator(neg_risk);

    // Compute struct hash
    let struct_hash = compute_order_struct_hash(
        salt,
        maker,
        signer,
        taker,
        token_id,
        maker_amount,
        taker_amount,
        expiration,
        nonce,
        fee_rate_bps,
        opts.side,
        opts.signature_type,
    );

    // Compute typed data hash
    let typed_data_hash = compute_typed_data_hash(&domain_separator, &struct_hash);

    // Sign the hash
    let signature = wallet
        .sign_hash(H256::from(typed_data_hash))
        .map_err(|e| Error::new(Status::GenericFailure, format!("Signing failed: {}", e)))?;

    // Encode signature as hex
    let sig_bytes = signature.to_vec();
    let signature_hex = format!("0x{}", hex::encode(&sig_bytes));

    Ok(SignedOrder {
        salt: salt.to_string(),
        maker: ethers_core::utils::to_checksum(&maker, None),
        signer: ethers_core::utils::to_checksum(&signer, None),
        taker: ethers_core::utils::to_checksum(&taker, None),
        token_id: token_id.to_string(),
        maker_amount: maker_amount.to_string(),
        taker_amount: taker_amount.to_string(),
        expiration: expiration.to_string(),
        nonce: nonce.to_string(),
        fee_rate_bps: fee_rate_bps.to_string(),
        side: opts.side,
        signature_type: opts.signature_type,
        signature: signature_hex,
    })
}

/// Order parameters for batch signing (excludes private key)
#[napi(object)]
#[derive(Clone)]
pub struct OrderParams {
    /// Random salt for the order
    pub salt: String,
    /// Maker address (proxy wallet)
    pub maker: String,
    /// Signer address (EOA)
    pub signer: String,
    /// Taker address (usually 0x0)
    pub taker: String,
    /// Token ID (position token)
    pub token_id: String,
    /// Maker amount in USDC units
    pub maker_amount: String,
    /// Taker amount in token units
    pub taker_amount: String,
    /// Expiration timestamp
    pub expiration: String,
    /// Order nonce
    pub nonce: String,
    /// Fee rate in basis points
    pub fee_rate_bps: String,
    /// Side: 0 = Buy, 1 = Sell
    pub side: u8,
    /// Signature type: 2 = POLY_GNOSIS_SAFE
    pub signature_type: u8,
    /// Whether this is a negRisk market
    pub neg_risk: Option<bool>,
}

/// Batch sign multiple orders using a single private key
/// Optimized to create the wallet instance only once
#[napi]
pub fn sign_clob_orders_batch(private_key: String, orders: Vec<OrderParams>) -> Result<Vec<SignedOrder>> {
    // Parse private key once
    let private_key = private_key.trim();
    let private_key = if private_key.starts_with("0x") || private_key.starts_with("0X") {
        &private_key[2..]
    } else {
        private_key
    };
    
    let key_bytes = hex::decode(private_key)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid private key: {}", e)))?;
    
    let wallet = LocalWallet::from_bytes(&key_bytes)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Failed to create wallet: {}", e)))?;

    // Pre-allocate results
    let mut results = Vec::with_capacity(orders.len());

    for opts in orders {
        // Parse order fields
        let salt = parse_u256(&opts.salt)?;
        let maker = parse_address(&opts.maker)?;
        let signer = parse_address(&opts.signer)?;
        let taker = parse_address(&opts.taker)?;
        let token_id = parse_u256(&opts.token_id)?;
        let maker_amount = parse_u256(&opts.maker_amount)?;
        let taker_amount = parse_u256(&opts.taker_amount)?;
        let expiration = parse_u256(&opts.expiration)?;
        let nonce = parse_u256(&opts.nonce)?;
        let fee_rate_bps = parse_u256(&opts.fee_rate_bps)?;

        // Compute domain separator
        let neg_risk = opts.neg_risk.unwrap_or(false);
        let domain_separator = compute_domain_separator(neg_risk);

        // Compute struct hash
        let struct_hash = compute_order_struct_hash(
            salt,
            maker,
            signer,
            taker,
            token_id,
            maker_amount,
            taker_amount,
            expiration,
            nonce,
            fee_rate_bps,
            opts.side,
            opts.signature_type,
        );

        // Compute typed data hash
        let typed_data_hash = compute_typed_data_hash(&domain_separator, &struct_hash);

        // Sign the hash
        let signature = wallet
            .sign_hash(H256::from(typed_data_hash))
            .map_err(|e| Error::new(Status::GenericFailure, format!("Signing failed: {}", e)))?;

        // Encode signature as hex
        let sig_bytes = signature.to_vec();
        let signature_hex = format!("0x{}", hex::encode(&sig_bytes));

        results.push(SignedOrder {
            salt: salt.to_string(),
            maker: ethers_core::utils::to_checksum(&maker, None),
            signer: ethers_core::utils::to_checksum(&signer, None),
            taker: ethers_core::utils::to_checksum(&taker, None),
            token_id: token_id.to_string(),
            maker_amount: maker_amount.to_string(),
            taker_amount: taker_amount.to_string(),
            expiration: expiration.to_string(),
            nonce: nonce.to_string(),
            fee_rate_bps: fee_rate_bps.to_string(),
            side: opts.side,
            signature_type: opts.signature_type,
            signature: signature_hex,
        });
    }

    Ok(results)
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_separator() {
        let domain_separator = compute_domain_separator();
        // Just verify it computes without panicking
        assert_eq!(domain_separator.len(), 32);
    }

    #[test]
    fn test_parse_u256() {
        let decimal = parse_u256("1000000").unwrap();
        assert_eq!(decimal, U256::from(1000000u64));

        let hex_val = parse_u256("0xF4240").unwrap();
        assert_eq!(hex_val, U256::from(1000000u64));
    }

    #[test]
    fn test_parse_address() {
        let addr = parse_address("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E").unwrap();
        assert_eq!(
            format!("{:?}", addr).to_lowercase(),
            "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"
        );
    }
}
