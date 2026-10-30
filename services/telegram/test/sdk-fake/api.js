// Test double for `sdk/api`: `api.<anyMethod>(params)` is recorded and resolved with a canned
// value; failures can be scripted with `BotApiError` like the real SDK.

export class BotApiError extends Error {
  constructor(code, description, { method = 'unknown', parameters } = {}) {
    super(description);
    this.name = 'BotApiError';
    this.code = code;
    this.description = description;
    this.method = method;
    if (parameters) this.parameters = parameters;
  }
}

export function createRecordingApi() {
  const calls = [];
  const responders = new Map();
  const helpers = {
    calls,
    reset() {
      calls.length = 0;
      responders.clear();
    },
    /** Script a method: `fn(params)` may return a value or throw. */
    respond(method, fn) {
      responders.set(method, fn);
    },
  };
  return new Proxy(helpers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return async (params) => {
        calls.push({ method: prop, params });
        const responder = responders.get(prop);
        if (responder) return responder(params);
        return prop === 'sendMessage' ? { message_id: 1 } : {};
      };
    },
  });
}

export const api = createRecordingApi();
