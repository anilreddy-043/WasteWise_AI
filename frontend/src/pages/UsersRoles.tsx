import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, Search, UserRoundX, Users } from "lucide-react";
import {
  listManagedUsers,
  updateUserActive,
  updateUserRole,
} from "../services/auth";
import type { ManagedUser } from "../services/auth";

type UserFilter = "All Status" | "Active" | "Inactive";

const roleLabels: Record<ManagedUser["role"], string> = {
  admin: "Admin",
  store_manager: "Store Manager",
  staff: "Staff",
  viewer: "Viewer",
};

export default function UsersRoles({ onNotify }: { onNotify: (message: string) => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserFilter>("All Status");
  const [isLoading, setIsLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function loadUsers() {
    setIsLoading(true);
    setError("");
    try {
      setUsers(await listManagedUsers());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load users.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users.filter((user) => {
      const matchesSearch =
        !term || `${user.full_name} ${user.email} ${roleLabels[user.role]}`.toLowerCase().includes(term);
      const matchesFilter =
        filter === "All Status" ||
        (filter === "Active" ? user.is_active : !user.is_active);
      return matchesSearch && matchesFilter;
    });
  }, [filter, query, users]);

  async function setActive(user: ManagedUser) {
    setBusyUserId(user.user_id);
    setError("");
    try {
      await updateUserActive(user.user_id, !user.is_active);
      await loadUsers();
      onNotify(user.is_active ? "User deactivated" : "User activated");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update user access.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function setRole(user: ManagedUser, role: ManagedUser["role"]) {
    if (user.role === role) return;
    setBusyUserId(user.user_id);
    setError("");
    try {
      await updateUserRole(user.user_id, role);
      await loadUsers();
      onNotify(`${user.full_name}'s role updated to ${roleLabels[role]}.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update the user's role.");
    } finally {
      setBusyUserId(null);
    }
  }

  const activeCount = users.filter((user) => user.is_active).length;
  const inactiveCount = users.filter((user) => !user.is_active).length;

  return (
    <div className="users-roles-page">
      <section className="users-roles-banner">
        <div>
          <h1>Users &amp; Roles</h1>
          <p>Manage account access</p>
        </div>
      </section>

      <section className="users-summary" aria-label="User summary">
        <article className="users-summary-card">
          <div className="users-summary-icon blue"><Users size={28} /></div>
          <div><span>Total Users</span><strong>{users.length}</strong><small>Application accounts</small></div>
        </article>
        <article className="users-summary-card">
          <div className="users-summary-icon red"><UserRoundX size={28} /></div>
          <div><span>Active Accounts</span><strong>{activeCount}</strong><small>Can sign in</small></div>
        </article>
        <article className="users-summary-card">
          <div className="users-summary-icon purple"><Users size={28} /></div>
          <div><span>Inactive</span><strong>{inactiveCount}</strong><small>Sign-in disabled</small></div>
        </article>
      </section>

      <section className="users-list-panel">
        <div className="users-toolbar">
          <label className="users-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, email, or role..."
              aria-label="Search users"
            />
          </label>
          <label className="users-filter">
            <select aria-label="Filter by account status" value={filter} onChange={(event) => setFilter(event.target.value as UserFilter)}>
              {(["All Status", "Active", "Inactive"] as const).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button type="button" className="users-add-button" onClick={() => void loadUsers()} disabled={isLoading}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>

        {error && <p className="auth-form-message error" role="alert">{error}</p>}

        <div className="users-table-scroll">
          <table className="users-table">
            <thead>
              <tr><th>User</th><th>Email</th><th>Role</th><th>Access</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td className="users-empty-state" colSpan={5}>Loading users...</td></tr>
              ) : filteredUsers.length === 0 ? (
                <tr><td className="users-empty-state" colSpan={5}>No users match this filter.</td></tr>
              ) : filteredUsers.map((user) => {
                const busy = busyUserId === user.user_id;
                return (
                  <tr key={user.user_id}>
                    <td><b>{user.full_name}</b></td>
                    <td>{user.email}</td>
                    <td>
                      <select
                        aria-label={`Role for ${user.full_name}`}
                        value={user.role}
                        disabled={busy}
                        onChange={(event) => void setRole(user, event.target.value as ManagedUser["role"])}
                      >
                        {(Object.keys(roleLabels) as ManagedUser["role"][]).map((role) => (
                          <option key={role} value={role}>{roleLabels[role]}</option>
                        ))}
                      </select>
                    </td>
                    <td><span className={`user-status-pill ${user.is_active ? "active" : "inactive"}`}><i />{user.is_active ? "Active" : "Inactive"}</span></td>
                    <td>
                      <div className="user-row-actions">
                        <button
                          type="button"
                          title={user.is_active ? "Deactivate account" : "Activate account"}
                          aria-label={`${user.is_active ? "Deactivate" : "Activate"} ${user.full_name}`}
                          disabled={busy}
                          onClick={() => void setActive(user)}
                        >
                          {user.is_active ? <UserRoundX size={14} /> : <Check size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="users-table-footer">
          <span>{filteredUsers.length} of {users.length} accounts</span>
          <span>Only administrators can change account access.</span>
        </footer>
      </section>
    </div>
  );
}
