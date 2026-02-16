import json
import os
import uuid
import datetime
from app.config import USE_SUPABASE, SUPABASE_URL, SUPABASE_KEY, LOCAL_JSON_DB

class POSRepository:
    def __init__(self):
        self.supabase = None
        if USE_SUPABASE:
            if SUPABASE_URL and SUPABASE_KEY:
                try:
                    from supabase import create_client
                    self.supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
                except ImportError:
                    pass
                except Exception:
                    pass

        if not self.supabase:
            self._ensure_local_db()

    def _ensure_local_db(self):
        initial_data = {
            "users": [{
                "id": "1",
                "username": "admin",
                "password_hash": "$2b$12$PJA.1wnlwzUhF38Zy9qOduQ5djSaYUlD1.COIPYV5X2XBQBKhM53e", # 'Admin123'
                "role_id": "1",
                "full_name": "Administrator",
                "is_active": True
            }],
            "roles": [{"id": "1", "name": "Admin"}, {"id": "2", "name": "Seller"}],
            "permissions": [],
            "role_permissions": [],
            "user_permissions": [],
            "customers": [],
            "inventory": [], # products
            "sales": [],
            "sale_items": [],
            "prescriptions": [],
            "order_examinations": [],
            "suppliers": [],
            "purchases": [],
            "purchase_items": [],
            "stock_movements": [],
            "warehouses": [{"id": "1", "name": "Main Warehouse"}],
            "settings": [
                {"key": "shop_name", "value": "Lensy Optical"},
                {"key": "currency", "value": "EGP"},
                {"key": "store_address", "value": "Your Store Address"},
                {"key": "store_phone", "value": "000-000-0000"}
            ],
            "lens_types": [{"id": "1", "name": "Single Vision"}, {"id": "2", "name": "Bifocal"}, {"id": "3", "name": "Progressive"}],
            "frame_types": [{"id": "1", "name": "Full Rim"}, {"id": "2", "name": "Half Rim"}, {"id": "3", "name": "Rimless"}],
            "frame_colors": [{"id": "1", "name": "Black"}, {"id": "2", "name": "Gold"}, {"id": "3", "name": "Silver"}, {"id": "4", "name": "Brown"}],
            "contact_lens_types": []
        }

        if not os.path.exists(LOCAL_JSON_DB):
            self._write_local(initial_data)
        else:
            # If it exists, ensure it has all required keys and at least one admin
            try:
                with open(LOCAL_JSON_DB, 'r') as f:
                    data = json.load(f)
                
                changed = False
                for key, value in initial_data.items():
                    if key not in data or (not data[key] and value):
                        data[key] = value
                        changed = True
                
                if changed:
                    self._write_local(data)
            except Exception:
                # If corrupted, overwrite
                self._write_local(initial_data)

    def _read_local(self):
        if not os.path.exists(LOCAL_JSON_DB):
            self._ensure_local_db()
        with open(LOCAL_JSON_DB, 'r') as f:
            return json.load(f)

    def _write_local(self, data):
        with open(LOCAL_JSON_DB, 'w') as f:
            json.dump(data, f, indent=4)

    # --- Auth & Users ---
    def authenticate(self, username, password):
        from app.core.auth import verify_password

        if self.supabase:
            try:
                res = self.supabase.table("users").select("*, roles(*)").eq("username", username).eq("is_active", True).execute()
                if res.data:
                    user = res.data[0]
                    if verify_password(password, user["password_hash"]):
                        return user
                return None
            except Exception as e:
                print(f"[AUTH] Supabase error: {e}")
                return None

        # Local DB authentication
        data = self._read_local()
        for user in data["users"]:
            if user["username"] == username and user.get("is_active", True):
                if verify_password(password, user["password_hash"]):
                    role_id = user.get("role_id")
                    user["role"] = next((r for r in data["roles"] if r["id"] == role_id), None)
                    return user
        return None

    def get_users(self):
        if self.supabase:
            return self.supabase.table("users").select("*, roles(*)").execute().data
        
        data = self._read_local()
        users = data["users"]
        roles = data["roles"]
        for u in users:
            u["role"] = next((r for r in roles if r["id"] == u.get("role_id")), None)
        return users

    def add_user(self, user_data):
        """Add a new user."""
        if self.supabase:
            return self.supabase.table("users").insert(user_data).execute().data[0]

        data = self._read_local()
        user_data["id"] = str(uuid.uuid4())
        data["users"].append(user_data)
        self._write_local(data)
        return user_data

    def update_user(self, user_id, user_data):
        """Update an existing user."""
        if self.supabase:
            return self.supabase.table("users").update(user_data).eq("id", user_id).execute()

        data = self._read_local()
        for user in data["users"]:
            if str(user["id"]) == str(user_id):
                user.update(user_data)
                break
        self._write_local(data)

    def has_permission(self, user_id, permission_code):
        if self.supabase:
            # This would require complex joins in Supabase. 
            # Simplified version:
            res = self.supabase.table("permissions").select("*").eq("code", permission_code).execute()
            if not res.data: return False, None
            perm_id = res.data[0]["id"]
            
            # 1. User override
            up = self.supabase.table("user_permissions").select("*").eq("user_id", user_id).eq("permission_id", perm_id).execute()
            if up.data:
                return up.data[0]["allow"], up.data[0].get("value")
            
            # 2. Role
            user = self.supabase.table("users").select("role_id").eq("id", user_id).execute().data[0]
            if not user.get("role_id"): return False, None
            
            rp = self.supabase.table("role_permissions").select("*").eq("role_id", user["role_id"]).eq("permission_id", perm_id).execute()
            if rp.data:
                return True, rp.data[0].get("value")
            
            return False, None

        data = self._read_local()
        perm = next((p for p in data["permissions"] if p["code"] == permission_code), None)
        if not perm: return False, None
        
        # 1. User override
        up = next((u for u in data["user_permissions"] if u["user_id"] == user_id and u["permission_id"] == perm["id"]), None)
        if up:
            return up["allow"], up.get("value")
        
        # 2. Role
        user = next((u for u in data["users"] if u["id"] == user_id), None)
        if not user or not user.get("role_id"): return False, None
        
        rp = next((r for r in data["role_permissions"] if r["role_id"] == user["role_id"] and r["permission_id"] == perm["id"]), None)
        if rp:
            return True, rp.get("value")
            
        return False, None

    # --- Utility ---
    def get_next_invoice_no(self):
        if self.supabase:
            res = self.supabase.table("sales").select("id", count="exact").execute()
            count = res.count or 0
            return f"{count + 1:06d}"
        
        data = self._read_local()
        count = len(data["sales"])
        return f"{count + 1:06d}"

    def generate_sku(self, category):
        prefix_map = {
            'Frame': '2', 
            'Sunglasses': '3', 
            'Accessory': '4', 
            'ContactLens': '5', 
            'Lens': '1', 
            'Other': '0'
        }
        prefix = prefix_map.get(category, '0')
        
        if self.supabase:
            res = self.supabase.table("inventory").select("sku").ilike("sku", f"{prefix}%").execute()
            count = len(res.data)
            return f"{prefix}{count + 1:04d}"
        
        data = self._read_local()
        count = len([i for i in data["inventory"] if i.get("sku", "").startswith(prefix)])
        return f"{prefix}{count + 1:04d}"

    # --- Generic Metadata ---
    def get_metadata(self, table_name):
        if self.supabase:
            return self.supabase.table(table_name).select("*").execute().data
        return self._read_local().get(table_name, [])

    def add_metadata(self, table_name, name):
        if self.supabase:
            return self.supabase.table(table_name).insert({"name": name}).execute().data[0]
        data = self._read_local()
        new_item = {"id": str(uuid.uuid4()), "name": name}
        data[table_name].append(new_item)
        self._write_local(data)
        return new_item

    # --- Customers ---
    def get_customers(self):
        if self.supabase:
            return self.supabase.table("customers").select("*").execute().data
        return self._read_local()["customers"]

    def add_customer(self, customer_data):
        if self.supabase:
            return self.supabase.table("customers").insert(customer_data).execute().data[0]
        
        data = self._read_local()
        customer_data["id"] = str(uuid.uuid4())
        data["customers"].append(customer_data)
        self._write_local(data)
        return customer_data

    def update_customer(self, customer_id, customer_data):
        if self.supabase:
            return self.supabase.table("customers").update(customer_data).eq("id", customer_id).execute()
        
        data = self._read_local()
        for c in data["customers"]:
            if str(c["id"]) == str(customer_id):
                c.update(customer_data)
                break
        self._write_local(data)

    def delete_customer(self, customer_id):
        """Delete a customer by ID."""
        if self.supabase:
            return self.supabase.table("customers").delete().eq("id", customer_id).execute()

        data = self._read_local()
        data["customers"] = [c for c in data["customers"] if str(c["id"]) != str(customer_id)]
        self._write_local(data)

    # --- Inventory ---
    def get_inventory(self, category=None, search_term=None):
        """Get inventory with stock calculated from movements."""
        if self.supabase:
            query = self.supabase.table("inventory").select("*")
            if category:
                query = query.eq("category", category)
            items = query.execute().data
            # Calculate stock for each item
            for item in items:
                item["stock_qty"] = self.get_product_stock(item["id"])
            return items

        data = self._read_local()
        items = data["inventory"]
        movements = data.get("stock_movements", [])

        # Calculate stock from movements
        for item in items:
            item["stock_qty"] = sum(m["qty"] for m in movements if m.get("product_id") == item["id"])

        # Filter by category if provided
        if category:
            items = [i for i in items if i.get("category") == category]

        # Filter by search term
        if search_term:
            term = search_term.lower()
            items = [i for i in items if
                term in i.get("name", "").lower() or
                term in i.get("sku", "").lower() or
                term in i.get("barcode", "").lower()]

        return items

    def get_products_by_category(self, category):
        """Get products filtered by category."""
        return self.get_inventory(category=category)

    def add_inventory_item(self, item_data):
        """Add inventory item with optional initial stock movement."""
        initial_qty = item_data.pop("stock_qty", 0)

        if self.supabase:
            result = self.supabase.table("inventory").insert(item_data).execute().data[0]
            if initial_qty > 0:
                self.add_stock_movement(result["id"], initial_qty, "initial", note="Initial stock")
            return result

        data = self._read_local()
        item_data["id"] = str(uuid.uuid4())
        if "sku" not in item_data or not item_data["sku"]:
            item_data["sku"] = self.generate_sku(item_data.get("category", "Other"))
        data["inventory"].append(item_data)

        # Create initial stock movement if qty > 0
        if initial_qty > 0:
            movement = {
                "id": str(uuid.uuid4()),
                "product_id": item_data["id"],
                "qty": initial_qty,
                "type": "initial",
                "ref_no": "",
                "note": "Initial stock",
                "created_at": datetime.datetime.utcnow().isoformat()
            }
            data["stock_movements"].append(movement)

        self._write_local(data)
        return item_data

    def update_inventory_item(self, item_id, item_data):
        if self.supabase:
            return self.supabase.table("inventory").update(item_data).eq("id", item_id).execute()
        
        data = self._read_local()
        for item in data["inventory"]:
            if str(item["id"]) == str(item_id):
                item.update(item_data)
                break
        self._write_local(data)

    def update_inventory_stock(self, item_id, new_qty):
        """Update stock by creating an adjustment movement."""
        current_stock = self.get_product_stock(item_id)
        diff = new_qty - current_stock
        if diff != 0:
            self.add_stock_movement(item_id, diff, "adjustment", note="Stock adjustment")

    def adjust_stock(self, item_id, qty_change, movement_type="adjustment", ref_no="", note=""):
        """Adjust stock by adding a movement record."""
        return self.add_stock_movement(item_id, qty_change, movement_type, ref_no, note)

    # --- Sales ---
    def get_sales(self):
        if self.supabase:
            return self.supabase.table("sales").select("*, sale_items(*)").execute().data
        
        data = self._read_local()
        sales = data["sales"]
        items = data["sale_items"]
        # Join items to sales for local mode
        for sale in sales:
            sale["sale_items"] = [item for item in items if item["sale_id"] == sale["id"]]
        return sales

    def add_sale(self, sale_data, items, exam_data=None, examinations=None):
        """
        Create a complete sale with items, stock movements, and examinations.

        Args:
            sale_data: Sale header data
            items: List of sale items [{product_id, qty, unit_price, total_price, name}]
            exam_data: Single examination data (legacy support)
            examinations: List of examination data (for multiple exams per order)
        """
        if self.supabase:
            res = self.supabase.table("sales").insert(sale_data).execute()
            sale_id = res.data[0]["id"]
            invoice_no = sale_data.get("invoice_no", sale_id)

            for item in items:
                item["sale_id"] = sale_id
                # Deduct stock
                self.add_stock_movement(
                    item["product_id"],
                    -item["qty"],
                    "sale",
                    ref_no=invoice_no,
                    note=f"POS Sale: {invoice_no}"
                )
            self.supabase.table("sale_items").insert(items).execute()
            
            # Handle examinations (multiple or single)
            all_exams = examinations or ([exam_data] if exam_data else [])
            for exam in all_exams:
                if exam:
                    exam["sale_id"] = sale_id
                    self.supabase.table("order_examinations").insert(exam).execute()

            return res.data[0]
        
        data = self._read_local()
        sale_id = str(uuid.uuid4())
        sale_data["id"] = sale_id
        invoice_no = sale_data.get("invoice_no", sale_id)

        # Add order_date if not present
        if "order_date" not in sale_data:
            sale_data["order_date"] = datetime.datetime.utcnow().isoformat()

        data["sales"].append(sale_data)

        for item in items:
            item_record = {
                "id": str(uuid.uuid4()),
                "sale_id": sale_id,
                "product_id": item["product_id"],
                "qty": item["qty"],
                "unit_price": item.get("unit_price", 0),
                "total_price": item.get("total_price", 0),
                "name": item.get("name", "")
            }
            data["sale_items"].append(item_record)

            # Create stock movement for sale (negative qty)
            movement = {
                "id": str(uuid.uuid4()),
                "product_id": item["product_id"],
                "qty": -item["qty"],
                "type": "sale",
                "ref_no": invoice_no,
                "note": f"POS Sale: {invoice_no}",
                "created_at": datetime.datetime.utcnow().isoformat()
            }
            data["stock_movements"].append(movement)

        # Handle examinations (multiple or single)
        all_exams = examinations or ([exam_data] if exam_data else [])
        for exam in all_exams:
            if exam:
                exam_record = {
                    "id": str(uuid.uuid4()),
                    "sale_id": sale_id,
                    **exam
                }
                data["order_examinations"].append(exam_record)

        self._write_local(data)
        return sale_data

    def update_sale_lab_status(self, sale_id, status):
        if self.supabase:
            return self.supabase.table("sales").update({"lab_status": status}).eq("id", sale_id).execute()
        
        data = self._read_local()
        for sale in data["sales"]:
            if sale["id"] == sale_id:
                sale["lab_status"] = status
                break
        self._write_local(data)

    def update_sale_payment(self, sale_id, amount_paid):
        """Update the amount paid for a sale."""
        if self.supabase:
            return self.supabase.table("sales").update({"amount_paid": amount_paid}).eq("id", sale_id).execute()

        data = self._read_local()
        for sale in data["sales"]:
            if sale["id"] == sale_id:
                sale["amount_paid"] = amount_paid
                break
        self._write_local(data)

    # --- Settings ---
    def get_setting(self, key, default=None):
        if self.supabase:
            res = self.supabase.table("settings").select("value").eq("key", key).execute()
            return res.data[0]["value"] if res.data else default
        
        data = self._read_local()
        setting = next((s for s in data["settings"] if s["key"] == key), None)
        return setting["value"] if setting else default

    def set_setting(self, key, value):
        if self.supabase:
            # Upsert
            res = self.supabase.table("settings").select("*").eq("key", key).execute()
            if res.data:
                return self.supabase.table("settings").update({"value": value}).eq("key", key).execute()
            else:
                return self.supabase.table("settings").insert({"key": key, "value": value}).execute()
        
        data = self._read_local()
        setting = next((s for s in data["settings"] if s["key"] == key), None)
        if setting:
            setting["value"] = value
        else:
            data["settings"].append({"key": key, "value": value})
        self._write_local(data)

    # --- Prescriptions ---
    def get_prescriptions(self, customer_id=None):
        if self.supabase:
            query = self.supabase.table("prescriptions").select("*")
            if customer_id:
                query = query.eq("customer_id", customer_id)
            return query.execute().data
        
        data = self._read_local()
        if customer_id:
            return [p for p in data["prescriptions"] if p["customer_id"] == customer_id]
        return data["prescriptions"]

    def add_prescription(self, p_data):
        if self.supabase:
            return self.supabase.table("prescriptions").insert(p_data).execute().data[0]
        
        data = self._read_local()
        p_data["id"] = str(uuid.uuid4())
        data["prescriptions"].append(p_data)
        self._write_local(data)
        return p_data

    # --- POS-Specific Operations ---
    def get_customer_past_examinations(self, customer_id: str) -> list:
        """Get past examinations for a customer with sale info."""
        if self.supabase:
            return self.supabase.table("order_examinations")\
                .select("*, sales(id, order_date, invoice_no, doctor_name)")\
                .eq("sales.customer_id", customer_id)\
                .order_by("sales.order_date", desc=True)\
                .limit(10)\
                .execute().data

        data = self._read_local()
        exams = data.get("order_examinations", [])
        sales = data.get("sales", [])

        customer_sales = [s for s in sales if str(s.get("customer_id")) == str(customer_id)]
        customer_sale_ids = [s["id"] for s in customer_sales]

        customer_exams = []
        for e in exams:
            if e.get("sale_id") in customer_sale_ids:
                # Attach sale info
                sale = next((s for s in customer_sales if s["id"] == e["sale_id"]), {})
                e["sale"] = {
                    "id": sale.get("id"),
                    "order_date": sale.get("order_date", ""),
                    "invoice_no": sale.get("invoice_no", ""),
                    "doctor_name": sale.get("doctor_name", "")
                }
                customer_exams.append(e)

        # Sort by date descending
        customer_exams.sort(
            key=lambda e: e.get("sale", {}).get("order_date", ""),
            reverse=True
        )

        return customer_exams[:10]

    def search_customers(self, query: str) -> list:
        """Search customers by name, phone, city, etc."""
        if self.supabase:
            # Supabase doesn't have great full-text search, so we do multiple OR queries
            return self.supabase.table("customers")\
                .select("*")\
                .ilike("name", f"%{query}%")\
                .limit(10)\
                .execute().data

        data = self._read_local()
        customers = data.get("customers", [])
        query_lower = query.lower()

        return [c for c in customers if (
            query_lower in c.get("name", "").lower() or
            query_lower in c.get("phone", "").lower() or
            query_lower in c.get("city", "").lower() or
            query_lower in c.get("email", "").lower()
        )][:10]

    def create_sale_order(self, customer_id: str, items: list, exam_data: dict = None,
                         totals: dict = None, doctor_name: str = "", user_id: str = None) -> dict:
        """
        Create a complete sale order with items, examinations, and stock movements.

        Args:
            customer_id: Customer ID
            items: List of {product_id, qty, unit_price, total_price}
            exam_data: Optional examination data
            totals: {total_amount, discount, net_amount, amount_paid}
            doctor_name: Doctor name for prescription orders
            user_id: User ID (cashier)

        Returns:
            Sale data with ID
        """
        invoice_no = self.get_next_invoice_no()

        # Deduct stock for each item
        for item in items:
            current_stock = self.get_product_stock(item["product_id"])
            if current_stock < item["qty"]:
                raise ValueError(f"Insufficient stock for product {item['product_id']}")

            # Update stock
            new_stock = current_stock - item["qty"]
            self.update_inventory_stock(item["product_id"], new_stock)

            # Record movement
            self.add_stock_movement(
                product_id=item["product_id"],
                qty=-item["qty"],
                movement_type="sale",
                ref_no=invoice_no,
                note=f"POS Sale: {invoice_no}"
            )

        import datetime
        sale_data = {
            "invoice_no": invoice_no,
            "customer_id": customer_id,
            "user_id": user_id,
            "total_amount": totals.get("total_amount", 0.0) if totals else 0.0,
            "discount": totals.get("discount", 0.0) if totals else 0.0,
            "net_amount": totals.get("net_amount", 0.0) if totals else 0.0,
            "amount_paid": totals.get("amount_paid", 0.0) if totals else 0.0,
            "payment_method": "Cash",
            "order_date": datetime.datetime.utcnow().isoformat(),
            "doctor_name": doctor_name,
            "lab_status": "Not Started"
        }

        return self.add_sale(sale_data, items, exam_data)

    def get_product_stock(self, product_id: str) -> int:
        """Get current stock quantity for a product."""
        if self.supabase:
            res = self.supabase.table("stock_movements").select("qty").eq("product_id", product_id).execute()
            return sum(m["qty"] for m in res.data)

        data = self._read_local()
        movements = data.get("stock_movements", [])
        return sum(m["qty"] for m in movements if m["product_id"] == product_id)

    def add_stock_movement(self, product_id: str, qty: int, movement_type: str,
                          ref_no: str = "", note: str = ""):
        """Record a stock movement."""
        if self.supabase:
            return self.supabase.table("stock_movements").insert({
                "product_id": product_id,
                "qty": qty,
                "type": movement_type,
                "ref_no": ref_no,
                "note": note,
                "created_at": datetime.datetime.utcnow().isoformat()
            }).execute().data[0]

        data = self._read_local()
        movement = {
            "id": str(uuid.uuid4()),
            "product_id": product_id,
            "qty": qty,
            "type": movement_type,
            "ref_no": ref_no,
            "note": note,
            "created_at": datetime.datetime.utcnow().isoformat()
        }
        if "stock_movements" not in data:
            data["stock_movements"] = []
        data["stock_movements"].append(movement)
        self._write_local(data)
        return movement

    # --- Lens Types, Frame Types, Frame Colors ---
    def get_lens_types(self):
        """Get all lens types."""
        return self.get_metadata("lens_types")

    def add_lens_type(self, name):
        """Add a new lens type if it doesn't exist."""
        existing = self.get_lens_types()
        if any(lt.get("name", "").lower() == name.lower() for lt in existing):
            return next(lt for lt in existing if lt.get("name", "").lower() == name.lower())
        return self.add_metadata("lens_types", name)

    def get_frame_types(self):
        """Get all frame types."""
        return self.get_metadata("frame_types")

    def add_frame_type(self, name):
        """Add a new frame type if it doesn't exist."""
        existing = self.get_frame_types()
        if any(ft.get("name", "").lower() == name.lower() for ft in existing):
            return next(ft for ft in existing if ft.get("name", "").lower() == name.lower())
        return self.add_metadata("frame_types", name)

    def get_frame_colors(self):
        """Get all frame colors."""
        return self.get_metadata("frame_colors")

    def add_frame_color(self, name):
        """Add a new frame color if it doesn't exist."""
        existing = self.get_frame_colors()
        if any(fc.get("name", "").lower() == name.lower() for fc in existing):
            return next(fc for fc in existing if fc.get("name", "").lower() == name.lower())
        return self.add_metadata("frame_colors", name)

    def ensure_lens_type_exists(self, name):
        """Ensure lens type exists, create if not."""
        if not name or not name.strip():
            return None
        return self.add_lens_type(name.strip())

    # --- Product Search Helper ---
    def find_product_by_name_or_sku(self, search_term):
        """Find product by name or SKU."""
        inventory = self.get_inventory()
        term = search_term.lower().strip()

        # Exact SKU match first
        for p in inventory:
            if p.get("sku", "").lower() == term:
                return p

        # Then name contains
        for p in inventory:
            if term in p.get("name", "").lower():
                return p

        return None

    def create_frame_product_if_needed(self, frame_name):
        """Create a frame product if it doesn't exist."""
        if not frame_name or not frame_name.strip():
            return None

        # Check if product exists
        inventory = self.get_inventory(category="Frame")
        for p in inventory:
            if p.get("name", "").lower() == frame_name.lower().strip():
                return p

        # Create new frame product
        return self.add_inventory_item({
            "name": frame_name.strip(),
            "category": "Frame",
            "sku": self.generate_sku("Frame"),
            "sale_price": 0.0,
            "cost_price": 0.0,
            "stock_qty": 0
        })


