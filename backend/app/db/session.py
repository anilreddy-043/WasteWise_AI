import logging
from collections.abc import Generator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.engine import URL

from app.core.config import get_database_settings

logger = logging.getLogger(__name__)
settings = get_database_settings()

DATABASE_URL = URL.create(
    drivername="mysql+pymysql",
    username=settings.user,
    password=settings.password,
    host=settings.host,
    port=settings.port,
    database=settings.name,
    query={"charset": "utf8mb4"},
)

engine: Engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=1800,
    connect_args={"connect_timeout": 5},
)
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    expire_on_commit=False,
)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def verify_database_connection() -> None:
    try:
        with engine.connect() as connection:
            result = connection.execute(text("SELECT 1")).scalar_one()
            if result != 1:
                raise RuntimeError("Database connectivity check returned an unexpected result.")
    except SQLAlchemyError as exc:
        logger.error(
            "MySQL connectivity check failed for host %s, port %s, database %s (%s).",
            settings.host,
            settings.port,
            settings.name,
            exc.__class__.__name__,
        )
        raise RuntimeError(
            "Unable to connect to the configured MySQL database. "
            "Check the local database service, database name, restricted account, "
            "password, and grants."
        ) from exc