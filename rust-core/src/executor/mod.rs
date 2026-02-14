//! Executor module — orchestrates the full execution flow.
//!
//! Signal → Validate → Prepare → Sign → POST → TradeResult callback
//!
//! Runs as a tokio task, receives signals via mpsc channel from the engine.

pub mod api_client;
pub mod signer;
pub mod validator;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::bridge::callbacks::get_registry;
use crate::types::order::{NapiExecutorConfigInput, NapiFailedOrder, OrderSide, TradeResult};
use crate::types::signal::ArbSignal;

use self::api_client::ClobApiClient;
use self::signer::SignerState;
use self::validator::{ExecutorConfig, ValidationState};

// =============================================================================
// EXECUTOR STATE
// =============================================================================

/// Complete executor state — owned by the executor task.
pub struct ExecutorState {
    pub signer: SignerState,
    pub api_client: ClobApiClient,
    pub config: ExecutorConfig,
    pub validation: Arc<ValidationState>,
    pub api_key: String, // Used as `owner` in batch order payload
}

impl ExecutorState {
    pub fn from_config(input: &NapiExecutorConfigInput) -> Result<Self, String> {
        let signer = SignerState::new(
            &input.private_key,
            &input.proxy_address,
            &input.signer_address,
        )?;

        let clob_url = input
            .clob_url
            .as_deref()
            .unwrap_or("https://clob.polymarket.com");

        let api_client = ClobApiClient::new(
            clob_url,
            &input.api_key,
            &input.api_secret,
            &input.api_passphrase,
            &input.signer_address,
        )?;

        let config = ExecutorConfig {
            min_pnl_threshold_percent: input.min_pnl_threshold_percent,
            default_size: input.default_size,
            slippage_enabled: input.slippage_enabled,
            opportunity_timeout_ms: input.opportunity_timeout_ms.unwrap_or(5000) as u64,
            maker_address: input.proxy_address.clone(),
            signer_address: input.signer_address.clone(),
        };

        let validation = Arc::new(ValidationState::new());

        Ok(Self {
            signer,
            api_client,
            config,
            validation,
            api_key: input.api_key.clone(),
        })
    }
}

// =============================================================================
// EXECUTOR LOOP — tokio task
// =============================================================================

/// Spawn the executor loop. Returns the sender for signals.
pub fn spawn_executor(
    state: Arc<ExecutorState>,
) -> mpsc::Sender<ArbSignal> {
    let (tx, rx) = mpsc::channel::<ArbSignal>(16);

    let runtime = crate::bridge::napi_exports::get_runtime();
    runtime.spawn(executor_loop(state, rx));

    tx
}

/// Main executor loop — receives signals and processes them.
async fn executor_loop(
    state: Arc<ExecutorState>,
    mut rx: mpsc::Receiver<ArbSignal>,
) {
    tracing::info!("[Executor] Loop started, waiting for signals...");

    while let Some(signal) = rx.recv().await {
        let state = Arc::clone(&state);
        // Process each signal sequentially (is_submitting guard ensures this)
        process_signal(&state, signal).await;
    }

    tracing::warn!("[Executor] Loop ended — channel closed");
}

