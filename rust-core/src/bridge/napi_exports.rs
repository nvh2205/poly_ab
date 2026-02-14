//! N-API exported functions — the public API surface for Node.js.
//!
//! These functions are callable from JavaScript via the native module.
//! They manage the lifecycle of the Rust socket engine, arbitrage engine, and executor.
//!
//! Callback policy: Only `on_trade_result` calls back to Node.js.
//! All other data flows (socket → engine → executor) stay entirely in Rust.

use crate::bridge::callbacks::get_registry;
use crate::engine::engine::{MarketDescriptorInput, RangeGroupInput};
use crate::engine::state::{EngineConfig, EngineState};
use crate::executor::api_client::ClobApiClient;
use crate::executor::{self, ExecutorState};
use crate::socket::manager::SocketManager;
use crate::types::config::SocketConfig;
use crate::types::market::{SocketStatus, TopOfBookUpdate};
use crate::types::order::{NapiExecutorConfigInput, TradeResult};
use crate::types::signal::ArbSignal;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;

// =============================================================================
// GLOBAL STATE
// =============================================================================

/// Global socket manager wrapped in Arc<Mutex> for thread-safe access.
static MANAGER: std::sync::OnceLock<Arc<tokio::sync::Mutex<Option<SocketManager>>>> =
    std::sync::OnceLock::new();

fn get_manager() -> &'static Arc<tokio::sync::Mutex<Option<SocketManager>>> {
    MANAGER.get_or_init(|| Arc::new(tokio::sync::Mutex::new(None)))
}

/// Global engine state — owns PriceTable and all groups.
static ENGINE_STATE: std::sync::OnceLock<Arc<std::sync::Mutex<EngineState>>> =
    std::sync::OnceLock::new();

fn get_engine() -> &'static Arc<std::sync::Mutex<EngineState>> {
    ENGINE_STATE.get_or_init(|| Arc::new(std::sync::Mutex::new(EngineState::new(EngineConfig::default()))))
}

/// Global tokio runtime for the socket engine.
static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

pub fn get_runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(3) // Socket + Engine + Executor threads
            .thread_name("rust-core")
            .enable_all()
            .build()
            .expect("Failed to create tokio runtime")
    })
}

/// Global executor state.
static EXECUTOR_STATE: std::sync::OnceLock<Arc<ExecutorState>> = std::sync::OnceLock::new();

/// Global executor signal sender (for dual-path dispatch).
static EXECUTOR_TX: std::sync::OnceLock<mpsc::Sender<ArbSignal>> = std::sync::OnceLock::new();

// =============================================================================
// N-API INPUT TYPES (JS → Rust)
// =============================================================================

/// Market descriptor input from Node.js.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiMarketDescriptorInput {
    pub market_id: String,
    pub slug: String,
    pub clob_token_ids: Vec<String>,
    pub bounds_lower: Option<f64>,
    pub bounds_upper: Option<f64>,
    pub kind: String,
    pub neg_risk: bool,
}

/// Group input from Node.js.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiRangeGroupInput {
    pub group_key: String,
    pub event_slug: String,
    pub crypto: String,
    pub children: Vec<NapiMarketDescriptorInput>,
    pub parents: Vec<NapiMarketDescriptorInput>,
}

/// Engine config input from Node.js.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiEngineConfigInput {
    pub min_profit_bps: Option<f64>,
    pub min_profit_abs: Option<f64>,
    pub cooldown_ms: Option<i64>,
}

/// Engine status output.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiEngineStatus {
    pub total_groups: i32,
    pub total_trios: i32,
    pub total_price_slots: i32,
    pub total_tokens_indexed: i32,
}

// =============================================================================
// CONVERSION HELPERS
// =============================================================================

