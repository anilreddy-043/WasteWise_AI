import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Profile from "./Profile";
import * as auth from "../services/auth";
import * as profileService from "../services/profile";

vi.mock("../services/auth", () => ({
  changePassword: vi.fn(),
}));

vi.mock("../services/profile", () => ({
  getProfile: vi.fn(),
  loadProfileImage: vi.fn(),
  removeProfileImage: vi.fn(),
  updateProfile: vi.fn(),
  uploadProfileImage: vi.fn(),
}));

const profileRecord: profileService.UserProfile = {
  user_id: 14,
  full_name: "Mira Store",
  email: "mira@example.test",
  role: "store_manager",
  approval_status: "approved",
  is_active: true,
  created_at: "2025-03-05T10:00:00Z",
  profile_image_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:profile-preview"),
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(profileService.getProfile).mockResolvedValue(profileRecord);
  vi.mocked(profileService.loadProfileImage).mockResolvedValue(new Blob(["profile"], { type: "image/png" }));
  vi.mocked(profileService.updateProfile).mockImplementation(async (full_name) => ({ ...profileRecord, full_name }));
  vi.mocked(profileService.uploadProfileImage).mockResolvedValue();
  vi.mocked(profileService.removeProfileImage).mockResolvedValue();
  vi.mocked(auth.changePassword).mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Profile", () => {
  it("loads account details and keeps email, role, and status read-only", async () => {
    render(<Profile onNotify={vi.fn()} onNameChange={vi.fn()} onPasswordChanged={vi.fn()} />);

    expect(await screen.findByDisplayValue("Mira Store")).toBeInTheDocument();
    expect(screen.getByDisplayValue("mira@example.test")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("Store Manager")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("Active")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("05 Mar 2025")).toHaveAttribute("readonly");
  });

  it("saves only the user's full name and updates the account menu name", async () => {
    const notify = vi.fn();
    const onNameChange = vi.fn();
    render(<Profile onNotify={notify} onNameChange={onNameChange} onPasswordChanged={vi.fn()} />);

    const nameInput = await screen.findByLabelText("Full name");
    fireEvent.change(nameInput, { target: { value: "  Mira Patel  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(profileService.updateProfile).toHaveBeenCalledWith("Mira Patel"));
    expect(onNameChange).toHaveBeenCalledWith("Mira Patel");
    expect(notify).toHaveBeenCalledWith("Profile details saved.");
  });

  it("validates and changes passwords using current-password verification", async () => {
    const onPasswordChanged = vi.fn();
    const notify = vi.fn();
    render(<Profile onNotify={notify} onNameChange={vi.fn()} onPasswordChanged={onPasswordChanged} />);
    await screen.findByLabelText("Current password");

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Current123!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "NewPass456!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Different456!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The new password and confirmation do not match.");
    expect(auth.changePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "NewPass456!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(auth.changePassword).toHaveBeenCalledWith("Current123!", "NewPass456!"));
    expect(notify).toHaveBeenCalledWith("Password changed. Sign in again with your new password.");
    expect(onPasswordChanged).toHaveBeenCalledOnce();
  });

  it("uploads supported profile images and removes them", async () => {
    vi.mocked(profileService.getProfile)
      .mockResolvedValueOnce(profileRecord)
      .mockResolvedValueOnce({ ...profileRecord, profile_image_url: "/api/v1/profile/image?v=2" });
    const notify = vi.fn();
    render(<Profile onNotify={notify} onNameChange={vi.fn()} onPasswordChanged={vi.fn()} />);
    await screen.findByDisplayValue("Mira Store");
    const file = new File(["png"], "avatar.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Profile image file"), { target: { files: [file] } });

    await waitFor(() => expect(profileService.uploadProfileImage).toHaveBeenCalledWith(file));
    expect(await screen.findByRole("img", { name: "Mira Store profile" })).toHaveAttribute("src", "blob:profile-preview");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(profileService.removeProfileImage).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith("Profile image removed.");
  });

  it("rejects unsupported image types before upload", async () => {
    render(<Profile onNotify={vi.fn()} onNameChange={vi.fn()} onPasswordChanged={vi.fn()} />);
    await screen.findByDisplayValue("Mira Store");
    const file = new File(["svg"], "avatar.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByLabelText("Profile image file"), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PNG, JPG, JPEG, or WebP image.");
    expect(profileService.uploadProfileImage).not.toHaveBeenCalled();
  });

  it("rejects profile images over the 5 MB limit before upload", async () => {
    render(<Profile onNotify={vi.fn()} onNameChange={vi.fn()} onPasswordChanged={vi.fn()} />);
    await screen.findByDisplayValue("Mira Store");
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Profile image file"), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile images must be 5 MB or smaller.");
    expect(profileService.uploadProfileImage).not.toHaveBeenCalled();
  });
});
