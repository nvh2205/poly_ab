//! Connection manager — orchestrates multiple WebSocket connections.
//!
//! Port of `SocketManagerService` from `socket-manager.service.ts`.
//! Manages a pool of `WsClient` instances, distributing tokens across
//! connections and dispatching parsed messages to the callback channel.

use crate::socket::parser;
use crate::socket::ws_client::WsClient;
use crate::types::config::SocketConfig;
use crate::types::market::TopOfBookUpdate;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{debug, info, warn};

/// Global socket manager state, shared across threads.
pub struct SocketManager {
    /// Configuration.
    config: SocketConfig,

    /// Shutdown signal sender.
    shutdown_tx: watch::Sender<bool>,

    /// Shutdown signal receiver (clone for each WsClient).
    shutdown_rx: watch::Receiver<bool>,

    /// Channel to send TopOfBookUpdate to Node.js callback.
    update_tx: mpsc::UnboundedSender<TopOfBookUpdate>,

    /// Currently subscribed tokens, keyed by connection_id.
    connections: Arc<Mutex<HashMap<String, Vec<String>>>>,

    /// Total messages received counter.
    messages_received: Arc<AtomicI64>,

    /// Timestamp of last message received.
    last_message_at_ms: Arc<AtomicI64>,

    /// Whether the manager is running.
    is_running: Arc<AtomicBool>,

