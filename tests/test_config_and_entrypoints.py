from app import config


def test_config_contract_defaults():
    assert isinstance(config.IS_SERVER, bool)
    assert isinstance(config.IS_WEB, bool)
    assert isinstance(config.DATA_BACKEND, str)
    assert config.DATA_BACKEND in {"auto", "supabase", "local"}
    assert isinstance(config.USE_SUPABASE, bool)
    assert isinstance(config.LOCAL_JSON_DB, str)
    assert config.LOCAL_JSON_DB.endswith("pos_data.json")


def test_import_main_module_smoke():
    import main  # noqa: F401
