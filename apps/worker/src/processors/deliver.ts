import { retryDelivery } from '../delivery.js';
import { logger } from '../logger.js';

/**
 * Webhook retry worker.
 *
 * Deliberately thin: all the state lives in `webhook_deliveries`, so a retry
 * that arrives after a deploy, or on a different worker, behaves identically.
 * BullMQ decides *when* to try again (exponential backoff, 6 attempts); this
 * function decides *what* happens on each attempt and whether the delivery is
 * finally dead.
 */
export async function processDelivery(payload: { deliveryId: string }): Promise<void> {
  const { ok, attempts } = await retryDelivery(payload.deliveryId);

  if (ok) {
    logger.info('Webhook delivery retry succeeded', { deliveryId: payload.deliveryId, attempts });
    return;
  }

  // Throwing hands the job back to BullMQ for another attempt with backoff.
  // When attempts are exhausted the row is already marked `dead`, and the error
  // is kept for the operator rather than swallowed.
  throw new Error(`Delivery ${payload.deliveryId} failed on attempt ${attempts}`);
}
