// Test double for `sdk/fetch`.

export class InputFile {
  constructor(bytes, filename, options = {}) {
    this.bytes = bytes;
    this.filename = filename;
    this.type = options.type;
  }
}

/** Builds a fake fetch whose responses are scripted by `handler(url, init)`. */
export function createFakeFetch(initialHandler = () => ({ status: 200, body: '{}' })) {
  let handler = initialHandler;
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const status = result.status ?? 200;
    return {
      status,
      statusText: String(status),
      ok: status >= 200 && status < 300,
      url,
      headers: { get: () => null, has: () => false, keys: () => [], entries: () => [] },
      text: async () => result.body ?? '',
      json: async () => JSON.parse(result.body ?? 'null'),
    };
  };
  fakeFetch.calls = calls;
  /** Test helper: replace the scripted behaviour. */
  fakeFetch.__setHandler = (next) => {
    handler = next;
  };
  return fakeFetch;
}

export const fetch = createFakeFetch();
