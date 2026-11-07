import { requestAuthenticatedBlob, requestAuthenticatedJson } from "./auth";

export type UserProfile = {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
  approval_status: string;
  is_active: boolean;
  created_at: string;
  profile_image_url: string | null;
};

export async function getProfile(): Promise<UserProfile> {
  return requestAuthenticatedJson<UserProfile>("/api/v1/profile");
}

export async function updateProfile(full_name: string): Promise<UserProfile> {
  return requestAuthenticatedJson<UserProfile>("/api/v1/profile", {
    method: "PATCH",
    body: JSON.stringify({ full_name }),
  });
}

export async function uploadProfileImage(file: File): Promise<void> {
  const formData = new FormData();
  formData.append("file", file);
  await requestAuthenticatedJson<{ profile_image_url: string }>("/api/v1/profile/image", {
    method: "POST",
    body: formData,
  });
}

export async function removeProfileImage(): Promise<void> {
  await requestAuthenticatedJson<void>("/api/v1/profile/image", { method: "DELETE" });
}

export async function loadProfileImage(): Promise<Blob> {
  return requestAuthenticatedBlob("/api/v1/profile/image");
}
