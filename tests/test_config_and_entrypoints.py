from app import config
from app.database import db_manager


def test_config_contract_defaults():
    assert isinstance(config.IS_SERVER, bool)
    assert isinstance(config.IS_WEB, bool)
    assert isinstance(config.DB_FILENAME, str)
    assert config.DB_FILENAME


def test_db_manager_uses_config_db_filename():
    assert db_manager.DB_PATH.endswith(config.DB_FILENAME)


def test_import_main_module_smoke():
    import main  # noqa: F401

