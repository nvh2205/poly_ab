//! Callback helpers for Rust → Node.js communication.
//!
//! Only `on_trade_result` callback remains — invoked when the executor
//! posts an order. All other data flows (socket, engine, signals) stay
//! entirely within Rust.

use crate::types::order::TradeResult;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Stores the registered Node.js callbacks.
///
/// Only `on_trade_result` is kept — called when the Rust executor
/// successfully posts an order, so NestJS can save to DB / send Telegram.
pub struct CallbackRegistry {
    /// The registered on_trade_result callback (executor trade results).
    on_trade_result: Mutex<Option<ThreadsafeFunction<TradeResult, ErrorStrategy::Fatal>>>,
}

impl CallbackRegistry {
    pub fn new() -> Self {
        Self {
            on_trade_result: Mutex::new(None),
        }
    }

    /// Register the on_trade_result callback for executor results.
    pub async fn set_on_trade_result(
        &self,
        callback: ThreadsafeFunction<TradeResult, ErrorStrategy::Fatal>,
    ) {
        let mut cb = self.on_trade_result.lock().await;
        *cb = Some(callback);
    }

    /// Invoke the on_trade_result callback with a TradeResult.
    pub async fn emit_trade_result(&self, result: TradeResult) {
        let cb = self.on_trade_result.lock().await;
        if let Some(ref tsfn) = *cb {
            tsfn.call(result, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    /// Check if the on_trade_result callback is registered.
    pub async fn has_on_trade_result(&self) -> bool {
        let cb = self.on_trade_result.lock().await;
        cb.is_some()
    }
}

/// Get a reference to the global callback registry.
pub fn get_registry() -> &'static Arc<CallbackRegistry> {
    use std::sync::OnceLock;
    static REGISTRY: OnceLock<Arc<CallbackRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Arc::new(CallbackRegistry::new()))
}
