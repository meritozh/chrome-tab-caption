/**
 * Dedupe stub — auto-close-older for normalized URL across windows (Phase 5).
 * Safety order (Pilot adopt): activate keep + focus window → remove dup;
 * maintain closingTabIds; on failure keep both tabs.
 */

/**
 * @param {Set<number>} _closingTabIds
 * @returns {Promise<{ closed: number, stub: true }>}
 */
export async function runAutoDedupe(_closingTabIds) {
  return { closed: 0, stub: true };
}
