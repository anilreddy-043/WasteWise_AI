from app.db.session import verify_database_connection


def initialize_database_connection() -> None:
    verify_database_connection()


if __name__ == "__main__":
    initialize_database_connection()
    print("MySQL connection verified with SELECT 1.")