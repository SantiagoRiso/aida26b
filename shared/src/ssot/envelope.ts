// The one response envelope every backend route emits and the frontend client decodes.
// Both sides type against these so the wire shape cannot fork.

export type ListMeta = { page: number; limit: number; total: number };

export type ApiEnvelope<T> = { success: true; data: T; meta?: ListMeta };

// Translatable form of a human message: a stable key plus its interpolation values.
// `message`/`fields` stay English so logs and non-browser consumers keep reading prose;
// `detail`/`fieldDetails` are what a localized UI resolves instead.
export type ErrorParams = Record<string, string | number>;
export type ErrorDetail = { key: string; params?: ErrorParams };

export type ApiError = {
  code: string;
  message: string;
  detail?: ErrorDetail;
  fields?: Record<string, string>;
  fieldDetails?: Record<string, ErrorDetail>;
};

export type ApiErrorEnvelope = { success: false; error: ApiError };
