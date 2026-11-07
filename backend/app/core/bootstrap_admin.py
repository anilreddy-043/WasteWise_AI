from getpass import getpass

from sqlalchemy import select

from app.core.security import hash_password
from app.db.session import SessionLocal, verify_database_connection
from app.models.user import User


def main() -> None:
    verify_database_connection()
    full_name = input("Administrator full name: ").strip()
    email = input("Administrator email: ").strip().lower()
    password = getpass("Administrator password: ")
    confirmation = getpass("Confirm administrator password: ")
    if not full_name or not email:
        raise SystemExit("Full name and email are required.")
    if len(password) < 12:
        raise SystemExit("Administrator password must contain at least 12 characters.")
    if password != confirmation:
        raise SystemExit("Passwords do not match.")

    with SessionLocal.begin() as db:
        if db.scalar(select(User.user_id).where(User.role == "admin").limit(1)) is not None:
            raise SystemExit("An administrator already exists; refusing to create another bootstrap account.")
        if db.scalar(select(User.user_id).where(User.email == email)) is not None:
            raise SystemExit("That email already belongs to an account.")
        db.add(
            User(
                full_name=full_name,
                email=email,
                password_hash=hash_password(password),
                role="admin",
                approval_status="approved",
                is_active=True,
            )
        )
    print("Initial administrator created.")


if __name__ == "__main__":
    main()
