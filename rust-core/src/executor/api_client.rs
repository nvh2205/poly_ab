//! CLOB API client — HTTP POST to Polymarket with HMAC-SHA256 authentication.
//!
//! Replaces axios-based `placeBatchOrdersAxios()` from PolymarketOnchainService.
//! Uses persistent `reqwest::Client` with TCP_NODELAY for HFT performance.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::order::SignedClobOrder;

type HmacSha256 = Hmac<Sha256>;

// =============================================================================
// API CLIENT STATE
// =============================================================================

/// Persistent CLOB API client. Created once at `init_executor()`.
pub struct ClobApiClient {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    api_secret_decoded: Vec<u8>, // Pre-decoded base64 secret
    api_passphrase: String,
    signer_address: String,
}

/// Single order response from Polymarket CLOB API.
#[derive(Debug, Deserialize)]
pub struct OrderResponse {
    #[serde(rename = "orderID")]
    pub order_id: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
}

/// Batch order payload item (matches Polymarket API format).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchOrderPayload {
    defer_exec: bool,
    order: OrderPayload,
    owner: String,
    order_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderPayload {
    salt: i64,
    maker: String,
    signer: String,
    taker: String,
    token_id: String,
    maker_amount: String,
    taker_amount: String,
    side: String,
    expiration: String,
    nonce: String,
    fee_rate_bps: String,
    signature_type: u8,
    signature: String,
}

/// Result of posting batch orders.
pub struct PostBatchResult {
    pub success: bool,
    pub responses: Vec<OrderResponse>,
    pub error: Option<String>,
}

impl ClobApiClient {
    /// Create a new ClobApiClient with persistent HTTP connections.
    pub fn new(
        base_url: &str,
        api_key: &str,
        api_secret: &str,
        api_passphrase: &str,
        signer_address: &str,
    ) -> Result<Self, String> {
        // Pre-decode base64 secret (handle both base64 and base64url formats)
        let sanitized_secret: String = api_secret
            .replace('-', "+")
            .replace('_', "/")
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
            .collect();

        let decoded_secret = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &sanitized_secret,
        )
        .map_err(|e| format!("Failed to decode API secret: {}", e))?;