fn convert_market_input(input: NapiMarketDescriptorInput) -> MarketDescriptorInput {
    MarketDescriptorInput {
        market_id: input.market_id,
        slug: input.slug,
        clob_token_ids: input.clob_token_ids,
        bounds_lower: input.bounds_lower,
        bounds_upper: input.bounds_upper,
        kind: input.kind,
        neg_risk: input.neg_risk,
    }
}

fn convert_group_input(input: NapiRangeGroupInput) -> RangeGroupInput {
    RangeGroupInput {
        group_key: input.group_key,
        event_slug: input.event_slug,
        crypto: input.crypto,
        children: input.children.into_iter().map(convert_market_input).collect(),
        parents: input.parents.into_iter().map(convert_market_input).collect(),
    }
}

// =============================================================================
// SOCKET N-API FUNCTIONS
// =============================================================================

/// Initialize the Rust socket engine with the given configuration.
///
/// Must be called before any other socket functions.
/// Creates the internal SocketManager and tokio runtime.
#[napi]
pub fn init_socket(config: SocketConfig) -> Result<()> {
    // Initialize tracing subscriber (only once, ignore error if already init)
    let _ = tracing_subscriber::fmt()
        .with_target(false)
        .with_thread_ids(true)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    info!("Initializing Rust socket engine");

    let runtime = get_runtime();

    runtime.block_on(async {
        let (update_tx, mut update_rx) = mpsc::unbounded_channel::<TopOfBookUpdate>();

        let manager = SocketManager::new(config, update_tx);

        // Store manager globally
        let mut mgr = get_manager().lock().await;
        *mgr = Some(manager);

        // Spawn engine dispatcher task
        // All data stays in Rust: socket → engine → executor
        // No callbacks to Node.js on this path (only on_trade_result from executor)
        let engine = get_engine().clone();

        tokio::spawn(async move {
            while let Some(update) = update_rx.recv().await {
                let signals = {
                    let mut eng = engine.lock().unwrap();
                    eng.handle_top_of_book(
                        &update.asset_id,
                        update.best_bid,
                        update.best_ask,
                        update.best_bid_size,
                        update.best_ask_size,
                        update.timestamp_ms,
                    )
                };

                // Dispatch signals to executor
                if !signals.is_empty() {
                    if let Some(tx) = EXECUTOR_TX.get() {
                        for signal in signals {
                            let _ = tx.try_send(signal);
                        }
                    }
                }
            }
        });
    });

    info!("Rust socket engine initialized");
    Ok(())
}

// on_top_of_book removed — entire data flow stays in Rust.

/// Subscribe to a list of token IDs.
#[napi]
pub fn subscribe_tokens(token_ids: Vec<String>) -> Result<()> {
    let runtime = get_runtime();

    runtime.block_on(async {
        let mgr = get_manager().lock().await;
        if let Some(ref manager) = *mgr {
            manager.subscribe_tokens(token_ids).await;
        } else {
            tracing::error!("Socket engine not initialized. Call initSocket() first.");
        }
    });

    Ok(())
}

/// Unsubscribe from a list of token IDs.
#[napi]
pub fn unsubscribe_tokens(token_ids: Vec<String>) -> Result<()> {
    let runtime = get_runtime();

    runtime.block_on(async {
        let mgr = get_manager().lock().await;
        if let Some(ref manager) = *mgr {
            manager.unsubscribe_tokens(token_ids).await;
        }
    });

    Ok(())
}

/// Get the current socket status (connection count, message stats, etc.).
#[napi]
pub fn get_socket_status() -> Result<SocketStatus> {
    let runtime = get_runtime();

    let status = runtime.block_on(async {
        let mgr = get_manager().lock().await;
        match *mgr {
            Some(ref manager) => {
                let s = manager.get_status().await;
                SocketStatus {
                    total_connections: s.total_connections,
                    active_connections: s.active_connections,
                    subscribed_tokens: s.subscribed_tokens,
                    messages_received: s.messages_received,
                    last_message_at_ms: s.last_message_at_ms,
                }
            }
            None => SocketStatus {
                total_connections: 0,
                active_connections: 0,
                subscribed_tokens: 0,
                messages_received: 0,
                last_message_at_ms: None,
            },
        }
    });

    Ok(status)
}

