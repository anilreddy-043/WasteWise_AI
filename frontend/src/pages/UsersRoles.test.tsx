import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UsersRoles from "./UsersRoles";
import * as auth from "../services/auth";

vi.mock("../services/auth", () => ({
  listManagedUsers: vi.fn(),
  updateUserActive: vi.fn(),
  updateUserRole: vi.fn(),
}));

const users: auth.ManagedUser[] = [
  {
    user_id: 1,
    full_name: "Administrator",
    email: "admin@example.com",
    role: "admin",
    is_active: true,
    created_at: "2026-01-01T00:00:00",
  },
  {
    user_id: 2,
    full_name: "Store Manager",
    email: "manager@example.com",
    role: "store_manager",
    is_active: true,
    created_at: "2026-01-02T00:00:00",
  },
];

describe("UsersRoles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.listManagedUsers).mockResolvedValue(users);
    vi.mocked(auth.updateUserRole).mockResolvedValue();
  });

  it("allows an administrator to select and save an existing account role", async () => {
    const onNotify = vi.fn();
    render(<UsersRoles onNotify={onNotify} />);

    const roleSelector = await screen.findByRole("combobox", { name: "Role for Store Manager" });
    fireEvent.change(roleSelector, { target: { value: "viewer" } });

    await waitFor(() => {
      expect(auth.updateUserRole).toHaveBeenCalledWith(2, "viewer");
    });
    expect(onNotify).toHaveBeenCalledWith("Store Manager's role updated to Viewer.");
  });

  it("shows backend role-change safeguards as actionable errors", async () => {
    vi.mocked(auth.updateUserRole).mockRejectedValueOnce(new Error("The last active administrator cannot be demoted."));
    render(<UsersRoles onNotify={vi.fn()} />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Role for Administrator" }), {
      target: { value: "viewer" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("The last active administrator cannot be demoted.");
  });
});
