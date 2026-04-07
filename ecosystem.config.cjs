// PM2 ecosystem config — alternative to built-in cluster mode.
// Usage: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [{
    name: 'claudecodeapi',
    script: 'dist/index.js',
    instances: 'max',            // 1 per CPU core
    exec_mode: 'cluster',
    max_memory_restart: '500M',

    env: {
      NODE_ENV: 'production',
      PORT: 3456,
      DATA_DIR: '/data',
      MAX_CONCURRENT: 8,
      MAX_CONCURRENT_PER_USER: 3,
      MAX_QUEUE_SIZE: 50,
      LOG_LEVEL: 'info',
    },

    // Graceful shutdown
    kill_timeout: 10000,
    listen_timeout: 5000,
    shutdown_with_message: true,

    // Logging
    error_file: '/var/log/claudecodeapi/error.log',
    out_file: '/var/log/claudecodeapi/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    // Auto-restart
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 1000,
  }],
};
