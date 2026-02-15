# scripts/migrate_add_contact_lens_table.py
"""
Migration script to add contact_lens_types table to existing database.
Run this if you get an error about missing contact_lens_types table.
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine
from app.database.models import Base, ContactLensType

def migrate():
    engine = get_engine()

    # Create only the ContactLensType table
    print("Creating contact_lens_types table...")
    ContactLensType.__table__.create(engine, checkfirst=True)

    # Seed some default contact lens types
    from app.database.db_manager import get_session
    session = get_session(engine)

    try:
        # Check if any already exist
        if session.query(ContactLensType).first() is None:
            print("Seeding default contact lens types...")
            types = ['Soft Contact Lens', 'Hard Contact Lens', 'Colored Contact Lens']
            for t in types:
                session.add(ContactLensType(name=t))
            session.commit()
            print("✓ Contact lens types seeded")
        else:
            print("Contact lens types already exist, skipping seed")
    finally:
        session.close()

    print("✓ Migration complete!")

if __name__ == '__main__':
    migrate()


