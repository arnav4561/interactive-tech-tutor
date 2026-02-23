const API_BASE_URL = (() => {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:4000/api`;
  }
  return "http://localhost:4000/api";
})();
const API_BASE_URLS = (() => {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv) {
    return [fromEnv.replace(/\/$/, "")];
  }
  if (typeof window === "undefined") {
    return [API_BASE_URL];
  }
  const host = window.location.hostname;
  if (host === "127.0.0.1") {
    return ["http://127.0.0.1:4000/api", "http://localhost:4000/api"];
  }
  if (host === "localhost") {
    return ["http://localhost:4000/api", "http://127.0.0.1:4000/api"];
  }
  return [API_BASE_URL];
})();

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown, token?: string): Promise<T> {
  let lastNetworkError: unknown;

  for (const baseUrl of API_BASE_URLS) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      lastNetworkError = error;
      continue;
    }

    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch (_error) {
        payload = { error: raw };
      }
    }

    if (!response.ok) {
      throw new Error(String(payload.error ?? `Request failed (${response.status}).`));
    }
    return payload as T;
  }

  void lastNetworkError;
  throw new Error(
    `Unable to reach API at ${API_BASE_URLS.join(" or ")}. Ensure the API server is running.`
  );
}

export function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>("GET", path, undefined, token);
}

export function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>("POST", path, body, token);
}

export function apiPut<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>("PUT", path, body, token);
}

export function apiDelete<T>(path: string, token?: string): Promise<T> {
  return request<T>("DELETE", path, undefined, token);
}