/// Gracefully shutdown the Rust socket engine.
#[napi]
pub fn shutdown_socket() -> Result<()> {
    let runtime = get_runtime();

    runtime.block_on(async {
        let mut mgr = get_manager().lock().await;
        if let Some(ref manager) = *mgr {
            manager.shutdown().await;
        }
        *mgr = None;
    });

    info!("Rust socket engine shut down");
    Ok(())
}

// =============================================================================
// ENGINE N-API FUNCTIONS
// =============================================================================

/// Update the market structure (groups, markets, trios).
///
/// Called by Node.js when markets are discovered/refreshed.
/// Rebuilds PriceTable, groups, and trio indices.
/// Returns the total number of trios created.
#[napi]
pub fn update_market_structure(groups: Vec<NapiRangeGroupInput>) -> Result<i32> {
    let converted: Vec<RangeGroupInput> = groups.into_iter().map(convert_group_input).collect();

    let trio_count = {
        let mut engine = get_engine().lock().unwrap();
        engine.update_market_structure(converted)
    };

    info!("Market structure updated: {} trios", trio_count);
    Ok(trio_count)
}

// on_signal removed — signals are dispatched directly to Rust executor.

/// Update engine configuration (profit thresholds, cooldown).
#[napi]
pub fn update_engine_config(config: NapiEngineConfigInput) -> Result<()> {
    let mut engine = get_engine().lock().unwrap();

    if let Some(v) = config.min_profit_bps {
        engine.config.min_profit_bps = v;
    }
    if let Some(v) = config.min_profit_abs {
        engine.config.min_profit_abs = v;
    }
    if let Some(v) = config.cooldown_ms {
        engine.config.cooldown_ms = v;
    }

    info!(
        "Engine config updated: bps={}, abs={}, cooldown={}ms",
        engine.config.min_profit_bps, engine.config.min_profit_abs, engine.config.cooldown_ms
    );
    Ok(())
}

/// Get engine status (group/trio counts, price slot count).
#[napi]
pub fn get_engine_status() -> Result<NapiEngineStatus> {
    let engine = get_engine().lock().unwrap();

    let total_trios: i32 = engine
        .groups
        .iter()
        .map(|g| g.trio_states.len() as i32)
        .sum();

    Ok(NapiEngineStatus {
        total_groups: engine.groups.len() as i32,
        total_trios,
        total_price_slots: engine.price_table.slots.len() as i32,
        total_tokens_indexed: engine.token_index.len() as i32,
    })
}



// =============================================================================
// EXECUTOR N-API FUNCTIONS
// =============================================================================

/// Initialize the executor with trading configuration.
///
/// Creates the signer (cached wallet), API client (persistent HTTP), and
/// spawns the executor loop. Must be called once at startup.
#[napi]
pub fn init_executor(config: NapiExecutorConfigInput) -> Result<()> {
    info!("Initializing Rust executor...");

    let state = ExecutorState::from_config(&config)
        .map_err(|e| napi::Error::from_reason(format!("Failed to init executor: {}", e)))?;

    let state = Arc::new(state);

    // Store executor state globally
    EXECUTOR_STATE
        .set(Arc::clone(&state))
        .map_err(|_| napi::Error::from_reason("Executor already initialized"))?;

    // Spawn executor loop and store sender
    let tx = executor::spawn_executor(state);
    EXECUTOR_TX
        .set(tx)
        .map_err(|_| napi::Error::from_reason("Executor channel already created"))?;

    info!("Rust executor initialized (wallet cached, HTTP client ready)");
    Ok(())
}

