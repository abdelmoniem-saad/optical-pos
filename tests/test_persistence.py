import unittest
import os
from uuid import uuid4
from splitmates.model.models import User, Category, Split
from splitmates.logic.group_manager import GroupManager
from splitmates.repository.group_repository import GroupRepository

class TestPersistence(unittest.TestCase):
    def setUp(self):
        self.test_file = "test_persistence.json"
        if os.path.exists(self.test_file):
            os.remove(self.test_file)

    def tearDown(self):
        if os.path.exists(self.test_file):
            os.remove(self.test_file)

    def test_save_load(self):
        repo = GroupRepository(storage_path=self.test_file)
        group = repo.create_group("Test Group")
        manager = repo.get_group_manager(group.id)
        
        alice = User(name="Alice")
        bob = User(name="Bob")
        group.members.extend([alice, bob])
        
        manager.add_equal_expense("Pizza", 40.0, alice, [alice, bob], Category.OTHER)
        manager.add_settlement(bob, alice, 10.0)
        
        repo.save()
        
        # Load in a new repo
        repo2 = GroupRepository(storage_path=self.test_file)
        groups = repo2.get_all_groups()
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].name, "Test Group")
        self.assertEqual(len(groups[0].members), 2)
        
        manager2 = repo2.get_group_manager(groups[0].id)
        self.assertEqual(len(manager2.expenses), 1)
        self.assertEqual(manager2.expenses[0].description, "Pizza")
        self.assertEqual(len(manager2.settlements), 1)
        self.assertEqual(manager2.settlements[0].amount, 10.0)
        
        balances = manager2.get_balances()
        # Alice paid 40, Bob owes 20. Bob paid 10 to Alice.
        # Alice net: +40 - 20 (her share) + 10 (from Bob) = +30 ? 
        # Wait, calculate_balances logic:
        # Expenses: Alice +20 (paid 40, share 20), Bob -20
        # Settlements: Bob paid Alice 10 -> Bob +10, Alice -10 (Wait, settlement amount is subtracted from 'from' and added to 'to'? No, usually it reduces debt)
        # Let's check balance_calculator.py
        
        # In balance_calculator.py:
        # amount_paid[expense.paid_by] += expense.amount
        # for split in expense.splits: amount_owed[split.user] += split.amount
        # net = amount_paid - amount_owed
        # Alice: 40 - 20 = +20
        # Bob: 0 - 20 = -20
        # Settlements:
        # balances[s.from_user] += s.amount
        # balances[s.to_user] -= s.amount
        # Alice: 20 - 10 = +10
        # Bob: -20 + 10 = -10
        
        self.assertEqual(balances[next(u for u in groups[0].members if u.name == "Alice")], 10.0)
        self.assertEqual(balances[next(u for u in groups[0].members if u.name == "Bob")], -10.0)

if __name__ == '__main__':
    unittest.main()
