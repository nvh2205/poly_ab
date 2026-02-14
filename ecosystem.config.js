module.exports = {
  apps: [
    // API Server - handles HTTP requests, WebSocket, trading signals
    {
      name: 'polymarket-api',
      script: './dist/src/main.js',
      instances: 1,
      exec_mode: 'cluster',
      node_args: [
        '--max-semi-space-size=64',   // 64MB young gen (default 16MB) - reduces minor GC frequency
        '--max-old-space-size=4096',  // 4GB old gen - reduces major GC frequency
      ].join(' '),
      env: {
        NODE_ENV: 'production',
        APP_MODE: 'api',
        RUST_LOG: 'debug',
      },
      env_production: {
        NODE_ENV: 'production',
        APP_MODE: 'api',
        RUST_LOG: 'debug',
      },
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '2G',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
    // Worker - processes Bull Queue jobs (mint, manage-position)
    {
      name: 'polymarket-worker',
      script: './dist/src/worker.main.js',
      instances: 1,
      exec_mode: 'fork', // Worker uses fork mode, not cluster
      env: {
        NODE_ENV: 'production',
        APP_MODE: 'worker',
      },
      env_production: {
        NODE_ENV: 'production',
        APP_MODE: 'worker',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1G', // Worker needs less memory
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
  ],
};