        // Build reqwest client with HFT settings
        // pool_idle_timeout = 25s — must be > warm interval (20s) to keep connections alive
        let client = reqwest::Client::builder()
            .tcp_nodelay(true) // Disable Nagle's algorithm
            .pool_idle_timeout(std::time::Duration::from_secs(25))
            .pool_max_idle_per_host(10)
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        Ok(Self {
            client,
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            api_secret_decoded: decoded_secret,
            api_passphrase: api_passphrase.to_string(),
            signer_address: signer_address.to_string(),
        })
    }

    /// Post batch orders to Polymarket CLOB API.
    pub async fn post_batch_orders(
        &self,
        signed_orders: &[SignedClobOrder],
        api_key_as_owner: &str,
    ) -> PostBatchResult {
        let order_types: Vec<String> = signed_orders.iter().map(|_| "GTC".to_string()).collect();
        self.post_batch_orders_with_types(signed_orders, api_key_as_owner, &order_types).await
    }

    /// Post batch orders to Polymarket CLOB API with per-order type (GTC/GTD/FOK/FAK).
    pub async fn post_batch_orders_with_types(
        &self,
        signed_orders: &[SignedClobOrder],
        api_key_as_owner: &str,
        order_types: &[String],
    ) -> PostBatchResult {
        if signed_orders.is_empty() {
            return PostBatchResult {
                success: false,
                responses: vec![],
                error: Some("No orders provided".to_string()),
            };
        }

        // Build payload
        let payload: Vec<BatchOrderPayload> = signed_orders
            .iter()
            .enumerate()
            .map(|(i, order)| {
                let ot = order_types.get(i).cloned().unwrap_or_else(|| "GTC".to_string());
                BatchOrderPayload {
                    defer_exec: false,
                    order: OrderPayload {
                        salt: order.salt,
                        maker: order.maker.clone(),
                        signer: order.signer.clone(),
                        taker: order.taker.clone(),
                        token_id: order.token_id.clone(),
                        maker_amount: order.maker_amount.clone(),
                        taker_amount: order.taker_amount.clone(),
                        side: order.side.clone(),
                        expiration: order.expiration.clone(),
                        nonce: order.nonce.clone(),
                        fee_rate_bps: order.fee_rate_bps.clone(),
                        signature_type: order.signature_type,
                        signature: order.signature.clone(),
                    },
                    owner: api_key_as_owner.to_string(),
                    order_type: ot,
                }
            })
            .collect();

        // Serialize body
        let body = match serde_json::to_string(&payload) {
            Ok(b) => b,
            Err(e) => {
                return PostBatchResult {
                    success: false,
                    responses: vec![],
                    error: Some(format!("Failed to serialize payload: {}", e)),
                };
            }
        };

        // Build auth headers
        let request_path = "/orders";
        let timestamp = get_unix_timestamp_secs();
        let signature = self.build_hmac_signature(timestamp, "POST", request_path, Some(&body));

        let url = format!("{}{}", self.base_url, request_path);

        // Execute POST
        let result = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Connection", "keep-alive")
            .header("POLY_ADDRESS", &self.signer_address)
            .header("POLY_SIGNATURE", &signature)
            .header("POLY_TIMESTAMP", timestamp.to_string())
            .header("POLY_API_KEY", &self.api_key)
            .header("POLY_PASSPHRASE", &self.api_passphrase)
            .body(body)
            .send()
            .await;

        match result {
            Ok(response) => {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                
                tracing::debug!(
                    "[BatchAPI] Response status={}, body={}",
                    status,
                    &body_text[..body_text.len().min(2000)]
                );

                if status.is_success() {
                    match serde_json::from_str::<Vec<OrderResponse>>(&body_text) {
                        Ok(responses) => PostBatchResult {
                            success: true,
                            responses,
                            error: None,
                        },
                        Err(e) => PostBatchResult {
                            success: false,
                            responses: vec![],
                            error: Some(format!("Failed to parse response: {} (body: {})", e, &body_text[..body_text.len().min(500)])),
                        },
                    }
                } else {
                    PostBatchResult {
                        success: false,
                        responses: vec![],
                        error: Some(format!("HTTP {}: {}", status, body_text)),
                    }
                }
            }
            Err(e) => PostBatchResult {
                success: false,
                responses: vec![],
                error: Some(format!("HTTP request failed: {}", e)),
            },
        }
    }

    /// Build HMAC-SHA256 signature for Polymarket L2 API authentication.
    /// Ported from PolymarketOnchainService.buildHmacSignature().
    fn build_hmac_signature(
        &self,
        timestamp: u64,
        method: &str,
        request_path: &str,
        body: Option<&str>,
    ) -> String {
        // Build message: timestamp + method + requestPath + body
        let mut message = format!("{}{}{}", timestamp, method, request_path);
        if let Some(b) = body {
            message.push_str(b);
        }

        // HMAC-SHA256 with pre-decoded secret
        let mut mac =
            HmacSha256::new_from_slice(&self.api_secret_decoded).expect("HMAC key error");
        mac.update(message.as_bytes());
        let result = mac.finalize();
        let sig = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            result.into_bytes(),
        );

        // Convert to URL-safe base64: '+' -> '-', '/' -> '_'
        sig.replace('+', "-").replace('/', "_")
    }

    /// Warm the connection pool by sending a lightweight GET request.
    /// This keeps the TCP+TLS connection alive across long idle periods.
    pub async fn warm_connection(&self) -> bool {
        let url = format!("{}/time", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) => {
                tracing::trace!("[Warmer] GET /time -> {}", resp.status());
                true
            }
            Err(e) => {
                tracing::warn!("[Warmer] Connection warm failed: {}", e);
                false
            }
        }
    }
}

fn get_unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs()
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hmac_signature_format() {
        // Create client with dummy credentials
        let client = ClobApiClient::new(
            "https://clob.polymarket.com",
            "test-api-key",
            "dGVzdC1zZWNyZXQ=", // base64("test-secret")
            "test-passphrase",
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        )
        .unwrap();

        let sig = client.build_hmac_signature(1234567890, "POST", "/orders", Some(r#"[{"test":true}]"#));

        // Should be URL-safe base64
        assert!(!sig.contains('+'));
        assert!(!sig.contains('/'));
        assert!(!sig.is_empty());
    }

    #[test]
    fn test_hmac_deterministic() {
        let client = ClobApiClient::new(
            "https://clob.polymarket.com",
            "test-api-key",
            "dGVzdC1zZWNyZXQ=",
            "test-passphrase",
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        )
        .unwrap();

        let sig1 = client.build_hmac_signature(1000, "POST", "/orders", Some("body"));
        let sig2 = client.build_hmac_signature(1000, "POST", "/orders", Some("body"));
        assert_eq!(sig1, sig2);

        // Different timestamp should produce different signature
        let sig3 = client.build_hmac_signature(1001, "POST", "/orders", Some("body"));
        assert_ne!(sig1, sig3);
    }
}
