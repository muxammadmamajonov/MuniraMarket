// Test double for the root `sdk` module. Mirrors the documented surface minimally:
// `db`, `api`, `fetch`, `InputFile`, `BotApiError`, `EndpointError`.
export { db } from './db.js';
export { api, BotApiError } from './api.js';
export { fetch, InputFile } from './fetch.js';

export class EndpointError extends Error {
  constructor(description, parameters) {
    super(description);
    this.name = 'EndpointError';
    if (parameters !== undefined) this.parameters = parameters;
  }
}
