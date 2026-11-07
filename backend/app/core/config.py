import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_DIR / ".env")


@dataclass(frozen=True)
class DatabaseSettings:
    host: str
    port: int
    name: str
    user: str
    password: str


def get_database_settings() -> DatabaseSettings:
    required = ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    missing = [key for key in required if not os.getenv(key)]
    if missing:
        raise RuntimeError(
            "Missing required database environment variables: "
            + ", ".join(missing)
        )

    name = os.environ["DB_NAME"]
    user = os.environ["DB_USER"]
    if name == "your_database_name" or user in {
        "your_mysql_username",
        "your_restricted_application_user",
    }:
        raise RuntimeError(
            "Replace the database name and application username in backend/.env."
        )
    if user.casefold() == "root":
        raise RuntimeError(
            "DB_USER must be a restricted, non-root MySQL application account."
        )

    try:
        port = int(os.environ["DB_PORT"])
    except ValueError as exc:
        raise RuntimeError("DB_PORT must be a valid TCP port number.") from exc
    if not 1 <= port <= 65535:
        raise RuntimeError("DB_PORT must be between 1 and 65535.")

    return DatabaseSettings(
        host=os.environ["DB_HOST"],
        port=port,
        name=name,
        user=user,
        password=os.environ["DB_PASSWORD"],
    )


def get_auth_secret() -> str:
    secret = os.getenv("AUTH_SECRET_KEY", "")
    if len(secret) < 32 or secret == "generate_a_long_random_local_signing_key":
        raise RuntimeError(
            "Set AUTH_SECRET_KEY to a randomly generated secret of at least 32 characters."
        )
    return secret


def get_frontend_origins() -> list[str]:
    configured = os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    return [origin.strip() for origin in configured.split(",") if origin.strip()]