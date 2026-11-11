/**
 * Typed message helpers for UI ↔ SW (Pilot-style MSG table).
 */

import { MSG } from './constants.js';

/**
 * Send a message to the service worker and await a response.
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<unknown>}
 */
export function sendToBackground(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

/**
 * @param {(message: { type: string } & Record<string, unknown>, sender: chrome.runtime.MessageSender) => boolean | void} handler
 * @returns {() => void} unsubscribe
 */
export function onBackgroundBroadcast(handler) {
  /** @param {any} message @param {chrome.runtime.MessageSender} sender */
  const listener = (message, sender) => {
    if (!message || typeof message.type !== 'string') return;
    handler(message, sender);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export { MSG };
