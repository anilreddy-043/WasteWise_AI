const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || ""
).replace(/\/+$/, "");

type AuthResponse = {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
};

type RegisterResponse = {
  user_id: number;
  email: string;
  message: string;
};

export type AuthenticatedUser = {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
};

export type ManagedUser = {
  user_id: number;
  full_name: string;
  email: string;
  role: "admin" | "store_manager" | "staff" | "viewer";
  is_active: boolean;
  created_at: string;
};

const ACCESS_TOKEN_KEY = "wastewise.accessToken";
const ACCESS_TOKEN_EXPIRY_KEY = "wastewise.accessTokenExpiresAt";
const inFlightGetRequests = new Map<string, Promise<unknown>>();

function readStoredSession(): { token: string | null; expiresAt: number | null } {
  try {
    const token = sessionStorage.getItem(ACCESS_TOKEN_KEY);
    const expiresAt = Number(sessionStorage.getItem(ACCESS_TOKEN_EXPIRY_KEY));
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      sessionStorage.removeItem(ACCESS_TOKEN_KEY);
      sessionStorage.removeItem(ACCESS_TOKEN_EXPIRY_KEY);
      return { token: null, expiresAt: null };
    }
    return { token, expiresAt };
  } catch {
    return { token: null, expiresAt: null };
  }
}

const storedSession = readStoredSession();
let accessToken: string | null = storedSession.token;
let accessTokenExpiresAt: number | null = storedSession.expiresAt;

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (accessToken && accessTokenExpiresAt !== null && Date.now() >= accessTokenExpiresAt) {
    clearAccessToken();
    throw new Error("Your WasteWise session has expired. Please sign in again.");
  }

  let response: Response;
  try {
    const headers = new Headers(init.headers ?? undefined);
    const shouldAddJsonContentType =
      init.body !== undefined &&
      !(init.body instanceof FormData) &&
      !headers.has("Content-Type") &&
      !(init.body instanceof Blob) &&
      !(init.body instanceof ArrayBuffer) &&
      !(init.body instanceof URLSearchParams) &&
      !(init.body instanceof File);

    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(shouldAddJsonContentType ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: ["Bearer", accessToken].join(" ") } : {}),
        ...Object.fromEntries(headers.entries()),
      },
    });
  } catch {
    throw new Error(
      `Cannot connect to the WasteWise API for ${path}. Check the FastAPI backend, API base URL, Vite proxy, and frontend origin in the backend CORS settings.`,
    );
  }

  if (response.status === 401 && accessToken) {
    clearAccessToken();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("wastewise:session-expired"));
    }
  }
  if (response.status === 204) return undefined as T;

  const responseText = await response.text();
  let result: unknown;
  try {
    result = responseText ? JSON.parse(responseText) as unknown : undefined;
  } catch {
    if (!response.ok) {
      throw new Error(
        response.status >= 500
          ? `The WasteWise API is unavailable at ${path} (HTTP ${response.status}). Check the backend logs.`
          : `The WasteWise API returned an unexpected response at ${path} (HTTP ${response.status}).`,
      );
    }
    throw new Error("The WasteWise API returned an invalid response.");
  }
  if (!response.ok) {
    const detail = result && typeof result === "object" && "detail" in result
      ? result.detail
      : undefined;
    if (typeof detail === "string") {
      throw new Error(detail);
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item: unknown) => {
          if (!item || typeof item !== "object" || !("msg" in item)) return null;
          const message = typeof item.msg === "string" ? item.msg : null;
          const location = "loc" in item && Array.isArray(item.loc)
            ? item.loc.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
            : [];
          return message ? `${location.join(".")}: ${message}` : null;
        })
        .filter((message): message is string => message !== null);
      if (messages.length > 0) {
        throw new Error(messages.join(" "));
      }
    }
    throw new Error(
      response.status >= 500
        ? `The WasteWise API encountered a server error at ${path} (HTTP ${response.status}). Check the backend logs.`
        : `The request to ${path} could not be completed (HTTP ${response.status}).`,
    );
  }
  return result as T;
}

export async function registerAccount(payload: {
  full_name: string;
  email: string;
  password: string;
  role: "Store Manager" | "Staff" | "Viewer";
  accepted_terms: boolean;
}): Promise<RegisterResponse> {
  return requestJson<RegisterResponse>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function signIn(payload: { email: string; password: string }): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  return requestJson<AuthenticatedUser>("/api/v1/auth/me");
}

export async function signOut(): Promise<void> {
  await requestJson<{ status: string }>("/api/v1/auth/logout", { method: "POST" });
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  return requestJson<ManagedUser[]>("/api/v1/users?limit=500");
}

export async function updateUserActive(userId: number, is_active: boolean): Promise<void> {
  await requestJson<{ user_id: number; is_active: boolean }>(`/api/v1/users/${userId}/active`, {
    method: "PATCH",
    body: JSON.stringify({ is_active }),
  });
}

export async function updateUserRole(
  userId: number,
  role: ManagedUser["role"],
): Promise<void> {
  await requestJson<{ user_id: number; role: ManagedUser["role"] }>(`/api/v1/users/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function changePassword(current_password: string, new_password: string): Promise<void> {
  await requestJson<{ status: string }>("/api/v1/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ current_password, new_password }),
  });
}

export function setAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
  try {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    sessionStorage.setItem(ACCESS_TOKEN_EXPIRY_KEY, String(accessTokenExpiresAt));
  } catch {
    // The authenticated API client still works for this page lifecycle when storage is unavailable.
  }
}

export function clearAccessToken(): void {
  accessToken = null;
  accessTokenExpiresAt = null;
  try {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(ACCESS_TOKEN_EXPIRY_KEY);
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
}

export function getAccessTokenExpiresAt(): number | null {
  return accessTokenExpiresAt;
}

export function requestAuthenticatedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" || init.body !== undefined || init.signal || init.headers) {
    return requestJson<T>(path, init);
  }

  const key = `${accessToken ?? ""}\u0000${path}`;
  const pending = inFlightGetRequests.get(key);
  if (pending) return pending as Promise<T>;

  const request = requestJson<T>(path, init);
  inFlightGetRequests.set(key, request);
  const removePending = () => {
    if (inFlightGetRequests.get(key) === request) inFlightGetRequests.delete(key);
  };
  void request.then(removePending, removePending);
  return request;
}

export async function requestAuthenticatedBlob(path: string): Promise<Blob> {
  if (accessToken && accessTokenExpiresAt !== null && Date.now() >= accessTokenExpiresAt) {
    clearAccessToken();
    throw new Error("Your WasteWise session has expired. Please sign in again.");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
  } catch {
    throw new Error(
      `Cannot connect to the WasteWise API for ${path}. Check the FastAPI backend, API base URL, and Vite proxy.`,
    );
  }

  if (response.status === 401 && accessToken) {
    clearAccessToken();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("wastewise:session-expired"));
    }
  }
  if (!response.ok) {
    const responseText = await response.text();
    let body: unknown;
    try {
      body = responseText ? JSON.parse(responseText) as unknown : undefined;
    } catch {
      body = undefined;
    }
    if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") {
      throw new Error(body.detail);
    }
    throw new Error(
      response.status >= 500
        ? `The WasteWise API encountered a server error at ${path} (HTTP ${response.status}). Check the backend logs.`
        : `The request to ${path} could not be completed (HTTP ${response.status}).`,
    );
  }
  return response.blob();
}
