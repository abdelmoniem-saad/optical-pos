"""Cross-entity search service.

Used by the top-bar global search. Lives outside the UI so the search
logic can be tested and reused without instantiating Flet controls.
"""


def search_all(repo, term: str, limit: int = 5) -> dict:
    """Search customers, products, and sales for matches against ``term``.

    Matches are case-insensitive substring matches against:
      - customers: ``name`` or ``phone``
      - products:  ``name`` or ``sku``
      - sales:     ``invoice_no``

    Returns a dict with keys ``customers``, ``products``, ``sales``,
    each containing up to ``limit`` matching records (in repo order).
    Empty / too-short terms return empty result sets, never None.
    """
    empty = {"customers": [], "products": [], "sales": []}
    if not term:
        return empty
    term = term.strip()
    if len(term) < 2:
        return empty

    term_lower = term.lower()

    customers = repo.get_customers() or []
    matching_customers = [
        c for c in customers
        if term_lower in str(c.get("name", "")).lower()
        or term_lower in str(c.get("phone") or "").lower()
    ][:limit]

    products = repo.get_inventory() or []
    matching_products = [
        p for p in products
        if term_lower in str(p.get("name", "")).lower()
        or term_lower in str(p.get("sku") or "").lower()
    ][:limit]

    sales = repo.get_sales() or []
    matching_sales = [
        s for s in sales
        if term_lower in str(s.get("invoice_no", "")).lower()
    ][:limit]

    return {
        "customers": matching_customers,
        "products": matching_products,
        "sales": matching_sales,
    }
