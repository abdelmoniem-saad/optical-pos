from typing import Callable, Dict
import flet as ft


class UIEventTopic:
    SALES = "sales"
    CUSTOMERS = "customers"
    INVENTORY = "inventory"
    LAB = "lab"


def _get_bus(page: ft.Page) -> Dict[str, Dict[str, Callable]]:
    if not hasattr(page, "data") or page.data is None:
        page.data = {}
    bus = page.data.get("_ui_sync_subscribers")
    if bus is None:
        bus = {}
        page.data["_ui_sync_subscribers"] = bus
    return bus


def subscribe_ui_event(page: ft.Page, topic: str, subscriber_id: str, callback: Callable):
    bus = _get_bus(page)
    topic_subs = bus.setdefault(topic, {})
    topic_subs[subscriber_id] = callback


def publish_ui_event(page: ft.Page, topic: str, payload=None):
    bus = _get_bus(page)
    for callback in list(bus.get(topic, {}).values()):
        try:
            callback(payload)
        except Exception:
            # Event handlers should not crash UI flow.
            pass