    /// Join handles for all WsClient tasks.
    task_handles: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl SocketManager {
    /// Create a new SocketManager.
    pub fn new(
        config: SocketConfig,
        update_tx: mpsc::UnboundedSender<TopOfBookUpdate>,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        Self {
            config,
            shutdown_tx,
            shutdown_rx,
            update_tx,
            connections: Arc::new(Mutex::new(HashMap::new())),
            messages_received: Arc::new(AtomicI64::new(0)),
            last_message_at_ms: Arc::new(AtomicI64::new(0)),
            is_running: Arc::new(AtomicBool::new(false)),
            task_handles: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Subscribe to a list of token IDs.
    ///
    /// Tokens are batched into connections based on `max_tokens_per_connection`.
    /// New connections are created as needed.
    pub async fn subscribe_tokens(&self, token_ids: Vec<String>) {
        if token_ids.is_empty() {
            return;
        }

        let max_per_conn = self.config.max_tokens_per_connection();
        let mut conns = self.connections.lock().await;

        // Collect all currently subscribed tokens
        let existing_tokens: std::collections::HashSet<String> = conns
            .values()
            .flat_map(|tokens| tokens.iter().cloned())
            .collect();

        // Filter out already-subscribed tokens
        let new_tokens: Vec<String> = token_ids
            .into_iter()
            .filter(|t| !existing_tokens.contains(t))
            .collect();

        if new_tokens.is_empty() {
            debug!("All tokens already subscribed");
            return;
        }

        info!(
            new_tokens_count = new_tokens.len(),
            "Subscribing to new tokens"
        );

        // Batch new tokens into groups
        let batches: Vec<Vec<String>> = new_tokens
            .chunks(max_per_conn)
            .map(|chunk| chunk.to_vec())
            .collect();

        // Determine next connection index
        let next_idx = conns.len();

        for (i, batch) in batches.into_iter().enumerate() {
            let conn_id = format!("conn_{}", next_idx + i);
            conns.insert(conn_id.clone(), batch.clone());

            // Spawn WsClient task
            self.spawn_connection(conn_id, batch).await;
        }

        self.is_running.store(true, Ordering::Relaxed);
    }

    /// Unsubscribe from a list of token IDs.
    ///
    /// Removes tokens from connections. Connections with no remaining tokens
    /// are closed.
    pub async fn unsubscribe_tokens(&self, token_ids: Vec<String>) {
        if token_ids.is_empty() {
            return;
        }

        let remove_set: std::collections::HashSet<String> = token_ids.into_iter().collect();
        let mut conns = self.connections.lock().await;

        let mut empty_conns = Vec::new();
        for (conn_id, tokens) in conns.iter_mut() {
            tokens.retain(|t| !remove_set.contains(t));
            if tokens.is_empty() {
                empty_conns.push(conn_id.clone());
            }
        }

        for conn_id in empty_conns {
            conns.remove(&conn_id);
            info!(conn_id = %conn_id, "Removed empty connection");
            // Note: the WsClient task will be stopped via shutdown signal
            // when the manager is fully shut down, or we can implement
            // per-connection shutdown in a future iteration.
        }
    }

    /// Get all currently subscribed token IDs.
    pub async fn get_subscribed_tokens(&self) -> Vec<String> {
        let conns = self.connections.lock().await;
        conns.values().flat_map(|tokens| tokens.iter().cloned()).collect()
    }

    /// Get socket status for monitoring.
    pub async fn get_status(&self) -> SocketStatusInternal {
        let conns = self.connections.lock().await;
        let total_tokens: usize = conns.values().map(|t| t.len()).sum();

        SocketStatusInternal {
            total_connections: conns.len() as i32,
            active_connections: conns.len() as i32,
            subscribed_tokens: total_tokens as i32,
            messages_received: self.messages_received.load(Ordering::Relaxed),
            last_message_at_ms: {
                let v = self.last_message_at_ms.load(Ordering::Relaxed);
                if v > 0 { Some(v) } else { None }
            },
        }
    }

    /// Graceful shutdown — close all connections.
    pub async fn shutdown(&self) {
        info!("Shutting down socket manager");
        let _ = self.shutdown_tx.send(true);
        self.is_running.store(false, Ordering::Relaxed);

        // Wait for all tasks to complete
        let mut handles = self.task_handles.lock().await;
        for handle in handles.drain(..) {
            let _ = handle.await;
        }

        // Clear connections
        let mut conns = self.connections.lock().await;
        conns.clear();
        info!("Socket manager shutdown complete");
    }

    /// Spawn a new WebSocket connection task.
    async fn spawn_connection(&self, conn_id: String, tokens: Vec<String>) {
        let client = WsClient::new(
            conn_id.clone(),
            tokens,
            self.config.ws_url.clone(),
            self.config.ping_interval_ms(),
            self.config.reconnect_base_delay_ms(),
            self.config.reconnect_max_delay_ms(),
            self.config.max_reconnect_attempts(),
        );

        let shutdown_rx = self.shutdown_rx.clone();
        let update_tx = self.update_tx.clone();
        let messages_received = self.messages_received.clone();
        let last_message_at_ms = self.last_message_at_ms.clone();

        // Channel for raw WS messages
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();

        // Spawn WS read loop
        let ws_handle = tokio::spawn(async move {
            client.run(raw_tx, shutdown_rx).await;
        });

        // Spawn message parser loop
        let parser_handle = tokio::spawn(async move {
            while let Some((_conn_id, raw_bytes)) = raw_rx.recv().await {
                // Track metrics
                messages_received.fetch_add(1, Ordering::Relaxed);
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                last_message_at_ms.store(now_ms, Ordering::Relaxed);

                // Parse and dispatch
                match parser::parse_ws_message(&raw_bytes) {
                    Ok(events) => {
                        for event in &events {
                            let updates = parser::extract_top_of_book(event);
                            for update in updates {
                                if update_tx.send(update).is_err() {
                                    warn!("Update channel closed, stopping parser");
                                    return;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        debug!(error = %e, "Failed to parse WS message");
                    }
                }
            }
        });

        // Store handles
        let mut handles = self.task_handles.lock().await;
        handles.push(ws_handle);
        handles.push(parser_handle);
    }
}

/// Internal status struct (not N-API, used by bridge to construct N-API struct).
pub struct SocketStatusInternal {
    pub total_connections: i32,
    pub active_connections: i32,
    pub subscribed_tokens: i32,
    pub messages_received: i64,
    pub last_message_at_ms: Option<i64>,
}
