/**
 * Application-wide constants
 * Centralized configuration values
 */

// Preview Server Configuration
export const PREVIEW_CONFIG = {
  LOG_LIMIT: 400,
  FALLBACK_PORT_START: 3_100,
  FALLBACK_PORT_END: 3_999,
  DEFAULT_PORT: 3000,
  STARTUP_TIMEOUT: 30000, // 30 seconds
  HEALTH_CHECK_INTERVAL: 2000, // 2 seconds
} as const;

// WebSocket Configuration
export const WEBSOCKET_CONFIG = {
  MAX_RECONNECT_ATTEMPTS: 10,
  BASE_RECONNECT_DELAY: 1000, // 1 second
  MAX_RECONNECT_DELAY: 30000, // 30 seconds
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  CONNECTION_TIMEOUT: 10000, // 10 seconds
} as const;
