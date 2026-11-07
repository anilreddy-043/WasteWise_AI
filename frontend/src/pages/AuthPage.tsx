import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  BarChart3,
  Eye,
  EyeOff,
  Leaf,
  LockKeyhole,
  Mail,
  Recycle,
  UserRound,
  UsersRound,
} from "lucide-react";
import { clearAccessToken, getCurrentUser, registerAccount, setAccessToken, signIn } from "../services/auth";
import type { AuthenticatedUser } from "../services/auth";

type AuthPageProps = {
  onAuthenticated: (user: AuthenticatedUser) => void;
};

type RegistrationRole = "Store Manager" | "Staff" | "Viewer";

export function StoreIllustration() {
  return (
    <svg className="auth-store-illustration" viewBox="0 0 760 390" role="img" aria-label="Green grocery store surrounded by plants">
      <defs>
        <linearGradient id="auth-sky" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#b9f1d0" /><stop offset="1" stopColor="#e9ffe8" /></linearGradient>
        <linearGradient id="auth-shop" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#fff8d7" /><stop offset="1" stopColor="#e3f3c8" /></linearGradient>
        <linearGradient id="auth-green" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#14b56d" /><stop offset="1" stopColor="#00663d" /></linearGradient>
      </defs>
      <path d="M0 0h760v390H0z" fill="url(#auth-sky)" />
      <path d="M0 120 135 75l83 54 100-83 126 86 99-63 96 53 121-64v188H0z" fill="#b3e8b3" />
      <path d="M0 165 125 112l110 55 95-58 108 62 92-47 106 53 124-56v142H0z" fill="#79ce86" />
      <g fill="#8fc8df" opacity=".8">
        <path d="M495 123h40v111h-40zM542 99h48v135h-48zM596 137h36v97h-36zM638 109h56v125h-56z" />
        <path d="M502 139h8v9h-8zm18 0h8v9h-8zm30-22h9v10h-9zm18 0h9v10h-9zm18 0h9v10h-9zm-41 28h9v10h-9zm18 0h9v10h-9zm18 0h9v10h-9zM603 153h8v9h-8zm16 0h8v9h-8zm28-25h10v10h-10zm20 0h10v10h-10zm-20 23h10v10h-10zm20 0h10v10h-10z" />
      </g>
      <g fill="#fff" opacity=".95">
        <path d="M476 119c-15 0-23-8-23-18 0-11 9-20 20-20 5-18 21-30 39-30 19 0 35 13 39 31 13 1 23 10 23 21 0 10-9 16-22 16z" />
        <path d="M550 213c-18 0-28-9-28-21 0-13 11-24 24-24 6-21 25-35 47-35 22 0 41 15 46 37 15 1 27 12 27 25 0 12-10 18-25 18z" />
      </g>
      <g opacity=".95">
        <path d="M80 160h340v183H80z" fill="url(#auth-shop)" stroke="#087548" strokeWidth="5" />
        <path d="M68 151h364l-25-47H94z" fill="#f3fff0" stroke="#087548" strokeWidth="5" />
        <path d="M94 105h338v52H94z" fill="#078a50" />
        <path d="M94 105h48l13 52h-48zm96 0h48l13 52h-48zm96 0h48l13 52h-48zm96 0h38v52h-25z" fill="#fff" />
        <path d="M93 158h338v17H93z" fill="#f4fff0" stroke="#087548" strokeWidth="4" />
        <path d="M108 68h284v38H108z" fill="#006b43" />
        <text x="250" y="95" textAnchor="middle" fill="#fff" fontSize="24" fontWeight="800" fontFamily="Arial, sans-serif">SUPERMARKET</text>
        <path d="M118 192h96v116h-96zM227 192h75v116h-75zM316 192h90v116h-90z" fill="#b9e6d2" stroke="#0a8150" strokeWidth="5" />
        <path d="M165 192v116m101-116v116m96-116v116" stroke="#0a8150" strokeWidth="4" />
        <path d="M170 226v34m96-34v34m95-34v34" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
        <path d="M118 279h96v29h-96zm109 0h75v29h-75zm89 0h90v29h-90z" fill="#fff1bc" />
        <g fill="#eaa72e"><circle cx="130" cy="279" r="8"/><circle cx="151" cy="277" r="9"/><circle cx="185" cy="280" r="8"/><circle cx="238" cy="280" r="8"/><circle cx="258" cy="278" r="9"/><circle cx="332" cy="279" r="8"/><circle cx="357" cy="278" r="9"/><circle cx="387" cy="280" r="8"/></g>
        <g fill="#e65342"><circle cx="139" cy="291" r="8"/><circle cx="173" cy="292" r="9"/><circle cx="247" cy="293" r="8"/><circle cx="281" cy="291" r="9"/><circle cx="341" cy="293" r="8"/><circle cx="376" cy="291" r="9"/></g>
        <path d="M65 336h377v18H65z" fill="#c49b58" />
      </g>
      <g>
        <path d="M17 337h89l-8 39H27z" fill="#087849" stroke="#064f37" strokeWidth="4" />
        <path d="M43 353h39" stroke="#d7f6df" strokeWidth="7" />
        <path d="M62 348l-12 17h9l-5 9 19-20h-10l7-6z" fill="#fff" />
      </g>
      <g>
        <path d="M-5 325h58v65H-5zm423 2h60v63h-60z" fill="#0b8d4e" />
        <path d="M15 325c-3-34 2-61 16-79m-30 56c15-19 29-19 39-8m-31-24c12-12 24-13 36-4m375 59c3-35-1-63-16-83m39 60c-13-20-26-21-38-11m30-26c-12-13-24-14-36-5" fill="none" stroke="#087648" strokeWidth="7" strokeLinecap="round" />
        <g fill="#27ae63"><ellipse cx="9" cy="276" rx="18" ry="8" transform="rotate(-35 9 276)"/><ellipse cx="39" cy="267" rx="18" ry="8" transform="rotate(32 39 267)"/><ellipse cx="2" cy="300" rx="18" ry="8" transform="rotate(25 2 300)"/><ellipse cx="36" cy="294" rx="18" ry="8" transform="rotate(-27 36 294)"/><ellipse cx="445" cy="269" rx="18" ry="8" transform="rotate(35 445 269)"/><ellipse cx="471" cy="284" rx="18" ry="8" transform="rotate(-30 471 284)"/><ellipse cx="440" cy="307" rx="18" ry="8" transform="rotate(-20 440 307)"/><ellipse cx="471" cy="316" rx="18" ry="8" transform="rotate(22 471 316)"/></g>
      </g>
      <path d="M0 374h760v16H0z" fill="#77b85f" />
    </svg>
  );
}

