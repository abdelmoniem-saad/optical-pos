# app/logging_config.py
import logging
from logging.handlers import RotatingFileHandler
import os
from .config import LOG_DIR, LOG_FILE, LOG_LEVEL

def ensure_log_dir():
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
    except Exception:
        pass

def setup_logging():
    ensure_log_dir()
    logger = logging.getLogger()
    logger.setLevel(LOG_LEVEL)

    # Console handler
    ch = logging.StreamHandler()
    ch.setLevel(LOG_LEVEL)
    ch_formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
    ch.setFormatter(ch_formatter)
    logger.addHandler(ch)

    # Rotating file handler
    fh = RotatingFileHandler(LOG_FILE, maxBytes=10*1024*1024, backupCount=5)
    fh.setLevel(LOG_LEVEL)
    fh_formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s')
    fh.setFormatter(fh_formatter)
    logger.addHandler(fh)

    return logger