/// Process a single signal: validate → prepare → sign → POST → callback.
async fn process_signal(state: &ExecutorState, signal: ArbSignal) {
    let start = Instant::now();

    // === VALIDATE ===
    let validation_result = match validator::should_skip(&signal, &state.validation, &state.config)
    {
        Ok(result) => result,
        Err(reason) => {
            tracing::debug!(
                "[Executor] Skip signal {}: {:?}",
                signal.group_key,
                reason
            );
            return;
        }
    };

    // === LOCK: Mark as submitting ===
    if state
        .validation
        .is_submitting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        tracing::debug!("[Executor] Already submitting, skip");
        return;
    }

    // === OPTIMISTIC BALANCE DEDUCTION ===
    if !state
        .validation
        .try_deduct_balance(validation_result.required_cost)
    {
        state
            .validation
            .is_submitting
            .store(false, Ordering::Release);
        tracing::debug!("[Executor] Insufficient balance after deduction attempt");
        return;
    }

    // === UPDATE: Mark execution timestamp ===
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    state
        .validation
        .last_executed_at
        .store(now_ms, Ordering::Relaxed);

    // === PREPARE ORDERS ===
    let orders = validator::prepare_batch_orders(
        &validation_result.candidates,
        validation_result.size,
        &state.config,
    );

    let prepare_elapsed = start.elapsed();
    tracing::debug!(
        "[Executor] Prepared {} orders in {:.1}µs",
        orders.len(),
        prepare_elapsed.as_micros()
    );

    // === SIGN ORDERS ===
    let signed_orders = match state.signer.sign_batch_orders(&orders) {
        Ok(signed) => signed,
        Err(e) => {
            tracing::error!("[Executor] Signing failed: {}", e);
            // Restore balance
            let balance = state.validation.get_balance();
            state
                .validation
                .set_balance(balance + validation_result.required_cost);
            state
                .validation
                .is_submitting
                .store(false, Ordering::Release);
            return;
        }
    };

    let sign_elapsed = start.elapsed();
    tracing::debug!(
        "[Executor] Signed {} orders in {:.1}µs",
        signed_orders.len(),
        sign_elapsed.as_micros()
    );

    // === HTTP POST ===
    let post_result = state
        .api_client
        .post_batch_orders(&signed_orders, &state.api_key)
        .await;

    let total_elapsed = start.elapsed();

    // === UNLOCK ===
    state
        .validation
        .is_submitting
        .store(false, Ordering::Release);

    // === BUILD TRADE RESULT ===
    let mut order_ids = Vec::new();
    let mut failed_orders = Vec::new();

    if post_result.success {
        for (i, resp) in post_result.responses.iter().enumerate() {
            if let Some(ref oid) = resp.order_id {
                order_ids.push(oid.clone());
            } else {
                let candidate = validation_result.candidates.get(i);
                failed_orders.push(NapiFailedOrder {
                    token_id: candidate.map(|c| c.token_id.clone()).unwrap_or_default(),
                    side: candidate
                        .map(|c| c.side.as_str().to_string())
                        .unwrap_or_default(),
                    price: candidate.map(|c| c.price).unwrap_or(0.0),
                    error_msg: resp
                        .error_msg
                        .clone()
                        .unwrap_or_else(|| format!("Order {} failed", i + 1)),
                });
            }
        }

        // Deduct minted assets for successful SELL legs
        for (i, candidate) in validation_result.candidates.iter().enumerate() {
            if candidate.side == OrderSide::Sell {
                // Check if this order succeeded (has order_id in response)
                let succeeded = post_result.responses.get(i)
                    .and_then(|r| r.order_id.as_ref())
                    .is_some();
                if succeeded {
                    state.validation.deduct_minted(
                        &signal.group_key,
                        &candidate.token_id,
                        validation_result.size,
                    );
                }
            }
        }
    } else {
        // Restore balance on total failure
        let balance = state.validation.get_balance();
        state
            .validation
            .set_balance(balance + validation_result.required_cost);
    }

    let actual_pnl = validation_result.size * signal.profit_abs;

    let trade_result = TradeResult {
        success: post_result.success && !order_ids.is_empty(),
        order_ids,
        failed_orders,
        total_cost: validation_result.required_cost,
        expected_pnl: actual_pnl,
        latency_us: total_elapsed.as_micros() as i64,
        signal_group_key: signal.group_key.clone(),
        signal_strategy: signal.strategy.clone(),
        signal_profit_abs: signal.profit_abs,
        signal_profit_bps: signal.profit_bps,
        signal_timestamp_ms: signal.timestamp_ms,
    };

    tracing::info!(
        "[EXEC] [{}] orders={} failed={} | validate+prepare={:.0}µs sign={:.0}µs post={:.0}µs total={:.1}ms | PnL: ${:.4}",
        if trade_result.success { "OK" } else { "FAIL" },
        trade_result.order_ids.len(),
        trade_result.failed_orders.len(),
        prepare_elapsed.as_micros(),
        (sign_elapsed - prepare_elapsed).as_micros(),
        (total_elapsed - sign_elapsed).as_micros(),
        total_elapsed.as_secs_f64() * 1000.0,
        actual_pnl,
    );

    // === CALLBACK TO NODE.JS ===
    let registry = get_registry();
    registry.emit_trade_result(trade_result).await;
}
