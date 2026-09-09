/**
 * Build-time constants for Oceanum AI integration.
 * These values are compiled into the extension.
 */

/** URL of the Oceanum AI backend service */
export const OCEANUM_AI_BACKEND_URL = 'https://ai.oceanum.io';

/**
 * Safety net on observe requests per prompt. The server's EXECUTE_MAX_ROUNDS
 * is what actually caps the chain (at its cap it answers without code, which
 * ends the loop); this only stops a client talking to a server that keeps
 * sending code, and is checked after each observe so the server's explanation
 * turn is always requested.
 */
export const MAX_OBSERVE_ROUNDS = 8;