function PasswordInput({ label, value, onChange, visible, onToggle, placeholder, name, autoComplete = "new-password" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  placeholder: string;
  name: string;
  autoComplete?: string;
}) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-input-wrap">
        <LockKeyhole size={16} />
        <input required name={name} type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete={autoComplete} />
        <button type="button" className="auth-password-toggle" aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} onClick={onToggle}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      </div>
    </label>
  );
}

export default function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<"register" | "signin">(
    window.location.pathname === "/signin" ? "signin" : "register",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<RegistrationRole | "">("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"error" | "info">("info");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    document.title = `${mode === "register" ? "Create Account" : "Sign In"} | WasteWise AI`;
  }, [mode]);

  useEffect(() => {
    function syncModeWithPath() {
      setMode(window.location.pathname === "/signin" ? "signin" : "register");
    }

    window.addEventListener("popstate", syncModeWithPath);
    return () => window.removeEventListener("popstate", syncModeWithPath);
  }, []);

  function showMessage(text: string, type: "error" | "info" = "error") {
    setMessage(text);
    setMessageType(type);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!event.currentTarget.reportValidity()) return;
    let registrationPayload: {
      full_name: string;
      email: string;
      password: string;
      role: RegistrationRole;
      accepted_terms: boolean;
    } | null = null;
    if (mode === "register") {
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        showMessage("Use at least 8 characters with a letter, a number, and a special character.");
        return;
      }
      if (password !== confirmPassword) {
        showMessage("Your passwords do not match.");
        return;
      }
      if (role !== "Store Manager" && role !== "Staff" && role !== "Viewer") {
        showMessage("Select a role to continue.");
        return;
      }
      if (!acceptedTerms) {
        showMessage("Please agree to the Terms of Service and Privacy Policy.");
        return;
      }
      registrationPayload = {
        full_name: name.trim(),
        email: email.trim(),
        password,
        role,
        accepted_terms: acceptedTerms,
      };
    }
    setIsSubmitting(true);
    try {
      if (registrationPayload) {
        const result = await registerAccount(registrationPayload);
        showMessage(result.message, "info");
      } else {
        const result = await signIn({ email: email.trim(), password });
        setAccessToken(result.access_token, result.expires_in);
        try {
          onAuthenticated(await getCurrentUser());
        } catch (error) {
          clearAccessToken();
          throw error;
        }
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "The authentication request failed.", "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  function changeMode(next: "register" | "signin") {
    const path = next === "register" ? "/signup" : "/signin";
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    setMode(next);
    setMessage("");
  }

  return (
    <main className="auth-screen">
      <div className="auth-frame">
        <section className="auth-story">
          <div className="auth-brand">
            <span className="auth-brand-mark"><Leaf size={45} fill="white" /></span>
            <div><b>WasteWise <i>AI</i></b><small>Smart Inventory&nbsp; · &nbsp;Less Waste&nbsp; · &nbsp;A Greener Tomorrow</small></div>
          </div>
          <div className="auth-story-copy">
            <h1>Reduce Food Waste<br />Build a <span>Sustainable<br />Tomorrow</span></h1>
            <p>AI-powered inventory management<br className="auth-desktop-break" /> for smarter stores and a healthier planet.</p>
            <ul>
              <li><span><BarChart3 size={24} /></span><div><b>Smart Predictions</b><small>Forecast demand and reduce waste</small></div></li>
              <li><span><Leaf size={24} fill="white" /></span><div><b>Better Inventory</b><small>Track expiry and manage stock</small></div></li>
              <li><span><Recycle size={25} /></span><div><b>Greener Tomorrow</b><small>Less food waste, healthier communities</small></div></li>
            </ul>
          </div>
          <div className="auth-art"><StoreIllustration /></div>
          <div className="auth-floating-leaf auth-floating-leaf-one">🌿</div>
          <div className="auth-floating-leaf auth-floating-leaf-two">🍃</div>
        </section>

        <section className="auth-form-side">
          <div className={`auth-form-card ${mode === "signin" ? "auth-signin-card" : ""}`}>
            <div className="auth-mode-switch">{mode === "register" ? "Already have an account?" : "New to WasteWise AI?"} <button type="button" onClick={() => changeMode(mode === "register" ? "signin" : "register")}>{mode === "register" ? "Sign In" : "Sign Up"}</button></div>
            <header className="auth-form-heading"><h2>{mode === "register" ? "Create Your Account" : "Welcome Back"}</h2><p>{mode === "register" ? "Join WasteWise AI and start managing smarter" : "Sign in to your WasteWise AI account"}</p></header>
            <form onSubmit={submit} noValidate>
              {mode === "register" ? (
                <>
                  <div className="auth-fields-grid">
                    <label className="auth-field"><span>Full Name</span><div className="auth-input-wrap"><UserRound size={16} /><input required name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter your full name" /></div></label>
                    <label className="auth-field"><span>Email Address</span><div className="auth-input-wrap"><Mail size={16} /><input required name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email" /></div></label>
                    <PasswordInput label="Password" name="password" value={password} onChange={setPassword} visible={passwordVisible} onToggle={() => setPasswordVisible((value) => !value)} placeholder="Create a password" />
                    <PasswordInput label="Confirm Password" name="confirm-password" value={confirmPassword} onChange={setConfirmPassword} visible={confirmVisible} onToggle={() => setConfirmVisible((value) => !value)} placeholder="Confirm your password" />
                  </div>
                  <p className="auth-password-hint">Use at least 8 characters with letters,<br className="auth-hint-break" /> numbers and a special character</p>
                  <label className="auth-field auth-role-field"><span>Role</span><div className="auth-input-wrap auth-select-wrap"><UsersRound size={16} /><select required aria-label="Select your role" value={role} onChange={(event) => { const selectedRole = event.target.value; if (selectedRole === "Store Manager" || selectedRole === "Staff" || selectedRole === "Viewer") setRole(selectedRole); }}><option value="" disabled>Select your role</option><option>Store Manager</option><option>Staff</option><option>Viewer</option></select><span className="auth-select-chevron">⌄</span></div></label>
                  <label className="auth-terms"><input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} /><span>I agree to the <a href="#terms" onClick={(event) => { event.preventDefault(); showMessage("Terms of Service will be available when authentication is configured.", "info"); }}>Terms of Service</a> and <a href="#privacy" onClick={(event) => { event.preventDefault(); showMessage("Privacy Policy will be available when authentication is configured.", "info"); }}>Privacy Policy</a></span></label>
                </>
              ) : (
                <div className="auth-fields-grid auth-signin-fields">
                  <label className="auth-field"><span>Email Address</span><div className="auth-input-wrap"><Mail size={16} /><input required type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email" /></div></label>
                  <PasswordInput label="Password" name="password" value={password} onChange={setPassword} visible={passwordVisible} onToggle={() => setPasswordVisible((value) => !value)} placeholder="Enter your password" autoComplete="current-password" />
                  <div className="auth-signin-options">
                    <span className="auth-session-note">Sessions expire after 60 minutes.</span>
                    <button type="button" className="auth-forgot-link" onClick={() => showMessage("Password recovery will be available when authentication is configured.", "info")}>Forgot password?</button>
                  </div>
                </div>
              )}
              {message && <div className={`auth-form-message ${messageType}`} role="alert">{message}</div>}
              <button type="submit" className="auth-submit" disabled={isSubmitting}>{isSubmitting ? "Please wait..." : mode === "register" ? "Create Account" : "Sign In"} {!isSubmitting && <ArrowRight size={17} />}</button>
            </form>
            <div className="auth-or"><span />OR<span /></div>
            <button type="button" className="auth-google-button" onClick={() => showMessage("Google sign-in is not configured yet.", "info")}><svg className="google-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.7c3.9-3.6 6-8.8 6-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.7-5.1c-1.8 1.2-4 1.9-6.8 1.9-5.2 0-9.6-3.5-11.2-8.2H5.9v5.2A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.8 27.7a12 12 0 0 1 0-7.4v-5.2H5.9a20 20 0 0 0 0 17.8l6.9-5.2Z"/><path fill="#EA4335" d="M24 12.1c3 0 5.7 1 7.8 3.1l5.8-5.8A19.4 19.4 0 0 0 24 4 20 20 0 0 0 5.9 15.1l6.9 5.2c1.6-4.7 6-8.2 11.2-8.2Z"/></svg>Continue with Google</button>
          </div>
        </section>
      </div>
    </main>
  );
}
