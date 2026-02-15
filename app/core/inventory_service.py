# app/core/inventory_service.py
"""
Inventory Service - Handles stock movements, product management, and frame/lens operations.
Centralizes all complex inventory logic for the POS system.
"""

from app.database.db_manager import get_session, get_engine
from app.database.models import (
    Product, StockMovement, Warehouse, LensType, OrderExamination
)
from sqlalchemy import func
import datetime


class InventoryService:
    """Service for managing inventory operations including stock movements and product management."""

    @staticmethod
    def get_available_stock(product_id: int, session=None) -> int:
        """
        Get the current available stock quantity for a product.

        Args:
            product_id: The product ID
            session: Optional database session (creates new one if not provided)

        Returns:
            Current stock quantity
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            movements = session.query(StockMovement).filter_by(product_id=product_id).all()
            total_qty = sum(m.qty for m in movements)
            return total_qty
        finally:
            if close_session:
                session.close()

    @staticmethod
    def deduct_stock(product_id: int, quantity: int, warehouse_id: int = None,
                     ref_no: str = "", note: str = "", session=None) -> bool:
        """
        Deduct stock from inventory (used for sales).

        Args:
            product_id: The product ID
            quantity: Quantity to deduct (as positive number)
            warehouse_id: Warehouse ID (uses first warehouse if not provided)
            ref_no: Reference number (invoice, PO, etc.)
            note: Additional note
            session: Optional database session

        Returns:
            True if successful, False otherwise
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            if warehouse_id is None:
                wh = session.query(Warehouse).first()
                warehouse_id = wh.id if wh else None

            if warehouse_id is None:
                return False

            # Check available stock
            available = InventoryService.get_available_stock(product_id, session)
            if available < quantity:
                return False

            # Create stock movement record
            move = StockMovement(
                product_id=product_id,
                warehouse_id=warehouse_id,
                qty=-int(quantity),
                type="sale",
                ref_no=ref_no,
                note=note or f"Sale: {ref_no}"
            )
            session.add(move)
            return True
        except Exception as e:
            print(f"Error deducting stock: {e}")
            return False
        finally:
            if close_session:
                session.close()

    @staticmethod
    def return_stock(product_id: int, quantity: int, warehouse_id: int = None,
                     ref_no: str = "", note: str = "", session=None) -> bool:
        """
        Return stock to inventory (used for order updates/cancellations).

        Args:
            product_id: The product ID
            quantity: Quantity to return (as positive number)
            warehouse_id: Warehouse ID
            ref_no: Reference number
            note: Additional note
            session: Optional database session

        Returns:
            True if successful, False otherwise
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            if warehouse_id is None:
                wh = session.query(Warehouse).first()
                warehouse_id = wh.id if wh else None

            if warehouse_id is None:
                return False

            move = StockMovement(
                product_id=product_id,
                warehouse_id=warehouse_id,
                qty=int(quantity),
                type="return",
                ref_no=ref_no,
                note=note or f"Return: {ref_no}"
            )
            session.add(move)
            return True
        except Exception as e:
            print(f"Error returning stock: {e}")
            return False
        finally:
            if close_session:
                session.close()

    @staticmethod
    def create_or_get_frame_product(frame_name: str, session=None) -> Product:
        """
        Create a frame product if it doesn't exist, or return existing one.

        Args:
            frame_name: Name of the frame
            session: Optional database session

        Returns:
            Product instance (Frame category)
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            # Try to find existing frame by name
            product = session.query(Product).filter_by(name=frame_name, category='Frame').first()

            if product:
                return product

            # Create new frame product
            from app.database.db_manager import generate_sku
            sku = generate_sku(session, 'Frame')

            product = Product(
                name=frame_name,
                category='Frame',
                sku=sku,
                sale_price=0.0,
                cost_price=0.0,
                description="Auto-created frame"
            )
            session.add(product)
            session.flush()

            # Create initial stock movement
            wh = session.query(Warehouse).first()
            move = StockMovement(
                product_id=product.id,
                warehouse_id=wh.id if wh else None,
                qty=0,
                type='initial',
                note='Auto-created frame product'
            )
            session.add(move)

            return product
        finally:
            if close_session:
                session.close()

    @staticmethod
    def create_or_get_lens_type(lens_name: str, session=None) -> int:
        """
        Create a lens type if it doesn't exist, or return existing one.

        Args:
            lens_name: Name of the lens type
            session: Optional database session

        Returns:
            LensType ID
        """
        if not lens_name or not lens_name.strip():
            return None

        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            existing = session.query(LensType).filter_by(name=lens_name.strip()).first()
            if existing:
                return existing.id

            new_lens = LensType(name=lens_name.strip())
            session.add(new_lens)
            session.flush()
            return new_lens.id
        finally:
            if close_session:
                session.close()

    @staticmethod
    def cleanup_unused_lens_types(session=None) -> int:
        """
        Delete lens types that are no longer used in any orders.

        Args:
            session: Optional database session

        Returns:
            Number of lens types deleted
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            lens_types = session.query(LensType).all()
            deleted_count = 0

            for lens_type in lens_types:
                # Check if this lens type is used by any order
                count = session.query(OrderExamination).filter_by(lens_info=lens_type.name).count()
                if count == 0:
                    session.delete(lens_type)
                    deleted_count += 1

            return deleted_count
        finally:
            if close_session:
                session.close()

    @staticmethod
    def get_customer_past_examinations(customer_id: int, limit: int = 10, session=None) -> list:
        """
        Get past examinations for a customer.

        Args:
            customer_id: Customer ID
            limit: Maximum number of examinations to return
            session: Optional database session

        Returns:
            List of OrderExamination objects
        """
        close_session = False
        if session is None:
            session = get_session(get_engine())
            close_session = True

        try:
            from app.database.models import Sale
            past_exams = session.query(OrderExamination)\
                .join(Sale)\
                .filter(Sale.customer_id == customer_id)\
                .order_by(Sale.order_date.desc())\
                .limit(limit)\
                .all()
            return past_exams
        finally:
            if close_session:
                session.close()


