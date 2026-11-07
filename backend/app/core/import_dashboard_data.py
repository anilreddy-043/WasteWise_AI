import logging

from app.db.session import SessionLocal
from app.services.dashboard_import_service import import_dashboard_csvs
from ml.src.train_all import maybe_train_all

logger = logging.getLogger(__name__)


def main() -> None:
    with SessionLocal() as session:
        try:
            runs = import_dashboard_csvs(session)
            session.commit()
        except Exception:
            session.rollback()
            logger.exception("Dashboard dataset import failed; the transaction was rolled back.")
            raise
    for run in runs:
        print(
            f"{run.source_file}: seen={run.rows_seen}, inserted={run.rows_inserted}, "
            f"skipped={run.rows_skipped}, sha256={run.source_sha256}"
        )
    results = maybe_train_all()
    if results is None:
        logger.info("ML training skipped because the validated training datasets are unchanged.")
    else:
        for model_name, metrics in results.items():
            logger.info(
                "%s candidate %s: %s",
                model_name,
                metrics["model_version"],
                metrics["promotion_status"],
            )


if __name__ == "__main__":
    main()