/// Register callback for trade results from executor.
#[napi(ts_args_type = "callback: (result: TradeResult) => void")]
pub fn on_trade_result(callback: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<TradeResult, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

    let runtime = get_runtime();
    let registry = get_registry().clone();

    runtime.block_on(async {
        registry.set_on_trade_result(tsfn).await;
    });

    info!("onTradeResult callback registered");
    Ok(())
}

/// Update USDC balance (called by Node.js background refresh).
#[napi]
pub fn update_balance(usdc_balance: f64) -> Result<()> {
    if let Some(state) = EXECUTOR_STATE.get() {
        state.validation.set_balance(usdc_balance);
    }
    Ok(())
}

/// Enable/disable trading at runtime.
#[napi]
pub fn set_trading_enabled(enabled: bool) -> Result<()> {
    if let Some(state) = EXECUTOR_STATE.get() {
        state
            .validation
            .trading_enabled
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
        info!("Trading enabled: {}", enabled);
    }
    Ok(())
}

/// Update minted asset balances for a group.
///
/// Called by Node.js background refresh to push minted token amounts.
/// Used by executor to validate SELL leg sizes — can't sell more than minted.
#[napi]
pub fn update_minted_assets(group_key: String, assets: Vec<NapiMintedAssetEntry>) -> Result<()> {
    if let Some(state) = EXECUTOR_STATE.get() {
        let map: std::collections::HashMap<String, f64> = assets
            .into_iter()
            .map(|a| (a.token_id, a.amount))
            .collect();
        state.validation.set_minted_assets(&group_key, map);
    }
    Ok(())
}

/// Minted asset entry input from Node.js.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiMintedAssetEntry {
    pub token_id: String,
    pub amount: f64,
}

// =============================================================================
// BATCH ORDER API — Manual order placement via Rust Core
// =============================================================================

use crate::types::order::{NapiBatchOrderInput, NapiBatchOrderResult, NapiBatchOrderResultItem, NapiBatchOrderConfig, OrderToSign};

/// Place batch orders using Rust Core (signer + API client).
///
/// This is the N-API entry point for the `place-batch-orders-rust` controller endpoint.
/// Reuses the executor's cached wallet for EIP-712 signing (HFT performance).
/// API credentials come from the `config` parameter (provided by JS service's credential cache)
/// rather than the executor's stored credentials which may be empty.
///
/// Flow: Input orders → prepare OrderToSign[] → sign → HTTP POST → results
#[napi]
pub fn place_batch_orders_rust(
    config: NapiBatchOrderConfig,
    orders: Vec<NapiBatchOrderInput>,
) -> Result<NapiBatchOrderResult> {
    let runtime = get_runtime();

    runtime.block_on(async {
        place_batch_orders_rust_inner(config, orders).await
    }).map_err(|e| napi::Error::from_reason(e))
}

