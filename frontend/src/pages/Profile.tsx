import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Camera, Check, KeyRound, Save, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { changePassword } from "../services/auth";
import { formatAppDate } from "../services/generalSettings";
import {
  getProfile,
  loadProfileImage,
  removeProfileImage,
  updateProfile,
  uploadProfileImage,
} from "../services/profile";
import type { UserProfile } from "../services/profile";

const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type ProfileProps = {
  onNotify: (message: string) => void;
  onNameChange: (fullName: string) => void;
  onPasswordChanged: () => void;
};

function initials(fullName: string): string {
  return fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function accountStatus(profile: UserProfile): string {
  if (!profile.is_active) return "Inactive";
  if (profile.approval_status !== "approved") {
    return profile.approval_status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return "Active";
}

export default function Profile({ onNotify, onNameChange, onPasswordChanged }: ProfileProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [fullName, setFullName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isSavingImage, setIsSavingImage] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setIsLoading(true);
    getProfile()
      .then(async (record) => {
        if (!active) return;
        setProfile(record);
        setFullName(record.full_name);
        if (!record.profile_image_url) {
          setImagePreview("");
          return;
        }
        try {
          const image = await loadProfileImage();
          if (active) {
            objectUrl = URL.createObjectURL(image);
            setImagePreview(objectUrl);
          }
        } catch (loadError) {
          if (active) {
            const message = loadError instanceof Error ? loadError.message : "The profile image could not be loaded.";
            setImageError(message);
            onNotify(message);
          }
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          const message = loadError instanceof Error ? loadError.message : "Your profile could not be loaded.";
          setError(message);
          onNotify(message);
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [onNotify]);

  useEffect(() => () => {
    if (imagePreview.startsWith("blob:")) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  async function handleSaveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = fullName.trim();
    if (!trimmedName) {
      setError("Enter your full name.");
      return;
    }
    setIsSavingName(true);
    setError("");
    try {
      const savedProfile = await updateProfile(trimmedName);
      setProfile(savedProfile);
      setFullName(savedProfile.full_name);
      onNameChange(savedProfile.full_name);
      onNotify("Profile details saved.");
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Your profile could not be updated.";
      setError(message);
      onNotify(message);
    } finally {
      setIsSavingName(false);
    }
  }

  async function handleImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!PROFILE_IMAGE_TYPES.has(file.type)) {
      const message = "Choose a PNG, JPG, JPEG, or WebP image.";
      setImageError(message);
      onNotify(message);
      return;
    }
    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      const message = "Profile images must be 5 MB or smaller.";
      setImageError(message);
      onNotify(message);
      return;
    }

    setIsSavingImage(true);
    setImageError("");
    try {
      await uploadProfileImage(file);
      const refreshedProfile = await getProfile();
      setProfile(refreshedProfile);
      const image = await loadProfileImage();
      setImagePreview(URL.createObjectURL(image));
      onNotify("Profile image updated.");
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "The profile image could not be uploaded.";
      setImageError(message);
      onNotify(message);
    } finally {
      setIsSavingImage(false);
    }
  }

  async function handleRemoveImage() {
    setIsSavingImage(true);
    setImageError("");
    try {
      await removeProfileImage();
      setImagePreview("");
      setProfile((current) => current ? { ...current, profile_image_url: null } : current);
      onNotify("Profile image removed.");
    } catch (removeError) {
      const message = removeError instanceof Error ? removeError.message : "The profile image could not be removed.";
      setImageError(message);
      onNotify(message);
    } finally {
      setIsSavingImage(false);
    }
  }

  async function handleChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      setError("Use at least 8 characters with a letter, a number, and a special character.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation do not match.");
      return;
    }

    setIsChangingPassword(true);
    setError("");
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onNotify("Password changed. Sign in again with your new password.");
      onPasswordChanged();
    } catch (passwordError) {
      const message = passwordError instanceof Error ? passwordError.message : "Your password could not be changed.";
      setError(message);
      onNotify(message);
    } finally {
      setIsChangingPassword(false);
    }
  }

  return (
    <div className="profile-page">
      <section className="page-banner profile-banner">
        <div className="banner-copy">
          <span className="eyebrow">ACCOUNT MANAGEMENT</span>
          <h1>My Profile</h1>
          <p>Manage your personal information and account security</p>
        </div>
        <div className="profile-banner-icon" aria-hidden="true"><UserRound size={52} /></div>
      </section>

      {error && <p className="profile-error" role="alert">{error}</p>}
      {isLoading ? <p className="profile-loading" role="status">Loading your profile…</p> : profile && <>
        <section className="profile-card profile-identity-card">
          <div className="profile-photo-wrap">
            <div className="profile-photo" aria-label="Profile image">
              {imagePreview ? <img src={imagePreview} alt={`${profile.full_name} profile`} /> : <span>{initials(profile.full_name)}</span>}
            </div>
            <div className="profile-photo-actions">
              <button type="button" className="profile-secondary-button" onClick={() => fileInput.current?.click()} disabled={isSavingImage}>
                <Camera size={16} /> {isSavingImage ? "Saving…" : "Change photo"}
              </button>
              {profile.profile_image_url && <button type="button" className="profile-remove-button" onClick={() => void handleRemoveImage()} disabled={isSavingImage}>
                <Trash2 size={15} /> Remove
              </button>}
              <input ref={fileInput} className="profile-file-input" type="file" aria-label="Profile image file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleImageSelection(event)} />
              <small>PNG, JPG, JPEG, or WebP · Max 5 MB</small>
              {imageError && <span className="profile-error" role="alert">{imageError}</span>}
            </div>
          </div>
          <div className="profile-card-heading">
            <span className="profile-card-icon"><UserRound size={19} /></span>
            <div><h2>Personal information</h2><p>Update your name and review your account details.</p></div>
          </div>
          <form className="profile-form" onSubmit={(event) => void handleSaveName(event)}>
            <label className="profile-field"><span>Full name</span><input value={fullName} maxLength={120} required onChange={(event) => setFullName(event.target.value)} /></label>
            <label className="profile-field"><span>Email address</span><input value={profile.email} readOnly aria-readonly="true" /><small>Email changes require a verified account recovery process.</small></label>
            <label className="profile-field"><span>Role</span><input value={profile.role.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} readOnly aria-readonly="true" /></label>
            <label className="profile-field"><span>Account status</span><input value={accountStatus(profile)} readOnly aria-readonly="true" /></label>
            <label className="profile-field"><span>Account created</span><input value={formatAppDate(profile.created_at)} readOnly aria-readonly="true" /></label>
            <div className="profile-form-actions"><button type="submit" className="profile-primary-button" disabled={isSavingName || !fullName.trim()}><Save size={16} /> {isSavingName ? "Saving…" : "Save profile"}</button></div>
          </form>
        </section>

        <section className="profile-card profile-security-card">
          <div className="profile-card-heading">
            <span className="profile-card-icon"><ShieldCheck size={19} /></span>
            <div><h2>Password & security</h2><p>Confirm your current password before choosing a new one.</p></div>
          </div>
          <form className="profile-form profile-password-form" onSubmit={(event) => void handleChangePassword(event)}>
            <label className="profile-field"><span>Current password</span><input aria-label="Current password" type="password" autoComplete="current-password" value={currentPassword} required onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label className="profile-field"><span>New password</span><input aria-label="New password" type="password" autoComplete="new-password" minLength={8} value={newPassword} required onChange={(event) => setNewPassword(event.target.value)} /><small>At least 8 characters, including a letter, number, and special character.</small></label>
            <label className="profile-field"><span>Confirm new password</span><input aria-label="Confirm new password" type="password" autoComplete="new-password" value={confirmPassword} required onChange={(event) => setConfirmPassword(event.target.value)} /></label>
            <div className="profile-form-actions"><button type="submit" className="profile-primary-button" disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}><KeyRound size={16} /> {isChangingPassword ? "Changing…" : "Change password"}</button></div>
          </form>
          <p className="profile-security-note"><Check size={15} /> Changing your password ends active sessions. You’ll need to sign in again.</p>
        </section>
      </>}
    </div>
  );
}
