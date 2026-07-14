// The one response envelope every backend route emits and the frontend client decodes.
// Both sides type against these so the wire shape cannot fork.

export type ListMeta = { page: number; limit: number; total: number };

export type ApiEnvelope<T> = { success: true; data: T; meta?: ListMeta };

export type ApiError = { code: string; message: string; fields?: Record<string, string> };

export type ApiErrorEnvelope = { success: false; error: ApiError };
