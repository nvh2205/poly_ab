//! WebSocket client using `tokio-tungstenite`.
//!
//! Manages a single WebSocket connection to Polymarket with:
//! - Automatic ping/pong heartbeat
//! - Exponential backoff reconnection
//! - Token subscription management
//! - Message forwarding via tokio channel

use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

/// A single WebSocket connection to Polymarket.
pub struct WsClient {
    /// Connection identifier (e.g. "conn_0", "conn_1").
    pub connection_id: String,
    /// Tokens subscribed on this connection.
    pub tokens: Vec<String>,
    /// WebSocket URL.
    ws_url: String,
    /// Ping interval in milliseconds.
    ping_interval_ms: u64,
    /// Reconnection base delay in milliseconds.
    reconnect_base_delay_ms: u64,
    /// Maximum reconnection delay in milliseconds.
    reconnect_max_delay_ms: u64,
    /// Maximum reconnection attempts (None = unlimited).
    max_reconnect_attempts: Option<u32>,
}

impl WsClient {
    pub fn new(
        connection_id: String,
        tokens: Vec<String>,
        ws_url: String,
        ping_interval_ms: u64,
        reconnect_base_delay_ms: u64,
        reconnect_max_delay_ms: u64,
        max_reconnect_attempts: Option<u32>,
    ) -> Self {
        Self {
            connection_id,
            tokens,
            ws_url,
            ping_interval_ms,
            reconnect_base_delay_ms,
            reconnect_max_delay_ms,
            max_reconnect_attempts,
        }
    }

    /// Run the WebSocket connection loop with auto-reconnection.
    ///
    /// Sends raw message bytes to `msg_tx` for downstream parsing.
    /// Runs indefinitely until the `shutdown` signal is received.
    pub async fn run(
        &self,
        msg_tx: mpsc::UnboundedSender<(String, Vec<u8>)>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        let mut reconnect_attempts: u32 = 0;

        loop {
            // Check shutdown before connecting
            if *shutdown.borrow() {
                info!(conn_id = %self.connection_id, "Shutdown signal received, stopping");
                break;
            }

            match self.connect_and_run(&msg_tx, &mut shutdown).await {
                Ok(()) => {
                    // Graceful close (shutdown or server-initiated)
                    info!(conn_id = %self.connection_id, "Connection closed cleanly");
                    if *shutdown.borrow() {
                        break;
                    }
                    reconnect_attempts = 0; // Reset on clean close
                }
                Err(e) => {
                    error!(conn_id = %self.connection_id, error = %e, "Connection error");
                    reconnect_attempts += 1;

                    if let Some(max) = self.max_reconnect_attempts {
                        if reconnect_attempts > max {
                            error!(
                                conn_id = %self.connection_id,
                                attempts = reconnect_attempts,
                                "Max reconnection attempts reached, giving up"
                            );
                            break;
                        }
                    }
                }
            }

            // Exponential backoff: base * 2^(attempts-1), capped at max
            let delay_ms = std::cmp::min(
                self.reconnect_base_delay_ms * 2u64.saturating_pow(reconnect_attempts.saturating_sub(1)),
                self.reconnect_max_delay_ms,
            );

            info!(
                conn_id = %self.connection_id,
                delay_ms = delay_ms,
                attempt = reconnect_attempts,
                "Reconnecting after delay"
            );

            tokio::select! {
                _ = sleep(Duration::from_millis(delay_ms)) => {},
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
    }

    /// Connect to WebSocket, subscribe to tokens, and process messages until
    /// disconnection or shutdown.
    async fn connect_and_run(
        &self,
        msg_tx: &mpsc::UnboundedSender<(String, Vec<u8>)>,
        shutdown: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        info!(conn_id = %self.connection_id, url = %self.ws_url, "Connecting to WebSocket");

        let (ws_stream, _) = connect_async(&self.ws_url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Subscribe to tokens
        self.subscribe(&mut write).await?;
        info!(
            conn_id = %self.connection_id,
            tokens_count = self.tokens.len(),
            "Subscribed to tokens"
        );

        // Ping interval timer
        let mut ping_timer = interval(Duration::from_millis(self.ping_interval_ms));
        ping_timer.tick().await; // Skip first immediate tick

        loop {
            tokio::select! {
                // Receive message from WebSocket
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            let bytes = text.into_bytes();
                            if msg_tx.send((self.connection_id.clone(), bytes)).is_err() {
                                warn!(conn_id = %self.connection_id, "Message channel closed");
                                return Ok(());
                            }
                        }
                        Some(Ok(Message::Binary(data))) => {
                            if msg_tx.send((self.connection_id.clone(), data.to_vec())).is_err() {
                                warn!(conn_id = %self.connection_id, "Message channel closed");
                                return Ok(());
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            write.send(Message::Pong(data)).await?;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Close(frame))) => {
                            info!(conn_id = %self.connection_id, ?frame, "Server closed connection");
                            return Ok(());
                        }
                        Some(Err(e)) => {
                            return Err(Box::new(e));
                        }
                        None => {
                            // Stream ended
                            return Ok(());
                        }
                        _ => {} // Frame variant (ignored)
                    }
                }
                // Send periodic ping
                _ = ping_timer.tick() => {
                    write.send(Message::Ping(vec![].into())).await?;
                }
                // Shutdown signal
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!(conn_id = %self.connection_id, "Shutdown signal, closing WS");
                        let _ = write.send(Message::Close(None)).await;
                        return Ok(());
                    }
                }
            }
        }
    }

    /// Send subscription message to Polymarket WebSocket.
    ///
    /// Subscription format matches existing JS implementation:
    /// ```json
    /// { "type": "subscribe", "assets_ids": ["token1", "token2", ...] }
    /// ```
    async fn subscribe(
        &self,
        write: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sub_msg = serde_json::json!({
            "type": "market",
            "assets_ids": self.tokens,
        });
        let text = serde_json::to_string(&sub_msg)?;
        write.send(Message::Text(text.into())).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exponential_backoff() {
        // Test backoff calculation: base=1000, max=30000
        let base: u64 = 1000;
        let max: u64 = 30000;

        // attempt 1: 1000 * 2^0 = 1000
        assert_eq!(std::cmp::min(base * 2u64.pow(0), max), 1000);
        // attempt 2: 1000 * 2^1 = 2000
        assert_eq!(std::cmp::min(base * 2u64.pow(1), max), 2000);
        // attempt 3: 1000 * 2^2 = 4000
        assert_eq!(std::cmp::min(base * 2u64.pow(2), max), 4000);
        // attempt 5: 1000 * 2^4 = 16000
        assert_eq!(std::cmp::min(base * 2u64.pow(4), max), 16000);
        // attempt 6: 1000 * 2^5 = 32000, capped at 30000
        assert_eq!(std::cmp::min(base * 2u64.pow(5), max), 30000);
    }

    #[test]
    fn test_ws_client_new() {
        let client = WsClient::new(
            "conn_0".to_string(),
            vec!["token1".to_string(), "token2".to_string()],
            "wss://example.com/ws".to_string(),
            15000,
            1000,
            30000,
            None,
        );

        assert_eq!(client.connection_id, "conn_0");
        assert_eq!(client.tokens.len(), 2);
        assert!(client.max_reconnect_attempts.is_none());
    }
}
