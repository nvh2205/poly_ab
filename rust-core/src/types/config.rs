use napi_derive::napi;

/// Configuration for the Rust socket engine.
/// Passed from Node.js via `initSocket()`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct SocketConfig {
    /// WebSocket URL (e.g. "wss://ws-subscriptions-clob.polymarket.com/ws/market")
    pub ws_url: String,

    /// Maximum tokens per WebSocket connection (default: 50)
    pub max_tokens_per_connection: Option<i32>,

    /// Ping interval in milliseconds (default: 15000)
    pub ping_interval_ms: Option<i64>,

    /// Reconnection base delay in milliseconds (default: 1000)
    pub reconnect_base_delay_ms: Option<i64>,

    /// Maximum reconnection delay in milliseconds (default: 30000)
    pub reconnect_max_delay_ms: Option<i64>,

    /// Maximum reconnection attempts before giving up (default: unlimited = -1)
    pub max_reconnect_attempts: Option<i32>,

    /// Enable verbose tracing logs (default: false)
    pub verbose: Option<bool>,
}

impl SocketConfig {
    pub fn max_tokens_per_connection(&self) -> usize {
        self.max_tokens_per_connection.unwrap_or(50) as usize
    }

    pub fn ping_interval_ms(&self) -> u64 {
        self.ping_interval_ms.unwrap_or(15_000) as u64
    }

    pub fn reconnect_base_delay_ms(&self) -> u64 {
        self.reconnect_base_delay_ms.unwrap_or(1_000) as u64
    }

    pub fn reconnect_max_delay_ms(&self) -> u64 {
        self.reconnect_max_delay_ms.unwrap_or(30_000) as u64
    }

    pub fn max_reconnect_attempts(&self) -> Option<u32> {
        match self.max_reconnect_attempts {
            Some(n) if n >= 0 => Some(n as u32),
            _ => None, // unlimited
        }
    }

    pub fn verbose(&self) -> bool {
        self.verbose.unwrap_or(false)
    }
}
