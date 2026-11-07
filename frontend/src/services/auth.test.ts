import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteProduct } from "./business";
import { clearAccessToken, requestAuthenticatedBlob, requestAuthenticatedJson, setAccessToken } from "./auth";
import { getExpiryAlertCharts, getExpiryAlertFilters, listExpiryAlerts } from "./expiryAlerts";

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  sessionStorage.clear();
});

describe("authenticated API responses", () => {
  it("accepts 204 responses from delete endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    setAccessToken("test-token", 60);

    await expect(deleteProduct(19)).resolves.toBeUndefined();
  });

  it("uses the same-origin API path by default so Vite can proxy requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user_id: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestAuthenticatedJson("/api/v1/auth/me");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("shares an in-flight authenticated GET for the same path and token", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("shared-token", 60);

    const first = requestAuthenticatedJson<{ user_id: number }>("/api/v1/test-summary");
    const second = requestAuthenticatedJson<{ user_id: number }>("/api/v1/test-summary");
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch(new Response(JSON.stringify({ user_id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { user_id: 1 },
      { user_id: 1 },
    ]);
  });

  it("sends the signed-in bearer token with every expiry data request", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("test-token", 60);

    await Promise.all([
      listExpiryAlerts({ page: 1, page_size: 10 }),
      getExpiryAlertCharts({}),
      getExpiryAlertFilters(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [path, init] of fetchMock.mock.calls) {
      expect(path).toMatch(/^\/api\/v1\/expiry-alerts(?:\/charts|\/filters)?(?:\?|$)/);
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    }
  });

  it("clears revoked sessions and announces the expiry to the app", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    setAccessToken("revoked-token", 60);
    const expired = vi.fn();
    window.addEventListener("wastewise:session-expired", expired);

    await expect(requestAuthenticatedJson("/api/v1/auth/me")).rejects.toThrow("Not authenticated");
    expect(sessionStorage.getItem("wastewise.accessToken")).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener("wastewise:session-expired", expired);
  });

  it("loads private profile images with the authenticated bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["private image"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("profile-image-token", 60);

    const image = await requestAuthenticatedBlob("/api/v1/profile/image");

    expect(image.type).toBe("image/png");
    const [requestedPath, requestOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestedPath).toBe("/api/v1/profile/image");
    expect(new Headers(requestOptions.headers).get("Authorization")).toBe("Bearer profile-image-token");
  });

  it("clears a revoked session when a private profile image request is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Sign in is required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    setAccessToken("revoked-profile-token", 60);
    const expired = vi.fn();
    window.addEventListener("wastewise:session-expired", expired);

    await expect(requestAuthenticatedBlob("/api/v1/profile/image")).rejects.toThrow("Sign in is required.");
    expect(sessionStorage.getItem("wastewise.accessToken")).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener("wastewise:session-expired", expired);
  });
});
