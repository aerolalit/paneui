// Shared protocol limits used across transports (HTTP and WebSocket).
// Defined once here so both relay and client code import the same constants.

/** Maximum length of an event type string, in characters. */
export const MAX_EVENT_TYPE_LENGTH = 64;

/** Maximum length of an idempotency key string, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Maximum number of characters from a raw response body to include in error details. */
export const MAX_RESPONSE_SNIPPET_LENGTH = 500;

/** Maximum number of characters from a raw stream frame to include in error messages. */
export const MAX_FRAME_SNIPPET_LENGTH = 200;
