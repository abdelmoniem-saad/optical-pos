import os
from supabase import create_client, Client

class SupabaseRepository:
    def __init__(self):
        url: str = os.environ.get("SUPABASE_URL")
        key: str = os.environ.get("SUPABASE_KEY")
        self.client: Client = create_client(url, key)

    # Inventory Management
    def get_inventory(self):
        response = self.client.table('inventory').select("*").execute()
        return response.data

    def add_inventory_item(self, item_data):
        response = self.client.table('inventory').insert(item_data).execute()
        return response.data

    def update_inventory_item(self, item_id, item_data):
        response = self.client.table('inventory').update(item_data).eq('id', item_id).execute()
        return response.data

    def delete_inventory_item(self, item_id):
        response = self.client.table('inventory').delete().eq('id', item_id).execute()
        return response.data

    # Customer Management
    def get_customers(self):
        response = self.client.table('customers').select("*").execute()
        return response.data

    def add_customer(self, customer_data):
        response = self.client.table('customers').insert(customer_data).execute()
        return response.data

    # Sales Management
    def create_sale(self, sale_data, items):
        # Create the main sale record
        sale_response = self.client.table('sales').insert({
            'customer_id': sale_data.get('customer_id'),
            'total_amount': sale_data.get('total_amount')
        }).execute()
        sale_id = sale_response.data[0]['id']

        # Add items to the sale_items table
        for item in items:
            item['sale_id'] = sale_id
            self.client.table('sale_items').insert(item).execute()
        
        return sale_response.data
