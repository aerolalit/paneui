// Protocol limits shared across HTTP routes and the WebSocket frame handler.
// Defined once here so both transports enforce the same caps and can't drift.

/** Maximum length of an event type string, in characters. */
export const MAX_EVENT_TYPE_LENGTH = 64;

/** Maximum length of a causation ID string, in characters. */
export const MAX_CAUSATION_ID_LENGTH = 64;

/** Maximum length of an idempotency key string, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Maximum length of a correlation ID string, in characters. */
export const MAX_CORRELATION_ID_LENGTH = 128;

/** Maximum number of characters from a close-reason string to log. */
export const MAX_CLOSE_REASON_LOG_LENGTH = 200;
