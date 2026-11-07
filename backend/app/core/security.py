import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_auth_secret
from app.db.session import get_db
from app.models.user import User
from app.models.waste import UserActivity

_bearer = HTTPBearer(auto_error=False)
_PASSWORD_N = 2**14
_PASSWORD_R = 8
_PASSWORD_P = 1
_TOKEN_TTL_SECONDS = 60 * 60
LOGIN_FAILURE_WINDOW = timedelta(minutes=15)
LOGIN_ACCOUNT_FAILURE_LIMIT = 10
LOGIN_IP_FAILURE_LIMIT = 30


@dataclass(frozen=True)
class AuthenticatedSession:
    user: User
    token_id: str


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived_key = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_PASSWORD_N,
        r=_PASSWORD_R,
        p=_PASSWORD_P,
        dklen=64,
    )
    return "scrypt${}${}${}${}${}".format(
        _PASSWORD_N,
        _PASSWORD_R,
        _PASSWORD_P,
        _encode(salt),
        _encode(derived_key),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, n, r, p, salt, expected = stored_hash.split("$")
        if (
            algorithm != "scrypt"
            or int(n) != _PASSWORD_N
            or int(r) != _PASSWORD_R
            or int(p) != _PASSWORD_P
        ):
            return False
        expected_key = _decode(expected)
        salt_bytes = _decode(salt)
        if len(expected_key) != 64 or len(salt_bytes) != 16:
            return False
        derived_key = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt_bytes,
            n=_PASSWORD_N,
            r=_PASSWORD_R,
            p=_PASSWORD_P,
            dklen=64,
        )
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        return False
    return hmac.compare_digest(derived_key, expected_key)


def create_access_token(user_id: int) -> tuple[str, str]:
    now = int(time.time())
    token_id = secrets.token_urlsafe(24)
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": str(user_id), "iat": now, "exp": now + _TOKEN_TTL_SECONDS, "jti": token_id}
    signing_input = f"{_encode_json(header)}.{_encode_json(payload)}"
    signature = hmac.new(
        get_auth_secret().encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{signing_input}.{_encode(signature)}", token_id


def _decode_access_token(token: str) -> tuple[int, str]:
    try:
        encoded_header, encoded_payload, encoded_signature = token.split(".")
        signing_input = f"{encoded_header}.{encoded_payload}"
        expected_signature = hmac.new(
            get_auth_secret().encode("utf-8"),
            signing_input.encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(expected_signature, _decode(encoded_signature)):
            raise ValueError("Invalid token signature.")

        header: dict[str, Any] = json.loads(_decode(encoded_header))
        payload: dict[str, Any] = json.loads(_decode(encoded_payload))
        user_id = int(payload["sub"])
        token_id = payload["jti"]
        issued_at = int(payload["iat"])
        expires_at = int(payload["exp"])
        if (
            header.get("alg") != "HS256"
            or user_id < 1
            or not isinstance(token_id, str)
            or not token_id
            or issued_at > int(time.time()) + 60
            or expires_at <= int(time.time())
        ):
            raise ValueError("Invalid or expired token.")
        return user_id, token_id
    except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def get_current_session(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> AuthenticatedSession:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_id, token_id = _decode_access_token(credentials.credentials)
    user = db.scalar(select(User).where(User.user_id == user_id))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is no longer available.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is inactive. Contact an administrator.",
        )
    revoked = db.scalar(
        select(UserActivity.activity_id)
        .where(
            UserActivity.user_id == user_id,
            UserActivity.action == "session_revoked",
            UserActivity.entity_type == "auth_session",
            UserActivity.details["jti"].as_string() == token_id,
        )
        .limit(1)
    )
    if revoked is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This session has ended. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return AuthenticatedSession(user=user, token_id=token_id)


def get_current_user(session: AuthenticatedSession = Depends(get_current_session)) -> User:
    return session.user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required.")
    return user


def require_roles(*allowed_roles: str):
    def role_dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your role cannot perform this action.")
        return user

    return role_dependency


def _login_key(value: str) -> str:
    return hmac.new(
        get_auth_secret().encode("utf-8"),
        value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _login_failure_stats(db: Session, field: str, key: str, since: datetime) -> tuple[int, datetime | None]:
    count, oldest = db.execute(
        select(func.count(UserActivity.activity_id), func.min(UserActivity.created_at)).where(
            UserActivity.action == "auth_login_failed",
            UserActivity.created_at >= since,
            UserActivity.details[field].as_string() == key,
        )
    ).one()
    return int(count), oldest


def check_login_rate_limit(db: Session, email: str, client_ip: str | None) -> int | None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    since = now - LOGIN_FAILURE_WINDOW
    principal_key = _login_key(f"account:{email.casefold()}")
    ip_key = _login_key(f"ip:{client_ip or 'unknown'}")
    limited_attempts: list[datetime] = []
    for field, key, limit in (
        ("principal_key", principal_key, LOGIN_ACCOUNT_FAILURE_LIMIT),
        ("ip_key", ip_key, LOGIN_IP_FAILURE_LIMIT),
    ):
        count, oldest = _login_failure_stats(db, field, key, since)
        if count >= limit and oldest is not None:
            limited_attempts.append(oldest)
    if not limited_attempts:
        return None
    retry_after = max(
        1,
        int(max(oldest + LOGIN_FAILURE_WINDOW for oldest in limited_attempts).timestamp() - now.timestamp()),
    )
    return retry_after


def record_login_failure(db: Session, email: str, client_ip: str | None, user_id: int | None) -> None:
    db.add(
        UserActivity(
            user_id=user_id,
            action="auth_login_failed",
            entity_type="auth_attempt",
            details={
                "principal_key": _login_key(f"account:{email.casefold()}"),
                "ip_key": _login_key(f"ip:{client_ip or 'unknown'}"),
            },
        )
    )


def revoke_user_sessions(db: Session, user_id: int, actor_user_id: int, reason: str) -> int:
    issued_sessions = db.scalars(
        select(UserActivity.details).where(
            UserActivity.user_id == user_id,
            UserActivity.action == "session_started",
            UserActivity.entity_type == "auth_session",
        )
    ).all()
    revoked_ids = set(
        db.scalars(
            select(UserActivity.details["jti"].as_string()).where(
                UserActivity.user_id == user_id,
                UserActivity.action == "session_revoked",
                UserActivity.entity_type == "auth_session",
            )
        ).all()
    )
    revoked_count = 0
    for details in issued_sessions:
        token_id = details.get("jti") if isinstance(details, dict) else None
        if not isinstance(token_id, str) or token_id in revoked_ids:
            continue
        db.add(
            UserActivity(
                user_id=user_id,
                action="session_revoked",
                entity_type="auth_session",
                details={"jti": token_id, "reason": reason, "revoked_by": actor_user_id},
            )
        )
        revoked_count += 1
    return revoked_count


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _encode_json(value: dict[str, Any]) -> str:
    return _encode(json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8"))