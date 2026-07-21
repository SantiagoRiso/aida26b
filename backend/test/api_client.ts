import type { ApiEnvelope, ApiError, ApiErrorEnvelope, ListMeta } from '../../shared/src/ssot/envelope';

// One typed HTTP client for the API tests. The caller declares the payload shape it expects, so
// every assertion is checked against a real record type instead of an opaque bag.
// Wire values are verbatim pg output: NUMERIC and BIGINT arrive as strings, so declare them so.

type JsonScalar = string | number | boolean | null;
export type JsonBody = Record<string, JsonScalar | JsonScalar[] | Record<string, JsonScalar>>;

// body is null when the response carried no envelope at all: a 204, or one of Express's own
// HTML fallbacks for a path no route claims. Those are legitimate responses a test asserts a
// status on, so they are a case the type carries, not an error the client throws on.
export type ApiResponse<T> = {
  status: number;
  cookie: string | null;
  body: ApiEnvelope<T> | ApiErrorEnvelope | null;
};

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: JsonBody;
  cookie?: string;
};

// Bound to a getter because the server's port is only known once beforeAll has started it.
export function makeApiClient(getBaseUrl: () => string) {
  return async function request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const { method = 'GET', body, cookie } = options;
    const response = await fetch(`${getBaseUrl()}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    // Express's own 404/405 fallbacks answer with HTML, not an envelope — those responses carry
    // no body a test can read, only a status.
    const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
    const text = await response.text();
    return {
      status: response.status,
      cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null,
      body: isJson && text ? (JSON.parse(text) as ApiEnvelope<T> | ApiErrorEnvelope) : null,
    };
  };
}

function envelopeOf<T>(response: ApiResponse<T>): ApiEnvelope<T> {
  if (response.body === null) {
    throw new Error(`Expected a response envelope, got an empty ${response.status} body`);
  }
  if (!response.body.success) {
    throw new Error(`Expected a success envelope, got ${response.status} ${response.body.error.code}`);
  }
  return response.body;
}

export function dataOf<T>(response: ApiResponse<T>): T {
  return envelopeOf(response).data;
}

export function metaOf<T>(response: ApiResponse<T>): ListMeta {
  const meta = envelopeOf(response).meta;
  if (meta === undefined) throw new Error('Expected a list envelope carrying meta');
  return meta;
}

export function errorOf<T>(response: ApiResponse<T>): ApiError {
  if (response.body === null) {
    throw new Error(`Expected a response envelope, got an empty ${response.status} body`);
  }
  if (response.body.success) throw new Error(`Expected an error envelope, got ${response.status}`);
  return response.body.error;
}
