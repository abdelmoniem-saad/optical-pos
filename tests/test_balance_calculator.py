import unittest
from uuid import uuid4
from splitmates.model.models import User, Group, Split, Expense, Settlement, Category
from splitmates.logic.balance_calculator import BalanceCalculator

class TestBalanceCalculator(unittest.TestCase):
    def setUp(self):
        self.calculator = BalanceCalculator()
        self.group_id = uuid4()
        self.alice = User(name="Alice")
        self.bob = User(name="Bob")
        self.charlie = User(name="Charlie")

    def test_calculate_balances_equal_split(self):
        # Alice pays 60 for Alice, Bob, Charlie (20 each)
        expense = Expense(
            description="Dinner",
            amount=60.0,
            paid_by=self.alice,
            splits=[
                Split(self.alice, 20.0),
                Split(self.bob, 20.0),
                Split(self.charlie, 20.0)
            ],
            group_id=self.group_id
        )
        
        balances = self.calculator.calculate_balances([expense], [])
        
        self.assertAlmostEqual(balances[self.alice], 40.0)
        self.assertAlmostEqual(balances[self.bob], -20.0)
        self.assertAlmostEqual(balances[self.charlie], -20.0)

    def test_calculate_balances_with_settlement(self):
        # Alice pays 60 for all (20 each)
        expense = Expense(
            description="Dinner",
            amount=60.0,
            paid_by=self.alice,
            splits=[
                Split(self.alice, 20.0),
                Split(self.bob, 20.0),
                Split(self.charlie, 20.0)
            ],
            group_id=self.group_id
        )
        
        # Bob pays Alice 10
        settlement = Settlement(
            from_user=self.bob,
            to_user=self.alice,
            amount=10.0,
            group_id=self.group_id
        )
        
        balances = self.calculator.calculate_balances([expense], [settlement])
        
        self.assertAlmostEqual(balances[self.alice], 30.0)
        self.assertAlmostEqual(balances[self.bob], -10.0)
        self.assertAlmostEqual(balances[self.charlie], -20.0)

    def test_simplify_debts(self):
        # A owes B 10, B owes C 10 -> A owes C 10
        balances = {
            self.alice: -10.0,
            self.bob: 0.0,
            self.charlie: 10.0
        }
        
        simplified = self.calculator.simplify_debts(balances, self.group_id)
        
        self.assertEqual(len(simplified), 1)
        self.assertEqual(simplified[0].from_user, self.alice)
        self.assertEqual(simplified[0].to_user, self.charlie)
        self.assertAlmostEqual(simplified[0].amount, 10.0)

    def test_complex_simplification(self):
        # Alice: +40, Bob: -5, Charlie: -35
        balances = {
            self.alice: 40.0,
            self.bob: -5.0,
            self.charlie: -35.0
        }
        
        simplified = self.calculator.simplify_debts(balances, self.group_id)
        
        # Should be: Charlie pays Alice 35, Bob pays Alice 5
        self.assertEqual(len(simplified), 2)
        
        # Sort by amount to check
        simplified.sort(key=lambda x: x.amount, reverse=True)
        
        self.assertEqual(simplified[0].from_user, self.charlie)
        self.assertEqual(simplified[0].to_user, self.alice)
        self.assertAlmostEqual(simplified[0].amount, 35.0)
        
        self.assertEqual(simplified[1].from_user, self.bob)
        self.assertEqual(simplified[1].to_user, self.alice)
        self.assertAlmostEqual(simplified[1].amount, 5.0)

if __name__ == '__main__':
    unittest.main()
