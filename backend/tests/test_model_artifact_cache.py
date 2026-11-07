from pathlib import Path
from unittest.mock import patch

from app.services import model_artifacts


def test_model_artifacts_are_reused_and_invalidated_when_files_change(tmp_path: Path) -> None:
    artifact = tmp_path / "model.joblib"
    artifact.write_bytes(b"first")
    loaded_values: list[object] = []

    def fake_load(path: str) -> object:
        value = object()
        loaded_values.append(value)
        return value

    model_artifacts._load_model_artifact_cached.cache_clear()
    try:
        with (
            patch("app.services.model_artifacts.artifact_path", return_value=artifact),
            patch("app.services.model_artifacts.joblib.load", side_effect=fake_load),
        ):
            first = model_artifacts.load_model_artifact("demand_forecast")
            second = model_artifacts.load_model_artifact("demand_forecast")
            assert second is first
            assert len(loaded_values) == 1

            artifact.write_bytes(b"updated artifact")
            updated = model_artifacts.load_model_artifact("demand_forecast")
            assert updated is not first
            assert len(loaded_values) == 2
    finally:
        model_artifacts._load_model_artifact_cached.cache_clear()
