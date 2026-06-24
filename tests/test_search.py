"""Tests for app.core.search.search_all (no Flet, no real repo required)."""

from app.core.search import search_all


class FakeRepo:
    def __init__(self, customers=None, inventory=None, sales=None):
        self._customers = customers or []
        self._inventory = inventory or []
        self._sales = sales or []

    def get_customers(self):
        return self._customers

    def get_inventory(self):
        return self._inventory

    def get_sales(self):
        return self._sales


def test_empty_term_returns_empty_results():
    repo = FakeRepo(customers=[{"name": "Ahmed"}])
    out = search_all(repo, "")
    assert out == {"customers": [], "products": [], "sales": []}


def test_short_term_returns_empty_results():
    repo = FakeRepo(customers=[{"name": "Ahmed"}])
    out = search_all(repo, "a")
    assert out["customers"] == []


def test_matches_customer_by_name_case_insensitive():
    repo = FakeRepo(customers=[
        {"id": 1, "name": "Ahmed Ali", "phone": "555-0101"},
        {"id": 2, "name": "Sara", "phone": "555-0202"},
    ])
    out = search_all(repo, "AHMED")
    assert len(out["customers"]) == 1
    assert out["customers"][0]["id"] == 1


def test_matches_customer_by_phone():
    repo = FakeRepo(customers=[
        {"id": 1, "name": "Ahmed", "phone": "555-9999"},
        {"id": 2, "name": "Sara", "phone": "555-0000"},
    ])
    out = search_all(repo, "9999")
    assert [c["id"] for c in out["customers"]] == [1]


def test_matches_product_by_sku():
    repo = FakeRepo(inventory=[
        {"sku": "LNS001", "name": "Single Vision Lens"},
        {"sku": "FRM001", "name": "Frame"},
    ])
    out = search_all(repo, "lns")
    assert len(out["products"]) == 1
    assert out["products"][0]["sku"] == "LNS001"


def test_matches_sale_by_invoice_no():
    repo = FakeRepo(sales=[
        {"invoice_no": "000001"},
        {"invoice_no": "000002"},
    ])
    out = search_all(repo, "0001")
    assert len(out["sales"]) == 1


def test_limit_caps_each_category():
    customers = [{"id": i, "name": f"Customer {i}"} for i in range(20)]
    repo = FakeRepo(customers=customers)
    out = search_all(repo, "customer", limit=3)
    assert len(out["customers"]) == 3


def test_handles_none_fields_without_crashing():
    repo = FakeRepo(customers=[{"name": "Ahmed", "phone": None}])
    out = search_all(repo, "ahm")
    assert len(out["customers"]) == 1
