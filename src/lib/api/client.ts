/**
 * Calls one of our own JSON endpoints from the browser and reduces the result to either the
 * data or a message that is safe to show. Used by the school forms, which all follow the
 * same shape: send, then either show the problem or move on.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export async function sendJson<T = unknown>(
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      message: "We could not reach the server. Check your connection.",
    };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // An empty or non-JSON body is handled below.
  }
  if (response.ok) return { ok: true, data: payload as T };
  const message =
    typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: unknown } }).error?.message ?? "")
      : "";
  return {
    ok: false,
    status: response.status,
    message: message || "Something went wrong. Please try again.",
  };
}