async fn place_batch_orders_rust_inner(
    config: NapiBatchOrderConfig,
    orders: Vec<NapiBatchOrderInput>,
) -> std::result::Result<NapiBatchOrderResult, String> {
    let start = std::time::Instant::now();

    // Get executor state (must have been initialized via init_executor) — for the signer
    let state = EXECUTOR_STATE
        .get()
        .ok_or_else(|| "Executor not initialized. Call initExecutor() first.".to_string())?;

    if orders.is_empty() {
        return Ok(NapiBatchOrderResult {
            success: false,
            results: vec![],
            error: Some("No orders provided".to_string()),
            latency_ms: 0.0,
        });
    }

    if orders.len() > 15 {
        return Ok(NapiBatchOrderResult {
            success: false,
            results: vec![],
            error: Some("Maximum 15 orders allowed per batch".to_string()),
            latency_ms: 0.0,
        });
    }

    // === BUILD API CLIENT with provided credentials ===
    let clob_url = config.clob_url.as_deref().unwrap_or("https://clob.polymarket.com");
    let api_client = ClobApiClient::new(
        clob_url,
        &config.api_key,
        &config.api_secret,
        &config.api_passphrase,
        &config.signer_address,
    ).map_err(|e| format!("Failed to create API client: {}", e))?;

    // === PREPARE: Convert NapiBatchOrderInput → OrderToSign ===
    let decimals: f64 = 1_000_000.0;
    let mut orders_to_sign = Vec::with_capacity(orders.len());
    let mut order_types = Vec::with_capacity(orders.len());

    for input in &orders {
        let side: u8 = if input.side == "SELL" { 1 } else { 0 };
        let neg_risk = input.neg_risk.unwrap_or(false);
        let fee_rate_bps = input.fee_rate_bps.unwrap_or(0) as u32;
        let order_type = input.order_type.clone().unwrap_or_else(|| "GTC".to_string());

        // Round size to 2 decimals
        let size_rounded = (input.size * 100.0).round() / 100.0;
        // Calculate USDC amount, round to 4 decimals
        let usdc_raw = input.price * size_rounded;
        let usdc_rounded = (usdc_raw * 10000.0).round() / 10000.0;

        let (maker_amount, taker_amount) = if side == 0 {
            // BUY: Maker = USDC, Taker = Asset
            let maker = (usdc_rounded * decimals).round() as u64;
            let taker = (size_rounded * decimals).round() as u64;
            (maker.to_string(), taker.to_string())
        } else {
            // SELL: Maker = Asset, Taker = USDC
            let maker = (size_rounded * decimals).round() as u64;
            let taker = (usdc_rounded * decimals).round() as u64;
            (maker.to_string(), taker.to_string())
        };

        // Generate salt
        let salt = {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let random: u64 = rng.gen_range(0..now_ms.max(1));
            random.to_string()
        };

        orders_to_sign.push(OrderToSign {
            salt,
            token_id: input.token_id.clone(),
            maker_amount,
            taker_amount,
            side,
            neg_risk,
            fee_rate_bps,
        });

        order_types.push(order_type);
    }

    // === SIGN (uses executor's cached wallet — no re-derivation) ===
    let signed_orders = state.signer.sign_batch_orders(&orders_to_sign)
        .map_err(|e| format!("Signing failed: {}", e))?;

    let sign_elapsed = start.elapsed();
    tracing::info!(
        "[BatchAPI] Signed {} orders in {:.1}µs",
        signed_orders.len(),
        sign_elapsed.as_micros(),
    );

    // === HTTP POST (uses API client with provided credentials) ===
    let post_result = api_client
        .post_batch_orders_with_types(&signed_orders, &config.api_key, &order_types)
        .await;

    let total_elapsed = start.elapsed();

    // === BUILD RESULTS ===
    if post_result.success {
        let results: Vec<NapiBatchOrderResultItem> = post_result
            .responses
            .iter()
            .map(|resp| {
                if resp.order_id.is_some() {
                    NapiBatchOrderResultItem {
                        success: true,
                        order_id: resp.order_id.clone(),
                        status: resp.status.clone(),
                        error_msg: resp.error_msg.clone(),
                    }
                } else {
                    NapiBatchOrderResultItem {
                        success: false,
                        order_id: None,
                        status: resp.status.clone(),
                        error_msg: resp.error_msg.clone().or_else(|| Some("Order failed".to_string())),
                    }
                }
            })
            .collect();

        tracing::info!(
            "[BatchAPI] Posted {} orders in {:.1}ms",
            results.len(),
            total_elapsed.as_secs_f64() * 1000.0,
        );

        Ok(NapiBatchOrderResult {
            success: true,
            results,
            error: None,
            latency_ms: total_elapsed.as_secs_f64() * 1000.0,
        })
    } else {
        tracing::error!(
            "[BatchAPI] Batch failed in {:.1}ms: {:?}",
            total_elapsed.as_secs_f64() * 1000.0,
            post_result.error,
        );

        Ok(NapiBatchOrderResult {
            success: false,
            results: vec![],
            error: post_result.error,
            latency_ms: total_elapsed.as_secs_f64() * 1000.0,
        })
    }
}

