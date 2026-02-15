# app/database/db_manager.py
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import os
import sys
from contextlib import contextmanager

from app.config import DB_FILENAME

# Default database URL
DB_FILENAME = DB_FILENAME

def get_base_dir():
    if getattr(sys, 'frozen', False):
        # Running as a bundled EXE
        return os.path.dirname(sys.executable)
    # Running from source
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE_DIR = get_base_dir()
DB_PATH = os.path.join(BASE_DIR, DB_FILENAME)
DEFAULT_DB_URL = f'sqlite:///{DB_PATH}'

def get_engine(db_url=DEFAULT_DB_URL):
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    return engine

from app.database.models import Setting

# create a Session factory (can be reused)
_SessionFactory = None

def get_session_factory(engine=None):
    global _SessionFactory
    if _SessionFactory is None:
        if engine is None:
            engine = get_engine()
        _SessionFactory = sessionmaker(bind=engine)
    return _SessionFactory

@contextmanager
def session_scope(engine=None):
    """Provide a transactional scope around a series of operations."""
    Session = get_session_factory(engine)
    session = Session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

# Compatibility helper
def get_session(engine=None):
    Session = get_session_factory(engine)
    return Session()

def get_setting(session, key, default=None):
    setting = session.query(Setting).filter_by(key=key).first()
    return setting.value if setting else default

def set_setting(session, key, value):
    setting = session.query(Setting).filter_by(key=key).first()
    if setting:
        setting.value = value
    else:
        setting = Setting(key=key, value=value)
        session.add(setting)
    session.commit()

def get_next_invoice_no(session):
    from app.database.models import Sale
    from sqlalchemy import func
    max_id = session.query(func.max(Sale.id)).scalar() or 0
    return f"{max_id + 1:06d}"

def generate_sku(session, category):
    from app.database.models import Product
    # Map categories to prefix digits
    prefix_map = {
        'Frame': '2', 
        'Sunglasses': '3', 
        'Accessory': '4', 
        'ContactLens': '5', 
        'Lens': '1', 
        'Other': '0'
    }
    prefix = prefix_map.get(category, '0')
    count = session.query(Product).filter(Product.sku.ilike(f"{prefix}%")).count()
    return f"{prefix}{count + 1:04d}"

