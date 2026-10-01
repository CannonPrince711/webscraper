/**
 * `@webscraper/shared` — the contract shared by the web app, the API routes
 * and the worker.
 *
 * Import rules:
 *   - Config validation lives in `scrape-config.ts` and is the *only* place a
 *     ScrapeConfig may be parsed.
 *   - Errors crossing a network boundary must be `AppError.toPublic()`.
 */

export * from './scrape-config.js';
export * from './types.js';
export * from './errors.js';
export * from './utils.js';
export * from './constants.js';
export * from './cron.js';
export * from './crawl.js';
export * from './webhooks.js';
export * from './proxy.js';
